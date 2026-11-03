// Official DSH FileSystem service over the original SQLite VFS. The web
// execution world never falls back to physical files on the development PC.
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs';
import { posix, resolve as hostResolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { initializeNovelStorage, isVirtualPath, canonicalVirtualPath } from './storage.mjs';

export const name = 'novel-sqlite-filesystem';
const virtual = isVirtualPath;
const prefix = 'novel-vfs:';
const outside = () => {
  throw new FsError('Path is outside the novel SQLite execution world', 'FS_OUTSIDE_WORKSPACE');
};
const sha = (text) => createHash('sha256').update(text).digest('hex');
// Match dsh-fs-local's edit/diff contract. Only CRLF pairs are normalized;
// other whitespace, punctuation, BOM and lone CR characters remain literal.
const normalizeLines = (value) => value.replaceAll('\r\n', '\n');
const lineStyle = (value) => {
  const sample = value.slice(0, 4096);
  const crlf = sample.split('\r\n').length - 1;
  return crlf > sample.split('\n').length - 1 - crlf ? 'CRLF' : 'LF';
};
const aborted = (signal) => {
  if (signal?.aborted) throw new FsError('Filesystem operation aborted', 'FS_ABORTED');
};
const text = (bytes) => {
  if (bytes.subarray(0, 8192).includes(0)) throw new FsError('Binary file is not UTF-8 text', 'FS_NOT_TEXT');
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new FsError('Invalid UTF-8 text', 'FS_NOT_TEXT');
  }
};

export class NovelFileSystem extends FileSystem {
  constructor(ctx, storage, documents) {
    super(ctx);
    this.storage = storage;
    this.documents = documents;
  }
  isVirtual(target) {
    return String(target.targetKey).startsWith(prefix);
  }
  path(target) {
    return String(target.targetKey).slice(prefix.length);
  }
  async resolve(path, options = {}) {
    aborted(options.signal);
    if (typeof path !== 'string' || !path.trim() || path.includes('\0'))
      throw new FsError('Invalid file path', 'FS_NOT_FOUND');
    const cwd = options.cwd ?? '/workspace';
    if (!virtual(path) && (posix.isAbsolute(path) || /^[a-zA-Z]:[\\/]/.test(path) || !virtual(cwd)))
      outside();
    let value = posix.resolve(cwd, path);
    if (!virtual(value))
      throw new FsError('Virtual path escaped the mapped VFS roots', 'FS_OUTSIDE_WORKSPACE');
    // Realpath the deepest existing parent too: an absent leaf through a
    // symlink must have the same target identity/history as its canonical path.
    value = canonicalVirtualPath(value, this.storage, true);
    if (!virtual(value))
      throw new FsError('Virtual symlink escaped the mapped VFS roots', 'FS_OUTSIDE_WORKSPACE');
    return { targetKey: FsTargetKey(prefix + value), displayPath: value };
  }
  processPath(target) {
    if (!this.isVirtual(target)) outside();
    return this.path(target);
  }
  processPathFromHostPath(_path) {
    // A host bootstrap file cannot be executed in the virtual world by passing
    // its Windows path through. Consumers must supply a mapped implementation.
    return undefined;
  }
  fileUrl(target) {
    if (!this.isVirtual(target)) outside();
    return 'file://' + this.path(target).split('/').map(encodeURIComponent).join('/');
  }
  contains(parent, child) {
    if (this.isVirtual(parent) !== this.isVirtual(child)) return false;
    if (!this.isVirtual(parent)) return false;
    const base = this.path(parent),
      path = this.path(child);
    return path === base || path.startsWith(base + '/');
  }
  document(path) {
    const match = /^\/workspace\/novels\/(b-[a-f0-9]{32})\/(.+)$/.exec(path);
    if (!match || !this.documents.documentPath(match[2])) return null;
    return {
      service: this.documents.makeDocumentService(this.storage.fs, this.storage.db, match[1]),
      relative: match[2],
    };
  }
  readDocument(path) {
    const item = this.document(path);
    if (!item) return null;
    try {
      return item.service.run({ kind: 'read', path: item.relative });
    } catch (error) {
      if (error.status === 404 || error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  info(path, noFollow = false) {
    try {
      const value = noFollow ? this.storage.fs.lstatSync(path) : this.storage.fs.statSync(path);
      const rev = this.storage.db.scalar('SELECT rev FROM vfs_nodes WHERE inode=?', value.ino);
      return {
        version: FsVersion(`vfs:${value.ino}:${rev}:${value.size}`),
        size: value.size,
        type: value.isSymbolicLink()
          ? 'symlink'
          : value.isFile()
            ? 'file'
            : value.isDirectory()
              ? 'directory'
              : 'other',
      };
    } catch (error) {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    }
  }
  async stat(target, signal) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    const path = this.path(target),
      doc = this.readDocument(path);
    if (doc)
      return { type: 'file', size: Buffer.byteLength(doc.text), version: FsVersion('doc:' + doc.hash) };
    if (doc === undefined) return undefined;
    return this.info(path);
  }
  async lstat(path, options = {}, signal) {
    const target = await this.resolve(path, { ...options, signal });
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    const rawPath = posix.resolve(options.cwd ?? '/workspace', path);
    const info = this.info(rawPath, true);
    if (info?.type === 'symlink') return info;
    return this.stat(target, signal);
  }
  bytes(target) {
    const path = this.path(target),
      doc = this.readDocument(path);
    if (doc) return Buffer.from(doc.text);
    if (doc === undefined) throw new FsError('File does not exist', 'FS_NOT_FOUND');
    try {
      return this.storage.fs.readFileSync(path);
    } catch (error) {
      throw new FsError(
        error.code === 'ENOENT' ? 'File does not exist' : 'File cannot be read',
        error.code === 'ENOENT' ? 'FS_NOT_FOUND' : 'FS_IO_ERROR',
      );
    }
  }
  async readText(target, signal) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    return text(this.bytes(target));
  }
  async streamText(target, signal) {
    if (!this.isVirtual(target)) outside();
    const content = await this.readText(target, signal);
    return (async function* () {
      for (let at = 0; at < content.length; at += 16384) {
        aborted(signal);
        yield content.slice(at, at + 16384);
      }
    })();
  }
  async readBytes(target, signal, maxBytes) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new FsError('Invalid byte bound', 'FS_TOO_LARGE');
    const info = await this.stat(target, signal);
    if (!info) throw new FsError('File does not exist', 'FS_NOT_FOUND');
    if (info.size > maxBytes) throw new FsError('File exceeds byte bound', 'FS_TOO_LARGE');
    const data = this.bytes(target);
    if (data.length > maxBytes) throw new FsError('File exceeds byte bound', 'FS_TOO_LARGE');
    return data;
  }
  async readByteRange(target, range, signal) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    if (
      ![range.offset, range.length].every((n) => Number.isSafeInteger(n) && n >= 0) ||
      range.length > 8 * 1024 * 1024
    )
      throw new FsError('Invalid byte range', 'FS_TOO_LARGE');
    const doc = this.readDocument(this.path(target));
    if (doc) return Buffer.from(doc.text).subarray(range.offset, range.offset + range.length);
    const fd = this.storage.fs.openSync(this.path(target), 'r');
    try {
      const out = Buffer.alloc(range.length);
      const read = this.storage.fs.readSync(fd, out, 0, out.length, range.offset);
      return out.subarray(0, read);
    } finally {
      this.storage.fs.closeSync(fd);
    }
  }
  async listDir(target, signal) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    return this.storage.fs
      .readdirSync(this.path(target))
      .sort()
      .map((name) => {
        const path = posix.join(this.path(target), name),
          info = this.info(path);
        return { name, ...info, target: { targetKey: FsTargetKey(prefix + path), displayPath: path } };
      });
  }
  version(path) {
    const doc = this.readDocument(path);
    return doc ? FsVersion('doc:' + doc.hash) : this.info(path)?.version;
  }
  mutate(target, content, expected, signal) {
    return this.storage.db.transactionSync(() => {
      aborted(signal);
      const path = this.path(target),
        version = this.version(path);
      if (expected?.kind === 'createIfAbsent' && version !== undefined)
        throw new FsError('File already exists', 'FS_NOT_OBSERVED');
      if (expected?.kind === 'replaceIfVersion' && version !== expected.version)
        throw new FsError('File version changed', 'FS_STALE_VERSION');
      const doc = this.document(path),
        before = version === undefined ? null : text(this.bytes(target));
      if (doc)
        doc.service.run({
          kind: 'save',
          path: doc.relative,
          text: content,
          expectedHash: before === null ? null : sha(before),
        });
      else {
        this.storage.fs.mkdirSync(posix.dirname(path), { recursive: true });
        this.storage.fs.writeFileSync(path, content);
      }
      return {
        operation: before === null ? 'create' : 'update',
        before: before === null ? null : normalizeLines(before),
        after: normalizeLines(content),
        version: this.version(path),
      };
    });
  }
  async writeText(target, content, expected, signal, policy) {
    if (!this.isVirtual(target)) outside();
    return this.mutate(target, content, expected, signal);
  }
  async editText(target, edit, expected, signal, policy) {
    if (!this.isVirtual(target)) outside();
    return this.storage.db.transactionSync(() => {
      aborted(signal);
      const version = this.version(this.path(target));
      if (version === undefined || (expected && expected.version !== version))
        throw new FsError('File version changed', 'FS_STALE_VERSION');
      const raw = text(this.bytes(target));
      const before = normalizeLines(raw);
      const oldString = normalizeLines(edit.oldString);
      const newString = normalizeLines(edit.newString);
      if (!oldString) throw new FsError('old_string must be non-empty', 'FS_EDIT_NOT_FOUND');
      const matches = before.split(oldString).length - 1;
      if (!matches)
        throw new FsError(
          'old_string was not found in "' +
            target.displayPath +
            '"; no change was made. Re-read the current file and copy the exact text without line-number prefixes before retrying.',
          'FS_EDIT_NOT_FOUND',
        );
      if (matches > 1 && !edit.replaceAll)
        throw new FsError(
          'old_string matched ' +
            matches +
            ' times; include more exact context or explicitly set replace_all. No change was made.',
          'FS_AMBIGUOUS_EDIT',
        );
      const after = edit.replaceAll
        ? before.split(oldString).join(newString)
        : before.replace(oldString, () => newString);
      const stored = lineStyle(raw) === 'CRLF' ? after.replaceAll('\n', '\r\n') : after;
      const outcome = this.mutate(target, stored, { kind: 'replaceIfVersion', version }, signal);
      // FsEditOutcome is NOT FsWriteOutcome: the original edit tool's strict
      // output schema forbids `operation`. Returning it reports failure AFTER
      // the transaction committed and induces retries against already-edited text.
      return { before, after, version: outcome.version };
    });
  }
  async watch(target, changed, signal) {
    if (!this.isVirtual(target)) outside();
    aborted(signal);
    const handle = this.storage.fs.watch(this.path(target), { signal });
    handle.on('change', () => changed());
    handle.on('error', (error) => changed(error));
    return async () => handle.close();
  }
}

export async function apply(ctx, config) {
  const storage = await initializeNovelStorage(config.sqlite);
  try {
    const documents = await import(
      pathToFileURL(hostResolve('data/official-validation/integration/baseline/worker/novel-documents.mjs'))
    );
    new NovelFileSystem(ctx, storage, documents);
    ctx.provide('novelStorage', storage);
    ctx.effect(() => async () => {
      storage.close();
    });
  } catch (error) {
    storage.close();
    throw error;
  }
}
