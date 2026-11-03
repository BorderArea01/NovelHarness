// One execution world for the unchanged official bash/search tools and the
// original SQLite VFS. No OS subprocess is spawned with a /workspace cwd.
import { Context } from '@deepseek-ai/cordis';
import { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess';
import { LocalSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-local';
import { Bash, DefenseInDepthBox } from 'just-bash';
import { resolve, basename, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { isVirtualPath } from './storage.mjs';
import { utf8Printf } from './printf-encoding.mjs';

export const name = 'novel-vfs-subprocess';
export const inject = ['novelStorage', 'fs'];

export const createNovelBash = (options = {}) => new Bash({ ...options, customCommands: [utf8Printf] });

export function createShellFilesystem(WorkspaceFsAdapter, facade) {
  // just-bash pipes carry byte-shaped strings. The upstream computer adapter
  // predates that contract and discards encoding options: `cat a > b` then
  // UTF-8 encodes a latin1 byte view a second time, corrupting every CJK glyph.
  // Honor the declared encoding at the boundary, never guess from text content.
  const encoding = (options) => (typeof options === 'string' ? options : options?.encoding) ?? 'utf8';
  const bytes = (content, options) =>
    typeof content === 'string' ? Buffer.from(content, encoding(options)) : content;
  return new (class extends WorkspaceFsAdapter {
    async readFile(path, options) {
      return Buffer.from(await this.readFileBuffer(path)).toString(encoding(options));
    }
    async writeFile(path, content, options) {
      return super.writeFile(path, bytes(content, options));
    }
    async appendFile(path, content, options) {
      return super.appendFile(path, bytes(content, options));
    }
    async stat(path) {
      const value = await super.stat(path);
      const canonical =
        path === '/dev' || path === '/dev/null'
          ? path
          : await (facade.canonicalPath ? facade.canonicalPath(path) : facade.realpath(path));
      return { ...value, identity: 'novel-shell:' + canonical };
    }
    async lstat(path) {
      const value = await super.lstat(path);
      if (value.isSymbolicLink) return { ...value, identity: 'novel-shell-link:' + posix.normalize(path) };
      return this.stat(path);
    }
  })(facade);
}

function virtualSearchArgs(argv, cwd) {
  const out = [];
  let modified = false;
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i];
    // The virtual runner never reads an ambient rg config. just-bash has no
    // --no-config or -- separator; passing either produces exit 1 with an
    // error, which official ripgrep consumers correctly reserve for no-match.
    if (value === '--no-config') continue;
    if (value === '--sort=modified') {
      modified = true;
      continue;
    }
    if (value === '--') {
      out.push(...argv.slice(i + 1).map((path) => posix.resolve(cwd, path)));
      break;
    }
    out.push(value);
  }
  return { args: out, modified };
}

function trustedFilesystem(adapter) {
  // Only the fixed, original VFS provider methods are trusted infrastructure.
  // Do not mark the Bash program or user callbacks as trusted, and do not
  // globally exclude Proxy/import protections merely because Cordis uses Proxy.
  const exposed = Object.create(null);
  for (let proto = adapter; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const key of Object.getOwnPropertyNames(proto)) {
      if (key === 'constructor' || exposed[key] || typeof adapter[key] !== 'function') continue;
      const method = adapter[key].bind(adapter);
      exposed[key] = (...args) => DefenseInDepthBox.runTrusted(() => method(...args));
    }
  }
  return exposed;
}

function outputReader(storage, maxBytes, channel) {
  let bytes = Buffer.alloc(0),
    spillPath;
  return {
    set(value) {
      bytes = Buffer.from(value);
      if (bytes.length > maxBytes) {
        spillPath = '/tmp/novel-jobs/' + randomUUID() + '-' + channel + '.txt';
        storage.fs.mkdirSync('/tmp/novel-jobs', { recursive: true });
        storage.fs.writeFileSync(spillPath, bytes);
      }
    },
    readFrom(fromByte) {
      if (!Number.isSafeInteger(fromByte) || fromByte < 0) throw new Error('Invalid output offset.');
      const first = Math.max(0, bytes.length - maxBytes);
      let start = Math.max(first, Math.min(fromByte, bytes.length));
      // A bounded UTF-8 tail must not begin in a multibyte continuation.
      while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
      return {
        text: bytes.subarray(start).toString('utf8'),
        nextOffset: bytes.length,
        lossy: fromByte < first,
        ...(spillPath ? { spillPath } : {}),
      };
    },
  };
}

export class NovelSubprocess extends SubprocessRuntime {
  constructor(ctx, storage, native, openFilesystem) {
    super(ctx);
    this.storage = storage;
    this.native = native;
    this.openFilesystem = openFilesystem;
    this.live = new Set();
    ctx.effect(() => async () => {
      const owned = [...this.live];
      for (const handle of owned) handle.terminate();
      await Promise.allSettled(owned.map((handle) => handle.done));
    });
  }
  resolveExecutable(command, env, signal) {
    // Nonvirtual host helpers retain the original provider. Search's absolute
    // packaged ripgrep argv is mapped only when the spawn cwd is virtual.
    return this.native.resolveExecutable(command, env, signal);
  }
  terminalEnvironment(signal) {
    return this.native.terminalEnvironment(signal);
  }
  spawnTerminal(spec) {
    throw new Error('An OS terminal is not part of the novel SQLite execution world.');
  }
  spawn(spec) {
    if (!isVirtualPath(spec.cwd)) throw new Error('Process cwd is outside the novel SQLite execution world.');
    spec.signal?.throwIfAborted();
    const program = basename(spec.argv[0]).toLowerCase();
    let command, args, search;
    if (program === 'bash' && spec.argv[1] === '-c' && spec.argv.length === 3) command = spec.argv[2];
    else if (program === 'rg' || program === 'rg.exe') {
      command = 'rg';
      search = virtualSearchArgs(spec.argv.slice(1), spec.cwd);
      args = search.args;
    } else throw new Error('No virtual executable adapter for ' + program);
    for (const stream of ['stdout', 'stderr'])
      if (!spec.stdio[stream] || typeof spec.stdio[stream] !== 'object')
        throw new Error('Virtual commands require collected output.');
    const stdout = outputReader(this.storage, spec.stdio.stdout.maxBytes, 'stdout');
    const stderr = outputReader(this.storage, spec.stdio.stderr.maxBytes, 'stderr');
    const controller = new AbortController();
    const abort = () => controller.abort(spec.signal.reason);
    spec.signal?.addEventListener('abort', abort, { once: true });
    let settled = false;
    const handle = {
      collected: { stdout, stderr },
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      control: undefined,
      terminate() {
        if (!settled) controller.abort(new Error('Virtual command stopped'));
      },
      async waitForExit(signal) {
        if (settled) return true;
        if (signal?.aborted) return false;
        let listener;
        try {
          return await Promise.race([
            handle.done.then(
              () => true,
              () => true,
            ),
            new Promise((resolve) => {
              if (signal) {
                listener = () => resolve(false);
                signal.addEventListener('abort', listener, { once: true });
              }
            }),
          ]);
        } finally {
          if (listener) signal.removeEventListener('abort', listener);
        }
      },
    };
    handle.done = Promise.resolve().then(async () => {
      const filesystem = this.openFilesystem();
      try {
        controller.signal.throwIfAborted();
        const result = await createNovelBash({
          fs: filesystem.adapter,
          cwd: spec.cwd,
          defenseInDepth: { enabled: 'auto' },
          executionLimitProfile: 'hardened',
          // Match the existing worker-shell bound, rather than an unbounded
          // process output allocation in the Node host.
          executionLimits: { maxOutputSize: 8 * 1024 * 1024 },
        }).exec(command, {
          cwd: spec.cwd,
          env: spec.env ?? {},
          replaceEnv: true,
          signal: controller.signal,
          ...(args ? { args } : {}),
          ...(spec.stdio.stdin && typeof spec.stdio.stdin === 'object'
            ? {
                stdin:
                  typeof spec.stdio.stdin.data === 'string'
                    ? spec.stdio.stdin.data
                    : Buffer.from(spec.stdio.stdin.data).toString('latin1'),
                stdinKind: typeof spec.stdio.stdin.data === 'string' ? 'text' : 'bytes',
              }
            : {}),
        });
        controller.signal.throwIfAborted();
        filesystem.commit();
        if (search?.modified && result.exitCode === 0) {
          const rows = result.stdout
            .split('\n')
            .filter(Boolean)
            .map((path) => ({ path, time: this.storage.fs.statSync(posix.resolve(spec.cwd, path)).mtimeMs }));
          rows.sort((a, b) => a.time - b.time || a.path.localeCompare(b.path));
          result.stdout = rows.map((row) => row.path).join('\n') + (rows.length ? '\n' : '');
        }
        // Unlike native rg, this interpreter uses 1 for option/regex failures
        // too. Preserve real failures instead of turning them into no-match.
        if (search && result.exitCode === 1 && result.stderr.trim()) result.exitCode = 2;
        stdout.set(result.stdout);
        stderr.set(result.stderr);
        return controller.signal.aborted
          ? { exitCode: null, signal: 'SIGTERM' }
          : { exitCode: result.exitCode, signal: null };
      } catch (error) {
        if (controller.signal.aborted) return { exitCode: null, signal: 'SIGTERM' };
        throw error;
      } finally {
        settled = true;
        spec.signal?.removeEventListener('abort', abort);
        this.live.delete(handle);
      }
    });
    this.live.add(handle);
    return handle;
  }
}

export function createManuscriptShell(storage, fs, WorkspaceFilesystem, WorkspaceFsAdapter) {
  const facade = new WorkspaceFilesystem(storage.db);
  const empty = new Map();
  const flush = (paths = [...empty.keys()]) =>
    storage.db.transactionSync(() => {
      for (const path of paths) {
        const item = empty.get(path);
        if (!item) continue;
        fs.mutate(
          item.target,
          '',
          item.version === undefined
            ? { kind: 'createIfAbsent' }
            : { kind: 'replaceIfVersion', version: item.version },
        );
      }
      for (const path of paths) empty.delete(path);
    });
  // Interpreter-internal metadata probes (/, /usr/bin, etc.) still go ONLY to
  // the unchanged SQLite facade. They are not physical host filesystem access.
  const canonical = async (path) =>
    isVirtualPath(path) ? fs.path(await fs.resolve(path)) : posix.resolve('/', path);
  // just-bash refuses cp when an external provider cannot establish file
  // identity. Use canonical VFS targets, not the logical-doc inode placeholder
  // (zero), so two chapters differ and a symlink alias is the SAME document.
  facade.canonicalPath = async (path) => 'novel-vfs:' + (await canonical(path));
  // The upstream shell adapter sees logical manuscript documents as well as
  // ordinary VFS files, exactly like the official generic read/write tools.
  const read = facade.readFile.bind(facade),
    write = facade.writeFile.bind(facade);
  const stat = facade.stat.bind(facade),
    lstat = facade.lstat.bind(facade);
  facade.readFile = async (path, options) => {
    path = await canonical(path);
    const doc = empty.has(path) ? { text: '' } : fs.readDocument(path);
    if (!doc) return read(path, options);
    return (typeof options === 'string' ? options : options?.encoding) === 'utf8'
      ? Promise.resolve(doc.text)
      : Promise.resolve(new Blob([doc.text]).stream());
  };
  facade.writeFile = async (path, content, options) => {
    if (!isVirtualPath(path)) return write(path, content, options);
    const target = await fs.resolve(path);
    path = fs.path(target);
    if (!fs.document(path)) return write(path, content, options);
    let value;
    try {
      value =
        typeof content === 'string'
          ? content
          : new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(content);
      // A shell opens `> manuscript` by truncating it BEFORE it produces bytes.
      // Defer that provisional empty write within THIS command only. Invalid
      // bytes/oversize/cancellation cannot leave the live manuscript empty.
      if (!value.length) {
        if (!empty.has(path)) empty.set(path, { target, version: fs.version(path) });
        return;
      }
      const provisional = empty.get(path);
      const outcome = fs.mutate(
        target,
        value,
        !provisional
          ? undefined
          : provisional.version === undefined
            ? { kind: 'createIfAbsent' }
            : { kind: 'replaceIfVersion', version: provisional.version },
      );
      empty.delete(path);
      return outcome;
    } catch (error) {
      empty.delete(path);
      if (error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA')
        throw new Error('写入内容不是有效 UTF-8，原稿未修改；请保留原始文件，不要重复转码。');
      throw error;
    }
  };
  facade.stat = async (path) => {
    path = await canonical(path);
    const doc = empty.has(path) ? { text: '', updatedAt: Date.now() } : fs.readDocument(path);
    if (!doc) return stat(path);
    return {
      name: posix.basename(path),
      inode: 0,
      mode: 420,
      mtime: doc.updatedAt,
      size: Buffer.byteLength(doc.text),
      isFile: true,
      isDirectory: false,
      isSymbolicLink: false,
    };
  };
  facade.lstat = async (path) => {
    try {
      const raw = await lstat(path);
      if (raw.isSymbolicLink) return raw;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    return facade.stat(path);
  };
  facade.statOrNull = async (path) => {
    try {
      return await facade.stat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  facade.lstatOrNull = async (path) => {
    try {
      return await facade.lstat(path);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  facade.exists = async (path) => (await facade.statOrNull(path)) !== null;
  const rename = facade.rename.bind(facade),
    rm = facade.rm.bind(facade),
    readdir = facade.readdir.bind(facade);
  facade.rename = async (src, dest) => {
    flush([await canonical(src), await canonical(dest)]);
    return rename(src, dest);
  };
  facade.rm = async (path, options) => {
    const key = await canonical(path),
      pending = empty.get(key);
    empty.delete(key);
    if (pending?.version === undefined && pending) return;
    return rm(path, options);
  };
  facade.readdir = async (path) => {
    const entries = await readdir(path),
      parent = await canonical(path);
    for (const key of empty.keys())
      if (posix.dirname(key) === parent && !entries.some((e) => e.name === posix.basename(key)))
        entries.push({ name: posix.basename(key), isFile: true, isDirectory: false, isSymbolicLink: false });
    return entries;
  };
  return { adapter: trustedFilesystem(createShellFilesystem(WorkspaceFsAdapter, facade)), commit: flush };
}

export async function apply(ctx) {
  const storage = ctx.get('novelStorage'),
    fs = ctx.get('fs');
  storage.fs.mkdirSync('/tmp', { recursive: true });
  const { WorkspaceFilesystem, WorkspaceFsAdapter } = await import(
    pathToFileURL(resolve('data/official-validation/integration/vfs.mjs'))
  );
  const local = new Context();
  try {
    await local.plugin(LocalSubprocessRuntime).await();
    new NovelSubprocess(ctx, storage, local.get('subprocess'), () =>
      createManuscriptShell(storage, fs, WorkspaceFilesystem, WorkspaceFsAdapter),
    );
    ctx.effect(() => async () => {
      await local.fiber.dispose();
    });
  } catch (error) {
    await local.fiber.dispose();
    throw error;
  }
}
