// LOCAL, isolated restore runtime only. The production entry never imports this.
// No native constructor, scheduler, AI or writable website is started here.
import { migrationAuthorized, restoreStorageSnapshot, storageSnapshotResponse } from '../worker/storage-snapshot.mjs';
import { beginPagedRestore, restoreStoragePage, commitPagedRestore } from '../worker/storage-pages.mjs';
class RestoreStore {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }
  async fetch(request) {
    if (!migrationAuthorized(request, this.env)) return new Response('', { status: 404 });
    if (request.method === 'GET') return storageSnapshotResponse(this.ctx, this.kind, () => {}, request, true);
    if (request.method !== 'POST') return new Response('', { status: 405 });
    const text = await request.text();
    try {
      const path = new URL(request.url).pathname;
      if (path === '/begin') { this.progress = beginPagedRestore(this.ctx.storage, JSON.parse(text), this.kind); return Response.json({ started: true }); }
      if (path === '/page') { const data = JSON.parse(text); restoreStoragePage(this.ctx.storage, this.progress, data.page, data.ordinal); return Response.json({ restored: true }); }
      if (path === '/commit') return Response.json(commitPagedRestore(this.ctx.storage, this.progress, JSON.parse(text)));
      return Response.json(restoreStorageSnapshot(this.ctx.storage, text));
    } catch {
      return Response.json({ error: '恢复失败，目标事务已回滚；不会覆盖已有目标。' }, { status: 409 });
    }
  }
}
export class DshEdgeInstance extends RestoreStore { kind = 'main'; }
export class PinAuth extends RestoreStore { kind = 'pin'; }
export default { fetch() { return new Response('', { status: 404 }); } };
