// Entire book trees move atomically in the SAME original SQLite VFS. No shell,
// recursive delete, second database, copied manuscript or automatic data purge.
import { createHash } from 'node:crypto';
import { bootstrapBook } from './book-catalog.mjs';
import { DocumentError } from './novel-documents.mjs';
const BASE = '/workspace/novels';
const TRASH = '/workspace/.novel-trash/books';
const fail = (status, message) => {
  throw new DocumentError(status, message);
};
function exists(fs, path) {
  try {
    fs.lstatSync(path);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false;
    throw e;
  }
}
function safe(fs, path) {
  let current = '';
  for (const part of path.split('/').filter(Boolean)) {
    current += '/' + part;
    if (!exists(fs, current)) continue;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
      fail(409, '本书含链接，未移动或读取书外资料。');
    if (current !== path && !stat.isDirectory()) fail(409, '书库路径不是目录。');
  }
}
function inspectTree(fs, dir, id) {
  safe(fs, dir);
  if (!exists(fs, dir)) fail(404, '小说不存在或已移入回收站。');
  const hash = createHash('sha256');
  let files = 0,
    bytes = 0,
    entries = 0;
  const counts = { chapters: 0, drafts: 0, notes: 0, histories: 0 };
  function walk(path, relative) {
    if (++entries > 8192) fail(413, '本书文件过多，未进行不完整操作。');
    safe(fs, path);
    const stat = fs.lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(JSON.stringify(['directory', relative]));
      for (const name of fs.readdirSync(path).sort()) {
        if (!name || /[\/\\\u0000-\u001f]/.test(name) || name === '.' || name === '..')
          fail(409, '书内路径无效。');
        walk(path + '/' + name, relative ? relative + '/' + name : name);
      }
    } else if (stat.isFile()) {
      if (++files > 2048 || (bytes += stat.size) > 64 * 1024 * 1024)
        fail(413, '本书超过安全核对上限，原数据保留。');
      const content = fs.readFileSync(path);
      if (content.length !== stat.size) fail(409, '核对期间本书有更新，请重新核对。');
      hash.update(JSON.stringify(['file', relative, content.length]));
      hash.update(content);
      if (relative.startsWith('chapters/')) counts.chapters++;
      if (relative.startsWith('drafts/')) counts.drafts++;
      if (relative.startsWith('notes/')) counts.notes++;
      if (relative.startsWith('.novel-history/')) counts.histories++;
    } else fail(409, '本书含不支持的节点，未移动。');
  }
  walk(dir, '');
  const book = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(dir + '/book.json')),
  );
  if (book.format !== 'novel-harness-book-v1' || book.id !== id || book.root !== BASE + '/' + id)
    fail(409, '小说收据不匹配，未移动。');
  return { book, revision: hash.digest('hex'), files, bytes, counts };
}
export function listTrashedBooks(fs, db) {
  return db.transactionSync(() => {
    safe(fs, TRASH);
    if (!exists(fs, TRASH)) return { books: [] };
    const books = [];
    for (const id of fs.readdirSync(TRASH).sort()) {
      if (!/^b-[a-f0-9]{32}$/.test(id)) continue;
      // Listing does not hash/scan every archived tree. Full verification only
      // occurs for the selected preview/restore, never on a polling timer.
      const dir = TRASH + '/' + id;
      safe(fs, dir + '/book.json');
      const book = JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(dir + '/book.json')),
      );
      if (book.id !== id || book.root !== BASE + '/' + id || book.format !== 'novel-harness-book-v1')
        fail(409, '回收站收据异常，未当成空书库。');
      books.push(book);
      if (books.length > 100) fail(413, '回收站超过100本显示上限，数据未删除。');
    }
    return { books };
  });
}
export function manageBook(fs, db, id, input, { isGenerating = () => false } = {}) {
  if (!/^b-[a-f0-9]{32}$/.test(id)) fail(400, '小说标识无效。');
  if (!input || !['inspect', 'delete', 'restore', 'restart'].includes(input.action))
    fail(400, '书库操作无效。');
  const active = BASE + '/' + id,
    archived = TRASH + '/' + id;
  return db.transactionSync(() => {
    const trashed = input.trashed === true || input.action === 'restore';
    const dir = trashed ? archived : active;
    const tree = inspectTree(fs, dir, id);
    const generating = isGenerating();
    if (input.action === 'inspect') return { ...tree, trashed, generating };
    if (generating) fail(409, '本书 AI 正在生成；请结束或停止后重新核对，未中断或删除。');
    if (input.expectedRevision !== tree.revision) fail(409, '本书已更新，请重新核对后确认；未移动。');
    const target = input.action === 'restore' ? active : archived;
    safe(fs, target);
    if (exists(fs, target)) fail(409, '目标目录已有内容，未覆盖；请保留两边数据后处理。');
    if (input.action === 'restore') {
      fs.mkdirSync(BASE, { recursive: true });
      fs.renameSync(archived, active);
      return { restored: true, book: tree.book };
    }
    let next;
    if (input.action === 'restart') {
      const bundle = input.bundle;
      if (!/^b-[a-f0-9]{32}$/.test(bundle?.manifest?.id ?? '') || bundle.manifest.id === id)
        fail(400, '重新开始必须使用独立新书标识。');
      if (exists(fs, BASE + '/' + bundle.manifest.id)) fail(409, '新书标识已存在，未覆盖。');
      // The bootstrap validator checks all supplied bytes/hashes/paths. Nested
      // native transactions roll back BOTH the new book and old-tree move.
      next = bootstrapBook(fs, db, bundle.manifest.id, bundle).book;
      if (next.stats.chapters !== 0 || next.stats.chats !== 0) fail(400, '重新开始必须为空白小说。');
    }
    fs.mkdirSync(TRASH, { recursive: true });
    fs.renameSync(active, archived);
    return { deleted: true, archivedBook: tree.book, ...(next ? { book: next, restarted: true } : {}) };
  });
}
