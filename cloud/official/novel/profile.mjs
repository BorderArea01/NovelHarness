// Native DSH layering: generated host defaults are a bundle; the editable
// profile patch belongs to the operator and is never regenerated on startup.
import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, lstat, symlink, unlink } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { parse, stringify } from 'yaml';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';

// Previous lab-only generated profiles remain untouched for comparison. This
// stable profile has one writable user layer from its first boot onward.
export const NOVEL_PROFILE = 'novel-lab-persistent';
const hostBundle = 'novel-host-bundle';
async function json(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}
async function linkPrivate(parent, name, target, remove = false) {
  const path = join(parent, name);
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (stat) {
    assert(stat.isSymbolicLink(), 'Managed dependency path is not a private junction.');
    assert.equal(await realpath(path), await realpath(target), 'Managed dependency target changed.');
    if (remove) await unlink(path); // Unlink the verified junction, never its target.
  } else if (!remove) await symlink(target, path, 'junction');
}
function purgeRow(row) {
  return row?.id === 'dsh-purge' || row?.name === 'dsh-purge';
}
function stripPurge(rows) {
  return rows.flatMap((row) => {
    if (purgeRow(row)) return [];
    if (!row.insert) return [row];
    const insert = row.insert.filter((entry) => !purgeRow(entry));
    return insert.length ? [{ ...row, insert }] : [];
  });
}

export async function configureNovelProfile({ home, modules, requestedMode }) {
  const rel = relative(resolve('data/official-validation/integration'), resolve(home));
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel));
  const profile = join(home, 'profiles', NOVEL_PROFILE),
    bundle = join(profile, 'host-bundle');
  await mkdir(bundle, { recursive: true });
  const manifestPath = join(profile, 'package.json');
  const existing = await json(manifestPath);
  const mode =
    requestedMode ??
    (existing ? (existing.dsh?.profile?.bundles?.includes('dsh-purge') ? 'enabled' : 'removed') : 'enabled');
  assert(['enabled', 'disabled', 'removed'].includes(mode));
  const patchPath = join(profile, 'cordis.patch.yml');
  let text;
  try {
    text = await readFile(patchPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Only explicit lifecycle operations change the plugin row. Normal startup
  // leaves the complete user patch byte-identical, including native UI edits.
  if (text === undefined || requestedMode !== undefined || !existing) {
    const rows = text === undefined ? [] : parse(text);
    assert(Array.isArray(rows), 'User profile patch must be a YAML sequence.');
    let next;
    if (mode === 'removed') {
      const saved = rows.flatMap((row) =>
        purgeRow(row) ? [row] : row.insert?.some(purgeRow) ? [{ insert: row.insert.filter(purgeRow) }] : [],
      );
      if (saved.length)
        await writeFileAtomic(join(profile, 'purge-removed.json'), JSON.stringify(saved), { mode: 0o600 });
      next = stripPurge(rows);
    } else {
      next = rows;
      let bodies = next.flatMap((row) => row.insert ?? []).filter(purgeRow);
      if (!bodies.length) {
        const saved = await json(join(profile, 'purge-removed.json'));
        if (saved) {
          assert(Array.isArray(saved), 'Saved plugin profile is invalid.');
          next.push(...saved);
          bodies = next.flatMap((row) => row.insert ?? []).filter(purgeRow);
        }
      }
      if (!bodies.length) {
        next.push({
          insert: [
            {
              id: 'dsh-purge',
              name: 'dsh-purge',
              inject: ['systemPrompt', 'tools'],
              config: { enabled: mode === 'enabled', autoApplyOnStart: false, autoUpdateOnStart: false },
            },
          ],
        });
      } else for (const body of bodies) body.config = { ...body.config, enabled: mode === 'enabled' };
      for (const row of next.filter(purgeRow)) row.config = { ...row.config, enabled: mode === 'enabled' };
    }
    const updated = stringify(next);
    if (updated !== text) await writeFileAtomic(patchPath, updated, { mode: 0o600 });
  }
  const dependencies = {
    ...existing?.dependencies,
    [hostBundle]: 'file:' + bundle.replaceAll('\\', '/'),
    'novel-harness-bridge':
      'file:' + resolve('data/official-validation/integration/client-plugin').replaceAll('\\', '/'),
  };
  if (mode === 'removed') delete dependencies['dsh-purge'];
  else dependencies['dsh-purge'] ??= '1.1.82';
  const others = (existing?.dsh?.profile?.bundles ?? []).filter(
    (name) => !['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-purge', hostBundle].includes(name),
  );
  const manifest = {
    ...existing,
    name: 'dsh-profile-' + NOVEL_PROFILE,
    private: true,
    dependencies,
    dsh: {
      ...existing?.dsh,
      profile: {
        ...existing?.dsh?.profile,
        bundles: [
          '@deepseek-ai/dsh-base',
          '@deepseek-ai/dsh-web-app',
          ...(mode === 'removed' ? [] : ['dsh-purge']),
          hostBundle,
          ...others,
        ],
      },
    },
  };
  await writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
  await writeFileAtomic(
    join(bundle, 'package.json'),
    JSON.stringify({
      name: hostBundle,
      version: '0.0.0',
      private: true,
      type: 'module',
      exports: { './package.json': './package.json' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }),
    { mode: 0o600 },
  );
  const nodeModules = join(profile, 'node_modules');
  await mkdir(nodeModules, { recursive: true });
  await linkPrivate(nodeModules, hostBundle, bundle);
  await linkPrivate(nodeModules, 'novel-harness-bridge', join(modules, 'novel-harness-bridge'));
  await linkPrivate(nodeModules, 'dsh-purge', join(modules, 'dsh-purge'), mode === 'removed');
  return { profile, bundle, mode };
}
