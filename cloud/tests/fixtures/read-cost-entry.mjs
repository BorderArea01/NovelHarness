// LOCAL FIXTURE ONLY. Never imported by the release entry. Transparent native
// SQL cursors are observed after consumption, using Cloudflare's rowsRead API.
import main, { DshEdgeInstance as CurrentInstance } from './entry.mjs';
import { nativeWorkspace } from './native-workspace.mjs';
export { PinAuth } from './entry.mjs';
export class DshEdgeInstance extends CurrentInstance {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== '/__local_read_cost') return super.fetch(request);
    if (this.env.NOVEL_EDITOR_DIAGNOSTICS !== 'local-fixture') return new Response(null, { status: 404 });
    const target = url.searchParams.get('target');
    if (
      !/^\/__novel_editor\/b-[a-f0-9]{32}\/(documents|document|changes|writingRun)(?:\?|$)/.test(target ?? '')
    )
      return new Response(null, { status: 400 });
    const { fs } = await nativeWorkspace(this);
    const sql = fs.db.sql,
      cursors = [];
    fs.db.sql = {
      exec: (...args) => {
        const cursor = sql.exec(...args);
        cursors.push(cursor);
        return cursor;
      },
    };
    let response;
    try {
      response = await super.fetch(new Request('http://fixture.internal' + target));
    } finally {
      fs.db.sql = sql;
    }
    return Response.json({
      rowsRead: cursors.reduce((sum, cursor) => sum + cursor.rowsRead, 0),
      rowsWritten: cursors.reduce((sum, cursor) => sum + cursor.rowsWritten, 0),
      queries: cursors.length,
      status: response.status,
      value: await response.json(),
    });
  }
}
export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/__local_read_cost' && env.NOVEL_EDITOR_DIAGNOSTICS === 'local-fixture') {
      url.pathname = '/__local_read_cost';
      return env.DSH_EDGE_INSTANCE.getByName('owner').fetch(new Request(url, request));
    }
    return main.fetch(request, env, ctx);
  },
};
