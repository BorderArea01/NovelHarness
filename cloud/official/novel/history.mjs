// Lossless, offline migration of the existing SQLite session format into the
// official persistence/attachment providers. Never mounts an Agent or a model.
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateDirectory } from '../../scripts/private-directory.mjs';

const modules = resolve('cloud/official/node_modules/@deepseek-ai');
const load = (name) => import(pathToFileURL(join(modules, name, 'lib/index.js')));
export const historyHash = (value) =>
  createHash('sha256')
    .update(JSON.stringify(value) ?? 'undefined')
    .digest('hex');

export async function historyTypes() {
  const [{ sessionFormatCatalog }, session, { currentSessionMessageProjections }] = await Promise.all([
    load('dsh-session-format-catalog'),
    load('dsh-session'),
    import(pathToFileURL(join(modules, 'dsh-session-format-catalog/lib/types/message-projections.js'))),
  ]);
  return { sessionFormatCatalog, ...session, currentSessionMessageProjections };
}

export function decodeHistoricalSession(source, row, catalog) {
  assert.equal(row.version, 4, 'Unsupported historical session version.');
  const header = {
    type: 'session',
    version: row.version,
    id: row.id,
    createdAt: row.created_at,
    delegationDepth: row.delegation_depth ?? 0,
    isSeeded: row.seed_length !== null,
    ...(row.cwd === null ? {} : { cwd: row.cwd }),
    ...(row.parent_session === null ? {} : { parentSession: row.parent_session }),
    ...(row.origin === null ? {} : { origin: row.origin }),
    ...(row.agent_preset === null ? {} : { agentPreset: row.agent_preset }),
  };
  const restore = catalog.createRestore(header, { recovery: 'recoverable', validation: 'current' });
  const records = source
    .prepare('SELECT * FROM dsh_session_events WHERE session_id=? ORDER BY seq')
    .all(row.id);
  for (const event of records) {
    const packed = ['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(event.type);
    restore.decodeRow({
      type: event.type,
      ...(packed ? { seq0: event.seq, time0: event.time } : { seq: event.seq, time: event.time }),
      data: JSON.parse(event.data),
      ...(event.source_event_seqs === null ? {} : { sourceEventSeqs: JSON.parse(event.source_event_seqs) }),
      ...(event.surface_op === null ? {} : { surfaceOp: JSON.parse(event.surface_op) }),
      ...(event.ignorable === 1 ? { ignorable: true } : {}),
    });
  }
  return { ...restore.finish(), rows: records.length };
}

export function projectHistory(artifact, types) {
  return types.Session.fromRestore(
    types.SessionId(artifact.header.id),
    artifact.events,
    artifact.header,
    types.SessionLogOffset(artifact.inheritedEventCount),
    'detached',
    types.currentSessionMessageProjections,
  );
}

// Collect references only, not arbitrary paths. Authorization remains with the
// native controller's declared-content-field checks, exercised by runtime tests.
export function imageReferences(value, refs = new Map()) {
  if (!value || typeof value !== 'object') return refs;
  if (value.type === 'image' && value.attachment?.attachmentId) {
    const ref = value.attachment;
    assert(/^sha256:[a-f0-9]{64}$/.test(ref.attachmentId), 'Invalid historical image ID.');
    const previous = refs.get(ref.attachmentId);
    if (previous)
      assert.equal(historyHash(previous), historyHash(ref), 'Conflicting historical image references.');
    refs.set(ref.attachmentId, ref);
  }
  for (const child of Object.values(value)) imageReferences(child, refs);
  return refs;
}

function labPath(path, parent) {
  const target = resolve(path),
    rel = relative(resolve(parent), target);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'History target escapes isolated lab.');
  return target;
}

export async function importHistoricalState({ sourcePath, home }) {
  sourcePath = labPath(sourcePath, 'data/official-validation');
  home = labPath(home, 'data/official-validation/integration');
  await privateDirectory(home);
  const types = await historyTypes();
  const [{ Context }, jsonl, attachments] = await Promise.all([
    load('cordis'),
    load('dsh-session-persistence-jsonl'),
    load('dsh-attachment-local'),
  ]);
  const source = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const ctx = new Context();
  const receipt = {
    sessions: [],
    storedRows: 0,
    projectedMessages: 0,
    images: 0,
    imageBytes: 0,
    createdSessions: 0,
  };
  try {
    assert.equal(source.pragma('quick_check', { simple: true }), 'ok');
    await ctx
      .plugin(jsonl, { root: join(home, 'sessions'), compression: 'none', listConcurrency: 1 })
      .await();
    await ctx.plugin(attachments.default, { dshHome: home, imageCompressionConcurrency: 1 }).await();
    const persistence = ctx.get('sessionPersistence'),
      store = ctx.get('attachments');
    assert(persistence && store);
    const refs = new Map();
    for (const row of source.prepare('SELECT * FROM dsh_sessions ORDER BY created_at,id').all()) {
      const artifact = decodeHistoricalSession(source, row, types.sessionFormatCatalog);
      imageReferences(artifact.events, refs);
      if (!(await persistence.stat(row.id))) {
        const handle = await persistence.create(artifact.header, {
          inheritedEventCount: artifact.inheritedEventCount,
        });
        try {
          await handle.append(artifact.events);
          await handle.flush();
        } finally {
          await handle.close();
        }
        receipt.createdSessions++;
      }
      const handle = await persistence.open(row.id, 'read');
      try {
        const loaded = await handle.read();
        assert.equal(
          historyHash(loaded.events),
          historyHash(artifact.events),
          'Existing session differs; never overwrite it.',
        );
        assert.equal(historyHash(handle.header), historyHash(artifact.header), 'Historical header differs.');
        assert.equal(handle.inheritedEventCount, artifact.inheritedEventCount);
        const session = projectHistory(artifact, types);
        const messages = session.deriveMessages();
        receipt.sessions.push({
          id: row.id,
          headerHash: historyHash(artifact.header),
          eventsHash: historyHash(artifact.events),
          eventCount: artifact.events.length,
          inheritedEventCount: artifact.inheritedEventCount,
          messagesHash: historyHash(messages),
          requestHeaderHash: historyHash(session.requestHeader()),
          imageRefs: [...imageReferences(artifact.events).values()],
        });
        receipt.storedRows += artifact.rows;
        receipt.projectedMessages += messages.length;
      } finally {
        await handle.close();
      }
    }
    const objects = source.prepare('SELECT digest,bytes,chunks FROM dsh_edge_attachment_objects').all();
    for (const object of objects) {
      const ref = refs.get('sha256:' + object.digest);
      assert(ref, 'Unreferenced image needs an explicit migration policy; not silently discarded.');
      const chunks = source
        .prepare(
          'SELECT chunk_index,data FROM dsh_edge_attachment_chunks WHERE digest=? ORDER BY chunk_index',
        )
        .all(object.digest);
      assert.equal(chunks.length, object.chunks, 'Historical image chunk count differs.');
      chunks.forEach((chunk, i) => assert.equal(chunk.chunk_index, i, 'Historical image chunk missing.'));
      const data = Buffer.concat(chunks.map((chunk) => chunk.data));
      assert.equal(data.length, object.bytes);
      assert.equal(data.length, ref.bytes);
      assert.equal(createHash('sha256').update(data).digest('hex'), object.digest);
      // Upstream verified immutable publication: exact bytes, fsync, digest
      // collision checks. No normalize/saveImages call that could alter IDs.
      await attachments.commitPreparedImageFile(store.root, { ref, data });
      const stored = await store.readImage(ref);
      assert.equal(createHash('sha256').update(stored.data).digest('hex'), object.digest);
      receipt.images++;
      receipt.imageBytes += data.length;
    }
    assert.equal(refs.size, objects.length, 'Some historical image references lack objects.');
    return receipt;
  } finally {
    source.close();
    await ctx.fiber.dispose();
  }
}
