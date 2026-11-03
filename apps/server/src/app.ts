import express, { type Request, type Response, type NextFunction } from 'express';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PIN_PATTERN,
  DB_SCHEMA_VERSION,
  characterInputSchema,
  conflictCopySchema,
  itemInputSchema,
  locationInputSchema,
  organizationInputSchema,
  projectCreateSchema,
  projectPatchSchema,
  projectStatePutSchema,
  projectStatePatchSchema,
  relationInputSchema,
  settingsSchema,
  storyBibleGenerateSchema,
} from '@novel-writer/shared';
import type { NovelDb } from './db.js';
import { Auth, isLoopback } from './auth.js';
import { hashPin, verifyPin } from './crypto.js';
import { Store } from './store.js';

export function createApp(db: NovelDb, store: Store) {
  const app = express(),
    auth = new Auth(db);
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((req, res, next) => {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' https: http:; img-src 'self' data: blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== `${req.protocol}://${req.headers.host}`) {
      return res.status(403).json({ error: '拒绝跨来源请求' });
    }
    next();
  });
  app.use(express.json({ limit: '20mb' }));

  app.get('/api/health', (_req, res) =>
    res.json({ ok: true, version: '5.0.0', schemaVersion: DB_SCHEMA_VERSION, features: { statePatch: 1, rowWiseState: 1 } }),
  );
  app.get('/api/auth/session', (req, res) =>
    res.json({ setup: store.isSetup(), authenticated: auth.check(req), local: isLoopback(req) }),
  );
  app.post('/api/auth/setup', async (req, res, next) => {
    try {
      if (store.isSetup()) return res.status(409).json({ error: '服务已经初始化' });
      if (!isLoopback(req)) return res.status(403).json({ error: '首次设置只能在主机本机完成' });
      const pin = String(req.body?.pin ?? '');
      if (!PIN_PATTERN.test(pin)) return res.status(400).json({ error: 'PIN 必须是四位数字' });
      store.setPinHash(await hashPin(pin));
      auth.create(req, res);
      res.status(201).json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/auth/login', async (req, res, next) => {
    try {
      const ip = req.ip ?? 'unknown',
        status = auth.loginStatus(ip);
      if (status.locked)
        return res.status(429).json({ error: '失败次数过多，请稍后再试', retryAfterMs: status.retryAfterMs });
      const pin = String(req.body?.pin ?? ''),
        stored = store.getPinHash();
      const ok = !!stored && PIN_PATTERN.test(pin) && (await verifyPin(pin, stored));
      auth.record(ip, ok);
      if (!ok) return res.status(401).json({ error: 'PIN 不正确' });
      auth.create(req, res);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });
  app.post('/api/auth/logout', auth.middleware, (req, res) => {
    auth.clear(req, res);
    res.json({ ok: true });
  });

  const api = express.Router();
  api.use(auth.middleware);
  api.get('/projects', (req, res) =>
    res.json({ projects: store.listProjects(req.query.status as string | undefined) }),
  );
  api.post('/projects', (req, res) => {
    const data = projectCreateSchema.parse(req.body);
    res.status(201).json(store.createProject(data));
  });
  api.get('/projects/:id', (req, res) => {
    const p = store.getProject(req.params.id);
    if (!p) return res.status(404).json({ error: '项目不存在' });
    res.json(p);
  });
  api.patch('/projects/:id', (req, res) =>
    res.json(store.patchProject(req.params.id, projectPatchSchema.parse(req.body))),
  );
  api.delete('/projects/:id', (req, res) => {
    if (req.query.permanent === 'true') {
      store.purgeProject(req.params.id);
      return res.status(204).end();
    }
    res.json(store.setStatus(req.params.id, 'trashed', Number(req.body?.expectedRevision)));
  });
  api.post('/projects/:id/duplicate', (req, res) =>
    res.status(201).json(store.duplicateProject(req.params.id)),
  );
  api.post('/projects/:id/conflict-copy', (req, res) => {
    const body = conflictCopySchema.parse(req.body);
    res.status(201).json(store.createConflictCopy(req.params.id, body.state));
  });
  api.post('/projects/:id/archive', (req, res) =>
    res.json(store.setStatus(req.params.id, 'archived', Number(req.body?.expectedRevision))),
  );
  api.post('/projects/:id/restore', (req, res) =>
    res.json(store.setStatus(req.params.id, 'active', Number(req.body?.expectedRevision))),
  );
  api.get('/projects/:id/state', (req, res) => res.json(store.getState(req.params.id)));
  api.put('/projects/:id/state', (req, res) => {
    const body = projectStatePutSchema.parse(req.body);
    res.json(store.putState(req.params.id, body.revision, body.state));
  });
  api.patch('/projects/:id/state', (req, res) => {
    const body = projectStatePatchSchema.parse(req.body);
    res.json(store.patchState(req.params.id, body.revision, body.patch));
  });
  api.post('/projects/:id/story-bible/generate', async (req, res, next) => {
    try {
      const body = storyBibleGenerateSchema.parse(req.body);
      res.json(await store.generateStoryBible(req.params.id, body.expectedRevision));
    } catch (error) {
      next(error);
    }
  });
  api.post('/projects/:id/story-bible/generate-stream', async (req, res) => {
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const send = (event: Record<string, unknown>) => res.write(`${JSON.stringify(event)}\n`);
    try {
      const body = storyBibleGenerateSchema.parse(req.body);
      const result = await store.generateStoryBible(req.params.id, body.expectedRevision, send);
      send({ stage: 'done', message: '人物与地点资料整理完成', result });
    } catch (error: any) {
      send({
        stage: 'error',
        message: error?.message || 'AI 资料整理失败',
        status: Number(error?.status) || 500,
        currentRevision: error?.currentRevision,
      });
    } finally {
      res.end();
    }
  });
  api.get('/projects/:id/chapters/:chapter', (req, res) =>
    res.json(store.getChapter(req.params.id, Number(req.params.chapter))),
  );
  api.put('/projects/:id/chapters/:chapter', (req, res) =>
    res.json(store.putChapter(req.params.id, Number(req.params.chapter), req.body)),
  );

  entityRoutes(api, store, 'characters', 'character', characterInputSchema);
  entityRoutes(api, store, 'locations', 'location', locationInputSchema);
  entityRoutes(api, store, 'items', 'item', itemInputSchema);
  entityRoutes(api, store, 'organizations', 'organization', organizationInputSchema);
  api.get('/projects/:id/relations', (req, res) =>
    res.json({ relations: store.listRelations(req.params.id) }),
  );
  api.post('/projects/:id/relations', (req, res) =>
    res.status(201).json(store.saveRelation(req.params.id, null, relationInputSchema.parse(req.body))),
  );
  api.patch('/projects/:id/relations/:entityId', (req, res) =>
    res.json(store.saveRelation(req.params.id, req.params.entityId, relationInputSchema.parse(req.body))),
  );
  api.delete('/projects/:id/relations/:entityId', (req, res) =>
    res.json(store.deleteRelation(req.params.id, req.params.entityId, Number(req.body?.expectedRevision))),
  );

  api.get('/projects/:id/export', (req, res) => {
    const data = store.getState(req.params.id);
    res.setHeader('Content-Disposition', `attachment; filename="novel-${req.params.id}.json"`);
    res
      .type('application/json')
      .send(
        JSON.stringify(
          { type: 'novel-writer-server-project', version: 1, exportedAt: new Date().toISOString(), ...data },
          null,
          2,
        ),
      );
  });
  api.post('/import/legacy-browser', (req, res) => res.status(201).json(store.importLegacy(req.body)));
  api.get('/settings', (_req, res) => res.json(maskSettings(store.getSettings())));
  api.get('/settings/runtime', (_req, res) => res.json(store.getSettings()));
  api.put('/settings', (req, res) =>
    res.json(maskSettings(store.putSettings(settingsSchema.parse(req.body)))),
  );
  app.use('/api', api);

  const here = resolve(fileURLToPath(new URL('.', import.meta.url)), '../../web/dist');
  const legacyFile = resolve(
    fileURLToPath(new URL('.', import.meta.url)),
    '../../../novel-writer-V4.4.3.html',
  );
  if (existsSync(legacyFile)) {
    app.get('/legacy/novel-writer-V4.4.3.html', (_req, res) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; img-src 'self' data: blob:",
      );
      res.sendFile(legacyFile);
    });
    app.get('/workbench.html', auth.middleware, (_req, res) => {
      const source = readFileSync(legacyFile, 'utf8'),
        at = source.lastIndexOf('</body>');
      const themed = source.replace(
        '</head>',
        '<link rel="stylesheet" href="/pixel-theme.css">\n<link rel="stylesheet" href="/workflow-ui.css">\n<link rel="stylesheet" href="/inspiration-writer.css">\n</head>',
      );
      const adapted =
        at >= 0
          ? `${themed.slice(0, themed.lastIndexOf('</body>'))}<script type="module" src="/state-patch.js"></script>\n<script src="/workbench-adapter.js"></script>\n<script src="/creative-workflow.js"></script>\n<script src="/inspiration-writer.js"></script>\n${themed.slice(themed.lastIndexOf('</body>'))}`
          : themed;
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self' https: http:; img-src 'self' data: blob:",
      );
      res.type('html').send(adapted);
    });
  }
  if (existsSync(here)) {
    app.use(express.static(here));
    app.get('*path', (_req, res) => res.sendFile(resolve(here, 'index.html')));
  }
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = Number(err.status) || (/ZodError/.test(err?.constructor?.name) ? 400 : 500);
    if (status >= 500) console.error(err);
    res
      .status(status)
      .json({ error: err.message || '服务器错误', currentRevision: err.currentRevision, issues: err.issues });
  });
  return app;
}

function entityRoutes(
  router: any,
  store: Store,
  path: string,
  type: 'character' | 'location' | 'item' | 'organization',
  schema: any,
) {
  router.get(`/projects/:id/${path}`, (req: Request, res: Response) =>
    res.json({ [path]: store.listEntities(type, String(req.params.id)) }),
  );
  router.post(`/projects/:id/${path}`, (req: Request, res: Response) =>
    res.status(201).json(store.saveEntity(type, String(req.params.id), null, schema.parse(req.body))),
  );
  router.patch(`/projects/:id/${path}/:entityId`, (req: Request, res: Response) =>
    res.json(
      store.saveEntity(type, String(req.params.id), String(req.params.entityId), schema.parse(req.body)),
    ),
  );
  router.delete(`/projects/:id/${path}/:entityId`, (req: Request, res: Response) =>
    res.json(
      store.deleteEntity(
        type,
        String(req.params.id),
        String(req.params.entityId),
        Number(req.body?.expectedRevision),
      ),
    ),
  );
}
function maskSettings(settings: any) {
  return {
    ...settings,
    apiConfigs: (settings.apiConfigs ?? []).map((cfg: any) => ({
      ...cfg,
      apiKey: cfg.apiKey ? '••••••••' : '',
    })),
  };
}
