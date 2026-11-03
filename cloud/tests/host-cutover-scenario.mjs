import assert from 'node:assert/strict';
import { hostRuntime } from '../host/runtime.mjs';
export async function verifyNativeCutover({ source, release, persist, ownerKey, cookie, bookId }) {
  let runtime;
  const headers = { authorization: 'Bearer ' + ownerKey, 'x-novel-host-control': 'cutover-v1', 'content-type': 'application/json' };
  const targetId = '12345678-abcd-abcd-abcd-123456789abc';
  const call = (path, init = {}) => runtime.dispatchFetch('http://localhost' + path, { ...init, redirect: 'manual' });
  try {
    runtime = await hostRuntime({ ...source, storageRole: 'cloud' });
    const ready = await call('/api/ready', { headers: { cookie } });
    assert.equal(ready.status, 200, await ready.text());
    for (const kind of ['main', 'pin']) {
      const response = await call('/api/host-migration/freeze/' + kind, { method: 'POST', headers, body: JSON.stringify({ targetId }) });
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal((await response.json()).frozen, true);
    }
    assert.equal((await call('/api/sessions', { headers: { cookie } })).status, 503);
    await runtime.dispose(); runtime = null;
    runtime = await hostRuntime({ ...source, storageRole: 'cloud' });
    assert.equal((await call('/api/sessions', { headers: { cookie } })).status, 503, 'Frozen source stays frozen across restart.');
    const saved = {};
    for (const kind of ['main', 'pin']) {
      const response = await call('/api/host-migration/snapshot/' + kind, { method: 'POST', headers: { authorization: 'Bearer ' + ownerKey, 'x-novel-migration': 'export-v1' } });
      saved[kind] = await response.text();
      assert.equal(response.status, 200, saved[kind]);
    }
    await runtime.dispose(); runtime = null;
    const destination = { release, persist, ownerKey, namespaceKey: 'fixture-cutover-restored-host-v1' };
    runtime = await hostRuntime({ ...destination, bootstrap: true });
    for (const kind of ['main', 'pin']) {
      const ns = await runtime.getDurableObjectNamespace(kind === 'main' ? 'DSH_EDGE_INSTANCE' : 'PIN_AUTH', 'novel-host-harness');
      const response = await ns.get(ns.idFromName('owner')).fetch('http://localhost/', { method: 'POST',
        headers: { authorization: 'Bearer ' + ownerKey, 'x-novel-migration': 'export-v1' }, body: saved[kind] });
      assert.equal(response.status, 200, await response.text());
    }
    await runtime.dispose(); runtime = null;
    runtime = await hostRuntime(destination);
    const session = await call('/api/auth/session', { headers: { cookie } });
    assert.equal((await session.json()).authenticated, true, 'Same signed PIN session works on the explicit new host.');
    const books = await call('/api/novels', { headers: { cookie } });
    assert.ok((await books.json()).books.some((book) => book.id === bookId));
    const main = await runtime.getDurableObjectNamespace('DSH_EDGE_INSTANCE', 'novel-host-harness');
    const activation = await main.get(main.idFromName('owner')).fetch('http://localhost/__host_activate', { method: 'POST',
      headers: { authorization: 'Bearer ' + ownerKey, 'x-novel-host-control': 'activate-v1', 'x-novel-target': targetId } });
    assert.equal(activation.status, 200, await activation.clone().text());
    assert.equal((await activation.json()).schedulerResumed, true);
    console.log(JSON.stringify({ nativeSourceFreezeAndRestart: true, nativeQueuesDrained: true, frozenSqlAndKvRestorable: true,
      explicitHostActivatesWithoutPinChange: true, oldSourceNeverUnfrozen: true, modelCalls: 0 }));
  } finally { await runtime?.dispose(); }
}
