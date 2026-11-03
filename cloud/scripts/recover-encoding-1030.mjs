// This incident has an exact reversible byte transform AND an independently
// retained matching history object. No inferred prose, heuristic repair or AI.
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const scope = resolve('data/official-validation/integration');
const folder = join(scope, 'encoding-recovery-1030');
await access(join(folder, 'incident.sqlite'));
const origin = 'http://127.0.0.1:3212';
const book = 'b-2da944423074c18587c1674a460dc203';
const path = 'chapters/free-a3d96474-553a-ac19-c84a-444fe18b1b47.md';
const goodHash = '4ea7de30921398a219ac2de559f17032be1c1415cd3520cfdfb685628cfa9697';
const badHash = '0a510366608a8fc9d108b7f41e673032471789656761427d0b3dd0673593a819';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const key = (await readFile(join(scope, 'lan-staging/owner-key.txt'), 'utf8')).trim();
const auth = await fetch(origin + '/api/auth/recover', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json' },
  body: JSON.stringify({ accessKey: key }),
  signal: AbortSignal.timeout(15000),
});
assert.equal(auth.status, 200);
await auth.arrayBuffer();
const cookie = auth.headers
  .getSetCookie()
  .map((v) => v.split(';')[0])
  .join('; ');
async function request(route, method = 'GET', body) {
  const r = await fetch(origin + route, {
    method,
    headers: { origin, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20000),
  });
  assert.equal(r.status, 200, 'Incident request rejected; no unsafe fallback or forced overwrite.');
  return r.json();
}
const activity = await request('/api/session/list', 'POST', {
  type: 'client-request',
  rpcId: crypto.randomUUID(),
  method: 'session/list',
  payload: { args: { _request: {} } },
});
const sessions = activity.result?.value ?? activity.result?.data ?? activity;
assert(
  Array.isArray(sessions.items) && sessions.items.every((v) => v.running === false),
  'AI is active; recovery refused.',
);
const url = '/api/novels/' + book + '/document?path=' + encodeURIComponent(path);
const current = await request(url);
if (current.hash === goodHash) {
  console.log(JSON.stringify({ alreadyRecovered: true, hash: goodHash }));
} else {
  assert.equal(current.hash, badHash, 'Chapter changed since incident snapshot; recovery refused.');
  assert.equal(sha(current.text), badHash);
  assert(
    [...current.text].every((c) => c.codePointAt(0) <= 255),
    'Not the proven reversible transform.',
  );
  const recovered = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    Buffer.from(current.text, 'latin1'),
  );
  assert.equal(sha(recovered), goodHash);
  const history = await request(
    '/api/novels/' + book + '/history?path=' + encodeURIComponent(path) + '&hash=' + goodHash,
  );
  assert.equal(history.text, recovered, 'Independent retained history does not match; recovery refused.');
  await writeFile(join(folder, 'corrupted-original.md'), current.text, { encoding: 'utf8', flag: 'wx' });
  await writeFile(join(folder, 'recovered.md'), recovered, { encoding: 'utf8', flag: 'wx' });
  const report = {
    at: new Date().toISOString(),
    book,
    path,
    originalHash: badHash,
    recoveredHash: goodHash,
    bytes: Buffer.byteLength(recovered),
    characters: recovered.length,
    editorCharacters: recovered.replace(/\s/g, '').length,
    han: (recovered.match(/\p{Script=Han}/gu) ?? []).length,
    independentHistoryMatched: true,
    applied: false,
  };
  if (process.argv.includes('--apply')) {
    const saved = await request(url, 'PUT', { path, text: recovered, expectedHash: badHash });
    assert.equal(saved.hash, goodHash);
    const verified = await request(url);
    assert.equal(verified.text, recovered);
    assert.equal(verified.hash, goodHash);
    const old = await request(
      '/api/novels/' + book + '/history?path=' + encodeURIComponent(path) + '&hash=' + badHash,
    );
    assert.equal(old.text, current.text, 'The corrupted original must remain available too.');
    report.applied = true;
  }
  await writeFile(join(folder, 'recovery.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
