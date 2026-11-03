import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type NovelDb } from './db.js';
import { loadOrCreateKey } from './crypto.js';
import { Store } from './store.js';
import { createApp } from './app.js';
import Database from 'better-sqlite3';
import { applyStatePatch, createStatePatch, normalizeStateDocument } from '@novel-writer/shared';

function createV2Fixture(path: string, rejectMigration = false) {
  const legacy = new Database(path);
  try {
    legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);
      INSERT INTO schema_migrations VALUES(2,'2026-01-01');
      CREATE TABLE projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,genre TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',
        revision INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_opened_at TEXT,deleted_at TEXT);
      INSERT INTO projects(id,title,created_at,updated_at) VALUES('legacy-book','旧书','2026-01-01','2026-01-01');`);
    for (const table of ['chapter_snapshots', 'operation_logs', 'agent_edit_history']) {
      legacy.exec(`CREATE TABLE ${table}(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,data TEXT NOT NULL)`);
      const insert = legacy.prepare(`INSERT INTO ${table} VALUES(?,'legacy-book',?)`);
      for (const name of ['z', 'a', 'm']) insert.run(`${table}-${name}`, JSON.stringify({ chapter: 1, content: `旧内容 ${name}` }));
    }
    if (rejectMigration) legacy.exec(`CREATE TRIGGER reject_v3 BEFORE INSERT ON schema_migrations WHEN NEW.version=3
      BEGIN SELECT RAISE(ABORT,'injected migration failure'); END;`);
  } finally { legacy.close(); }
}

describe('LAN service API', () => {
  let dir: string, db: NovelDb, store: Store, agent: ReturnType<typeof request.agent>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'novel-writer-'));
    db = openDatabase(join(dir, 'test.sqlite'));
    store = new Store(db, loadOrCreateKey(join(dir, 'server.key')));
    agent = request.agent(createApp(db, store));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates inspiration projects atomically and preserves the writing lane across copies', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    await agent.post('/api/projects').send({ inspiration: '   ' }).expect(400);
    await agent
      .post('/api/projects')
      .send({ inspiration: 'x'.repeat(20001) })
      .expect(400);
    const seed = '钟声响起，城里有一个人被所有人遗忘。';
    const project = (await agent.post('/api/projects').send({ title: '钟声', inspiration: seed }).expect(201))
      .body;
    const initial = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    expect(initial.revision).toBe(0);
    expect(initial.state.uiDrafts.inspirationWriter).toMatchObject({
      seed,
      phase: 'idle',
      pendingChapter: 1,
    });
    expect(initial.state.project.wordsPerChapter).toBe(2200);
    expect(initial.state.chapters).toEqual([]);
    expect((await agent.get('/api/projects')).body.projects[0].writingMode).toBe('inspiration');
    const copy = (
      await agent.post(`/api/projects/${project.id}/duplicate`).send({ expectedRevision: 0 }).expect(201)
    ).body;
    expect(
      (await agent.get(`/api/projects/${copy.id}/state`)).body.state.uiDrafts.inspirationWriter.seed,
    ).toBe(seed);
    expect((await agent.get(`/workbench.html?project=${project.id}`)).text).toContain(
      '/inspiration-writer.js',
    );
    const ordinary = (await agent.post('/api/projects').send({ title: '完整模式' }).expect(201)).body;
    expect((await agent.get(`/api/projects/${ordinary.id}/state`)).body.state.project.wordsPerChapter).toBe(
      10000,
    );
  });

  it('saves small patches atomically and keeps strict version and content preconditions', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = store.createProject({ title: '增量保存' })!;
    const initial = store.getState(project.id);
    store.putState(project.id, 0, {
      ...initial.state,
      chapters: [{ chapter: 1, content: '原稿' }],
      operationLogs: [{ id: 'old', message: '旧记录' }],
      uiDrafts: { note: '原备注' },
    });
    const baseline = normalizeStateDocument(store.getState(project.id).state);
    const revision = store.getProject(project.id)!.revision;
    const next = structuredClone(baseline);
    next.chapters[0].content = '新稿';
    next.operationLogs.unshift({ id: 'new', message: '新增记录' });
    const patch = createStatePatch(baseline, next);
    await request(createApp(db, store))
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision, patch })
      .expect(401);
    await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: revision - 1, patch })
      .expect(409);
    const invalid = structuredClone(patch);
    invalid.operations.push({ op: 'replace', path: '/absent/path', value: '失败时不能留下前面一半改动' });
    const rejected = await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision, patch: invalid })
      .expect(422);
    expect(rejected.text).not.toContain('原稿');
    expect(store.getState(project.id).state.chapters[0].content).toBe('原稿');
    expect(store.getProject(project.id)!.revision).toBe(revision);
    const saved = await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision, patch })
      .expect(200);
    expect(saved.body.revision).toBe(revision + 1);
    expect(store.getState(project.id).state.operationLogs.map((row: any) => row.id)).toEqual(['new', 'old']);
    await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision, patch: { operations: [], arrays: [], missing: [] } })
      .expect(409);
    const unchanged = await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: revision + 1, patch: { operations: [], arrays: [], missing: [] } })
      .expect(200);
    expect(unchanged.body).toMatchObject({ revision: revision + 1, unchanged: true });
    const poisoned = {
      operations: [{ op: 'add', path: '/__proto__/polluted', value: true }],
      arrays: [],
      missing: [],
    };
    await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: revision + 1, patch: poisoned })
      .expect(422);
    expect(({} as any).polluted).toBeUndefined();
  });

  it('keeps large existing history when only a small chapter edit is transferred', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = store.createProject({ title: '超过全量请求限制的旧历史' })!;
    const initial = store.getState(project.id).state;
    const archived = 'x'.repeat(540_000);
    store.putState(project.id, 0, {
      ...initial,
      chapters: [{ chapter: 1, content: '旧章' }],
      chapterSnapshots: Array.from({ length: 40 }, (_, i) => ({
        id: `snapshot-${i}`,
        chapter: 1,
        content: archived,
      })),
    });
    const baseline = normalizeStateDocument(store.getState(project.id).state);
    const next = structuredClone(baseline);
    next.chapters[0].content = '只改这一个章节';
    next.chapterSnapshots.push({ id: 'latest', chapter: 1, content: '旧章' });
    const patch = createStatePatch(baseline, next);
    const packet = { revision: store.getProject(project.id)!.revision, patch };
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(5000);
    expect(archived.length * 40).toBeGreaterThan(20 * 1024 * 1024);
    await agent.patch(`/api/projects/${project.id}/state`).send(packet).expect(200);
    const saved = store.getState(project.id).state;
    expect(saved.chapters[0].content).toBe('只改这一个章节');
    expect(saved.chapterSnapshots).toHaveLength(41);
    expect(saved.chapterSnapshots[0].content).toBe(archived);
    const cleared = normalizeStateDocument(saved);
    cleared.chapterSnapshots = [];
    const deletion = createStatePatch(normalizeStateDocument(saved), cleared);
    expect(Buffer.byteLength(JSON.stringify(deletion))).toBeLessThan(8000);
    await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: store.getProject(project.id)!.revision, patch: deletion })
      .expect(200);
    expect(store.getState(project.id).state.chapterSnapshots).toEqual([]);
    expect(store.getState(project.id).state.chapters[0].content).toBe('只改这一个章节');
  });

  it('gives legacy history stable identities and conflicts on concurrent log-only edits', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = store.createProject({ title: '旧历史' })!;
    store.putState(project.id, 0, {
      ...store.getState(project.id).state,
      chapterSnapshots: [{ chapter: 1, content: '旧版快照，没有 id' }],
      operationLogs: [],
    });
    const before = normalizeStateDocument(store.getState(project.id).state);
    expect(before.chapterSnapshots[0].id).toBeTruthy();
    expect(store.getState(project.id).state.chapterSnapshots[0].id).toBe(before.chapterSnapshots[0].id);
    const version = store.getProject(project.id)!.revision;
    const local = structuredClone(before);
    local.operationLogs.push({ id: 'local', message: '本地日志' });
    const remote = structuredClone(before);
    remote.operationLogs.push({ id: 'remote', message: '另一设备日志' });
    const saved = await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: version, patch: createStatePatch(before, remote) })
      .expect(200);
    expect(saved.body.revision).toBe(version + 1);
    await agent
      .patch(`/api/projects/${project.id}/state`)
      .send({ revision: version, patch: createStatePatch(before, local) })
      .expect(409);
    expect(store.getState(project.id).state.operationLogs[0].message).toBe('另一设备日志');
  });

  it('round-trips identity-aware arrays, nested edits, deletions, nullable values and escaped keys', () => {
    for (let n = 0; n < 100; n++) {
      const before = {
        'a/b': { '~field': n },
        records: [
          { id: 'a', text: '原稿', tags: ['一', '二'], nested: { old: true } },
          { id: 'b', text: '另一份', tags: ['三'], nested: {} },
        ],
        optional: '可删除',
      };
      const after = {
        'a/b': { '~field': n + 1 },
        records: [
          { id: 'new', text: '插入', tags: [], nested: { new: null } },
          { id: 'b', text: '已改', tags: ['三', '四'], nested: { added: true } },
          ...(n % 2 ? [{ id: 'a', text: '原稿', tags: ['一', '二'], nested: { old: true } }] : []),
        ],
      };
      const patch = createStatePatch(before, after);
      expect(applyStatePatch(before, patch)).toEqual(after);
      expect(before.records[0].text).toBe('原稿');
      const altered = structuredClone(before);
      altered.records.push({ id: 'unexpected', text: '另一个设备的记录', tags: [], nested: {} });
      expect(() => applyStatePatch(altered, patch)).toThrow();
    }
  });

  it('updates only a changed chapter and leaves unchanged history, metadata and memory cards alone', () => {
    const project = store.createProject({ title: '行级保存' })!;
    const initial = store.getState(project.id).state;
    store.putState(project.id, 0, { ...initial,
      chapters: Array.from({ length: 200 }, (_, i) => ({ chapter: i + 1, content: `正文 ${i + 1}` })),
      chapterSnapshots: [{ id: 'snapshot-1', chapter: 1, content: '既有快照' }],
      operationLogs: [{ id: 'log-1', message: '既有记录' }],
      agentEditHistory: [{ id: 'edit-1', content: '既有修改历史' }],
      memory: { characters: { 沈澄: { notes: '人工文本原样保留' } } },
    });
    db.prepare("UPDATE chapters SET updated_at='2000-01-01T00:00:00.000Z' WHERE project_id=?").run(project.id);
    db.exec('CREATE TEMP TABLE write_probe(table_name TEXT,kind TEXT,row_key TEXT)');
    for (const table of ['chapters', 'chapter_snapshots', 'operation_logs', 'agent_edit_history', 'project_state', 'story_characters']) {
      const key = table === 'chapters' ? 'chapter' : table === 'project_state' ? 'project_id' : 'id';
      for (const kind of ['INSERT', 'UPDATE', 'DELETE']) db.exec(`CREATE TEMP TRIGGER probe_${table}_${kind} AFTER ${kind} ON ${table}
        BEGIN INSERT INTO write_probe VALUES('${table}','${kind}',${kind === 'DELETE' ? 'OLD' : 'NEW'}.${key}); END`);
    }
    const beforeRows = db.prepare('SELECT rowid,chapter,updated_at FROM chapters WHERE project_id=? ORDER BY chapter').all(project.id) as any[];
    const next = store.getState(project.id);
    next.state.chapters[99].content = '只改第 100 章';
    store.putState(project.id, next.revision, next.state);
    expect(db.prepare('SELECT table_name,kind,row_key FROM write_probe').all()).toEqual([
      { table_name: 'chapters', kind: 'UPDATE', row_key: '100' },
    ]);
    const afterRows = db.prepare('SELECT rowid,chapter,updated_at FROM chapters WHERE project_id=? ORDER BY chapter').all(project.id) as any[];
    expect(afterRows.map((row) => row.rowid)).toEqual(beforeRows.map((row) => row.rowid));
    expect(afterRows.filter((row) => row.chapter !== 100).map((row) => row.updated_at))
      .toEqual(beforeRows.filter((row) => row.chapter !== 100).map((row) => row.updated_at));
    expect(afterRows[99].updated_at).not.toBe(beforeRows[99].updated_at);
    db.exec('DELETE FROM write_probe');
    const unchanged = store.getState(project.id);
    store.putState(project.id, unchanged.revision, unchanged.state);
    expect(db.prepare('SELECT * FROM write_probe').all()).toEqual([]);
  });

  it('keeps single-chapter saves idempotent and preserves row identity on actual edits', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = store.createProject({ title: '单章保存' })!;
    const first = await agent.put(`/api/projects/${project.id}/chapters/1`).send({ revision: 0,
      content: '原正文', bridge: { summary: '既有承接' } }).expect(200);
    const rowBefore = db.prepare('SELECT rowid,* FROM chapters WHERE project_id=? AND chapter=1').get(project.id) as any;
    const same = await agent.put(`/api/projects/${project.id}/chapters/1`).send({ revision: first.body.revision,
      content: '原正文', bridge: { summary: '既有承接' } }).expect(200);
    expect(same.body).toMatchObject({ revision: first.body.revision, unchanged: true });
    expect(db.prepare('SELECT rowid,* FROM chapters WHERE project_id=? AND chapter=1').get(project.id)).toEqual(rowBefore);
    await agent.put(`/api/projects/${project.id}/chapters/1`).send({ revision: 0,
      content: '原正文', bridge: { summary: '既有承接' } }).expect(409);
    const changed = await agent.put(`/api/projects/${project.id}/chapters/1`).send({ revision: first.body.revision,
      content: '作者改稿', bridge: { summary: '既有承接' } }).expect(200);
    expect(changed.body.revision).toBe(first.body.revision + 1);
    expect((db.prepare('SELECT rowid FROM chapters WHERE project_id=? AND chapter=1').get(project.id) as any).rowid).toBe(rowBefore.rowid);
    expect(changed.body.chapter.content).toBe('作者改稿');
    const cleared = await agent.put(`/api/projects/${project.id}/chapters/1`).send({ revision: changed.body.revision,
      content: '作者改稿', bridge: null }).expect(200);
    expect(cleared.body.chapter.bridge).toBeNull();
  });

  it('retains history identity and requested order without deleting or rewriting unchanged texts', () => {
    const project = store.createProject({ title: '历史顺序' })!;
    store.putState(project.id, 0, { ...store.getState(project.id).state,
      chapterSnapshots: ['z', 'a', 'm'].map((id) => ({ id: `snap-${id}`, chapter: 1, content: id })),
      operationLogs: ['z', 'a'].map((id) => ({ id: `log-${id}`, message: id })),
      agentEditHistory: ['z', 'a'].map((id) => ({ id: `edit-${id}`, content: id })),
    });
    const oldRowids = new Map((db.prepare('SELECT id,rowid FROM chapter_snapshots WHERE project_id=?').all(project.id) as any[]).map((row) => [row.id, row.rowid]));
    db.exec(`CREATE TEMP TABLE changed_history(table_name TEXT,kind TEXT,id TEXT);
      CREATE TEMP TRIGGER history_data_update AFTER UPDATE OF data ON chapter_snapshots
      BEGIN INSERT INTO changed_history VALUES('snapshots','data',NEW.id); END;
      CREATE TEMP TRIGGER history_delete AFTER DELETE ON chapter_snapshots
      BEGIN INSERT INTO changed_history VALUES('snapshots','delete',OLD.id); END;`);
    const next = store.getState(project.id);
    next.state.chapterSnapshots = [next.state.chapterSnapshots[2], next.state.chapterSnapshots[0]];
    next.state.operationLogs.unshift({ id: 'log-front', message: '新的最前记录' });
    next.state.agentEditHistory.reverse();
    store.putState(project.id, next.revision, next.state);
    const saved = store.getState(project.id).state;
    expect(saved.chapterSnapshots.map((row: any) => row.id)).toEqual(['snap-m', 'snap-z']);
    expect(saved.operationLogs.map((row: any) => row.id)).toEqual(['log-front', 'log-z', 'log-a']);
    expect(saved.agentEditHistory.map((row: any) => row.id)).toEqual(['edit-a', 'edit-z']);
    expect(db.prepare('SELECT * FROM changed_history').all()).toEqual([{ table_name: 'snapshots', kind: 'delete', id: 'snap-a' }]);
    for (const row of db.prepare('SELECT id,rowid FROM chapter_snapshots WHERE project_id=?').all(project.id) as any[])
      expect(row.rowid).toBe(oldRowids.get(row.id));
  });

  it('rolls back earlier changed rows and metadata when a later row update fails', () => {
    const project = store.createProject({ title: '完整事务' })!;
    store.putState(project.id, 0, { ...store.getState(project.id).state,
      chapters: [{ chapter: 1, content: '第一章原文' }, { chapter: 2, content: '第二章原文' }],
      chapterSnapshots: [{ id: 'rollback-snapshot', chapter: 1, content: '旧快照' }],
    });
    const before = store.getState(project.id);
    const rows = db.prepare('SELECT rowid,* FROM chapters WHERE project_id=? ORDER BY chapter').all(project.id);
    db.exec(`CREATE TEMP TRIGGER reject_second_chapter BEFORE UPDATE ON chapters WHEN NEW.chapter=2
      BEGIN SELECT RAISE(ABORT,'injected row failure'); END;`);
    const next = structuredClone(before.state);
    next.project.title = '不能保留这个未提交标题';
    next.chapters[0].content = '尚未提交的第一章';
    next.chapters[1].content = '触发第二章错误';
    expect(() => store.putState(project.id, before.revision, next)).toThrow('injected row failure');
    expect(store.getState(project.id)).toEqual(before);
    expect(db.prepare('SELECT rowid,* FROM chapters WHERE project_id=? ORDER BY chapter').all(project.id)).toEqual(rows);
  });

  it('migrates v2 histories without rewriting text or changing their original insertion order', () => {
    const path = join(dir, 'legacy-v2.sqlite');
    createV2Fixture(path);
    const migrated = openDatabase(path);
    try {
      expect((migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version).toBe(3);
      const migratedStore = new Store(migrated, loadOrCreateKey(join(dir, 'server.key')));
      const state = migratedStore.getState('legacy-book').state;
      expect(state.chapterSnapshots.map((row: any) => row.content)).toEqual(['旧内容 z', '旧内容 a', '旧内容 m']);
      const original = migrated.prepare('SELECT data FROM chapter_snapshots ORDER BY rowid').all() as any[];
      expect(original.map((row) => row.data)).toEqual(['z', 'a', 'm'].map((name) => JSON.stringify({ chapter: 1, content: `旧内容 ${name}` })));
    } finally { migrated.close(); }
    const reopened = openDatabase(path);
    try { expect((reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version=3').get() as any).count).toBe(1); }
    finally { reopened.close(); }
  });

  it('rolls back a failed v3 migration, including added columns, and supports an explicit subsequent retry', () => {
    const path = join(dir, 'legacy-rejected.sqlite');
    createV2Fixture(path, true);
    expect(() => openDatabase(path)).toThrow('injected migration failure');
    const old = new Database(path);
    try {
      expect((old.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version).toBe(2);
      for (const table of ['chapter_snapshots', 'operation_logs', 'agent_edit_history'])
        expect((old.prepare(`PRAGMA table_info(${table})`).all() as any[]).some((column) => column.name === 'sort_order')).toBe(false);
      expect((old.prepare('SELECT COUNT(*) AS count FROM chapter_snapshots').get() as any).count).toBe(3);
      old.exec('DROP TRIGGER reject_v3');
    } finally { old.close(); }
    const retried = openDatabase(path);
    try { expect((retried.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version).toBe(3); }
    finally { retried.close(); }
  });

  it('refuses a newer database without migrating or leaving a connection open', () => {
    const path = join(dir, 'future-version.sqlite');
    createV2Fixture(path);
    const future = new Database(path);
    future.exec("INSERT INTO schema_migrations VALUES(4,'2026-01-02')");
    future.close();
    expect(() => openDatabase(path)).toThrow('禁止降级写入');
    const unchanged = new Database(path);
    try {
      expect((unchanged.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any).version).toBe(4);
      expect(unchanged.pragma('journal_mode', { simple: true })).toBe('delete');
      expect((unchanged.prepare('PRAGMA table_info(chapter_snapshots)').all() as any[]).some((column) => column.name === 'sort_order')).toBe(false);
    } finally { unchanged.close(); }
  });

  it('requires local setup and authenticates with a four digit PIN', async () => {
    expect((await agent.get('/api/auth/session')).body.setup).toBe(false);
    await agent.post('/api/auth/setup').send({ pin: '12' }).expect(400);
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    expect((await agent.get('/api/auth/session')).body.authenticated).toBe(true);
    await agent.post('/api/auth/logout').expect(200);
    await agent.get('/api/projects').expect(401);
    await agent.post('/api/auth/login').send({ pin: '2468' }).expect(200);
    await agent.get('/api/projects').expect(200);
    const project = (await agent.post('/api/projects').send({ title: '工作台测试' }).expect(201)).body;
    const workbench = await agent.get(`/workbench.html?project=${project.id}`).expect(200);
    expect(workbench.text).toContain('/workbench-adapter.js');
  });

  it('stores projects atomically and rejects stale revisions', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const created = (await agent.post('/api/projects').send({ title: '测试小说', genre: '悬疑' }).expect(201))
      .body;
    const initial = (await agent.get(`/api/projects/${created.id}/state`).expect(200)).body;
    const uiOnly = (
      await agent
        .put(`/api/projects/${created.id}/state`)
        .send({ revision: initial.revision, state: { ...initial.state, onboardingSeen: true } })
        .expect(200)
    ).body;
    expect(uiOnly).toMatchObject({ revision: 0, unchanged: true });
    const saved = (
      await agent
        .put(`/api/projects/${created.id}/state`)
        .send({
          revision: initial.revision,
          state: {
            ...initial.state,
            project: { ...initial.state.project, title: '新标题' },
            chapters: [{ chapter: 1, content: '第一章正文' }],
          },
        })
        .expect(200)
    ).body;
    expect(saved.revision).toBe(1);
    await agent
      .put(`/api/projects/${created.id}/state`)
      .send({ revision: 0, state: initial.state })
      .expect(409);
    const reloaded = (await agent.get(`/api/projects/${created.id}/state`)).body;
    expect(reloaded.state.chapters[0].content).toBe('第一章正文');
  });

  it('imports legacy data once and creates structured memory cards', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const state = {
      project: { title: '旧书', genre: '玄幻', setting: '旧世界', characters: '自由文本' },
      chapters: [{ chapter: 1, content: '正文' }],
      chatWindows: [{ id: 'chat0', messages: [{ role: 'user', content: '你好' }] }],
      chapterSnapshots: [{ id: 'snap1', chapter: 1 }],
      operationLogs: [{ id: 'log1', type: 'save' }],
      agentEditHistory: [{ id: 'agent1', patches: [] }],
      memory: {
        characters: { 林尘: { role: '主角', currentStatus: '出发', voice: '先听后问，句子简短' } },
        locations: [{ name: '青山镇', description: '边陲小镇' }],
      },
      apiConfigs: [
        {
          id: 'deepseek',
          name: 'DeepSeek',
          baseURL: 'https://api.deepseek.com',
          model: 'deepseek-chat',
          apiKey: 'secret',
        },
      ],
    };
    const first = (await agent.post('/api/import/legacy-browser').send({ state }).expect(201)).body;
    expect(first.duplicate).toBe(false);
    const second = (await agent.post('/api/import/legacy-browser').send({ state }).expect(201)).body;
    expect(second.duplicate).toBe(true);
    const bundle = (await agent.get(`/api/projects/${first.projectId}/state`)).body;
    expect(bundle.characters[0].name).toBe('林尘');
    expect(bundle.characters[0].speechStyle).toBe('先听后问，句子简短');
    expect(bundle.locations[0].name).toBe('青山镇');
    expect(bundle.state.chatWindows).toHaveLength(1);
    expect(bundle.state.chapterSnapshots).toHaveLength(1);
    expect(bundle.state.operationLogs).toHaveLength(1);
    expect(bundle.state.agentEditHistory).toHaveLength(1);
    expect((await agent.get('/api/settings/runtime')).body.apiConfigs[0].apiKey).toBe('secret');
    const stored = db.prepare('SELECT encrypted_data FROM global_settings WHERE id=1').get() as {
      encrypted_data: string;
    };
    expect(stored.encrypted_data).not.toContain('secret');
  });

  it('locks repeated PIN failures and duplicates structured data', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: '资料库原本' }).expect(201)).body;
    const character = (
      await agent
        .post(`/api/projects/${project.id}/characters`)
        .send({ name: '林尘', speechStyle: '先观察，再用短句确认', expectedRevision: 0 })
        .expect(201)
    ).body;
    const location = (
      await agent
        .post(`/api/projects/${project.id}/locations`)
        .send({ name: '青山镇', expectedRevision: character.revision })
        .expect(201)
    ).body;
    const item = (
      await agent
        .post(`/api/projects/${project.id}/items`)
        .send({
          name: '青铜钥匙',
          tags: ['主线道具'],
          customFields: { 封印层数: '三层' },
          expectedRevision: location.revision,
        })
        .expect(201)
    ).body;
    const organization = (
      await agent
        .post(`/api/projects/${project.id}/organizations`)
        .send({ name: '巡夜司', expectedRevision: item.revision })
        .expect(201)
    ).body;
    await agent
      .post(`/api/projects/${project.id}/relations`)
      .send({
        sourceType: 'character',
        sourceId: character.entity.id,
        targetType: 'location',
        targetId: location.entity.id,
        label: '居住于',
        tags: ['当前关系'],
        customFields: { 起始章节: '1' },
        expectedRevision: organization.revision,
      })
      .expect(201);
    const copy = (await agent.post(`/api/projects/${project.id}/duplicate`).send({}).expect(201)).body;
    const copied = (await agent.get(`/api/projects/${copy.id}/state`).expect(200)).body;
    expect(copied.characters).toHaveLength(1);
    expect(copied.locations).toHaveLength(1);
    expect(copied.items).toHaveLength(1);
    expect(copied.organizations).toHaveLength(1);
    expect(copied.relations).toHaveLength(1);
    expect(copied.relations[0]).toMatchObject({
      tags: ['当前关系'],
      customFields: { 起始章节: '1' },
    });
    const exported = (await agent.get(`/api/projects/${project.id}/export`).expect(200)).body;
    const imported = (await agent.post('/api/import/legacy-browser').send(exported).expect(201)).body;
    const roundTrip = (await agent.get(`/api/projects/${imported.projectId}/state`).expect(200)).body;
    expect(roundTrip.characters[0].name).toBe('林尘');
    expect(roundTrip.characters[0].speechStyle).toBe('先观察，再用短句确认');
    expect(roundTrip.locations[0].name).toBe('青山镇');
    expect(roundTrip.items[0].customFields).toEqual({ 封印层数: '三层' });
    expect(roundTrip.organizations[0].name).toBe('巡夜司');
    expect(roundTrip.relations).toHaveLength(1);
    await agent.post('/api/auth/logout').expect(200);
    for (let i = 0; i < 5; i++) await agent.post('/api/auth/login').send({ pin: '0000' }).expect(401);
    await agent.post('/api/auth/login').send({ pin: '2468' }).expect(429);
  });

  it('keeps story cards in sync with AI memory without overwriting manual cards', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: '自动资料库' }).expect(201)).body;
    const initial = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    const firstSave = (
      await agent
        .put(`/api/projects/${project.id}/state`)
        .send({
          revision: initial.revision,
          state: {
            ...initial.state,
            memory: {
              characters: { 林尘: { role: '主角', goal: '离开小镇' } },
              locations: [{ name: '青山镇', description: '边陲小镇' }],
            },
          },
        })
        .expect(200)
    ).body;
    let bundle = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    expect(bundle.characters[0]).toMatchObject({ name: '林尘', role: '主角', trust: 'auto' });
    expect(bundle.locations[0]).toMatchObject({ name: '青山镇', description: '边陲小镇', trust: 'auto' });

    const manual = (
      await agent
        .patch(`/api/projects/${project.id}/characters/${bundle.characters[0].id}`)
        .send({
          ...bundle.characters[0],
          role: '人工确认的主角',
          trust: 'confirmed',
          expectedRevision: firstSave.revision,
        })
        .expect(200)
    ).body;
    bundle = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    await agent
      .put(`/api/projects/${project.id}/state`)
      .send({
        revision: manual.revision,
        state: {
          ...bundle.state,
          memory: {
            ...bundle.state.memory,
            characters: { 林尘: { role: 'AI 新角色定位' } },
            locations: [{ name: '青山镇', description: 'AI 更新后的描述' }],
          },
        },
      })
      .expect(200);
    bundle = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    expect(bundle.characters[0]).toMatchObject({ role: '人工确认的主角', trust: 'confirmed' });
    expect(bundle.locations[0]).toMatchObject({ description: 'AI 更新后的描述', trust: 'auto' });
  });

  it('extracts characters and locations with the configured AI model', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: 'AI 整理测试' }).expect(201)).body;
    await agent
      .put('/api/settings')
      .send({
        apiConfigs: [
          { id: 'cfg', name: '测试', baseURL: 'https://model.test', model: 'writer', apiKey: 'secret' },
        ],
        activeConfigId: 'cfg',
      })
      .expect(200);
    const generated = JSON.stringify({
      characters: [{ name: '林尘', role: '主角', speechStyle: '先听完再追问，不轻易下结论' }],
      locations: [{ name: '青山镇', description: '故事起点' }],
      items: [
        {
          name: '青铜钥匙',
          type: '钥匙',
          tags: ['主线道具'],
          customFields: { 封印层数: '三层' },
        },
      ],
      organizations: [{ name: '巡夜司', type: '官署' }],
      relations: [
        {
          sourceType: 'character',
          sourceName: '林尘',
          targetType: 'organization',
          targetName: '巡夜司',
          label: '受雇于',
        },
      ],
    });
    let extractionSystemPrompt = '';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const requestBody = JSON.parse(String(init?.body ?? '{}'));
      extractionSystemPrompt = requestBody.messages?.[0]?.content ?? '';
      const wantsStream = requestBody.stream;
      if (wantsStream) {
        const midpoint = Math.floor(generated.length / 2);
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: generated.slice(0, midpoint) } }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: { content: generated.slice(midpoint) } }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        );
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: generated } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const result = (
      await agent
        .post(`/api/projects/${project.id}/story-bible/generate`)
        .send({ expectedRevision: project.revision })
        .expect(200)
    ).body;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://model.test/v1/chat/completions',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.characters[0]).toMatchObject({
      name: '林尘',
      speechStyle: '先听完再追问，不轻易下结论',
      trust: 'auto',
    });
    expect(extractionSystemPrompt).toContain('speechStyle');
    expect(extractionSystemPrompt).toContain('没有证据就留空');
    expect(result.locations[0]).toMatchObject({ name: '青山镇', trust: 'auto' });
    expect(result.items[0]).toMatchObject({
      name: '青铜钥匙',
      tags: ['主线道具'],
      customFields: { 封印层数: '三层' },
      trust: 'auto',
    });
    expect(result.organizations[0]).toMatchObject({ name: '巡夜司', trust: 'auto' });
    expect(result.relations[0]).toMatchObject({ label: '受雇于', trust: 'auto' });

    const streamed = await agent
      .post(`/api/projects/${project.id}/story-bible/generate-stream`)
      .send({ expectedRevision: result.revision })
      .expect(200);
    const events = streamed.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.map((event) => event.stage)).toEqual(
      expect.arrayContaining(['preparing', 'extracting', 'merging', 'done']),
    );
    expect(events.at(-1).result.changes.characters.updated).toBe(1);
    expect(events.at(-1).result.changes.items.updated).toBe(1);
  });

  it('disables DeepSeek thinking and retries when a stream contains reasoning but no final content', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: '思考模式回退' }).expect(201)).body;
    await agent
      .put('/api/settings')
      .send({
        apiConfigs: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            baseURL: 'https://api.deepseek.com',
            model: 'deepseek-v4-flash',
            apiKey: 'secret',
          },
        ],
        activeConfigId: 'deepseek',
      })
      .expect(200);
    const generated = JSON.stringify({
      characters: [{ name: '林尘' }],
      locations: [],
      items: [],
      organizations: [],
      relations: [],
    });
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '正在分析人物与设定' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] })}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ choices: [{ message: { content: generated }, finish_reason: 'stop' }] }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        ),
      );
    const streamed = await agent
      .post(`/api/projects/${project.id}/story-bible/generate-stream`)
      .send({ expectedRevision: project.revision })
      .expect(200);
    const events = streamed.text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(events.some((event) => event.stage === 'retrying' && event.reasoningChars > 0)).toBe(true);
    expect(events.at(-1)).toMatchObject({ stage: 'done' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(firstBody).toMatchObject({
      model: 'deepseek-v4-flash',
      stream: true,
      thinking: { type: 'disabled' },
    });
  });

  it('rebases AI index results over saves made while the model is running', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: '并发整理' }).expect(201)).body;
    await agent
      .put('/api/settings')
      .send({
        apiConfigs: [
          { id: 'cfg', name: '测试', baseURL: 'https://model.test', model: 'writer', apiKey: 'secret' },
        ],
        activeConfigId: 'cfg',
      })
      .expect(200);
    vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => {
      const current = store.getState(project.id);
      store.putState(project.id, current.revision, {
        ...current.state,
        project: { ...current.state.project, title: '模型运行期间保存的新标题' },
      });
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  characters: [{ name: '林尘' }],
                  locations: [],
                  items: [],
                  organizations: [],
                  relations: [],
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    });
    const result = (
      await agent
        .post(`/api/projects/${project.id}/story-bible/generate`)
        .send({ expectedRevision: project.revision })
        .expect(200)
    ).body;
    expect(result).toMatchObject({ revision: 2, rebasedFromRevision: 0 });
    const reloaded = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    expect(reloaded.state.project.title).toBe('模型运行期间保存的新标题');
    expect(reloaded.characters[0].name).toBe('林尘');
  });

  it('can preserve a conflicted local state as a separate project', async () => {
    await agent.post('/api/auth/setup').send({ pin: '2468' }).expect(201);
    const project = (await agent.post('/api/projects').send({ title: '服务器版本' }).expect(201)).body;
    const initial = (await agent.get(`/api/projects/${project.id}/state`).expect(200)).body;
    const copy = (
      await agent
        .post(`/api/projects/${project.id}/conflict-copy`)
        .send({
          state: {
            ...initial.state,
            project: { ...initial.state.project, title: '本地未合并版本' },
            chapters: [{ chapter: 1, content: '本地正文' }],
          },
        })
        .expect(201)
    ).body;
    expect(copy.title).toBe('本地未合并版本（冲突副本）');
    const copied = (await agent.get(`/api/projects/${copy.id}/state`).expect(200)).body;
    expect(copied.state.chapters[0].content).toBe('本地正文');
    expect((await agent.get(`/api/projects/${project.id}/state`)).body.project.title).toBe('服务器版本');
  });
});
