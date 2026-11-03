// Storage adapter, not a second document store. All bytes remain in native VFS.
// One logical document may have the importer's ordered .part-NNNN backing files.
import { createHash } from 'node:crypto';
export const PART_LIMIT = 512 * 1024;
export const NATIVE_FILE_LIMIT = 1024 * 1024;
export const DOCUMENT_LIMIT = 2 * 1024 * 1024;
export const REQUEST_LIMIT = DOCUMENT_LIMIT * 6 + 65536;
export const logicalPath = (path) => path.replace(/\.part-\d{4}$/, '');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function documentStorage(fs, safe, fault, { legacyParts = () => [] } = {}) {
  const directories = new Map();
  const reset = () => directories.clear();
  function directory(parent) {
    if (directories.has(parent)) return directories.get(parent);
    const names = fs.readdirSync(parent),
      groups = new Map();
    for (const name of names) {
      const index = name.lastIndexOf('.part-');
      if (index < 0) continue;
      const base = name.slice(0, index);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(name);
    }
    for (const parts of groups.values()) parts.sort();
    const result = { names: new Set(names), groups };
    directories.set(parent, result);
    return result;
  }
  function inspect(path) {
    safe(path, true);
    const slash = path.lastIndexOf('/'),
      parent = path.slice(0, slash),
      name = path.slice(slash + 1);
    let names;
    try {
      names = directory(parent);
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    const parts = names.groups.get(name) ?? [];
    const direct = names.names.has(name);
    const marker = parent + '/' + name + '.parts.json';
    let expected = [];
    if (names.names.has(name + '.parts.json')) {
      safe(marker);
      const stat = fs.lstatSync(marker);
      if (!stat.isFile() || stat.size > 16384) fault(409, '分片布局凭据无效，原文未覆盖。');
      let value;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(marker)));
      } catch {
        fault(409, '分片布局凭据损坏，原文未覆盖。');
      }
      if (
        !value ||
        value.format !== 'novel-document-parts-v1' ||
        !Array.isArray(value.parts) ||
        !value.parts.length ||
        value.parts.some((p, i) => p !== name + '.part-' + String(i + 1).padStart(4, '0'))
      )
        fault(409, '分片布局凭据不兼容，未猜测正文顺序。');
      expected = value.parts;
    } else if (parts.length) expected = legacyParts(path).map((p) => p.slice(p.lastIndexOf('/') + 1));
    if (
      (parts.length || expected.length) &&
      (!expected.length ||
        direct ||
        expected.length !== parts.length ||
        expected.some((p, i) => p !== parts[i]))
    )
      fault(409, '文档分片与布局凭据不一致（可能缺少首尾分片），未拼接不完整正文。');
    if (direct && parts.length)
      fault(409, '同一文档同时存在整篇与分片，未猜测或覆盖；请先在原生文件工具中核对。');
    if (!direct && !parts.length) return null;
    if (parts.length && parts.some((item, i) => item !== name + '.part-' + String(i + 1).padStart(4, '0')))
      fault(409, '文档分片缺失、编号不连续或命名异常，未拼接不完整正文。');
    const files = (direct ? [name] : parts).map((item) => {
      const target = parent + '/' + item;
      safe(target);
      const stat = fs.lstatSync(target);
      if (!stat.isFile()) fault(409, '文档分片不是普通文件，未读取或覆盖。');
      if (stat.size > NATIVE_FILE_LIMIT)
        fault(413, '单个原生文件超过 1 MiB 兼容上限；原文保留，请先核对文件。');
      return { path: target, size: stat.size, updatedAt: stat.mtimeMs };
    });
    return {
      files,
      multipart: !direct,
      size: files.reduce((sum, f) => sum + f.size, 0),
      updatedAt: Math.max(...files.map((f) => f.updatedAt)),
    };
  }
  function read(path) {
    const layout = inspect(path);
    if (!layout) return null;
    if (layout.size > DOCUMENT_LIMIT) fault(413, '完整文档超过 2 MiB 编辑上限；未截断，所有原生分片仍保留。');
    const content = new Uint8Array(layout.size);
    let offset = 0;
    for (const file of layout.files) {
      const part = fs.readFileSync(file.path);
      if (part.byteLength !== file.size) fault(409, '分片读取期间发生变化，未返回半份正文。');
      content.set(part, offset);
      offset += part.byteLength;
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      fault(415, '该文档不是 UTF-8 文本，原始字节已保留，请在原生文件工具中处理。');
    }
    return {
      content,
      text,
      hash: hash(content),
      updatedAt: layout.updatedAt,
      parts: layout.files.map((f) => f.path),
      multipart: layout.multipart,
    };
  }
  function write(path, value) {
    const content = typeof value === 'string' ? new TextEncoder().encode(value) : value;
    if (content.byteLength > DOCUMENT_LIMIT) fault(413, '完整文档超过 2 MiB，未截断保存。');
    const before = inspect(path);
    // Existing multipart documents stay multipart; imported index paths remain
    // provenance. Runtime resolution always discovers the CURRENT complete set.
    const multipart = before?.multipart || content.byteLength > PART_LIMIT;
    const outputs = [];
    if (!multipart) outputs.push({ path, content });
    else {
      let start = 0;
      do {
        let end = Math.min(start + PART_LIMIT, content.byteLength);
        while (end < content.byteLength && (content[end] & 0xc0) === 0x80) end--;
        outputs.push({
          path: path + '.part-' + String(outputs.length + 1).padStart(4, '0'),
          content: content.slice(start, end),
        });
        start = end;
      } while (start < content.byteLength);
    }
    if (
      typeof fs.unlinkSync !== 'function' &&
      before?.files.some((f) => !outputs.some((o) => o.path === f.path))
    )
      fault(503, '原生文件删除能力不可用，未保存半份分片。');
    safe(path, true);
    fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    for (const output of outputs) {
      safe(output.path, true);
      const previous = before?.files.find((f) => f.path === output.path);
      if (!previous || hash(fs.readFileSync(output.path)) !== hash(output.content))
        fs.writeFileSync(output.path, output.content);
    }
    for (const file of before?.files ?? [])
      if (!outputs.some((output) => output.path === file.path)) fs.unlinkSync(file.path);
    if (multipart) {
      const marker = path + '.parts.json';
      safe(marker, true);
      fs.writeFileSync(
        marker,
        JSON.stringify({
          format: 'novel-document-parts-v1',
          parts: outputs.map((output) => output.path.slice(output.path.lastIndexOf('/') + 1)),
        }),
      );
    }
    reset();
  }
  function remove(path) {
    const layout = inspect(path);
    if (!layout) return;
    if (typeof fs.unlinkSync !== 'function') fault(503, '原生删除能力不可用，文档未删除。');
    // The caller owns the native SQLite transaction, including all backing
    // parts, the layout marker and the recovery receipt.
    for (const file of layout.files) fs.unlinkSync(file.path);
    const marker = path + '.parts.json';
    if (
      directory(path.slice(0, path.lastIndexOf('/'))).names.has(
        path.slice(path.lastIndexOf('/') + 1) + '.parts.json',
      )
    ) {
      safe(marker);
      fs.unlinkSync(marker);
    }
    reset();
  }
  return { inspect, read, write, remove, reset };
}
