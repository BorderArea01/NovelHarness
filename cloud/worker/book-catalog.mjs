import { createHash } from 'node:crypto';
import { DocumentError } from './novel-documents.mjs';

// A view/transaction over the ORIGINAL native VFS, not another book store.
const BASE = '/workspace/novels';
export const BOOTSTRAP_LIMIT = 256 * 1024;
const INITIAL_FILES = new Set([
  'setting.md',
  'seed.md',
  'outline.json',
  'canon.json',
  'memory.json',
  'rules.json',
  'chapter-index.json',
  'archive/source.json',
]);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => {
  throw new DocumentError(status, message);
};
function safe(fs, path, missing = false) {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += '/' + part;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (missing && error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      fail(409, '书库含链接，未读取或覆盖书外数据。');
    if (current !== path && !stat.isDirectory()) fail(409, '小说父路径不是目录。');
  }
  return true;
}
function receipt(fs, root, id) {
  const path = root + '/book.json';
  if (!safe(fs, path, true)) return null;
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.size > 512 * 1024) fail(409, '小说收据无效，未忽略已有作品。');
  let book;
  try {
    book = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path)));
  } catch {
    fail(409, '小说收据损坏，未覆盖原数据。');
  }
  if (
    book?.format !== 'novel-harness-book-v1' ||
    book.id !== id ||
    book.root !== root ||
    !Array.isArray(book.files)
  )
    fail(409, '小说收据不匹配，未覆盖原数据。');
  return book;
}

export function listBooks(fs, db) {
  return db.transactionSync(() => {
    if (!safe(fs, BASE, true)) return { books: [] };
    const books = [];
    for (const id of fs.readdirSync(BASE).sort()) {
      if (!/^b-[a-f0-9]{32}$/.test(id)) continue;
      const root = BASE + '/' + id;
      safe(fs, root);
      if (!fs.lstatSync(root).isDirectory()) continue;
      const book = receipt(fs, root, id);
      if (book) books.push(book); // An unfinished legacy import has no receipt.
      if (books.length > 100) fail(413, '书库超过本版 100 本列表上限，数据未删除。');
    }
    return { books };
  });
}

export function bootstrapBook(fs, db, id, input) {
  const { manifest, files } = input;
  const root = BASE + '/' + id;
  if (
    !/^b-[a-f0-9]{32}$/.test(id) ||
    manifest?.id !== id ||
    manifest.root !== root ||
    manifest.format !== 'novel-harness-book-v1' ||
    !/^[a-f0-9]{64}$/.test(manifest.fingerprint ?? '') ||
    id !== 'b-' + manifest.fingerprint.slice(0, 32) ||
    typeof manifest.title !== 'string' ||
    !manifest.title.trim() ||
    manifest.title.length > 200 ||
    !Array.isArray(files) ||
    files.length !== INITIAL_FILES.size ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== files.length ||
    Object.values(manifest.stats ?? {}).length !== 5 ||
    Object.values(manifest.stats).some((value) => value !== 0)
  )
    fail(400, '新建小说数据无效，请勿用新建接口迁移已有作品。');
  const paths = new Set();
  let total = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i],
      meta = manifest.files[i];
    if (!file || !INITIAL_FILES.has(file.path) || paths.has(file.path) || typeof file.content !== 'string')
      fail(400, '新建小说路径无效。');
    paths.add(file.path);
    const bytes = new TextEncoder().encode(file.content);
    total += bytes.length;
    if (
      total > BOOTSTRAP_LIMIT ||
      bytes.length !== file.bytes ||
      sha(bytes) !== file.sha256 ||
      meta?.path !== file.path ||
      meta.sha256 !== file.sha256 ||
      meta.bytes !== file.bytes
    )
      fail(400, '新建小说校验失败，未写入任何文件。');
  }
  const marker = JSON.stringify(manifest, null, 2);
  if (new TextEncoder().encode(marker).length > BOOTSTRAP_LIMIT) fail(413, '新建小说收据过大。');
  return db.transactionSync(() => {
    const existing = receipt(fs, root, id);
    if (existing) {
      if (existing.fingerprint !== manifest.fingerprint) fail(409, '小说标识冲突，未覆盖已有作品。');
      return { book: existing, alreadyImported: true };
    }
    if (safe(fs, root, true)) fail(409, '该目录已有未完成数据，未覆盖；请保留档案后处理。');
    for (const file of files) {
      const target = root + '/' + file.path;
      safe(fs, target, true);
      fs.mkdirSync(target.slice(0, target.lastIndexOf('/')), { recursive: true });
      fs.writeFileSync(target, file.content);
      if (sha(fs.readFileSync(target)) !== file.sha256) fail(409, '新建小说保存校验不一致，事务已撤销。');
    }
    // Receipt LAST, within the same original durable transaction. Abort/network
    // retry is idempotent even when the browser misses the committed response.
    fs.writeFileSync(root + '/book.json', marker);
    if (sha(fs.readFileSync(root + '/book.json')) !== sha(marker)) fail(409, '小说收据保存失败。');
    return { book: manifest, alreadyImported: false };
  });
}
