import native from './native/index.js';
import { handlePinRequest } from './pin-gateway.mjs';
import { DshEdgeInstance as NativeDshEdgeInstance } from './native/index.js';
import { nativeWorkspace, nativeBookTitle, bookIsGenerating } from './native-workspace.mjs';
import { makeDocumentService, DocumentError } from './novel-documents.mjs';
import { novelGateway } from './novel-gateway.mjs';
import { REQUEST_LIMIT } from './document-storage.mjs';
import { installNovelRole } from './novel-role.mjs';
import { installWritingRunTools } from './writing-run-tools.mjs';
import { installProposalTools } from './proposal-tools.mjs';
import { novelRoot } from './novel-role.mjs';
import { bootstrapBook, listBooks, BOOTSTRAP_LIMIT } from './book-catalog.mjs';
import { manageBook, listTrashedBooks } from './book-lifecycle.mjs';
import { createReadSnapshots, readWorkspaceRevision } from './read-snapshot.mjs';
import { serviceFailure } from './service-failure.mjs';
import {
  migrationSnapshotGateway,
  migrationAuthorized,
  storageSnapshotResponse,
  nativeSnapshotIdle,
} from './storage-snapshot.mjs';
import {
  initialFreeze,
  hostLeaseFetch,
  withHostLease,
  cutoverGateway,
  freezeHostStore,
  maintenanceResponse,
  hostControlAuthorized,
  FREEZE_KEY,
} from './host-cutover.mjs';
export { PinAuth } from './pin-store.mjs';
// Keep the ORIGINAL class/binding/namespace identity and inherit all upstream
// sessions, RPC, sockets, alarms and credentials. Novel routes use that same owner.
export class DshEdgeInstance extends NativeDshEdgeInstance {
  constructor(ctx, env) {
    super(ctx, env);
    this.hostFreezeState = initialFreeze(ctx, env);
    this.novelReadSnapshots = createReadSnapshots();
    if (this.hostFreezeState) return; // Do not initialize frozen cloud Agents.
    // Register synchronously on the ORIGINAL Cordis context, before native
    // initialization can admit a model turn (including alarms/cold resumes).
    installNovelRole(this.sessions.context, {
      readBookTitle: (root) => nativeBookTitle(this, root),
    });
    installWritingRunTools(this);
    installProposalTools(this);
  }
  async alarm(...args) {
    if (this.hostFreezeState) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    return super.alarm(...args);
  }
  webSocketMessage(socket, ...args) {
    if (this.hostFreezeState?.phase === 'frozen') {
      socket.close(1012, 'storage cutover');
      return;
    }
    return super.webSocketMessage(socket, ...args);
  }
  webSocketClose(socket, ...args) {
    if (this.hostFreezeState?.phase === 'frozen') return;
    return super.webSocketClose(socket, ...args);
  }
  webSocketError(socket, ...args) {
    if (this.hostFreezeState?.phase === 'frozen') {
      socket.close(1012, 'storage cutover');
      return;
    }
    return super.webSocketError(socket, ...args);
  }
  async fetch(request) {
    if (new URL(request.url).pathname === '/__host_activate') {
      if (
        this.env.NOVEL_STORAGE_ROLE !== 'host' ||
        request.method !== 'POST' ||
        !hostControlAuthorized(request, this.env, 'activate-v1')
      )
        return new Response('', { status: 404 });
      const marker = this.ctx.storage.kv.get(FREEZE_KEY);
      if (marker?.phase !== 'frozen' || marker.targetId !== request.headers.get('x-novel-target'))
        return new Response('', { status: 409 });
      await this.sessions.waitForInitialization();
      await this.scheduleMainWake();
      return Response.json({ activated: true, schedulerResumed: true, targetId: marker.targetId });
    }
    const lease = await hostLeaseFetch(this, request);
    if (lease) return lease;
    if (new URL(request.url).pathname === '/__host_freeze') {
      if (!this.hostFreezeState) await this.sessions.waitForInitialization();
      return freezeHostStore(this, request, {
        kind: 'main',
        ensureIdle: () => {
          if (this.hostFreezeState?.phase === 'frozen') return;
          nativeSnapshotIdle(this);
          if (
            typeof this.mainQueue?.hasWork !== 'function' ||
            this.mainQueue.hasWork() ||
            this.mainQueue.current() !== undefined
          )
            throw new Error('Native queued work has not drained.');
        },
        closeChannels: () => {
          for (const socket of this.ctx.getWebSockets()) socket.close(1012, 'storage cutover');
        },
      });
    }
    if (new URL(request.url).pathname === '/__private_storage_snapshot') {
      if (request.method !== 'POST' || !migrationAuthorized(request, this.env))
        return new Response('', { status: 404 });
      if (!this.hostFreezeState) await this.sessions.waitForInitialization();
      return storageSnapshotResponse(
        this.ctx,
        'main',
        () => {
          if (!this.hostFreezeState) nativeSnapshotIdle(this);
        },
        request,
        this.env.NOVEL_STORAGE_ROLE === 'host',
      );
    }
    if (this.hostFreezeState?.phase === 'frozen') return maintenanceResponse();
    if (new URL(request.url).pathname === '/__novel_purge') return new Response('', { status: 410 });
    const url = new URL(request.url),
      match = /^\/__novel_editor\/(b-[a-f0-9]{32})\/(\w+)$/.exec(url.pathname);
    const catalog = url.pathname === '/__novel_catalog';
    if (!match && !catalog) return super.fetch(request);
    try {
      await this.sessions.waitForInitialization();
      if (catalog) {
        const { fs, db } = await nativeWorkspace(this);
        return Response.json(
          url.searchParams.get('trash') === '1' ? listTrashedBooks(fs, db) : listBooks(fs, db),
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      let input = {};
      if (!['GET', 'HEAD'].includes(request.method)) {
        const reader = request.body?.getReader();
        let size = 0;
        const chunks = [];
        if (reader)
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              const limit =
                match[2] === 'bootstrap'
                  ? BOOTSTRAP_LIMIT
                  : match[2] === 'document'
                    ? REQUEST_LIMIT
                    : match[2] === 'chapterOrder'
                      ? 2 * 1024 * 1024
                      : 1100000;
              if (size > limit) {
                await reader.cancel();
                throw new DocumentError(413, '请求过大，原文未修改。');
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        const joined = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          joined.set(chunk, offset);
          offset += chunk.length;
        }
        try {
          input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(joined));
        } catch {
          throw new DocumentError(400, '请求格式不正确。');
        }
        if (!input || typeof input !== 'object' || Array.isArray(input))
          throw new DocumentError(400, '请求格式不正确。');
      }
      if (match[2] === 'bootstrap') {
        const { fs, db } = await nativeWorkspace(this);
        return Response.json(bootstrapBook(fs, db, match[1], input), {
          headers: { 'cache-control': 'no-store' },
        });
      }
      if (match[2] === 'lifecycle') {
        const { fs, db } = await nativeWorkspace(this);
        return Response.json(
          manageBook(fs, db, match[1], input, {
            isGenerating: () => bookIsGenerating(this, '/workspace/novels/' + match[1]),
          }),
          { headers: { 'cache-control': 'no-store' } },
        );
      }
      const { fs, db } = await nativeWorkspace(this);
      const snapshots = this.novelReadSnapshots;
      const kind =
        { documents: 'list', document: request.method === 'GET' ? 'read' : 'save', proposals: 'propose' }[
          match[2]
        ] ?? match[2];
      // This registry is the original in-memory owner after initialization.
      // Titles may change without touching book.json/VFS; include them in the
      // snapshot identity rather than serving a stale cached book heading.
      const bookTitle = ['identity', 'list', 'propose', 'writingRun', 'changes'].includes(kind)
        ? await nativeBookTitle(this, '/workspace/novels/' + match[1])
        : undefined;
      // One primary-key lookup even for old clients which still request the
      // complete directory every four seconds. Never cache a mutation/CAS read.
      const cacheable =
        request.method === 'GET' &&
        ['documents', 'document', 'review', 'writingRun', 'changes'].includes(match[2]);
      const revision = cacheable ? readWorkspaceRevision(fs) : null;
      if (match[2] === 'changes') {
        if (request.method !== 'GET') throw new DocumentError(405, '不支持此请求方式。');
        return Response.json(
          {
            revision:
              snapshots.token(revision) +
              ':' +
              JSON.stringify(bookTitle ?? '') +
              ':' +
              bookIsGenerating(this, '/workspace/novels/' + match[1]),
          },
          {
            headers: { 'cache-control': 'no-store' },
          },
        );
      }
      const cacheKey = cacheable
        ? url.pathname +
          url.search +
          ':' +
          JSON.stringify(bookTitle ?? '') +
          ':' +
          bookIsGenerating(this, '/workspace/novels/' + match[1])
        : null;
      const cached = cacheable ? snapshots.get(cacheKey, revision) : null;
      if (cached !== null)
        return new Response(cached, {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      if (kind === 'writingRun' && input.action === 'create') {
        const host = this.sessions.context;
        const agent = host.get('agents').get(input.originSessionId);
        if (
          !agent ||
          novelRoot(host.get('workingDirectory').get(agent.session)) !== '/workspace/novels/' + match[1]
        )
          throw new DocumentError(409, '原生小说对话未就绪或不属于本书，未创建连写任务。');
      }
      // Drafts can be inspected while the native stream runs. Acceptance waits
      // for it to finish; no partial growing proposal is silently published.
      const ensureIdle = () => {
        if (
          (kind === 'accept' ||
            (kind === 'chapterOrder' && input.action === 'apply') ||
            (kind === 'propose' && input.resumeId !== undefined)) &&
          bookIsGenerating(this, '/workspace/novels/' + match[1])
        )
          throw new DocumentError(
            409,
            kind === 'chapterOrder'
              ? 'AI 仍在生成，可以继续浏览；结束或停止后再确认重排。'
              : kind === 'propose'
                ? 'AI 仍在生成；结束或停止后再继续当前候选。'
                : 'AI 仍在生成，可以继续浏览；完成后再接受提案。',
          );
      };
      ensureIdle();
      if (kind === 'propose' && input.resumeId !== undefined) {
        if (
          typeof input.originSessionId !== 'string' ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(input.originSessionId)
        )
          throw new DocumentError(400, '继续候选需要当前原生对话。');
        const host = this.sessions.context;
        const summary = host.get('agents').get(input.originSessionId)
          ? null
          : await this.sessions.getApiSessionSummary(input.originSessionId);
        const agent = host.get('agents').get(input.originSessionId);
        const directory = agent ? host.get('workingDirectory').get(agent.session) : summary?.cwd;
        if (novelRoot(directory) !== '/workspace/novels/' + match[1])
          throw new DocumentError(403, '继续候选的对话不属于本书，未转移提交权。');
      }
      ensureIdle();
      const result = makeDocumentService(fs, db, match[1], {
        isGenerating: () => bookIsGenerating(this, '/workspace/novels/' + match[1]),
        runKey: this.env.DSH_EDGE_ACCESS_KEY,
        bookTitle,
      }).run({
        ...input,
        kind,
        path: url.searchParams.get('path') ?? input.path,
        id: url.searchParams.get('id') ?? input.id,
        hash: url.searchParams.get('hash') ?? input.hash,
        after: url.searchParams.get('after') ?? input.after,
        ...(kind === 'illustrations' && request.method === 'GET'
          ? {
              action: url.searchParams.get('action') ?? 'list',
              imagePath: url.searchParams.get('imagePath'),
              cursor: url.searchParams.get('cursor') ?? undefined,
            }
          : {}),
        ...(kind === 'writingRun'
          ? { action: input.action ?? (url.searchParams.get('id') ? 'get' : 'list') }
          : {}),
      });
      if (cacheable) {
        // Reads may reconcile native checkpoints. Stamp only after the service
        // returns, synchronously, with no intervening await or other writer.
        const body = snapshots.put(cacheKey, readWorkspaceRevision(fs), result);
        return new Response(body, {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      if (this.env.NOVEL_EDITOR_DIAGNOSTICS === 'local-fixture')
        console.error('Local fixture manuscript failure:', error.stack ?? String(error));
      const failure = serviceFailure(error);
      return Response.json(
        {
          ...(error instanceof DocumentError ? { error: error.message } : failure.body),
          ...(error instanceof DocumentError ? error.extra : {}),
        },
        {
          status: error instanceof DocumentError ? error.status : error.code === 'ENOENT' ? 404 : 503,
          headers: {
            'cache-control': 'no-store',
            ...(error instanceof DocumentError ? {} : failure.headers),
          },
        },
      );
    }
  }
}
const extended = { fetch: (request, env, ctx) => novelGateway(request, env, ctx, native) };
export default {
  fetch: async (request, env, ctx) =>
    (await cutoverGateway(request, env)) ??
    (await migrationSnapshotGateway(request, env)) ??
    withHostLease(request, env, ctx, () => handlePinRequest(request, env, ctx, extended)),
};
