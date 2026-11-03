// Pinned dsh-edge 0.30.0 / Computer adapter. This is intentionally isolated:
// Computer's native Workspace is attached by withWorkspace under a symbol and
// exposes its synchronous provider/database. No minified code/schema is patched.
// A runtime upgrade must revalidate this seam; missing capabilities fail closed.
import { novelRoot } from './novel-role.mjs';

// Presentation/edit admission derived from ORIGINAL native runtime ownership.
// This is not a filesystem ACL: generic native file tools remain available.
export function bookIsGenerating(instance, root) {
  if (typeof root !== 'string' || novelRoot(root) !== root || !(instance.activeTurns instanceof Map))
    throw new Error('Unsupported native activity interface.');
  const host = instance.sessions?.context;
  if (typeof host?.get !== 'function') throw new Error('Native activity context unavailable.');
  const agents = host?.get('agents'),
    directory = host?.get('workingDirectory');
  if (typeof agents?.list !== 'function' || typeof directory?.get !== 'function')
    throw new Error('Native Agent activity services unavailable.');
  const resident = agents.list();
  if (!resident || typeof resident[Symbol.iterator] !== 'function')
    throw new Error('Native Agent activity catalog unavailable.');
  const busy = new Set([...resident].filter((agent) => agent.status === 'running'));
  for (const turn of instance.activeTurns.values()) {
    // Admission/cleanup may have a live turn before/after its Agent is present.
    // Its scope is unknown: retain the previous conservative global barrier.
    if (!turn?.agent) return true;
    busy.add(turn.agent);
  }
  for (const agent of busy) {
    const current = novelRoot(directory.get(agent.session));
    // Ordinary/global Agents can legitimately operate across directories.
    // Unknown/global work must not be silently declared unrelated to this book.
    if (!current || current === root) return true;
  }
  return false;
}

export async function nativeBookTitle(instance, root) {
  if (!/^\/workspace\/novels\/b-[a-f0-9]{32}$/.test(root) || typeof instance.listWorkspaces !== 'function')
    throw new Error('Unsupported native book identity interface.');
  const catalog = await instance.listWorkspaces();
  if (!Array.isArray(catalog?.items)) throw new Error('Native workspace catalog unavailable.');
  const matches = catalog.items.filter((item) => item.path === root);
  if (matches.length > 1) throw new Error('Ambiguous native book identity.');
  const title = matches[0]?.title;
  return typeof title === 'string' && title.trim() ? title : undefined;
}

export async function nativeWorkspace(instance) {
  const candidates = Object.getOwnPropertySymbols(instance)
    .filter((key) => key.description === 'workspace')
    .map((key) => instance[key]);
  if (candidates.length !== 1) throw new Error('Unsupported native Workspace adapter.');
  const workspace = candidates[0];
  if (typeof workspace.ready !== 'function' || typeof workspace.provider !== 'function')
    throw new Error('Unsupported native Workspace interface.');
  await workspace.ready();
  const fs = workspace.provider(),
    db = workspace.db;
  if (
    fs.db !== db ||
    typeof db?.transactionSync !== 'function' ||
    ![
      'readFileSync',
      'writeFileSync',
      'unlinkSync',
      'mkdirSync',
      'statSync',
      'lstatSync',
      'readdirSync',
    ].every((name) => typeof fs[name] === 'function')
  )
    throw new Error('Native atomic filesystem capabilities unavailable.');
  // Do not open an outer Computer Database transaction: that adapter emulates
  // nested transactions with SQL SAVEPOINT, forbidden by workerd. The platform
  // transaction must own the outer boundary; native file operations then open
  // their own platform nested transactions while its DB depth starts at zero.
  if (typeof instance.ctx?.storage?.transactionSync !== 'function')
    throw new Error('Native durable transaction capability unavailable.');
  return { fs, db: { transactionSync: (fn) => instance.ctx.storage.transactionSync(fn) } };
}
