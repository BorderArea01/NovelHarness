// Explicit compatibility patch for the isolated OFFICIAL Node host. Its stock
// path admission assumes every cwd is a physical host path. /workspace and /tmp
// resolves through the registered SQLite provider. A web operator does not gain
// an implicit Windows directory-creation/opener capability from this migration.
// Apply this BEFORE dsh-purge's backup/apply, so Restore preserves novel support.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const VIRTUAL_BASH_FACTS =
  '小说工作区是 SQLite 虚拟 Bash，不提供 Python、Node、Perl 或 PowerShell；常用内建命令可用。草稿字数与最新 hash 使用 novel_proposal_inspect。';
export function patchVirtualBashFacts(source) {
  const marker = '// novel-host-vfs-bash-description-v1';
  if (source.includes(marker)) return source;
  const before = 'description: bashDescription(),';
  if (source.split(before).length !== 2) throw new Error('Official bash description seam changed.');
  return (
    marker +
    '\n' +
    source.replace(
      before,
      'description: bashDescription() + ' + JSON.stringify('\n' + VIRTUAL_BASH_FACTS) + ',',
    )
  );
}

export function patchFileMutationCounts(source) {
  const marker = '// novel-host-vfs-mutation-counts-v1';
  if (source.includes(marker)) return source;
  for (const before of [
    'text: formatWriteOutput(value.path, value)',
    'text: formatEditOutput(value.path, args.replace_all ?? false)',
  ]) {
    if (source.split(before).length !== 2)
      throw new Error('Official file mutation presentation seam changed.');
    source = source.replace(
      before,
      before + ' + "\\ncharacters (editor, excluding whitespace): " + value.after.replace(/\\s/g, "").length',
    );
  }
  return marker + '\n' + source;
}

export async function installHostCompatibility() {
  const moduleRoot = resolve('cloud/official/node_modules/@deepseek-ai');
  const bashFile = join(moduleRoot, 'dsh-tool-bash/lib/index.js');
  const bashSource = await readFile(bashFile, 'utf8');
  const patchedBash = patchVirtualBashFacts(bashSource);
  if (patchedBash !== bashSource) await writeFile(bashFile, patchedBash);
  const fsToolFile = join(moduleRoot, 'dsh-tool-fs/lib/index.js');
  const fsToolSource = await readFile(fsToolFile, 'utf8');
  const patchedFsTool = patchFileMutationCounts(fsToolSource);
  if (patchedFsTool !== fsToolSource) await writeFile(fsToolFile, patchedFsTool);
  const storage = pathToFileURL(resolve('cloud/official/novel/storage.mjs')).href;
  const files = [
    {
      file: join(moduleRoot, 'dsh-workspace/lib/index.js'),
      changes: [
        [
          'function fullyQualifiedWorkspacePath(path, platform = process.platform) {',
          'function fullyQualifiedWorkspacePath(path, platform = process.platform) {\n\tif (isVirtualPath(path)) return true;',
        ],
        [
          'async function realpathNormalize(path) {',
          'async function realpathNormalize(path) {\n\tif (isVirtualPath(path)) return virtualRealpath(path);',
        ],
        [
          'if (!(await stat(canonical)).isDirectory())',
          'if (!(isVirtualPath(canonical) ? virtualStat(canonical) : await stat(canonical)).isDirectory())',
        ],
      ],
    },
    {
      file: join(moduleRoot, 'dsh-api-session-controller/lib/index.js'),
      changes: [
        [
          'await mkdir(cwd, { recursive: true });',
          'if (isVirtualPath(cwd)) ensureVirtualDirectory(cwd); else await mkdir(cwd, { recursive: true });',
        ],
      ],
    },
  ];
  for (const { file, changes } of files) {
    let source = await readFile(file, 'utf8');
    if (source.includes('// novel-host-vfs-compat-v1')) continue;
    for (const [before, after] of changes) {
      if (source.split(before).length !== 2)
        throw new Error('Official host path seam changed; no speculative patch: ' + file);
      source = source.replace(before, after);
    }
    source =
      '// novel-host-vfs-compat-v1\nimport { isVirtualPath, virtualRealpath, virtualStat, ensureVirtualDirectory } from ' +
      JSON.stringify(storage) +
      ';\n' +
      source;
    await writeFile(file, source);
  }
  // The Workspace command path additionally validates attached/resumed
  // Session directories. These must use the very same execution-world stat,
  // rather than interpreting a valid POSIX VFS path as D:\\workspace on Windows.
  const workspaceFile = join(moduleRoot, 'dsh-workspace/lib/index.js');
  let workspace = await readFile(workspaceFile, 'utf8');
  if (!workspace.includes('// novel-host-vfs-compat-v2')) {
    for (const name of ['cwd', 'path']) {
      const before = 'if (!(await stat(' + name + ')).isDirectory())';
      if (workspace.split(before).length !== 2)
        throw new Error('Official workspace attachment seam changed.');
      workspace = workspace.replace(
        before,
        'if (!(isVirtualPath(' +
          name +
          ') ? virtualStat(' +
          name +
          ') : await stat(' +
          name +
          ')).isDirectory())',
      );
    }
    await writeFile(workspaceFile, '// novel-host-vfs-compat-v2\n' + workspace);
  }
  workspace = await readFile(workspaceFile, 'utf8');
  if (!workspace.includes('// novel-host-vfs-compat-v3')) {
    for (const [before, after] of [
      [
        '(await stat(this.record.path)).isDirectory()',
        '(isVirtualPath(this.record.path) ? virtualStat(this.record.path) : await stat(this.record.path)).isDirectory()',
      ],
      [
        'await mkdir(path, { recursive: true });',
        'if (isVirtualPath(path)) ensureVirtualDirectory(path); else await mkdir(path, { recursive: true });',
      ],
    ]) {
      if (workspace.split(before).length !== 2)
        throw new Error('Official workspace availability seam changed.');
      workspace = workspace.replace(before, after);
    }
    await writeFile(workspaceFile, '// novel-host-vfs-compat-v3\n' + workspace);
  }
  // Instruction discovery must use the execution world's POSIX path algebra,
  // rather than probing D:\\workspace on a Windows host. Stop ancestor discovery
  // at the mapped root; this is a root boundary, not a missing-file fallback.
  const instructionsFile = join(moduleRoot, 'dsh-agent-instructions/lib/index.js');
  let instructions = await readFile(instructionsFile, 'utf8');
  if (!instructions.includes('// novel-host-vfs-instructions-v1')) {
    const beforeImport =
      'import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";';
    if (instructions.split(beforeImport).length !== 2)
      throw new Error('Official instruction path imports changed.');
    instructions = instructions.replace(
      beforeImport,
      [
        'import * as hostPaths from "node:path";',
        'import { isVirtualPath } from ' + JSON.stringify(storage) + ';',
        'const pathsFor = (path) => typeof path === "string" && path.startsWith("/") ? hostPaths.posix : hostPaths;',
        'const basename = (path) => pathsFor(path).basename(path);',
        'const dirname = (path) => pathsFor(path).dirname(path);',
        'const join = (...parts) => pathsFor(parts[0]).join(...parts);',
        'const relative = (from, to) => pathsFor(from).relative(from, to);',
        'const resolve = (...parts) => pathsFor(parts.findLast((path) => hostPaths.isAbsolute(path)) ?? "").resolve(...parts);',
        'const { isAbsolute, sep } = hostPaths;',
      ].join('\n'),
    );
    const beforeParent = 'if (parent === current) return resolve(cwd);';
    if (instructions.split(beforeParent).length !== 2)
      throw new Error('Official instruction ancestor seam changed.');
    instructions = instructions.replace(
      beforeParent,
      'if (parent === current || isVirtualPath(current) && !isVirtualPath(parent)) return resolve(cwd);',
    );
    await writeFile(instructionsFile, '// novel-host-vfs-instructions-v1\n' + instructions);
  }
  const controllerFile = join(moduleRoot, 'dsh-api-workspace-controller/lib/index.js');
  let controller = await readFile(controllerFile, 'utf8');
  if (!controller.includes('// novel-host-vfs-documents-v1')) {
    for (const [before, after] of [
      [
        'function validateDocumentsDirectory(directory, platform = process.platform) {',
        'function validateDocumentsDirectory(directory, platform = process.platform) {\n\tif (isVirtualPath(directory)) return posix.normalize(directory);',
      ],
      [
        'async function defaultWorkspaceDirectory(documentsDirectory, signal, internals = {}) {',
        'async function defaultWorkspaceDirectory(documentsDirectory, signal, internals = {}) {\n\tif (isVirtualPath(documentsDirectory)) { signal.throwIfAborted(); return posix.join(documentsDirectory, "deepseek-harness", DEFAULT_WORKSPACE_DIRECTORY); }',
      ],
    ]) {
      if (controller.split(before).length !== 2) throw new Error('Official default workspace seam changed.');
      controller = controller.replace(before, after);
    }
    await writeFile(
      controllerFile,
      '// novel-host-vfs-documents-v1\nimport { isVirtualPath } from ' +
        JSON.stringify(storage) +
        ';\n' +
        controller,
    );
  }
  const sessionFile = join(moduleRoot, 'dsh-api-session-controller/lib/index.js');
  let session = await readFile(sessionFile, 'utf8');
  if (!session.includes('// novel-host-vfs-session-default-v1')) {
    const before = 'this.commands = new SessionCommandController(ctx, this.agents, process.cwd());';
    if (session.split(before).length !== 2) throw new Error('Official session cwd default seam changed.');
    session = session.replace(
      before,
      'this.commands = new SessionCommandController(ctx, this.agents, "/workspace");',
    );
    await writeFile(sessionFile, '// novel-host-vfs-session-default-v1\n' + session);
  }
  for (const [file, before, after, marker] of [
    [
      sessionFile,
      'if (isVirtualPath(cwd)) ensureVirtualDirectory(cwd); else await mkdir(cwd, { recursive: true });',
      'if (isVirtualPath(cwd)) ensureVirtualDirectory(cwd); else throw new Error("Session directory is outside the novel SQLite execution world.");',
      '// novel-host-vfs-session-boundary-v1',
    ],
    [
      workspaceFile,
      'if (isVirtualPath(path)) return virtualRealpath(path);',
      'if (isVirtualPath(path)) return virtualRealpath(path);\n\tthrow new Error("Workspace directory is outside the novel SQLite execution world.");',
      '// novel-host-vfs-workspace-boundary-v1',
    ],
    [
      workspaceFile,
      'if (isVirtualPath(path)) ensureVirtualDirectory(path); else await mkdir(path, { recursive: true });',
      'if (isVirtualPath(path)) ensureVirtualDirectory(path); else throw new Error("Default workspace is outside the novel SQLite execution world.");',
      '// novel-host-vfs-default-boundary-v1',
    ],
  ]) {
    let source = await readFile(file, 'utf8');
    if (source.includes(marker)) continue;
    if (source.split(before).length !== 2) throw new Error('Official directory boundary seam changed.');
    await writeFile(file, marker + '\n' + source.replace(before, after));
  }
  // Use the native pre-plugin host initializer, not a second dsh-purge profile
  // entry or a renamed plugin (upstream patch names are assertions, not aliases).
  // The optional callback is supplied only by this isolated host composition.
  const bootFile = join(moduleRoot, 'dsh/lib/profile-boot-C14i-8IN.js');
  let boot = await readFile(bootFile, 'utf8');
  const marker = '// novel-host-configure-context-v1';
  if (!boot.includes(marker)) {
    const before = 'await hostCtx.plugin(PluginPackages, { resolution: composed.resolution });';
    if (boot.split(before).length !== 2) throw new Error('Official host initializer seam changed.');
    boot = boot.replace(before, 'await options.configureHost?.(hostCtx);\n\t\t\t' + before);
    await writeFile(bootFile, marker + '\n' + boot);
  }
  return { files: files.length + 4, protocol: 'novel-host-vfs-compat-v8' };
}
