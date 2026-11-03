export const FREEZE_KEY = 'novel-host-migration-freeze-v1';
export const CUTOVER_PATH = '/api/host-migration/freeze/';
const headers = { 'cache-control': 'no-store', 'retry-after': '3' };
export const maintenanceResponse = () => Response.json({ error: '正在切换到本机存储，请稍后重新连接；已保存数据保留，未启用旧库回退。', maintenance: true }, { status: 503, headers });
const equal = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || b.length < 32) return false;
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) mismatch |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return mismatch === 0;
};
export function hostControlAuthorized(request, env, scope) {
  const origin = request.headers.get('origin');
  return equal(request.headers.get('authorization'), 'Bearer ' + env.DSH_EDGE_ACCESS_KEY)
    && typeof env.DSH_EDGE_ACCESS_KEY === 'string' && env.DSH_EDGE_ACCESS_KEY.length >= 32
    && request.headers.get('x-novel-host-control') === scope
    && (!origin || origin === new URL(request.url).origin);
}
export function initialFreeze(ctx, env) {
  return env.NOVEL_STORAGE_ROLE === 'host' ? null : ctx.storage.kv?.get(FREEZE_KEY) ?? null;
}
export async function hostLeaseFetch(instance, request) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/__host_lease/')) return null;
  if (request.method !== 'POST' || !hostControlAuthorized(request, instance.env, 'lease-v1')) return new Response('', { status: 404 });
  const leases = instance.hostRequestLeases ??= new Set();
  if (path === '/__host_lease/enter') {
    if (instance.hostFreezeState) return maintenanceResponse();
    if (leases.size >= 2048) return new Response('', { status: 503 });
    const token = crypto.randomUUID(); leases.add(token);
    return Response.json({ token }, { headers: { 'cache-control': 'no-store' } });
  }
  const token = request.headers.get('x-novel-lease');
  if (path === '/__host_lease/leave' && typeof token === 'string') {
    leases.delete(token); return new Response(null, { status: 204 });
  }
  return new Response('', { status: 404 });
}
export async function withHostLease(request, env, ctx, run) {
  if (env.NOVEL_STORAGE_ROLE === 'host' || new URL(request.url).pathname === '/api/health') return run();
  const owner = env.DSH_EDGE_INSTANCE.getByName('owner');
  const control = { authorization: 'Bearer ' + env.DSH_EDGE_ACCESS_KEY, 'x-novel-host-control': 'lease-v1' };
  const entered = await owner.fetch(new Request('https://host.internal/__host_lease/enter', { method: 'POST', headers: control }));
  if (!entered.ok) return entered;
  const { token } = await entered.json();
  try { return await run(); }
  finally {
    await owner.fetch(new Request('https://host.internal/__host_lease/leave', { method: 'POST', headers: { ...control, 'x-novel-lease': token } }));
  }
}
async function controlInput(request) {
  const reader = request.body?.getReader(); let bytes = 0; const chunks = [];
  try {
    if (reader) while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 2048) { await reader.cancel(); throw new Error('Invalid control body.'); }
      chunks.push(value);
    }
  } finally { reader?.releaseLock(); }
  const joined = new Uint8Array(bytes); let offset = 0;
  for (const part of chunks) { joined.set(part, offset); offset += part.length; }
  const input = JSON.parse(new TextDecoder('utf8', { fatal: true }).decode(joined));
  if (!/^[a-f0-9-]{36}$/.test(input?.targetId ?? '')) throw new Error('Invalid cutover target.');
  return input;
}
export async function cutoverGateway(request, env) {
  const path = new URL(request.url).pathname;
  if (!path.startsWith(CUTOVER_PATH)) return null;
  if (env.NOVEL_STORAGE_ROLE === 'host' || request.method !== 'POST' || !hostControlAuthorized(request, env, 'cutover-v1'))
    return new Response('', { status: 404 });
  const kind = path.slice(CUTOVER_PATH.length);
  if (!['main', 'pin'].includes(kind)) return new Response('', { status: 404 });
  const owner = (kind === 'main' ? env.DSH_EDGE_INSTANCE : env.PIN_AUTH).getByName('owner');
  return owner.fetch(new Request('https://host.internal/__host_freeze', {
    method: 'POST', body: request.body, duplex: 'half', headers: {
      authorization: request.headers.get('authorization'), 'x-novel-host-control': 'cutover-v1',
    },
  }));
}
// No arbitrary timeout-based release of admitted work. Failed draining unblocks
// the SAME source before a target can be activated; a completed freeze persists.
export async function freezeHostStore(instance, request, { kind, ensureIdle = () => {}, closeChannels = () => {} }) {
  if (instance.env.NOVEL_STORAGE_ROLE === 'host' || request.method !== 'POST' || !hostControlAuthorized(request, instance.env, 'cutover-v1'))
    return new Response('', { status: 404 });
  let targetId;
  try { ({ targetId } = await controlInput(request)); } catch { return new Response('', { status: 400 }); }
  if (instance.hostFreezeState?.phase === 'frozen') return instance.hostFreezeState.targetId === targetId
    ? Response.json({ frozen: true, kind, targetId, noAIStopped: true }, { headers }) : new Response('', { status: 409 });
  const entered = await instance.ctx.blockConcurrencyWhile(async () => {
    try {
      ensureIdle();
      const alarm = await instance.ctx.storage.getAlarm(); ensureIdle();
      const flag = { version: 1, phase: 'draining', kind, targetId, originalAlarm: alarm, at: new Date().toISOString() };
      instance.ctx.storage.kv.put(FREEZE_KEY, flag); instance.hostFreezeState = flag;
      return true;
    } catch { return false; }
  });
  if (!entered) return Response.json({ error: '原生任务仍在运行或状态未能确认；未暂停它们。', frozen: false }, { status: 409, headers });
  const until = Date.now() + 15000;
  while (instance.hostRequestLeases?.size && Date.now() < until) await new Promise((done) => setTimeout(done, 25));
  const frozen = await instance.ctx.blockConcurrencyWhile(async () => {
    try {
      if (instance.hostRequestLeases?.size) throw new Error('Admitted requests did not drain.');
      ensureIdle();
      const flag = { ...instance.hostFreezeState, phase: 'frozen' };
      instance.ctx.storage.kv.put(FREEZE_KEY, flag); instance.hostFreezeState = flag;
      await instance.ctx.storage.deleteAlarm();
      closeChannels(); await instance.ctx.storage.sync();
      return true;
    } catch {
      // A completed frozen marker is never silently reverted: the target could
      // already rely on it. Only failed pre-freeze draining can unblock source.
      if (instance.hostFreezeState?.phase === 'draining') {
        instance.ctx.storage.kv.delete(FREEZE_KEY); instance.hostFreezeState = null;
      }
      return false;
    }
  });
  return Response.json({ frozen, kind, targetId, noAIStopped: true }, { status: frozen ? 200 : 409, headers });
}
