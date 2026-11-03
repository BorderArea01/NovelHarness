import { FORMAT, FILE_LIMIT, digest } from './bundle.mjs';
import {
  BACKUP_LIMIT,
  BACKUP_FILE_COUNT,
  TRANSFER_FILE_LIMIT,
  validRelativePath,
  contentBytes,
  wireBytes,
  sameBytes,
  makeBackup,
} from './backup.mjs';

function validId(id) {
  return typeof id === 'string' && /^b-[a-f0-9]{32}$/.test(id);
}
function fileUrl(path) {
  return `/api/workspace/file?path=${encodeURIComponent(path)}`;
}

export function makeWorkspaceClient(fetcher = fetch) {
  async function call(url, init) {
    const response = await fetcher(url, { ...init, credentials: 'same-origin', redirect: 'error' });
    if (response.status === 401) throw new Error('登录已过期，请重新登录；本地原文件未改动。');
    return response;
  }
  async function readBytes(path, signal) {
    const response = await call(fileUrl(path), { signal });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取工作区失败（HTTP ${response.status}），未视作空数据。`);
    const declared = response.headers.get('content-length');
    if (declared && Number(declared) > TRANSFER_FILE_LIMIT) {
      await response.body?.cancel();
      throw new Error(`文件超过 1 MiB 传输上限（${path}），未生成不完整备份。`);
    }
    const reader = response.body?.getReader(),
      chunks = [];
    let length = 0;
    if (reader)
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > TRANSFER_FILE_LIMIT) {
            await reader.cancel();
            throw new Error(`文件超过 1 MiB 传输上限（${path}），未生成不完整备份。`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    return bytes;
  }
  async function read(path, signal) {
    const bytes = await readBytes(path, signal);
    return bytes === null ? null : new TextDecoder().decode(bytes);
  }
  async function write(path, content, signal) {
    const body = wireBytes(content);
    if (body.length > TRANSFER_FILE_LIMIT) throw new Error('文件超过安全传输长度。');
    const response = await call(fileUrl(path), {
      method: 'PUT',
      body,
      headers: {
        'content-type':
          typeof content === 'string' ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      },
      signal,
    });
    if (!response.ok) throw new Error(`写入工作区失败（HTTP ${response.status}），保留导入进度供重试。`);
    // A success response alone is not proof that the expected text was persisted.
    const saved = await readBytes(path, signal);
    if (!sameBytes(saved, contentBytes(content)))
      throw new Error('写入后校验不一致，导入未完成，未发布小说收据。');
  }
  function parseManifest(text, id) {
    let book;
    try {
      book = JSON.parse(text);
    } catch {
      throw new Error('小说收据损坏，未覆盖原数据。');
    }
    if (
      book.format !== FORMAT ||
      book.id !== id ||
      book.root !== `/workspace/novels/${id}` ||
      !Array.isArray(book.files)
    ) {
      throw new Error('无法识别的小说收据，未覆盖原数据。');
    }
    return book;
  }
  async function scanBook(id, signal) {
    const root = `/workspace/novels/${id}`;
    // ID is validated before interpolation; titles, file paths and content never
    // become shell commands. Do not follow links out of the book directory.
    async function find(type) {
      const response = await call('/api/workspace/exec', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        // Pinned light-shell find supports f/d, not l; its lstat walker exposes
        // symlinks as neither file nor directory, without following their target.
        body: JSON.stringify({
          command: `find ${root} ${type === 'l' ? '! -type f ! -type d' : '-type f'} -print0`,
          cwd: '/workspace',
        }),
      });
      if (!response.ok) throw new Error(`无法扫描本书文件（HTTP ${response.status}）。`);
      const result = await response.json();
      if (
        result.exitCode !== 0 ||
        result.timedOut ||
        result.outputTruncated ||
        typeof result.stdout !== 'string'
      )
        throw new Error('本书文件扫描不完整，备份已停止。');
      if (result.stdout && !result.stdout.endsWith('\0')) throw new Error('本书文件扫描结果不完整。');
      return result.stdout ? result.stdout.slice(0, -1).split('\0') : [];
    }
    if ((await find('l')).length) throw new Error('本书含符号链接，请先在 DSH 中处理；不会读取书外文件。');
    const absolute = await find('f');
    if (!absolute.length || absolute.length > BACKUP_FILE_COUNT)
      throw new Error('本书为空或超过 2048 文件备份上限。');
    const paths = absolute
      .map((path) => {
        if (!path.startsWith(root + '/')) throw new Error('扫描返回了书外路径，备份已停止。');
        const relative = path.slice(root.length + 1);
        if (!validRelativePath(relative)) throw new Error('本书含不支持的文件路径，备份已停止。');
        return relative;
      })
      .sort();
    if (new Set(paths).size !== paths.length || !paths.includes('book.json'))
      throw new Error('本书文件列表或收据无效。');
    return paths;
  }
  async function identity(id, signal) {
    if (!validId(id)) throw new Error('小说标识无效。');
    const response = await call('/api/novels/' + id + '/identity', { signal });
    if (!response.ok) throw new Error(`读取作品身份失败（HTTP ${response.status}），未使用旧书名生成备份。`);
    const value = await response.json();
    if (
      value?.version !== 1 ||
      value.id !== id ||
      value.root !== '/workspace/novels/' + id ||
      typeof value.title !== 'string' ||
      !value.title.trim() ||
      !['workspace', 'receipt'].includes(value.titleSource)
    )
      throw new Error('作品身份来源不一致，未生成备份。');
    return value;
  }
  return {
    identity(id, { signal } = {}) {
      return identity(id, signal);
    },
    readFile(path, { signal } = {}) {
      return readBytes(path, signal);
    },
    async create(bundle, { signal } = {}) {
      const id = bundle?.manifest?.id;
      if (!validId(id)) throw new Error('新建小说标识无效。');
      const response = await call('/api/novels/' + id + '/bootstrap', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(bundle),
      });
      const value = await response.json();
      if (!response.ok)
        throw new Error(value.error || `新建小说失败（HTTP ${response.status}），可安全重试。`);
      const book = parseManifest(JSON.stringify(value.book), id);
      if (book.fingerprint !== bundle.manifest.fingerprint || typeof value.alreadyImported !== 'boolean')
        throw new Error('新建小说收据不一致，未打开其他作品。');
      return { ...value, book };
    },
    async list(signal) {
      const response = await call('/api/novels', { signal });
      if (!response.ok) throw new Error(`无法读取书库（HTTP ${response.status}）。`);
      const result = await response.json();
      if (!Array.isArray(result.books) || result.books.length > 100)
        throw new Error('书库扫描未完整完成，请重试。');
      const books = result.books.map((book) => {
        if (!validId(book?.id)) throw new Error('书库含未知标识，未继续读取。');
        return parseManifest(JSON.stringify(book), book.id);
      });
      if (new Set(books.map((book) => book.id)).size !== books.length)
        throw new Error('书库含重复作品标识。');
      return books;
    },
    async trash({ signal } = {}) {
      const response = await call('/api/novels?trash=1', { signal });
      const value = await response.json();
      if (!response.ok || !Array.isArray(value.books)) throw new Error(value.error || '回收站读取失败。');
      return value.books.map((book) => parseManifest(JSON.stringify(book), book.id));
    },
    async lifecycle(id, data, { signal } = {}) {
      if (!validId(id)) throw new Error('小说标识无效。');
      const response = await call('/api/novels/' + id + '/lifecycle', {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || '书库操作失败，未声称完成。');
      return value;
    },
    async backup(id, { signal, onProgress = () => {} } = {}) {
      if (!validId(id)) throw new Error('小说标识无效。');
      const initialIdentity = await identity(id, signal);
      const root = `/workspace/novels/${id}`,
        paths = await scanBook(id, signal),
        files = [];
      let total = 0;
      for (const path of paths) {
        signal?.throwIfAborted();
        const content = await readBytes(`${root}/${path}`, signal);
        if (content === null) throw new Error('备份期间文件消失，请停止生成后重试。');
        total += content.length;
        if (total > BACKUP_LIMIT) throw new Error('本书超过 64 MiB 备份上限，未下载不完整档案。');
        files.push({ path, content });
        onProgress({ phase: 'read', done: files.length, total: paths.length, path });
      }
      const book = parseManifest(
        new TextDecoder().decode(files.find((file) => file.path === 'book.json').content),
        id,
      );
      if (JSON.stringify(await scanBook(id, signal)) !== JSON.stringify(paths))
        throw new Error('备份期间文件列表发生变化，请停止生成后重试。');
      for (let i = 0; i < files.length; i++) {
        const current = await readBytes(`${root}/${files[i].path}`, signal);
        if (!sameBytes(current, files[i].content))
          throw new Error('备份期间书稿发生变化，请停止生成后重试。');
        onProgress({ phase: 'verify', done: i + 1, total: files.length, path: files[i].path });
      }
      if (JSON.stringify(await scanBook(id, signal)) !== JSON.stringify(paths))
        throw new Error('备份期间文件列表发生变化，请停止生成后重试。');
      signal?.throwIfAborted();
      const backup = await makeBackup({ ...book, title: initialIdentity.title }, files);
      signal?.throwIfAborted();
      const finalIdentity = await identity(id, signal);
      if (
        finalIdentity.title !== initialIdentity.title ||
        finalIdentity.titleSource !== initialIdentity.titleSource
      )
        throw new Error('备份期间书名发生变化，未下载混合版本；请重试。');
      signal?.throwIfAborted();
      return backup;
    },
    async import(bundle, { signal, onProgress = () => {} } = {}) {
      const { manifest, files } = bundle;
      if (
        !validId(manifest.id) ||
        manifest.format !== FORMAT ||
        manifest.root !== `/workspace/novels/${manifest.id}`
      )
        throw new Error('无效的导入包。');
      const root = manifest.root;
      const marker = `${root}/book.json`;
      let existing = await read(marker, signal);
      if (existing !== null) {
        const book = parseManifest(existing, manifest.id);
        if (book.fingerprint !== manifest.fingerprint) throw new Error('项目标识冲突，未覆盖已有小说。');
        return { book, alreadyImported: true };
      }
      if (files.length !== manifest.files.length) throw new Error('导入包文件数量不一致。');
      // Validate the ENTIRE bundle before the first write.
      const paths = new Set();
      for (let index = 0; index < files.length; index++) {
        const file = files[index],
          expected = manifest.files[index];
        if (!validRelativePath(file.path) || file.path === 'book.json' || paths.has(file.path))
          throw new Error('导入路径不安全。');
        paths.add(file.path);
        if (
          file.path !== expected.path ||
          file.sha256 !== expected.sha256 ||
          file.bytes !== expected.bytes ||
          contentBytes(file.content).length !== file.bytes ||
          wireBytes(file.content).length > TRANSFER_FILE_LIMIT ||
          (await digest(file.content)) !== file.sha256
        )
          throw new Error('导入包内容校验失败。');
      }
      const markerText = JSON.stringify(manifest, null, 2);
      if (new TextEncoder().encode(markerText).length > FILE_LIMIT) throw new Error('导入收据过大。');
      for (let index = 0; index < files.length; index++) {
        signal?.throwIfAborted();
        const file = files[index],
          path = `${root}/${file.path}`;
        // Another identical import may have finished while we were uploading.
        existing = await read(marker, signal);
        if (existing !== null) {
          const book = parseManifest(existing, manifest.id);
          if (book.fingerprint !== manifest.fingerprint) throw new Error('项目标识冲突。');
          return { book, alreadyImported: true };
        }
        const saved = await readBytes(path, signal);
        if (saved !== null && !sameBytes(saved, contentBytes(file.content)))
          throw new Error(`发现已有改动（${file.path}），未覆盖；请保留档案后处理。`);
        if (saved === null) await write(path, file.content, signal);
        onProgress({ done: index + 1, total: files.length, path: file.path });
      }
      // Only complete, verified imports become visible in the book list. Failed
      // imports leave their private staging files for an explicit retry, not delete.
      await write(marker, markerText, signal);
      return { book: manifest, alreadyImported: false };
    },
  };
}
