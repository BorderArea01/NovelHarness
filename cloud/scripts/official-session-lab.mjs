// Read-only source snapshot -> isolated official JSONL -> official Session replay.
// No Agent, model, scheduler or network provider is mounted in this process.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { decodeHistoricalSession } from '../official/novel/history.mjs';
const lab = resolve(process.env.NOVEL_OFFICIAL_LAB ?? '');
assert(lab.endsWith('official-validation'));
const modules = resolve(process.env.DSH_BASE, '..');
const load = (name) => import(pathToFileURL(join(modules, '@deepseek-ai', name, 'lib/index.js')));
const { Context } = await load('cordis');
const jsonl = await load('dsh-session-persistence-jsonl');
const { sessionFormatCatalog } = await load('dsh-session-format-catalog');
const { Session, SessionId, SessionLogOffset } = await load('dsh-session');
const { currentSessionMessageProjections } = await import(
  pathToFileURL(join(modules, '@deepseek-ai/dsh-session-format-catalog/lib/types/message-projections.js'))
);
const source = new Database(join(lab, 'source-main.sqlite'), { readonly: true, fileMustExist: true });
let ctx;
const report = {
  complete: false,
  originalSqliteReadOnly: true,
  modelCalls: 0,
  sessions: 0,
  storedRows: 0,
  logicalEvents: 0,
  exactLogicalEventHashes: true,
  projectedMessages: 0,
  projectedMessageHashesMatch: true,
  restartReadVerified: false,
  cwdRemapped: false,
  attachmentsPorted: false,
};
const sha = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');
function decode(row) {
  return decodeHistoricalSession(source, row, sessionFormatCatalog);
}
async function mount() {
  const context = new Context();
  await context
    .plugin(jsonl, { root: join(lab, 'session-replay'), compression: 'none', listConcurrency: 1 })
    .await();
  assert(context.get('sessionPersistence'));
  return context;
}
try {
  const headers = source.prepare('SELECT * FROM dsh_sessions ORDER BY created_at,id').all();
  ctx = await mount();
  const persistence = ctx.get('sessionPersistence');
  for (const row of headers) {
    const artifact = decode(row);
    let handle;
    const existing = await persistence.stat(row.id);
    if (!existing) {
      handle = await persistence.create(artifact.header, {
        inheritedEventCount: artifact.inheritedEventCount,
      });
      try {
        await handle.append(artifact.events);
        await handle.flush();
      } finally {
        await handle.close();
      }
    }
    handle = await persistence.open(row.id, 'read');
    try {
      const loaded = await handle.read();
      assert.equal(sha(loaded.events), sha(artifact.events), 'Imported logical event hash differs.');
      assert.deepEqual(handle.header, artifact.header);
      assert.equal(handle.inheritedEventCount, artifact.inheritedEventCount);
      const replay = Session.fromRestore(
        SessionId(row.id),
        loaded.events,
        handle.header,
        SessionLogOffset(handle.inheritedEventCount),
        'detached',
        currentSessionMessageProjections,
      );
      const original = Session.fromRestore(
        SessionId(row.id),
        artifact.events,
        artifact.header,
        SessionLogOffset(artifact.inheritedEventCount),
        'detached',
        currentSessionMessageProjections,
      );
      const messages = replay.deriveMessages();
      assert.equal(sha(messages), sha(original.deriveMessages()), 'Effective message projection differs.');
      assert.equal(sha(replay.requestHeader()), sha(original.requestHeader()));
      report.projectedMessages += messages.length;
    } finally {
      await handle.close();
    }
    report.sessions++;
    report.storedRows += artifact.rows;
    report.logicalEvents += artifact.events.length;
  }
  await ctx.fiber.dispose();
  ctx = await mount();
  for (const row of headers) {
    const handle = await ctx.get('sessionPersistence').open(row.id, 'read');
    try {
      assert.equal(sha((await handle.read()).events), sha(decode(row).events));
    } finally {
      await handle.close();
    }
  }
  report.restartReadVerified = true;
  report.complete = report.sessions === headers.length;
} catch (error) {
  report.failure = String(error.message).slice(0, 800);
  process.exitCode = 1;
} finally {
  source.close();
  if (ctx) await ctx.fiber.dispose();
  await writeFile(join(lab, 'session-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
