import { storageSnapshotResponse, restoreStorageSnapshot } from '../../worker/storage-snapshot.mjs';
export class Store {
  constructor(ctx) { this.ctx = ctx; }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/seed') {
      try { this.ctx.storage.transactionSync(() => {
        for (const sql of [
          'CREATE TABLE parent(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE)',
          'CREATE TABLE child(id INTEGER PRIMARY KEY,p INTEGER REFERENCES parent(id),payload BLOB)',
          "INSERT INTO parent(id,name) VALUES(50,'书稿')",
          "INSERT INTO child VALUES(9223372036854775807,50,X'00FF0100')",
          'CREATE INDEX child_parent ON child(p)',
        ]) {
          try { this.ctx.storage.sql.exec(sql); }
          catch (error) { throw new Error('Synthetic seed SQL failed: ' + sql + ': ' + error.message); }
        }
        this.ctx.storage.kv.put('credentials', { apiKey: 'fixture-not-real', provider: 'fixture' });
        const graph = { date: new Date(12345), bytes: new Uint8Array([0, 255, 11]), map: new Map([['model', 'fixture']]) };
        graph.self = graph;
        this.ctx.storage.kv.put('graph', graph);
      }); } catch (error) { return Response.json({ error: error.message }, { status: 503 }); }
      return Response.json({ seeded: true });
    }
    if (path === '/snapshot') return storageSnapshotResponse(this.ctx, 'main');
    if (path === '/restore') {
      try { return Response.json(restoreStorageSnapshot(this.ctx.storage, await request.text())); }
      catch (error) { return Response.json({ error: error.message }, { status: 409 }); }
    }
    return new Response('', { status: 404 });
  }
}
export default { fetch() { return new Response('', { status: 404 }); } };
