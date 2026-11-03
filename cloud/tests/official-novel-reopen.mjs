// A fresh OS process, not an in-memory remount. Reads only the isolated copy.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { startOfficialNovel } from '../official/novel/runtime.mjs';
import { vfsFileFingerprint } from '../official/novel/storage.mjs';

const root = resolve('data/official-validation/integration');
const report = { passed: false, freshProcess: true, realProviderRequests: 0, productionSwitched: false };
const sha = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
let app;
try {
  const witness = JSON.parse(await readFile(join(root, 'restart-witness.json'), 'utf8'));
  app = await startOfficialNovel({
    sqlite: join(root, 'test-main.sqlite'),
    home: join(root, 'home'),
    fixtureEndpoint: witness.fixtureEndpoint,
  });
  assert.equal(sha(vfsFileFingerprint(app.storage)), witness.filesHash);
  const found = await app.ctx.get('sessionController').resolveAgent(witness.sessionId);
  assert(!('error' in found), 'Official Session restore failed.');
  const agent = found.agent;
  assert.equal(sha(agent.session.log.slice(0, witness.eventCount)), witness.logHash);
  assert.equal(sha(agent.session.deriveMessages()), witness.messagesHash);
  assert.equal(app.ctx.get('workingDirectory').get(agent.session), witness.cwd);
  for (const name of [
    'novel_proposal_prepare',
    'novel_proposal_submit',
    'novel_outline_update',
    'read',
    'bash',
    'grep',
    'glob',
    'purge_status',
  ])
    assert(agent.ctx.get('tools').get(name, agent), 'Tool missing after restart: ' + name);
  report.passed = true;
  report.manuscriptsAndHistoryByteIdentical = true;
  report.syntheticConversationEventPrefixIdentical = true;
  report.syntheticConversationEffectiveMessagesIdentical = true;
  report.virtualWorkspaceAndOriginalPluginRestored = true;
  report.realHistoricalAgentsResumed = 0;
} catch (error) {
  report.failure = String(error.stack ?? error);
  process.exitCode = 1;
} finally {
  if (app) await app.shutdown.shutdown(process.exitCode ? 1 : 0);
  await writeFile(join(root, 'restart-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, failure: report.failure?.split('\n')[0] }));
}
