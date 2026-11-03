import { createHash, randomUUID } from 'node:crypto';
import type { NovelDb } from './db.js';
import { decryptJson, encryptJson } from './crypto.js';
import {
  applyStatePatch,
  normalizeStateDocument,
  PatchPreconditionError,
  type StatePatchPacket,
} from '@novel-writer/shared';

const now = () => new Date().toISOString();
const json = (value: unknown) => JSON.stringify(value ?? {});
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return value ? (JSON.parse(String(value)) as T) : fallback;
  } catch {
    return fallback;
  }
};
const historyRecord = (row: any) => {
  const data = parse<any>(row.data, {});
  return data && typeof data === 'object' && !Array.isArray(data) ? { ...data, id: data.id ?? row.id } : data;
};
type StoryEntityType = 'character' | 'location' | 'item' | 'organization';
const entityTable = (type: StoryEntityType) =>
  ({
    character: 'story_characters',
    location: 'story_locations',
    item: 'story_items',
    organization: 'story_organizations',
  })[type];
const entityTableSafe = (type: unknown): type is StoryEntityType =>
  ['character', 'location', 'item', 'organization'].includes(String(type));

export class ConflictError extends Error {
  status = 409;
  constructor(public currentRevision: number) {
    super('项目已在其他设备更新');
  }
}

export class Store {
  constructor(
    private db: NovelDb,
    private key: Buffer,
  ) {}

  isSetup(): boolean {
    return !!this.db.prepare("SELECT value FROM server_meta WHERE key='pin_hash'").get();
  }
  getPinHash(): string | null {
    return (
      (
        this.db.prepare("SELECT value FROM server_meta WHERE key='pin_hash'").get() as
          { value: string } | undefined
      )?.value ?? null
    );
  }
  setPinHash(hash: string): void {
    this.db.prepare("INSERT OR REPLACE INTO server_meta(key,value) VALUES('pin_hash',?)").run(hash);
  }

  listProjects(status?: string) {
    const query = `SELECT projects.*, json_extract(project_state.data, '$.uiDrafts.inspirationWriter.mode') AS writing_mode
      FROM projects JOIN project_state ON project_state.project_id=projects.id`;
    const rows = status
      ? this.db.prepare(`${query} WHERE status=? ORDER BY updated_at DESC`).all(status)
      : this.db.prepare(`${query} WHERE status!='trashed' ORDER BY updated_at DESC`).all();
    const counts = this.db.prepare(
      "SELECT COUNT(*) chapters, COALESCE(SUM(LENGTH(REPLACE(REPLACE(content, char(10),''),' ',''))),0) chars FROM chapters WHERE project_id=?",
    );
    return rows.map((row: any) => ({
      ...camelProject(row),
      writingMode: row.writing_mode || 'workbench',
      ...(counts.get(row.id) as Record<string, unknown>),
    }));
  }

  createProject(input: { title: string; genre?: string; inspiration?: string }) {
    const id = randomUUID(),
      time = now();
    this.db.transaction(() => {
      this.db
        .prepare(
          "INSERT INTO projects(id,title,genre,status,revision,created_at,updated_at,last_opened_at) VALUES(?,?,?,'active',0,?,?,?)",
        )
        .run(id, input.title, input.genre ?? '', time, time, time);
      this.db
        .prepare('INSERT INTO project_state(project_id,schema_version,data) VALUES(?,1,?)')
        .run(id, json(defaultProjectState(input)));
    })();
    return this.getProject(id);
  }

  getProject(id: string) {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
    return row ? camelProject(row) : null;
  }

  assertRevision(id: string, expected: number): any {
    const row = this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as any;
    if (!row) throw Object.assign(new Error('项目不存在'), { status: 404 });
    if (row.revision !== expected) throw new ConflictError(row.revision);
    return row;
  }

  bump(id: string): number {
    this.db.prepare('UPDATE projects SET revision=revision+1,updated_at=? WHERE id=?').run(now(), id);
    return (this.db.prepare('SELECT revision FROM projects WHERE id=?').get(id) as any).revision;
  }

  patchProject(id: string, patch: any) {
    return this.db.transaction(() => {
      this.assertRevision(id, patch.expectedRevision);
      const current = this.getProject(id)!;
      this.db
        .prepare('UPDATE projects SET title=?,genre=? WHERE id=?')
        .run(patch.title ?? current.title, patch.genre ?? current.genre, id);
      this.bump(id);
      return this.getProject(id);
    })();
  }

  setStatus(id: string, status: 'active' | 'archived' | 'trashed', expected?: number) {
    return this.db.transaction(() => {
      const current = this.getProject(id);
      if (!current) throw Object.assign(new Error('项目不存在'), { status: 404 });
      this.assertRevision(id, expected ?? current.revision);
      this.db
        .prepare('UPDATE projects SET status=?,deleted_at=? WHERE id=?')
        .run(status, status === 'trashed' ? now() : null, id);
      this.bump(id);
      return this.getProject(id);
    })();
  }

  purgeProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id=? AND status='trashed'").run(id);
  }

  duplicateProject(id: string) {
    const bundle = this.getState(id),
      source = this.getProject(id);
    if (!source) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const created = this.createProject({ title: `${source.title}（副本）`, genre: source.genre });
    this.putState(created!.id, 0, bundle.state, false);
    const idMap = new Map<string, string>();
    let revision = this.getProject(created!.id)!.revision;
    for (const [type, entries] of [
      ['character', bundle.characters],
      ['location', bundle.locations],
      ['item', bundle.items],
      ['organization', bundle.organizations],
    ] as [StoryEntityType, any[]][]) {
      for (const entry of entries) {
        const data = { ...entry };
        const oldId = String(data.id);
        delete data.id;
        delete data.createdAt;
        delete data.updatedAt;
        const saved = this.saveEntity(type, created!.id, null, { ...data, expectedRevision: revision });
        revision = saved.revision;
        idMap.set(oldId, saved.entity!.id);
      }
    }
    for (const relation of bundle.relations as any[]) {
      const sourceId = idMap.get(relation.sourceId),
        targetId = idMap.get(relation.targetId);
      if (!sourceId || !targetId) continue;
      const saved = this.saveRelation(created!.id, null, {
        ...relation,
        sourceId,
        targetId,
        expectedRevision: revision,
      });
      revision = saved.revision;
    }
    return this.getProject(created!.id);
  }

  createConflictCopy(id: string, localState: Record<string, any>) {
    const copy = this.duplicateProject(id);
    if (!copy) throw Object.assign(new Error('无法创建冲突副本'), { status: 500 });
    this.putState(copy.id, copy.revision, localState);
    const title = String(localState.project?.title || copy.title || '无题');
    const latest = this.getProject(copy.id)!;
    return this.patchProject(copy.id, {
      title: `${title}（冲突副本）`,
      expectedRevision: latest.revision,
    });
  }

  getState(id: string) {
    const project = this.getProject(id);
    if (!project) throw Object.assign(new Error('项目不存在'), { status: 404 });
    const row = this.db.prepare('SELECT data FROM project_state WHERE project_id=?').get(id) as any;
    const state = parse<Record<string, any>>(row?.data, {});
    state.chapters = this.db
      .prepare('SELECT chapter,content,bridge FROM chapters WHERE project_id=? ORDER BY chapter')
      .all(id)
      .map((item: any) => ({ ...item, bridge: parse(item.bridge, null) }));
    state.chapterSnapshots = this.db
      .prepare('SELECT id,data FROM chapter_snapshots WHERE project_id=? ORDER BY COALESCE(sort_order,rowid),rowid')
      .all(id)
      .map(historyRecord);
    state.operationLogs = this.db
      .prepare('SELECT id,data FROM operation_logs WHERE project_id=? ORDER BY COALESCE(sort_order,rowid),rowid')
      .all(id)
      .map(historyRecord);
    state.agentEditHistory = this.db
      .prepare('SELECT id,data FROM agent_edit_history WHERE project_id=? ORDER BY COALESCE(sort_order,rowid),rowid')
      .all(id)
      .map(historyRecord);
    return {
      project,
      revision: project.revision,
      state,
      characters: this.listEntities('character', id),
      locations: this.listEntities('location', id),
      items: this.listEntities('item', id),
      organizations: this.listEntities('organization', id),
      relations: this.listRelations(id),
    };
  }

  putState(id: string, revision: number, input: Record<string, any>, syncMemory = true) {
    return this.db.transaction(() => {
      const state = structuredClone(input);
      for (const key of [
        'baseURL',
        'apiKey',
        'model',
        'models',
        'apiConfigs',
        'activeConfigId',
        'modelRoutes',
        'modelRouteThinking',
        'modelRouteThinkingEffort',
      ])
        delete state[key];
      const currentProject = this.getProject(id);
      if (!currentProject) throw Object.assign(new Error('项目不存在'), { status: 404 });
      const currentState = this.getState(id).state;
      const contentChanged = storyContentFingerprint(state) !== storyContentFingerprint(currentState);
      if (currentProject.revision !== revision && contentChanged)
        throw new ConflictError(currentProject.revision);
      const chapters = Array.isArray(state.chapters) ? state.chapters : [];
      const snapshots = Array.isArray(state.chapterSnapshots) ? state.chapterSnapshots : [];
      const logs = Array.isArray(state.operationLogs) ? state.operationLogs : [];
      const history = Array.isArray(state.agentEditHistory) ? state.agentEditHistory : [];
      delete state.chapters;
      delete state.chapterSnapshots;
      delete state.operationLogs;
      delete state.agentEditHistory;
      const encodedState = json(state);
      const storedState = this.db.prepare('SELECT data FROM project_state WHERE project_id=?').get(id) as any;
      if (storedState?.data !== encodedState)
        this.db.prepare(`INSERT INTO project_state(project_id,schema_version,data) VALUES(?,1,?)
          ON CONFLICT(project_id) DO UPDATE SET data=excluded.data`).run(id, encodedState);
      replaceRows(this.db, 'chapters', id, chapters, (item: any) => [
        Number(item.chapter),
        String(item.content ?? ''),
        item.bridge ? json(item.bridge) : null,
        now(),
      ]);
      replaceDataRows(this.db, 'chapter_snapshots', id, snapshots);
      replaceDataRows(this.db, 'operation_logs', id, logs);
      replaceDataRows(this.db, 'agent_edit_history', id, history);
      const title = String(state.project?.title || this.getProject(id)?.title || '无题');
      const genre = String(state.project?.genre || this.getProject(id)?.genre || '');
      if (title !== currentProject.title || genre !== currentProject.genre)
        this.db.prepare('UPDATE projects SET title=?,genre=? WHERE id=?').run(title, genre, id);
      const memoryContent = (memory: any) => {
        return json(stableValue({ characters: memory?.characters ?? {}, locations: memory?.locations ?? [],
          items: Array.isArray(memory?.items) ? memory.items : memory?.props ?? [],
          organizations: Array.isArray(memory?.organizations) ? memory.organizations : memory?.factions ?? [] }));
      };
      if (syncMemory && contentChanged && memoryContent(state.memory) !== memoryContent(currentState.memory))
        this.syncMemoryCardsInTransaction(id, state.memory);
      const next = contentChanged ? this.bump(id) : currentProject.revision;
      return { revision: next, savedAt: now(), unchanged: !contentChanged };
    })();
  }

  patchState(id: string, revision: number, patch: StatePatchPacket) {
    return this.db.transaction(() => {
      this.assertRevision(id, revision);
      if (!patch.operations.length && !patch.arrays.length && !patch.missing.length)
        return { revision, savedAt: now(), unchanged: true };
      const current = normalizeStateDocument(this.getState(id).state);
      let next: Record<string, any>;
      try {
        next = applyStatePatch(current, patch);
      } catch (error: any) {
        if (error instanceof PatchPreconditionError || error?.name === 'TEST_OPERATION_FAILED')
          throw new ConflictError(revision);
        // Library errors can contain the entire target document. Never return
        // or log that document, user prose or secrets as validation diagnostics.
        throw Object.assign(new Error('增量保存内容无效，原数据已保留'), { status: 422 });
      }
      return this.putState(id, revision, next);
    })();
  }

  async generateStoryBible(
    id: string,
    expectedRevision: number,
    onProgress?: (event: Record<string, unknown>) => void,
  ) {
    this.assertRevision(id, expectedRevision);
    const bundle = this.getState(id);
    const settings = this.getSettings();
    const config =
      (settings.apiConfigs ?? []).find((item: any) => item.id === settings.activeConfigId) ??
      settings.apiConfigs?.[0];
    if (!config?.baseURL || !config?.model)
      throw Object.assign(new Error('请先在书库的 API 设置中配置 Base URL 和模型'), { status: 400 });

    const source = buildStoryBibleSource(bundle.state);
    if (!source.trim())
      throw Object.assign(new Error('项目中还没有可供整理的设定、大纲或正文'), { status: 400 });
    onProgress?.({
      stage: 'preparing',
      message: '已汇总项目设定、大纲、长期记忆和正文',
      sourceChars: source.length,
      chapters: bundle.state.chapters?.length ?? 0,
    });
    const base = String(config.baseURL).replace(/\/+$/, '');
    const url = `${base.endsWith('/v1') ? base : `${base}/v1`}/chat/completions`;
    const isDeepSeek = /deepseek\.com/i.test(base) || /^deepseek-/i.test(String(config.model));
    const headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
    };
    const requestBody = {
      model: config.model,
      stream: !!onProgress,
      temperature: 0.2,
      max_tokens: 16000,
      ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
      messages: [
        {
          role: 'system',
          content: [
            '你是小说知识库整理助手。只提取输入中已经出现、且有明确证据的人物与世界事实，不编造、不脑补、不把主题、事件、章节标题、抽象概念或普通名词当成资料卡；合并同名对象。宁可少提取，也不要生成泛化或猜测性的卡片。不得推断、生成或修改叙事人称、视角角色、视角切换和章节视角安排，这些是作者独立指定的上游规则。',
            '每张卡必须有可追溯的 evidence：填写一段 20-400 字的原文短引或精确来源指针；无法给出证据的字段留空，无法给出证据的实体不要输出。可选 confidence 只能是 high 或 medium。不要把 AI 自己的推断写成作者正史。',
            '只在两个端点都能从已输出实体中确定、且原文明确支持时输出关系；不要因为人物同场、同章或语义相近就猜测关系。',
            '输出严格 JSON，不要 Markdown。顶层必须包含 characters、locations、items、organizations、relations 五个数组。所有实体都有 name、aliases、tags、notes、customFields；customFields 用于承载无法归入标准字段但有价值的键值信息。',
            '人物字段可含 role/basicInfo/appearance/personality/speechStyle/background/motivation/goals/secrets/currentStatus。speechStyle 只根据原文直接支持的说话特征概括语气、句式、用词、称呼或信息表达习惯；没有证据就留空，不得从性格推导，不得编造口癖、方言或口音。',
            '地点字段可含 type/description/geography/culture/rules/currentStatus；物品字段可含 type/description/owner/abilities/origin/currentStatus；组织字段可含 type/description/purpose/culture/rules/leaders/headquarters/currentStatus。',
            '关系格式为 {"sourceType":"character|location|item|organization","sourceName":"","targetType":"character|location|item|organization","targetName":"","label":"","description":"","tags":[],"customFields":{}}。未知字段用空字符串、空数组或空对象。',
          ].join('\n'),
        },
        { role: 'user', content: source },
      ],
    };
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody),
    });
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw Object.assign(new Error(`AI 整理失败（HTTP ${response.status}）${detail ? `：${detail}` : ''}`), {
        status: 502,
      });
    }
    onProgress?.({
      stage: 'extracting',
      message: '模型已连接，正在识别人、地、物、组织与关系',
      receivedChars: 0,
    });
    const streamed = onProgress
      ? await readStreamingAiText(response, (receivedChars, preview) =>
          onProgress({
            stage: 'extracting',
            message: '模型正在返回结构化资料',
            receivedChars,
            preview,
          }),
        )
      : extractNonStreamingAiText((await response.json()) as any);
    let content = typeof streamed === 'string' ? streamed : streamed.content;
    let diagnostics = typeof streamed === 'string' ? null : streamed;
    if (!content.trim()) {
      onProgress?.({
        stage: 'retrying',
        message: '模型首轮未返回正文，正在关闭思考模式快速重试',
        reasoningChars: diagnostics?.reasoningChars ?? 0,
        finishReason: diagnostics?.finishReason ?? '',
      });
      const retry = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          ...requestBody,
          stream: false,
          ...(isDeepSeek ? { thinking: { type: 'disabled' } } : {}),
          messages: [
            ...requestBody.messages,
            {
              role: 'user',
              content: '请立即输出完整 json 对象。不要思考过程、解释、Markdown 或空白响应。',
            },
          ],
        }),
      });
      if (!retry.ok) {
        const detail = (await retry.text().catch(() => '')).slice(0, 500);
        throw Object.assign(
          new Error(`AI 自动重试失败（HTTP ${retry.status}）${detail ? `：${detail}` : ''}`),
          { status: 502 },
        );
      }
      const retryPayload = (await retry.json()) as any;
      content = extractNonStreamingAiText(retryPayload);
      diagnostics = {
        content,
        reasoningChars: String(retryPayload?.choices?.[0]?.message?.reasoning_content ?? '').length,
        finishReason: String(retryPayload?.choices?.[0]?.finish_reason ?? ''),
        eventCount: 1,
      };
    }
    if (!content.trim())
      throw Object.assign(
        new Error(
          `模型两次都没有返回最终正文${diagnostics?.reasoningChars ? `（仅返回了 ${diagnostics.reasoningChars} 字推理）` : ''}${diagnostics?.finishReason ? `，结束原因：${diagnostics.finishReason}` : ''}。建议换用非思考模型后重试。`,
        ),
        { status: 502 },
      );
    const generated = parseGeneratedStoryBible(content);
    onProgress?.({
      stage: 'merging',
      message: '正在合并同名资料并保护人工确认内容',
      detectedCharacters: generated.characters.length,
      detectedLocations: generated.locations.length,
      detectedItems: generated.items.length,
      detectedOrganizations: generated.organizations.length,
      detectedRelations: generated.relations.length,
    });
    return this.db.transaction(() => {
      const latest = this.getProject(id);
      if (!latest) throw Object.assign(new Error('项目不存在'), { status: 404 });
      if (latest.revision !== expectedRevision)
        onProgress?.({
          stage: 'rebasing',
          message: '项目在整理期间有新保存，正在把 AI 索引安全重放到最新版本',
          fromRevision: expectedRevision,
          ontoRevision: latest.revision,
        });
      const characterChanges = this.mergeAutoCardsInTransaction(id, 'character', generated.characters);
      const locationChanges = this.mergeAutoCardsInTransaction(id, 'location', generated.locations);
      const itemChanges = this.mergeAutoCardsInTransaction(id, 'item', generated.items);
      const organizationChanges = this.mergeAutoCardsInTransaction(
        id,
        'organization',
        generated.organizations,
      );
      const relationChanges = this.mergeAutoRelationsInTransaction(id, generated.relations);
      return {
        revision: this.bump(id),
        rebasedFromRevision: latest.revision === expectedRevision ? null : expectedRevision,
        characters: this.listEntities('character', id),
        locations: this.listEntities('location', id),
        items: this.listEntities('item', id),
        organizations: this.listEntities('organization', id),
        relations: this.listRelations(id),
        changes: {
          characters: characterChanges,
          locations: locationChanges,
          items: itemChanges,
          organizations: organizationChanges,
          relations: relationChanges,
        },
      };
    })();
  }

  getChapter(id: string, chapter: number) {
    const item = this.db
      .prepare(
        'SELECT chapter,content,bridge,updated_at updatedAt FROM chapters WHERE project_id=? AND chapter=?',
      )
      .get(id, chapter) as any;
    return item ? { ...item, bridge: parse(item.bridge, null) } : null;
  }
  putChapter(id: string, chapter: number, body: any) {
    return this.db.transaction(() => {
      this.assertRevision(id, body.revision);
      if (!Number.isFinite(chapter))
        throw Object.assign(new Error('章节编号无效，原数据已保留'), { status: 422 });
      const content = String(body.content ?? '');
      const bridge = body.bridge ? json(body.bridge) : null;
      const existing = this.db.prepare('SELECT content,bridge FROM chapters WHERE project_id=? AND chapter=?').get(id, chapter) as any;
      if (existing && existing.content === content && existing.bridge === bridge)
        return { revision: body.revision, chapter: this.getChapter(id, chapter), unchanged: true };
      this.db
        .prepare(
          `INSERT INTO chapters(project_id,chapter,content,bridge,updated_at) VALUES(?,?,?,?,?)
            ON CONFLICT(project_id,chapter) DO UPDATE SET content=excluded.content,bridge=excluded.bridge,updated_at=excluded.updated_at`,
        )
        .run(id, chapter, content, bridge, now());
      return { revision: this.bump(id), chapter: this.getChapter(id, chapter) };
    })();
  }

  listEntities(type: StoryEntityType, projectId: string) {
    const table = entityTable(type);
    return this.db
      .prepare(
        `SELECT id,name,data,created_at createdAt,updated_at updatedAt FROM ${table} WHERE project_id=? ORDER BY name`,
      )
      .all(projectId)
      .map((row: any) => ({
        ...parse(row.data, {}),
        id: row.id,
        name: row.name,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      }));
  }

  saveEntity(type: StoryEntityType, projectId: string, id: string | null, input: any) {
    const table = entityTable(type);
    return this.db.transaction(() => {
      this.assertRevision(projectId, input.expectedRevision);
      const entityId = id ?? randomUUID(),
        time = now();
      const exists = id
        ? (this.db
            .prepare(`SELECT created_at FROM ${table} WHERE id=? AND project_id=?`)
            .get(id, projectId) as any)
        : null;
      if (id && !exists) throw Object.assign(new Error('资料不存在'), { status: 404 });
      const data = { ...input };
      delete data.expectedRevision;
      this.db
        .prepare(
          `INSERT OR REPLACE INTO ${table}(id,project_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
        )
        .run(entityId, projectId, data.name, json(data), exists?.created_at ?? time, time);
      return {
        entity: this.listEntities(type, projectId).find((x: any) => x.id === entityId),
        revision: this.bump(projectId),
      };
    })();
  }

  deleteEntity(type: StoryEntityType, projectId: string, id: string, revision: number) {
    const table = entityTable(type);
    return this.db.transaction(() => {
      this.assertRevision(projectId, revision);
      this.db.prepare(`DELETE FROM ${table} WHERE id=? AND project_id=?`).run(id, projectId);
      this.db
        .prepare('DELETE FROM story_relations WHERE project_id=? AND (source_id=? OR target_id=?)')
        .run(projectId, id, id);
      return { revision: this.bump(projectId) };
    })();
  }

  listRelations(projectId: string): any[] {
    return this.db
      .prepare(
        'SELECT id,source_type sourceType,source_id sourceId,target_type targetType,target_id targetId,label,description,data,created_at createdAt,updated_at updatedAt FROM story_relations WHERE project_id=? ORDER BY created_at',
      )
      .all(projectId)
      .map((row: any) => ({ ...parse(row.data, {}), ...row, data: undefined })) as any[];
  }
  saveRelation(projectId: string, id: string | null, input: any) {
    return this.db.transaction(() => {
      this.assertRevision(projectId, input.expectedRevision);
      const sourceTable = entityTable(input.sourceType),
        targetTable = entityTable(input.targetType);
      const source = this.db
          .prepare(`SELECT id FROM ${sourceTable} WHERE id=? AND project_id=?`)
          .get(input.sourceId, projectId),
        target = this.db
          .prepare(`SELECT id FROM ${targetTable} WHERE id=? AND project_id=?`)
          .get(input.targetId, projectId);
      if (!source || !target)
        throw Object.assign(new Error('关系端点不存在或不属于当前项目'), { status: 400 });
      const relationId = id ?? randomUUID(),
        time = now();
      const exists = id
        ? (this.db
            .prepare('SELECT created_at FROM story_relations WHERE id=? AND project_id=?')
            .get(id, projectId) as any)
        : null;
      if (id && !exists) throw Object.assign(new Error('关系不存在'), { status: 404 });
      this.db
        .prepare(
          'INSERT OR REPLACE INTO story_relations(id,project_id,source_type,source_id,target_type,target_id,label,description,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
        )
        .run(
          relationId,
          projectId,
          input.sourceType,
          input.sourceId,
          input.targetType,
          input.targetId,
          input.label,
          input.description ?? '',
          json({
            tags: input.tags ?? [],
            customFields: input.customFields ?? {},
            evidence: input.evidence ?? '',
            confidence: input.confidence,
            trust: input.trust ?? 'manual',
          }),
          exists?.created_at ?? time,
          time,
        );
      return {
        relation: this.listRelations(projectId).find((x: any) => x.id === relationId),
        revision: this.bump(projectId),
      };
    })();
  }
  deleteRelation(projectId: string, id: string, revision: number) {
    return this.db.transaction(() => {
      this.assertRevision(projectId, revision);
      this.db.prepare('DELETE FROM story_relations WHERE id=? AND project_id=?').run(id, projectId);
      return { revision: this.bump(projectId) };
    })();
  }

  getSettings(): any {
    const row = this.db.prepare('SELECT encrypted_data FROM global_settings WHERE id=1').get() as any;
    return row ? decryptJson(row.encrypted_data, this.key) : defaultSettings();
  }
  putSettings(settings: any): any {
    this.db
      .prepare('INSERT OR REPLACE INTO global_settings(id,encrypted_data,updated_at) VALUES(1,?,?)')
      .run(encryptJson(settings, this.key), now());
    return settings;
  }

  importLegacy(raw: any) {
    const state = raw?.state ?? raw;
    const fingerprint = createHash('sha256')
      .update(
        json({
          state,
          characters: raw?.characters ?? [],
          locations: raw?.locations ?? [],
          items: raw?.items ?? [],
          organizations: raw?.organizations ?? [],
          relations: raw?.relations ?? [],
        }),
      )
      .digest('hex');
    const previous = this.db
      .prepare('SELECT project_id projectId FROM legacy_imports WHERE fingerprint=?')
      .get(fingerprint) as any;
    if (previous) return { duplicate: true, projectId: previous.projectId, fingerprint };
    const project = state?.project ?? {};
    const created = this.createProject({
      title: String(project.title || '无题'),
      genre: String(project.genre || ''),
    })!;
    const hasStructuredCards =
      Array.isArray(raw?.characters) ||
      Array.isArray(raw?.locations) ||
      Array.isArray(raw?.items) ||
      Array.isArray(raw?.organizations);
    this.putState(created.id, 0, state, !hasStructuredCards);
    if (hasStructuredCards) this.importStructuredCards(created.id, raw);
    const currentSettings = this.getSettings();
    if (!currentSettings.apiConfigs?.length) {
      const apiConfigs =
        Array.isArray(state.apiConfigs) && state.apiConfigs.length
          ? state.apiConfigs
          : state.apiKey
            ? [
                {
                  id: 'cfg_default',
                  name: '默认配置',
                  baseURL: state.baseURL,
                  apiKey: state.apiKey,
                  model: state.model,
                },
              ]
            : [];
      this.putSettings({
        ...currentSettings,
        apiConfigs,
        activeConfigId: state.activeConfigId ?? apiConfigs[0]?.id ?? null,
        models: state.models ?? [],
        modelRoutes: state.modelRoutes ?? {},
        modelRouteThinking: state.modelRouteThinking ?? {},
        modelRouteThinkingEffort: state.modelRouteThinkingEffort ?? {},
      });
    }
    this.db
      .prepare('INSERT INTO legacy_imports(fingerprint,project_id,imported_at) VALUES(?,?,?)')
      .run(fingerprint, created.id, now());
    return { duplicate: false, projectId: created.id, fingerprint };
  }

  private syncMemoryCardsInTransaction(projectId: string, memory: any) {
    const characters = Object.entries(memory?.characters ?? {}).map(([name, value]) => {
      const info = typeof value === 'string' ? {} : ((value as any) ?? {});
      return {
        name,
        aliases: info.aliases ?? [],
        role: info.role ?? '',
        basicInfo: info.basicInfo ?? '',
        appearance: info.appearance ?? '',
        personality: info.personality ?? '',
        speechStyle: info.speechStyle ?? info.speakingStyle ?? info.voice ?? '',
        background: info.background ?? '',
        motivation: info.motivation ?? '',
        goals: info.goals ?? info.goal ?? '',
        secrets: info.secrets ?? '',
        currentStatus: info.currentStatus ?? '',
        tags: info.tags ?? [],
        notes: typeof value === 'string' ? value : (info.notes ?? ''),
      };
    });
    const rawLocations = Array.isArray(memory?.locations)
      ? memory.locations
      : Object.entries(memory?.locations ?? {}).map(([name, value]) => ({
          ...(typeof value === 'object' && value ? value : {}),
          name,
          notes: typeof value === 'string' ? value : (value as any)?.notes,
        }));
    const locations = rawLocations.map((value: any) => {
      const info = typeof value === 'string' ? { name: value } : (value ?? {});
      return {
        name: info.name ?? info.location ?? '',
        aliases: info.aliases ?? [],
        type: info.type ?? '',
        description: info.description ?? info.desc ?? '',
        geography: info.geography ?? '',
        culture: info.culture ?? '',
        rules: info.rules ?? '',
        currentStatus: info.currentStatus ?? '',
        tags: info.tags ?? [],
        notes: info.notes ?? '',
      };
    });
    this.mergeAutoCardsInTransaction(projectId, 'character', characters);
    this.mergeAutoCardsInTransaction(projectId, 'location', locations);
    const items = (Array.isArray(memory?.items) ? memory.items : (memory?.props ?? [])).map((value: any) => {
      const info = typeof value === 'string' ? { name: value } : (value ?? {});
      return {
        ...info,
        name: info.name ?? info.item ?? '',
        customFields: info.customFields ?? {},
        tags: info.tags ?? [],
      };
    });
    const organizations = (
      Array.isArray(memory?.organizations) ? memory.organizations : (memory?.factions ?? [])
    ).map((value: any) => {
      const info = typeof value === 'string' ? { name: value } : (value ?? {});
      return {
        ...info,
        name: info.name ?? info.organization ?? info.faction ?? '',
        customFields: info.customFields ?? {},
        tags: info.tags ?? [],
      };
    });
    this.mergeAutoCardsInTransaction(projectId, 'item', items);
    this.mergeAutoCardsInTransaction(projectId, 'organization', organizations);
  }

  private mergeAutoCardsInTransaction(projectId: string, type: StoryEntityType, items: any[]) {
    const table = entityTable(type);
    const rows = this.db
      .prepare(`SELECT id,name,data,created_at createdAt FROM ${table} WHERE project_id=?`)
      .all(projectId) as any[];
    const byName = new Map(rows.map((row) => [normalizeEntityName(row.name), row]));
    const statement = this.db.prepare(
      `INSERT OR REPLACE INTO ${table}(id,project_id,name,data,created_at,updated_at) VALUES(?,?,?,?,?,?)`,
    );
    const changes = { created: 0, updated: 0, protected: 0 };
    for (const raw of Array.isArray(items) ? items : []) {
      const name = String(raw?.name ?? '').trim();
      if (!name) continue;
      const key = normalizeEntityName(name);
      const existing = byName.get(key);
      const previous = existing ? parse<any>(existing.data, {}) : null;
      if (previous && previous.trust !== 'auto') {
        changes.protected += 1;
        continue;
      }
      const data: any = { ...(previous ?? {}), trust: 'auto', name };
      for (const [field, value] of Object.entries(raw ?? {})) {
        if (field === 'id' || field === 'expectedRevision' || field === 'trust') continue;
        if (Array.isArray(value)) {
          if (value.length) data[field] = value.map(String).filter(Boolean);
        } else if (value !== null && value !== undefined && String(value).trim()) data[field] = value;
      }
      data.aliases = Array.isArray(data.aliases) ? data.aliases : [];
      data.tags = Array.isArray(data.tags) ? data.tags : [];
      const time = now();
      const entityId = existing?.id ?? randomUUID();
      statement.run(entityId, projectId, name, json(data), existing?.createdAt ?? time, time);
      byName.set(key, {
        id: entityId,
        name,
        data: json(data),
        createdAt: existing?.createdAt ?? time,
      });
      if (existing) changes.updated += 1;
      else changes.created += 1;
    }
    return changes;
  }

  private mergeAutoRelationsInTransaction(projectId: string, relations: any[]) {
    const changes = { created: 0, updated: 0, protected: 0, skipped: 0 };
    const entities = new Map<string, { id: string; type: StoryEntityType }>();
    for (const type of ['character', 'location', 'item', 'organization'] as StoryEntityType[])
      for (const entity of this.listEntities(type, projectId) as any[]) {
        entities.set(`${type}:${normalizeEntityName(entity.name)}`, { id: entity.id, type });
        for (const alias of entity.aliases ?? [])
          entities.set(`${type}:${normalizeEntityName(alias)}`, { id: entity.id, type });
      }
    const existingRows = this.db
      .prepare(
        'SELECT id,source_type sourceType,source_id sourceId,target_type targetType,target_id targetId,label,data,created_at createdAt FROM story_relations WHERE project_id=?',
      )
      .all(projectId) as any[];
    const relationKey = (sourceId: string, targetId: string, label: string) =>
      `${sourceId}:${targetId}:${normalizeEntityName(label)}`;
    const existing = new Map(
      existingRows.map((row) => [relationKey(row.sourceId, row.targetId, row.label), row]),
    );
    const statement = this.db.prepare(
      'INSERT OR REPLACE INTO story_relations(id,project_id,source_type,source_id,target_type,target_id,label,description,data,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
    );
    for (const relation of Array.isArray(relations) ? relations : []) {
      const sourceType = relation?.sourceType as StoryEntityType;
      const targetType = relation?.targetType as StoryEntityType;
      if (!entityTableSafe(sourceType) || !entityTableSafe(targetType)) {
        changes.skipped += 1;
        continue;
      }
      const source = entities.get(`${sourceType}:${normalizeEntityName(relation.sourceName)}`);
      const target = entities.get(`${targetType}:${normalizeEntityName(relation.targetName)}`);
      const label = String(relation?.label ?? '').trim();
      if (!source || !target || !label) {
        changes.skipped += 1;
        continue;
      }
      const key = relationKey(source.id, target.id, label);
      const previous = existing.get(key);
      const previousData = previous ? parse<any>(previous.data, {}) : null;
      if (previousData && previousData.trust !== 'auto') {
        changes.protected += 1;
        continue;
      }
      const time = now();
      const relationId = previous?.id ?? randomUUID();
      statement.run(
        relationId,
        projectId,
        sourceType,
        source.id,
        targetType,
        target.id,
        label,
        String(relation.description ?? ''),
        json({
          tags: Array.isArray(relation.tags) ? relation.tags : [],
          customFields: relation.customFields ?? {},
          evidence: String(relation.evidence ?? '').slice(0, 2_000),
          confidence: ['high', 'medium'].includes(relation.confidence) ? relation.confidence : undefined,
          trust: 'auto',
        }),
        previous?.createdAt ?? time,
        time,
      );
      if (previous) changes.updated += 1;
      else changes.created += 1;
    }
    return changes;
  }

  private importStructuredCards(projectId: string, raw: any) {
    const idMap = new Map<string, string>();
    let revision = this.getProject(projectId)!.revision;
    for (const [type, items] of [
      ['character', raw.characters ?? []],
      ['location', raw.locations ?? []],
      ['item', raw.items ?? []],
      ['organization', raw.organizations ?? []],
    ] as [StoryEntityType, any[]][])
      for (const source of items as any[]) {
        const data = { ...source };
        const oldId = String(data.id ?? '');
        delete data.id;
        delete data.createdAt;
        delete data.updatedAt;
        const saved = this.saveEntity(type, projectId, null, { ...data, expectedRevision: revision });
        revision = saved.revision;
        if (oldId) idMap.set(oldId, saved.entity!.id);
      }
    for (const relation of Array.isArray(raw.relations) ? raw.relations : []) {
      const sourceId = idMap.get(relation.sourceId),
        targetId = idMap.get(relation.targetId);
      if (!sourceId || !targetId) continue;
      const saved = this.saveRelation(projectId, null, {
        ...relation,
        sourceId,
        targetId,
        expectedRevision: revision,
      });
      revision = saved.revision;
    }
  }
}

function defaultProjectState(input: any) {
  return {
    project: {
      title: input.title,
      genre: input.genre ?? '',
      setting: '',
      characters: '',
      chapterCount: 24,
      wordsPerChapter: input.inspiration ? 2200 : 10000,
      novelNote: '',
    },
    outline: [],
    storyBibleFreeText: '',
    memory: {},
    chapterMemories: {},
    chatWindows: [],
    savedPrompts: {},
    creativeRules: {},
    editorAgent: {},
    reviewReports: {},
    chapters: [],
    ...(input.inspiration
      ? {
          onboardingSeen: true,
          uiDrafts: {
            inspirationWriter: {
              mode: 'inspiration',
              autoSetup: true,
              initialTitle: input.title,
              seed: input.inspiration,
              additions: [],
              plans: {},
              phase: 'idle',
              pendingChapter: 1,
              completedChapter: 0,
            },
          },
        }
      : {}),
  };
}

function normalizeEntityName(value: unknown) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-CN');
}

function stableValue(value: any): any {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableValue(value[key])]),
    );
  return value;
}

function storyContentFingerprint(state: any) {
  const memory = structuredClone(state?.memory ?? {});
  delete memory.structuredStoryBible;
  const content = {
    project: state?.project ?? {},
    storyBibleFreeText: state?.storyBibleFreeText ?? '',
    outline: state?.outline ?? [],
    chapters: state?.chapters ?? [],
    memory,
    chapterMemories: state?.chapterMemories ?? {},
    chatWindows: state?.chatWindows ?? [],
    referenceText: state?.referenceText ?? '',
    methodologyCards: state?.methodologyCards ?? [],
    savedPrompts: state?.savedPrompts ?? {},
    creativeRules: state?.creativeRules ?? {},
    editorAgent: state?.editorAgent ?? {},
    uiDrafts: state?.uiDrafts ?? {},
    reviewReports: state?.reviewReports ?? {},
    memoryTrust: state?.memoryTrust ?? {},
    chapterSnapshots: state?.chapterSnapshots ?? [],
    operationLogs: state?.operationLogs ?? [],
    agentEditHistory: state?.agentEditHistory ?? [],
  };
  return createHash('sha256')
    .update(JSON.stringify(stableValue(content)))
    .digest('hex');
}

function buildStoryBibleSource(state: any) {
  const chapters = (Array.isArray(state?.chapters) ? state.chapters : [])
    .filter((item: any) => String(item?.content ?? '').trim())
    .sort((a: any, b: any) => Number(a.chapter) - Number(b.chapter));
  const chapterBudget = 60_000;
  let remaining = chapterBudget;
  const excerpts: string[] = [];
  for (const chapter of chapters) {
    if (remaining <= 0) break;
    const content = String(chapter.content ?? '').slice(0, remaining);
    excerpts.push(`第 ${chapter.chapter} 章：\n${content}`);
    remaining -= content.length;
  }
  return [
    `书名：${state?.project?.title ?? ''}`,
    `类型：${state?.project?.genre ?? ''}`,
    `世界观与设定：\n${state?.project?.setting ?? ''}`,
    `人物自由文本：\n${state?.project?.characters ?? ''}`,
    `资料库自由文本：\n${state?.storyBibleFreeText ?? ''}`,
    `大纲：\n${json(state?.outline ?? [])}`,
    `长期记忆：\n${json(state?.memory ?? {})}`,
    `已写正文（最多 ${chapterBudget} 字）：\n${excerpts.join('\n\n')}`,
  ].join('\n\n');
}

function aiText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value))
    return value.map((item) => aiText((item as any)?.text ?? (item as any)?.content ?? item)).join('');
  if (value && typeof value === 'object') return aiText((value as any).value ?? (value as any).text);
  return '';
}

function extractNonStreamingAiText(payload: any): string {
  return aiText(
    payload?.choices?.[0]?.message?.content ??
      payload?.choices?.[0]?.text ??
      payload?.output_text ??
      payload?.output?.flatMap((item: any) => item?.content ?? []),
  );
}

async function readStreamingAiText(
  response: Response,
  report: (receivedChars: number, preview?: string) => void,
) {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json') || !response.body) {
    const payload = (await response.json()) as any;
    const content = extractNonStreamingAiText(payload);
    report(content.length, content.slice(-800));
    return {
      content,
      reasoningChars: aiText(payload?.choices?.[0]?.message?.reasoning_content).length,
      finishReason: String(payload?.choices?.[0]?.finish_reason ?? ''),
      eventCount: 1,
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let content = '';
  let reasoningChars = 0;
  let finishReason = '';
  let eventCount = 0;
  let lastReport = 0;
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const lines = buffer.split(/\r?\n/);
    buffer = done ? '' : (lines.pop() ?? '');
    for (const line of lines) {
      const data = line.trim().replace(/^data:\s*/, '');
      if (!data || data === '[DONE]') continue;
      try {
        const event = JSON.parse(data);
        const choice = event?.choices?.[0];
        eventCount += 1;
        content += aiText(
          choice?.delta?.content ??
            choice?.message?.content ??
            choice?.text ??
            event?.output_text ??
            (event?.type === 'response.output_text.delta' ? event?.delta : ''),
        );
        reasoningChars += aiText(
          choice?.delta?.reasoning_content ?? choice?.message?.reasoning_content,
        ).length;
        if (choice?.finish_reason) finishReason = String(choice.finish_reason);
      } catch {
        // Ignore keep-alives and provider-specific non-JSON event lines.
      }
    }
    if (content.length - lastReport >= 80 || done) {
      lastReport = content.length;
      report(content.length, content.slice(-800));
    }
    if (done) break;
  }
  return { content, reasoningChars, finishReason, eventCount };
}

function parseGeneratedStoryBible(content: unknown) {
  if (typeof content !== 'string' || !content.trim())
    throw Object.assign(new Error('AI 没有返回可用的资料'), { status: 502 });
  const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  const extracted = fenced ?? (start >= 0 && end > start ? content.slice(start, end + 1) : content);
  const candidates = [extracted, extracted.replace(/,\s*([}\]])/g, '$1')];
  let parsed: any = null;
  for (const candidate of candidates) {
    try {
      parsed = JSON.parse(candidate.replace(/^\uFEFF/, '').trim());
      break;
    } catch {
      // Try the next provider-tolerant variant.
    }
  }
  if (!parsed || typeof parsed !== 'object')
    throw Object.assign(new Error('AI 返回的资料格式无法解析，请重试'), { status: 502 });
  const root =
    parsed.storyBible && typeof parsed.storyBible === 'object'
      ? parsed.storyBible
      : parsed.data && typeof parsed.data === 'object'
        ? parsed.data
        : parsed.result && typeof parsed.result === 'object'
          ? parsed.result
          : parsed;
  const clean = (value: unknown, max = 20_000) =>
    String(value ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, max);
  const list = (value: unknown) =>
    [
      ...new Set(
        (Array.isArray(value) ? value : String(value ?? '').split(/[\n,，、;；]+/))
          .map((item) => clean(item, 200))
          .filter(Boolean),
      ),
    ].slice(0, 100);
  const fields = (value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .map(([key, item]) => [clean(key, 100), clean(item, 20_000)])
            .filter(([key, item]) => key && item)
            .slice(0, 100),
        )
      : {};
  const normalizeEntity = (value: any) => {
    if (!value || typeof value !== 'object') return null;
    const name = clean(
      value.name ?? value.character ?? value.location ?? value.item ?? value.organization,
      200,
    );
    if (!name) return null;
    const normalized: any = {
      ...value,
      name,
      aliases: list(value.aliases),
      tags: list(value.tags),
      customFields: fields(value.customFields),
    };
    for (const [key, item] of Object.entries(normalized)) {
      if (['name', 'aliases', 'tags', 'customFields', 'id', 'trust'].includes(key)) continue;
      if (typeof item === 'string') normalized[key] = clean(item);
      else if (item !== null && item !== undefined && typeof item !== 'object') normalized[key] = clean(item);
    }
    if (normalized.evidence) normalized.evidence = clean(normalized.evidence, 800);
    if (normalized.confidence && !['high', 'medium'].includes(normalized.confidence))
      delete normalized.confidence;
    // Keep a named card even when the provider only returned its name. The card remains
    // `auto` and therefore visibly awaits confirmation; dropping it would make a partial
    // stream look like a successful empty result and would lose a useful author lead.
    return normalized;
  };
  const mergeByName = (items: unknown[]) => {
    const merged = new Map<string, any>();
    for (const item of items.map(normalizeEntity).filter(Boolean) as any[]) {
      const key = normalizeEntityName(item.name);
      const previous = merged.get(key);
      if (!previous) {
        merged.set(key, item);
        continue;
      }
      for (const [field, value] of Object.entries(item)) {
        if (Array.isArray(value))
          previous[field] = [...new Set([...(previous[field] || []), ...value])].slice(0, 100);
        else if (value && typeof value === 'object')
          previous[field] = { ...(previous[field] || {}), ...value };
        else if (
          !String(previous[field] ?? '').trim() ||
          String(value).length > String(previous[field] ?? '').length
        )
          previous[field] = value;
      }
    }
    return [...merged.values()];
  };
  const entityTypes = ['character', 'location', 'item', 'organization'];
  const output: any = Object.fromEntries(
    entityTypes.map((type) => [
      type === 'character' ? 'characters' : `${type}s`,
      mergeByName(
        Array.isArray(root?.[type === 'character' ? 'characters' : `${type}s`])
          ? root[type === 'character' ? 'characters' : `${type}s`]
          : [],
      ),
    ]),
  );
  const relations = new Map<string, any>();
  for (const raw of Array.isArray(root?.relations) ? root.relations : []) {
    if (!raw || typeof raw !== 'object') continue;
    const sourceType = clean(raw.sourceType, 30);
    const targetType = clean(raw.targetType, 30);
    const sourceName = clean(raw.sourceName ?? raw.source, 200);
    const targetName = clean(raw.targetName ?? raw.target, 200);
    const label = clean(raw.label ?? raw.relation, 200);
    if (
      !entityTypes.includes(sourceType) ||
      !entityTypes.includes(targetType) ||
      !sourceName ||
      !targetName ||
      !label
    )
      continue;
    const normalized = {
      ...raw,
      sourceType,
      targetType,
      sourceName,
      targetName,
      label,
      description: clean(raw.description),
      tags: list(raw.tags),
      customFields: fields(raw.customFields),
      trust: undefined,
    };
    delete normalized.trust;
    const key = `${sourceType}:${normalizeEntityName(sourceName)}:${targetType}:${normalizeEntityName(targetName)}:${normalizeEntityName(label)}`;
    const previous = relations.get(key);
    relations.set(
      key,
      previous
        ? { ...previous, ...normalized, description: previous.description || normalized.description }
        : normalized,
    );
  }
  output.relations = [...relations.values()];
  if (!Object.values(output).some((items: any) => Array.isArray(items) && items.length))
    throw Object.assign(new Error('AI 返回的 JSON 没有可用资料；请补充更具体的设定或重试'), { status: 502 });
  return output;
}
function defaultSettings() {
  return {
    apiConfigs: [],
    activeConfigId: null,
    models: [],
    modelRoutes: {},
    modelRouteThinking: {},
    modelRouteThinkingEffort: {},
    ui: {},
  };
}
function camelProject(row: any) {
  return {
    id: row.id,
    title: row.title,
    genre: row.genre,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    deletedAt: row.deleted_at,
  };
}
function replaceRows(
  db: NovelDb,
  table: string,
  projectId: string,
  items: any[],
  values: (item: any) => any[],
) {
  // Keep the old transaction boundary; only insert, update or remove rows that
  // really differ. In particular, untouched chapter timestamps must survive.
  const existing = new Map((db.prepare(`SELECT chapter,content,bridge FROM ${table} WHERE project_id=?`).all(projectId) as any[])
    .map((row) => [Number(row.chapter), row]));
  const desired = items.map(values);
  const keys = new Set<number>();
  for (const [chapter] of desired) {
    if (!Number.isFinite(chapter) || keys.has(chapter))
      throw Object.assign(new Error('章节编号无效或重复，原数据已保留'), { status: 422 });
    keys.add(chapter);
  }
  const insert = db.prepare(`INSERT INTO ${table}(project_id,chapter,content,bridge,updated_at) VALUES(?,?,?,?,?)`);
  const update = db.prepare(`UPDATE ${table} SET content=?,bridge=?,updated_at=? WHERE project_id=? AND chapter=?`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE project_id=? AND chapter=?`);
  for (const [chapter, content, bridge, updatedAt] of desired) {
    const row = existing.get(chapter);
    if (!row) insert.run(projectId, chapter, content, bridge, updatedAt);
    else if (row.content !== content || row.bridge !== bridge) update.run(content, bridge, updatedAt, projectId, chapter);
  }
  for (const chapter of existing.keys()) if (!keys.has(chapter)) remove.run(projectId, chapter);
}
function replaceDataRows(db: NovelDb, table: string, projectId: string, items: any[]) {
  const rows = db.prepare(`SELECT id,data,sort_order FROM ${table} WHERE project_id=?
    ORDER BY COALESCE(sort_order,rowid),rowid`).all(projectId) as any[];
  const existing = new Map(rows.map((row) => [String(row.id), row]));
  const keys = new Set<string>();
  const desired = items.map((item, index) => {
    const data = json(item);
    const matching = item?.id == null
      ? rows.find((row) => !keys.has(String(row.id)) && row.data === data) : null;
    const id = String(item?.id ?? matching?.id ?? randomUUID());
    if (keys.has(id)) throw Object.assign(new Error('历史记录 id 重复，原数据已保留'), { status: 422 });
    keys.add(id);
    return { id, data, index };
  });
  const insert = db.prepare(`INSERT INTO ${table}(id,project_id,data,sort_order) VALUES(?,?,?,?)`);
  const updateData = db.prepare(`UPDATE ${table} SET data=? WHERE project_id=? AND id=?`);
  const updateOrder = db.prepare(`UPDATE ${table} SET sort_order=? WHERE project_id=? AND id=?`);
  const remove = db.prepare(`DELETE FROM ${table} WHERE project_id=? AND id=?`);
  for (const item of desired) {
    const row = existing.get(item.id);
    if (!row) insert.run(item.id, projectId, item.data, item.index);
    else {
      // Legacy rows can omit the id in their JSON. Its stable SQL identity is
      // exposed on read; that alone must not rewrite a large historical text.
      if (row.data !== item.data && json(historyRecord(row)) !== item.data)
        updateData.run(item.data, projectId, item.id);
      if (row.sort_order !== item.index) updateOrder.run(item.index, projectId, item.id);
    }
  }
  for (const id of existing.keys()) if (!keys.has(id)) remove.run(projectId, id);
}
