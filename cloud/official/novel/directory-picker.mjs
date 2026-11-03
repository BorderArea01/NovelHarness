// Preserve the official in-app folder browser, using the SAME SQLite owner.
// The stock Node browser traverses/creates physical host directories directly.
import { DirectoryPicker, DirectoryPickerError } from '@deepseek-ai/dsh-host-directory-picker';
import { posix } from 'node:path';
import { isVirtualPath } from './storage.mjs';

export const name = 'novel-vfs-directory-picker';
export const inject = ['fs', 'novelStorage'];
export class NovelDirectoryPicker extends DirectoryPicker {
  constructor(ctx) {
    super(ctx);
    this.browse = Object.freeze({
      kind: 'browse',
      list: (path, signal) => this.list(path, signal),
      createDirectory: (path, name) => this.createDirectory(path, name),
    });
  }
  capability() {
    return this.browse;
  }
  async directory(path, signal) {
    if (!isVirtualPath(path)) throw new Error('Directory is outside the SQLite execution world.');
    const target = await this.ctx.fs.resolve(path, { signal });
    const info = await this.ctx.fs.stat(target, signal);
    if (info?.type !== 'directory') throw new Error('Directory does not exist.');
    return target;
  }
  async list(path = '/workspace', signal) {
    try {
      signal?.throwIfAborted();
      const target = await this.directory(path, signal);
      const canonical = this.ctx.fs.processPath(target);
      const entries = [];
      let truncated = false;
      for (const entry of await this.ctx.fs.listDir(target, signal)) {
        signal?.throwIfAborted();
        let child;
        try {
          child = await this.directory(posix.join(canonical, entry.name), signal);
        } catch {
          signal?.throwIfAborted();
          continue;
        }
        if (entries.length === 1000) {
          truncated = true;
          break;
        }
        entries.push({
          name: entry.name,
          path: this.ctx.fs.processPath(child),
          hidden: entry.name.startsWith('.'),
        });
      }
      const crumbs = [];
      for (let current = canonical; isVirtualPath(current); current = posix.dirname(current))
        crumbs.unshift({
          name: posix.basename(current),
          path: current,
          hidden: posix.basename(current).startsWith('.'),
        });
      return { path: canonical, home: '/workspace', crumbs, entries, truncated };
    } catch (error) {
      signal?.throwIfAborted();
      throw new DirectoryPickerError(
        'directory-unreadable',
        path,
        'Cannot browse this directory in the novel workspace.',
      );
    }
  }
  async createDirectory(path, name) {
    try {
      if (
        typeof name !== 'string' ||
        !name.trim() ||
        name === '.' ||
        name === '..' ||
        /[/\\\u0000-\u001f]/.test(name)
      )
        throw new Error('Not a single directory segment.');
      const parent = await this.directory(path);
      const child = await this.ctx.fs.resolve(posix.join(this.ctx.fs.processPath(parent), name));
      const canonical = this.ctx.fs.processPath(child);
      this.ctx.novelStorage.db.transactionSync(() => this.ctx.novelStorage.fs.mkdirSync(canonical));
      return canonical;
    } catch (error) {
      throw new DirectoryPickerError(
        error.code === 'EEXIST' ? 'directory-exists' : 'directory-create-failed',
        path,
        error.code === 'EEXIST'
          ? 'Directory already exists.'
          : 'Cannot create this directory in the novel workspace.',
      );
    }
  }
}
export function apply(ctx) {
  new NovelDirectoryPicker(ctx);
}
