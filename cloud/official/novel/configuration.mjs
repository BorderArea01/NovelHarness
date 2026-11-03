// Offline, lossless bridge from the existing DO's structured KV to the
// official credential, settings and storage owners. Never boots a model/Agent.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { deserialize } from 'node:v8';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json';
import { workspaceDomainSpec } from '@deepseek-ai/dsh-workspace';
import { projectionCacheDomainSpec } from '@deepseek-ai/dsh-session-projection-cache';
import { parse, stringify } from 'yaml';
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write';
import { NOVEL_PROFILE } from './profile.mjs';
import { privateDirectory } from '../../scripts/private-directory.mjs';

export const configurationHash = (value) =>
  createHash('sha256')
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === 'object' && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest('hex');
const specs = [workspaceDomainSpec, projectionCacheDomainSpec];
function inside(path, root) {
  const resolved = resolve(path),
    rel = relative(resolve(root), resolved);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Configuration path escapes the private lab.');
  return resolved;
}
export function readLegacyConfiguration(path) {
  path = inside(path, 'data/official-validation');
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    assert.equal(db.pragma('quick_check', { simple: true }), 'ok');
    const rows = db.prepare('SELECT key,value FROM _cf_KV ORDER BY key').all();
    const get = (key) => {
      const row = rows.find((item) => item.key === key);
      return row ? deserialize(row.value) : undefined;
    };
    const settings = get('dsh-edge:settings-document') ?? {};
    assert(settings && typeof settings === 'object' && !Array.isArray(settings));
    const defaultModel = get('dsh-edge:agent-default-model');
    if (defaultModel)
      assert(typeof defaultModel.provider === 'string' && typeof defaultModel.model === 'string');
    const refs = rows
      .filter((row) => row.key.startsWith('dsh-edge:credential:'))
      .map((row) => {
        const ref = credentialRef(row.key.slice('dsh-edge:credential:'.length));
        const value = deserialize(row.value);
        assert(typeof value === 'string' && value.length, 'Unsupported stored credential value.');
        return { ref, value };
      });
    assert(
      !rows.some(
        (row) => row.key.startsWith('dsh-edge:credential') && !row.key.startsWith('dsh-edge:credential:'),
      ),
      'Unknown credential key space; migration refused rather than silently skipping.',
    );
    const units = [];
    const unitNames = new Set(rows.flatMap((row) => /^dsh-kv:([^:]+):/.exec(row.key)?.slice(1) ?? []));
    assert(
      [...unitNames].every((name) => specs.some((spec) => spec.name === name)),
      'Unknown native storage domain; migration refused rather than silently skipping.',
    );
    for (const spec of specs) {
      const prefix = 'dsh-kv:' + spec.name + ':';
      const selected = rows.filter((row) => row.key.startsWith(prefix));
      if (!selected.length) continue;
      assert.equal(get(prefix + '__version__'), spec.version, 'Legacy native domain version differs.');
      const global = get(prefix + '__global__') ?? null;
      if (spec.global && global !== null)
        assert(spec.global.schema.safeParse(global).success, 'Invalid workspace singleton.');
      const tables = {};
      for (const [table, declaration] of Object.entries(spec.tables)) {
        const tablePrefix = prefix + table + ':';
        tables[table] = Object.fromEntries(
          selected
            .filter((row) => row.key.startsWith(tablePrefix))
            .map((row) => {
              const key = row.key.slice(tablePrefix.length),
                value = deserialize(row.value);
              assert(
                declaration.valueSchema.safeParse(value).success,
                'Invalid historical native domain record.',
              );
              const recordVersion = get(prefix + '__recver__:' + table + ':' + key);
              if (recordVersion !== undefined) assert.equal(recordVersion, spec.version);
              return [key, value];
            }),
        );
      }
      units.push({ spec, global, tables });
    }
    const ownerTimeZone = get('dsh-edge:owner-time-zone');
    if (ownerTimeZone !== undefined) assert(typeof ownerTimeZone === 'string');
    return { settings, defaultModel, refs, units, ownerTimeZone };
  } finally {
    db.close();
  }
}

async function planSettings(home, state) {
  const profile = join(home, 'profiles', NOVEL_PROFILE);
  await privateDirectory(profile);
  const path = join(profile, 'cordis.patch.yml');
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const rows = text ? parse(text) : [];
  assert(Array.isArray(rows));
  const overrides = {
    ...state.settings,
    ...(state.defaultModel ? { 'agent-default-model': state.defaultModel } : {}),
  };
  for (const [id, config] of Object.entries(overrides)) {
    assert(/^[a-z][a-z0-9-]*$/.test(id), 'Invalid legacy settings namespace.');
    const existing = rows.findLast((row) => row.id === id && !row.insert);
    if (existing)
      assert.equal(
        configurationHash(existing.config),
        configurationHash(config),
        'User settings differ; never overwrite.',
      );
    else rows.push({ id, config });
  }
  const next = stringify(rows);
  return { path, next, changed: next !== text };
}

export async function importLegacyConfiguration({ sourcePath, home }) {
  home = inside(home, 'data/official-validation/integration');
  await privateDirectory(home);
  const state = readLegacyConfiguration(sourcePath);
  // Validate every record before the first destination write. Retry can fill
  // an interrupted import, but cannot replace any conflicting destination.
  const report = {
    settingsNamespaces: Object.keys(state.settings).length,
    defaultModel: !!state.defaultModel,
    credentials: state.refs.length,
    domains: [],
    ownerTimeZonePreserved: state.ownerTimeZone !== undefined,
    ownerTimeZoneApplied: false,
    modelCalls: 0,
    status: 'running',
    credentialPolicy: state.refs.some((item) => !item.value.startsWith('fixture-only-'))
      ? 'offline-only'
      : 'synthetic',
  };
  const ctx = new Context();
  const backend = new JsonStorageBackend(join(home, 'storages'));
  const opened = [];
  try {
    await ctx.plugin(LocalCredentialProvider, { dshHome: home, watch: false }).await();
    const provider = ctx.get('credentials');
    const credentials = [];
    for (const { ref, value } of state.refs) {
      const existing = await provider.resolve(ref);
      if (existing?.source === 'file')
        assert.equal(
          configurationHash(existing.value),
          configurationHash(value),
          'Stored credential differs; never overwrite.',
        );
      else credentials.push({ ref, value });
    }
    const settings = await planSettings(home, state);
    let zoneExists = false;
    const zonePath = join(home, 'legacy-owner-time-zone.json');
    if (state.ownerTimeZone !== undefined) {
      try {
        const existing = JSON.parse(await readFile(zonePath, 'utf8'));
        assert.equal(configurationHash(existing), configurationHash({ timeZone: state.ownerTimeZone }));
        zoneExists = true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    for (const { spec, tables, global } of state.units) {
      const unit = await backend.kv.open({
        name: spec.name,
        version: spec.version,
        tables: Object.keys(spec.tables),
        hasGlobal: !!spec.global,
        layout: spec.layout,
      });
      const plan = { unit, spec, tables, global, writes: [], writeGlobal: false };
      opened.push(plan);
      const existing = await unit.loadAll();
      if (global !== null) {
        if (existing.global !== null)
          assert.equal(
            configurationHash(existing.global),
            configurationHash(global),
            'Native singleton differs.',
          );
        else plan.writeGlobal = true;
      }
      let records = 0;
      for (const [table, values] of Object.entries(tables))
        for (const [key, value] of Object.entries(values)) {
          if (Object.hasOwn(existing.tables[table] ?? {}, key))
            assert.equal(
              configurationHash(existing.tables[table][key]),
              configurationHash(value),
              'Native record differs.',
            );
          else plan.writes.push({ table, key, value });
          records++;
        }
      for (const [table, values] of Object.entries(existing.tables))
        assert(
          Object.keys(values).every((key) => Object.hasOwn(tables[table] ?? {}, key)),
          'Destination has unrelated native records.',
        );
      report.domains.push({ name: spec.name, records });
    }
    // A rejected preflight leaves the previous ready receipt and all values
    // intact. Only a commit that may have partially happened blocks boot.
    await writeFileAtomic(join(home, 'configuration-import.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    for (const { ref, value } of credentials) await provider.set(ref, value);
    for (const { ref, value } of state.refs) {
      const stored = await provider.resolve(ref);
      assert.equal(stored?.source, 'file');
      assert.equal(
        configurationHash(stored.value),
        configurationHash(value),
        'Credential did not round-trip.',
      );
    }
    if (settings.changed) await writeFileAtomic(settings.path, settings.next, { mode: 0o600 });
    for (const { unit, global, writeGlobal, writes, tables } of opened) {
      if (writeGlobal) await unit.setGlobal(global);
      for (const { table, key, value } of writes) await unit.putRecord(table, key, value);
      assert.equal(
        configurationHash(await unit.loadAll()),
        configurationHash({ tables, global }),
        'Native storage round-trip differs.',
      );
    }
    // Retain this Edge-owned preference separately, not as an invented Node
    // settings namespace. Browser-turn time zones retain their native protocol.
    if (state.ownerTimeZone !== undefined && !zoneExists)
      await writeFileAtomic(zonePath, JSON.stringify({ timeZone: state.ownerTimeZone }), { mode: 0o600 });
    report.status = 'ready';
    await writeFileAtomic(join(home, 'configuration-import.json'), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
    return report;
  } finally {
    await backend.close();
    await ctx.fiber.dispose();
  }
}
