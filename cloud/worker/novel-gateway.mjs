import { LEGACY_DEFAULT_PROMPTS, PROMPT_LABELS } from './prompt-templates.mjs';
const json = (body, status = 200) =>
  Response.json(body, {
    status,
    headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
export async function novelGateway(request, env, ctx, native) {
  const url = new URL(request.url);
  const route =
    /^\/api\/novels\/(b-[a-f0-9]{32})\/(bootstrap|lifecycle|identity|documents|document|content|changes|proposals|review|accept|reject|history|outline-chapter|chapter-title|chapter-order|writing-run|adopt-draft|illustrations)$/.exec(
      url.pathname,
    );
  const templates = url.pathname === '/api/novel-prompt-templates';
  const purge = url.pathname === '/api/novel-plugins/dsh-purge';
  const catalog = url.pathname === '/api/novels';
  if (!route && !templates && !catalog && !purge) return native.fetch(request, env, ctx);
  const session = await native.fetch(
    new Request(new URL('/api/auth/session', url), {
      headers: { cookie: request.headers.get('cookie') ?? '' },
    }),
    env,
    ctx,
  );
  if (!session.ok) return json({ error: '原生认证服务不可用。' }, 503);
  if ((await session.json()).authenticated !== true) return json({ error: '请先登录。' }, 401);
  if (purge) {
    return json({ error: '小说适配版入口已退役；完整版使用 dsh-purge 原生入口。' }, 410);
  }
  if (catalog) {
    if (request.method !== 'GET') return json({ error: '不支持此请求方式。' }, 405);
    return env.DSH_EDGE_INSTANCE.getByName('owner').fetch(
      new Request('https://novel.internal/__novel_catalog' + url.search, request),
    );
  }
  if (templates)
    return request.method === 'GET'
      ? json({
          version: 1,
          defaults: LEGACY_DEFAULT_PROMPTS,
          labels: PROMPT_LABELS,
        })
      : json({ error: '不支持此请求方式。' }, 405);
  const allowed = {
    bootstrap: ['POST'],
    lifecycle: ['POST'],
    identity: ['GET'],
    documents: ['GET'],
    changes: ['GET'],
    document: ['GET', 'PUT'],
    content: ['GET', 'POST'],
    proposals: ['POST'],
    review: ['GET'],
    accept: ['POST'],
    reject: ['POST'],
    history: ['GET'],
    'outline-chapter': ['POST'],
    'chapter-title': ['POST'],
    'chapter-order': ['GET', 'POST'],
    'writing-run': ['GET', 'POST'],
    'adopt-draft': ['POST'],
    illustrations: ['GET', 'POST'],
  };
  if (!allowed[route[2]].includes(request.method)) return json({ error: '不支持此请求方式。' }, 405);
  return env.DSH_EDGE_INSTANCE.getByName('owner').fetch(
    new Request(
      'https://novel.internal/__novel_editor/' +
        route[1] +
        '/' +
        ({
          'outline-chapter': 'outlineChapter',
          'chapter-title': 'chapterTitle',
          'chapter-order': 'chapterOrder',
          'writing-run': 'writingRun',
          'adopt-draft': 'adoptDraft',
        }[route[2]] ?? route[2]) +
        url.search,
      request,
    ),
  );
}
