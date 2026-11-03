// Actual official history/attachment controllers, with real copied historical
// data but no resumed Agent and no model request (including to the fixture).
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  importHistoricalState,
  historyTypes,
  historyHash,
  projectHistory,
} from '../official/novel/history.mjs';
import { prepareOfficialNovel } from '../scripts/prepare-official-novel.mjs';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';
import { startModelFixture } from './fixtures/model-server.mjs';
import { privateDirectory } from '../scripts/private-directory.mjs';

const root = resolve('data/official-validation/integration');
const sourcePath = resolve('data/official-validation/source-main.sqlite');
const home = join(root, 'history-home');
const sqlite = join(root, 'history-main.sqlite');
const reopened = process.argv.includes('--reopen');
const shaBytes = (data) => createHash('sha256').update(data).digest('hex');
const reportPath = join(root, reopened ? 'history-reopen-report.json' : 'history-report.json');
const report = {
  format: 'novel-official-history-v1',
  at: new Date().toISOString(),
  complete: false,
  passed: false,
  freshProcess: reopened,
  realModelCalls: 0,
  realHistoricalAgentsResumed: 0,
  productionSwitched: false,
};
let app,
  model,
  phase = 'prepare';
await privateDirectory(root);
await writeFile(reportPath, JSON.stringify(report, null, 2));
const activeBefore = await readFile('data/local-host/active.json');
const sourceHash = shaBytes(await readFile(sourcePath));
try {
  let receipt;
  if (!reopened) {
    await prepareOfficialNovel();
    await copyFile(sourcePath, sqlite);
    phase = 'offline lossless import';
    receipt = await importHistoricalState({ sourcePath, home });
    await writeFile(join(root, 'history-witness.json'), JSON.stringify(receipt, null, 2));
    // Repeated imports must verify rather than duplicate or overwrite sessions.
    const again = await importHistoricalState({ sourcePath, home });
    assert.equal(again.createdSessions, 0, 'Repeated import created sessions.');
    assert.equal(historyHash(again.sessions), historyHash(receipt.sessions));
    report.idempotent = true;
  } else receipt = JSON.parse(await readFile(join(root, 'history-witness.json'), 'utf8'));
  phase = 'official host startup';
  model = await startModelFixture();
  app = await startOfficialNovel({ sqlite, home, fixtureEndpoint: model.url });
  const fingerprints = vfsFileFingerprint(app.storage);
  const types = await historyTypes();
  const controller = app.ctx.get('sessionController');
  const agents = app.ctx.get('agents');
  assert.equal(agents.list().length, 0, 'Host automatically resumed a historical Agent.');
  phase = 'native cold history listing';
  const listed = await controller.list({});
  for (const witness of receipt.sessions)
    assert(
      listed.items.some((item) => item.sessionId === witness.id),
      'Historical session absent from native list.',
    );
  let pages = 0,
    authorizedImages = 0;
  for (const witness of receipt.sessions) {
    phase = 'native history integrity';
    const inspected = await controller.inspect(witness.id);
    assert.equal(historyHash(inspected.meta), witness.headerHash, 'Native history metadata changed.');
    assert.equal(historyHash(inspected.events), witness.eventsHash, 'Native history events changed.');
    assert.equal(inspected.inheritedEventCount, witness.inheritedEventCount);
    const session = projectHistory(
      {
        header: inspected.meta,
        events: inspected.events,
        inheritedEventCount: inspected.inheritedEventCount,
      },
      types,
    );
    assert.equal(
      historyHash(session.deriveMessages()),
      witness.messagesHash,
      'Native effective messages changed.',
    );
    assert.equal(historyHash(session.requestHeader()), witness.requestHeaderHash);
    // The browser's backwards pagination must reconstruct the entire exact log,
    // not just a recent page or a list entry with no readable messages.
    let beforeSeq,
      reconstructed = [],
      count = 0;
    do {
      const page = await controller.page(
        {
          address: { kind: 'session', sessionId: witness.id },
          throughSeq: witness.eventCount - 1,
          maxMessages: 20,
          ...(beforeSeq === undefined ? {} : { beforeSeq }),
        },
        new AbortController().signal,
      );
      const events = page.records.map((record) => {
        assert.equal(record.type, 'event', 'Unexpected history wire record.');
        return record.event;
      });
      reconstructed = events.concat(reconstructed);
      pages++;
      count++;
      assert(count <= witness.eventCount + 1, 'History pagination did not advance.');
      if (!page.hasMore) break;
      assert(
        events.length && (beforeSeq === undefined || events[0].seq < beforeSeq),
        'History pagination stalled.',
      );
      beforeSeq = events[0].seq;
    } while (true);
    assert.equal(
      historyHash(reconstructed),
      witness.eventsHash,
      'Browser history pages lost or duplicated events.',
    );
    phase = 'native authorized attachment read';
    for (const ref of witness.imageRefs) {
      const result = await controller.attachment({ sessionId: witness.id, attachmentId: ref.attachmentId });
      assert.equal(historyHash(result.attachment), historyHash(ref), 'Native attachment reference changed.');
      assert.equal(shaBytes(Buffer.from(result.data, 'base64')), ref.attachmentId.slice(7));
      authorizedImages++;
    }
  }
  const withImage = receipt.sessions.find((item) => item.imageRefs.length);
  const withoutImage = receipt.sessions.find((item) => !item.imageRefs.length);
  assert(withImage && withoutImage);
  await assert.rejects(
    () =>
      controller.attachment({
        sessionId: withoutImage.id,
        attachmentId: withImage.imageRefs[0].attachmentId,
      }),
    (error) =>
      error.code === 'session/attachment-invalid' && error.details?.reason === 'ATTACHMENT_NOT_REFERENCED',
  );
  assert.equal(agents.list().length, 0, 'History browsing activated an Agent.');
  assert.equal(model.requests.length, 0, 'History browsing requested a model.');
  assert.equal(
    historyHash(vfsFileFingerprint(app.storage)),
    historyHash(fingerprints),
    'History browsing modified manuscripts.',
  );
  await app.shutdown.shutdown(0);
  app = undefined;
  assert.equal(shaBytes(await readFile(sourcePath)), sourceHash, 'Read-only source snapshot changed.');
  assert.equal(shaBytes(await readFile('data/local-host/active.json')), shaBytes(activeBefore));
  report.nativeSessionList = receipt.sessions.length;
  report.storedRows = receipt.storedRows;
  report.projectedMessages = receipt.projectedMessages;
  report.exactHistoryPages = pages;
  report.authorizedImageReads = authorizedImages;
  report.images = receipt.images;
  report.imageBytes = receipt.imageBytes;
  report.crossSessionAttachmentRejected = true;
  report.manuscriptsAndReadOnlySnapshotUnchanged = true;
  if (!reopened) {
    phase = 'fresh process reopen';
    await promisify(execFile)(
      process.execPath,
      ['--max-old-space-size=384', 'cloud/tests/official-novel-history.mjs', '--reopen'],
      { cwd: process.cwd(), windowsHide: true, timeout: 120000, maxBuffer: 128 * 1024 },
    );
    const restart = JSON.parse(await readFile(join(root, 'history-reopen-report.json'), 'utf8'));
    assert.equal(restart.passed, true);
    report.freshProcessReopenPassed = true;
  }
  report.passed = true;
} catch (error) {
  // Never serialize assertion actual/expected, historical text or native stack.
  report.failure = {
    phase,
    name: error.name,
    code: error.code ?? null,
    message: String(error.message).split('\n')[0].slice(0, 240),
  };
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(1);
  if (model) await model.close();
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
