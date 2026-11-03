import './styles.css';

type Json = Record<string, any>;
type EntityType = 'character' | 'location' | 'item' | 'organization';
const entityConfig: Record<EntityType, { label: string; path: string; listId: string; bundleKey: string }> = {
  character: { label: '人物', path: 'characters', listId: 'characterList', bundleKey: 'characters' },
  location: { label: '地点', path: 'locations', listId: 'locationList', bundleKey: 'locations' },
  item: { label: '物品', path: 'items', listId: 'itemList', bundleKey: 'items' },
  organization: {
    label: '组织',
    path: 'organizations',
    listId: 'organizationList',
    bundleKey: 'organizations',
  },
};
type Project = {
  id: string;
  title: string;
  genre: string;
  status: string;
  revision: number;
  updatedAt: string;
  chapters?: number;
  chars?: number;
  writingMode?: string;
};
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let projects: Project[] = [],
  current: Project | null = null,
  bundle: Json | null = null,
  currentChapter = 1,
  chapterSaveTimer: number | undefined,
  projectSaveTimer: number | undefined,
  projectDirty = false,
  settings: Json = {},
  saveChain = Promise.resolve();

async function api<T = any>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = Object.assign(new Error(data.error || `HTTP ${response.status}`), {
      status: response.status,
      data,
    });
    throw error;
  }
  return data;
}
function show(view: string) {
  for (const id of ['loadingView', 'authView', 'libraryView', 'workspaceView'])
    $(id).classList.toggle('hidden', id !== view);
}
function toast(message: string) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  window.setTimeout(() => el.classList.remove('show'), 2600);
}
function dialog(id: string) {
  ($(id) as HTMLDialogElement).showModal();
}
function closeDialog(id: string) {
  ($(id) as HTMLDialogElement).close();
}
function setSaveStatus(text: string, error = false) {
  const el = $('saveStatus');
  el.textContent = text;
  el.style.color = error ? '#a9362d' : '';
}
function enqueueSave(task: () => Promise<void>) {
  saveChain = saveChain.then(task, task);
  return saveChain;
}

async function boot() {
  try {
    const session = await api<Json>('/auth/session');
    if (!session.authenticated) {
      show('authView');
      $('authHint').textContent = session.setup
        ? '请输入四位 PIN'
        : session.local
          ? '首次运行：请输入四位数字并点击“设置 PIN”'
          : '首次设置只能在运行服务的电脑打开 http://127.0.0.1:3210 完成';
      $('authForm').dataset.mode = session.setup ? 'login' : 'setup';
      const submit = $('authForm').querySelector('button') as HTMLButtonElement;
      submit.textContent = session.setup ? '进入书库' : session.local ? '设置 PIN' : '请在主机设置 PIN';
      if (!session.setup && !session.local) {
        submit.disabled = true;
        $<HTMLInputElement>('pin').disabled = true;
        $<HTMLInputElement>('pin').placeholder = '请改用主机本机地址';
      }
      return;
    }
    const params = new URLSearchParams(location.search);
    const projectId = params.get('project');
    if (projectId) {
      await openProject(projectId);
      switchTab(params.get('tab') || 'bible');
    } else await openLibrary();
  } catch (error) {
    show('loadingView');
    $('loadingView').querySelector('p')!.textContent = `无法连接服务：${(error as Error).message}`;
  }
}
async function openLibrary() {
  current = null;
  bundle = null;
  show('libraryView');
  await loadProjects();
}
async function loadProjects() {
  const status = $<HTMLSelectElement>('statusFilter').value || 'active';
  projects = (await api<Json>(`/projects?status=${status}`)).projects;
  renderProjects(status);
}
function renderProjects(status: string) {
  const grid = $('projectGrid');
  grid.replaceChildren();
  if (!projects.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = status === 'trashed' ? '回收站为空' : '这里还没有小说。';
    grid.append(p);
    return;
  }
  for (const project of projects) {
    const card = document.createElement('article');
    card.className = 'project-card';
    const h = document.createElement('h2');
    h.textContent = project.title;
    const meta = document.createElement('p');
    meta.className = 'project-meta';
    meta.textContent = `${project.genre || '未分类'} · ${Number(project.chapters || 0)} 章 · ${Number(project.chars || 0).toLocaleString()} 字`;
    const time = document.createElement('p');
    time.className = 'project-meta';
    time.textContent = `更新于 ${new Date(project.updatedAt).toLocaleString()}`;
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    if (status === 'active') {
      const more = document.createElement('details');
      more.className = 'project-more';
      const summary = document.createElement('summary');
      summary.textContent = '更多';
      const menu = document.createElement('div');
      menu.className = 'project-more-menu';
      menu.append(
        button(project.writingMode === 'inspiration' ? '完整工作台' : '灵感开写', () =>
          openWorkbench(project.id, project.writingMode !== 'inspiration'),
        ),
        button('复制副本', () => projectAction(project, 'duplicate')),
        button('归档项目', () => projectAction(project, 'archive')),
      );
      more.append(summary, menu);
      actions.append(
        button('进入写作', () => openWorkbench(project.id, project.writingMode === 'inspiration'), true),
        button('资料库', () => openBible(project.id)),
        more,
      );
    }
    if (status === 'archived')
      actions.append(
        button('恢复', () => projectAction(project, 'restore')),
        button('删除', () => projectAction(project, 'trash'), false, true),
      );
    if (status === 'trashed')
      actions.append(
        button('恢复', () => projectAction(project, 'restore')),
        button('永久删除', () => projectAction(project, 'purge'), false, true),
      );
    card.append(h, meta, time, actions);
    grid.append(card);
  }
}
function openWorkbench(id: string, inspiration = false) {
  location.href = `/workbench.html?project=${encodeURIComponent(id)}${inspiration ? '&mode=inspiration' : ''}`;
}
function openBible(id: string) {
  location.href = `/?project=${encodeURIComponent(id)}&tab=bible`;
}
function button(label: string, handler: () => void, primary = false, danger = false) {
  const b = document.createElement('button');
  b.textContent = label;
  if (primary) b.classList.add('primary');
  if (danger) b.classList.add('danger');
  b.onclick = handler;
  return b;
}
async function projectAction(project: Project, action: string) {
  try {
    if (action === 'purge' && !confirm('永久删除后无法恢复，确定继续？')) return;
    if (action === 'trash' && !confirm('将项目移入回收站？')) return;
    const map: Json = {
      duplicate: `/projects/${project.id}/duplicate`,
      archive: `/projects/${project.id}/archive`,
      restore: `/projects/${project.id}/restore`,
    };
    if (action === 'purge') await api(`/projects/${project.id}?permanent=true`, { method: 'DELETE' });
    else if (action === 'trash')
      await api(`/projects/${project.id}`, {
        method: 'DELETE',
        body: JSON.stringify({ expectedRevision: project.revision }),
      });
    else
      await api(map[action], {
        method: 'POST',
        body: JSON.stringify({ expectedRevision: project.revision }),
      });
    await loadProjects();
  } catch (e) {
    toast((e as Error).message);
  }
}

async function openProject(id: string) {
  const loaded = await api<Json>(`/projects/${id}/state`),
    project: Project = { ...loaded.project, revision: loaded.revision };
  bundle = loaded;
  current = project;
  show('workspaceView');
  $('workspaceTitle').textContent = project.title;
  $<HTMLAnchorElement>('workbenchLink').href = `/workbench.html?project=${encodeURIComponent(id)}`;
  $<HTMLAnchorElement>('workbenchHeaderLink').href = `/workbench.html?project=${encodeURIComponent(id)}`;
  fillProjectForm();
  renderChapters();
  renderBible();
  switchTab('project');
}
function state(): Json {
  return bundle!.state;
}
function fillProjectForm() {
  const p = state().project ?? {};
  $<HTMLInputElement>('projectTitle').value = p.title ?? current!.title;
  $<HTMLInputElement>('projectGenre').value = p.genre ?? current!.genre;
  $<HTMLTextAreaElement>('projectSetting').value = p.setting ?? '';
  $<HTMLTextAreaElement>('projectCharacters').value = p.characters ?? '';
  $<HTMLInputElement>('chapterCount').value = String(p.chapterCount ?? 24);
  $<HTMLInputElement>('wordsPerChapter').value = String(p.wordsPerChapter ?? 10000);
}
function collectProject() {
  state().project = {
    ...(state().project ?? {}),
    title: $<HTMLInputElement>('projectTitle').value.trim() || '无题',
    genre: $<HTMLInputElement>('projectGenre').value.trim(),
    setting: $<HTMLTextAreaElement>('projectSetting').value,
    characters: $<HTMLTextAreaElement>('projectCharacters').value,
    chapterCount: Number($<HTMLInputElement>('chapterCount').value) || 24,
    wordsPerChapter: Number($<HTMLInputElement>('wordsPerChapter').value) || 10000,
  };
}
function queueProjectSave() {
  projectDirty = true;
  setSaveStatus('有未保存修改');
  window.clearTimeout(projectSaveTimer);
  projectSaveTimer = window.setTimeout(() => void enqueueSave(saveProjectState), 900);
}
async function saveProjectState() {
  if (!current || !bundle) return;
  collectProject();
  setSaveStatus('保存中…');
  try {
    const result = await api<Json>(`/projects/${current.id}/state`, {
      method: 'PUT',
      body: JSON.stringify({ revision: current.revision, state: state() }),
    });
    current.revision = result.revision;
    bundle.revision = result.revision;
    current.title = state().project.title;
    $('workspaceTitle').textContent = current.title;
    projectDirty = false;
    setSaveStatus('已保存');
    toast('项目已保存');
  } catch (e) {
    handleSaveError(e as any);
  }
}
function handleSaveError(error: any) {
  if (error.status === 409) {
    setSaveStatus('版本冲突', true);
    toast('项目已在其他设备更新，本地内容尚未覆盖服务器');
  } else {
    setSaveStatus('保存失败', true);
    toast(error.message);
  }
}

function renderChapters() {
  const list = $('chapterList');
  list.replaceChildren();
  const total = Math.max(
    Number(state().project?.chapterCount) || 1,
    ...(state().chapters ?? []).map((x: any) => Number(x.chapter) || 0),
  );
  for (let chapter = 1; chapter <= total; chapter++) {
    const b = document.createElement('button');
    b.className = 'chapter-item';
    b.textContent = `第 ${chapter} 章`;
    b.onclick = () => selectChapter(chapter);
    list.append(b);
  }
  selectChapter(Math.min(currentChapter, total));
}
function chapterRecord(chapter: number) {
  let record = (state().chapters ??= []).find((x: any) => Number(x.chapter) === chapter);
  if (!record) {
    record = { chapter, content: '', bridge: null };
    state().chapters.push(record);
  }
  return record;
}
function selectChapter(chapter: number) {
  if (
    currentChapter &&
    $<HTMLTextAreaElement>('chapterEditor').value !== chapterRecord(currentChapter).content
  )
    saveChapterNow();
  currentChapter = chapter;
  document
    .querySelectorAll('.chapter-item')
    .forEach((x, i) => x.classList.toggle('active', i + 1 === chapter));
  $('chapterHeading').textContent = `第 ${chapter} 章`;
  $<HTMLTextAreaElement>('chapterEditor').value = chapterRecord(chapter).content ?? '';
  updateWords();
}
function updateWords() {
  const count = $<HTMLTextAreaElement>('chapterEditor').value.replace(/\s/g, '').length;
  $('chapterWords').textContent = `${count.toLocaleString()} 字`;
}
function queueChapterSave() {
  updateWords();
  setSaveStatus('有未保存修改');
  window.clearTimeout(chapterSaveTimer);
  chapterSaveTimer = window.setTimeout(() => void enqueueSave(saveChapterNow), 700);
}
async function saveChapterNow() {
  if (!current || !bundle) return;
  window.clearTimeout(chapterSaveTimer);
  const content = $<HTMLTextAreaElement>('chapterEditor').value,
    record = chapterRecord(currentChapter);
  record.content = content;
  setSaveStatus('保存中…');
  try {
    const result = await api<Json>(`/projects/${current.id}/chapters/${currentChapter}`, {
      method: 'PUT',
      body: JSON.stringify({ revision: current.revision, content, bridge: record.bridge }),
    });
    current.revision = result.revision;
    bundle.revision = result.revision;
    setSaveStatus('已保存');
  } catch (e) {
    handleSaveError(e as any);
  }
}

function renderBible() {
  for (const type of Object.keys(entityConfig) as EntityType[])
    renderEntityList(type, bundle![entityConfig[type].bundleKey] ?? []);
  $<HTMLTextAreaElement>('storyBibleFreeText').value =
    state().storyBibleFreeText ?? state().project?.characters ?? '';
  const list = $('relationList');
  list.replaceChildren();
  for (const relation of bundle!.relations ?? []) {
    const card = document.createElement('div');
    card.className = 'entity-card';
    const names = entityOptions();
    const p = document.createElement('p');
    const tags = relation.tags?.length ? `\n#${relation.tags.join(' #')}` : '';
    const custom = Object.entries(relation.customFields ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');
    p.textContent = `${names.get(relation.sourceId) || '未知'} — ${relation.label} → ${names.get(relation.targetId) || '未知'}${relation.description ? `\n${relation.description}` : ''}${tags}${custom ? `\n${custom}` : ''}`;
    const actions = document.createElement('div');
    actions.className = 'entity-actions';
    actions.append(button('删除', () => deleteRelation(relation), false, true));
    card.append(p, actions);
    list.append(card);
  }
}
function renderEntityList(type: EntityType, items: any[]) {
  const list = $(entityConfig[type].listId);
  list.replaceChildren();
  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'entity-card';
    const h = document.createElement('h3');
    h.textContent = `${item.name}${item.trust === 'auto' ? ' · AI 自动维护' : ' · 已人工确认'}`;
    const p = document.createElement('p');
    const fields =
      type === 'character'
        ? [item.role, item.personality, item.speechStyle, item.goals, item.currentStatus]
        : type === 'item'
          ? [item.type, item.description, item.owner, item.abilities, item.currentStatus]
          : type === 'organization'
            ? [item.type, item.description, item.purpose, item.leaders, item.currentStatus]
            : [item.type, item.description, item.currentStatus];
    const tags = item.tags?.length ? `#${item.tags.join(' #')}` : '';
    const custom = Object.entries(item.customFields ?? {})
      .map(([key, value]) => `${key}: ${value}`)
      .join(' · ');
    p.textContent = [...fields, tags, custom, item.notes].filter(Boolean).join('\n');
    const actions = document.createElement('div');
    actions.className = 'entity-actions';
    actions.append(
      button('编辑', () => openEntityDialog(type, item)),
      button('删除', () => deleteEntity(type, item), false, true),
    );
    card.append(h, p, actions);
    list.append(card);
  }
}
async function generateStoryBible() {
  if (!current || !bundle) return;
  const control = $<HTMLButtonElement>('generateBibleButton');
  control.disabled = true;
  control.textContent = 'AI 正在整理…';
  setSaveStatus('AI 整理中…');
  try {
    if (projectDirty) await enqueueSave(saveProjectState);
    const response = await fetch(`/api/projects/${current.id}/story-bible/generate-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: current.revision }),
    });
    if (!response.ok || !response.body) throw new Error(`无法启动 AI 整理（HTTP ${response.status}）`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let result: Json | null = null;
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split(/\r?\n/);
      buffer = done ? '' : (lines.pop() ?? '');
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line);
        if (event.stage === 'error') throw new Error(event.message);
        if (event.stage === 'preparing') setSaveStatus(`已读取 ${event.sourceChars} 字资料`);
        if (event.stage === 'extracting')
          setSaveStatus(`模型正在整理 · 已返回 ${event.receivedChars ?? 0} 字`);
        if (event.stage === 'retrying') setSaveStatus('首轮没有正文，正在关闭思考模式重试…');
        if (event.stage === 'rebasing') setSaveStatus('检测到新保存，正在把 AI 索引重放到最新版本…');
        if (event.stage === 'merging') setSaveStatus('正在合并并保护人工资料…');
        if (event.stage === 'done') result = event.result;
      }
      if (done) break;
    }
    if (!result) throw new Error('AI 整理结束，但没有收到结果');
    current.revision = result.revision;
    bundle.revision = result.revision;
    bundle.characters = result.characters;
    bundle.locations = result.locations;
    bundle.items = result.items;
    bundle.organizations = result.organizations;
    bundle.relations = result.relations;
    renderBible();
    setSaveStatus('已保存');
    toast(
      `AI 索引已更新：${result.characters.length} 人物、${result.locations.length} 地点、${result.items.length} 物品、${result.organizations.length} 组织`,
    );
  } catch (error) {
    handleSaveError(error as any);
  } finally {
    control.disabled = false;
    control.textContent = '✦ AI 更新结构化索引';
  }
}
const characterFields = [
  ['name', '姓名'],
  ['aliases', '别名（逗号分隔）'],
  ['role', '角色定位'],
  ['basicInfo', '基础信息'],
  ['appearance', '外貌'],
  ['personality', '性格'],
  ['speechStyle', '说话方式 / 语言习惯'],
  ['background', '背景'],
  ['motivation', '动机'],
  ['goals', '目标'],
  ['secrets', '秘密'],
  ['currentStatus', '当前状态'],
  ['tags', '标签（逗号分隔）'],
  ['notes', '备注'],
];
const locationFields = [
  ['name', '名称'],
  ['aliases', '别名（逗号分隔）'],
  ['type', '类型'],
  ['description', '描述'],
  ['geography', '地理'],
  ['culture', '文化'],
  ['rules', '规则'],
  ['currentStatus', '当前状态'],
  ['tags', '标签（逗号分隔）'],
  ['notes', '备注'],
];
const itemFields = [
  ['name', '名称'],
  ['aliases', '别名（逗号分隔）'],
  ['type', '类型'],
  ['description', '描述'],
  ['owner', '持有者'],
  ['abilities', '能力与作用'],
  ['origin', '来源'],
  ['currentStatus', '当前状态'],
  ['tags', '标签（逗号分隔）'],
  ['notes', '备注'],
];
const organizationFields = [
  ['name', '名称'],
  ['aliases', '别名（逗号分隔）'],
  ['type', '类型'],
  ['description', '描述'],
  ['purpose', '目标与立场'],
  ['culture', '文化'],
  ['rules', '规则'],
  ['leaders', '领导者'],
  ['headquarters', '总部'],
  ['currentStatus', '当前状态'],
  ['tags', '标签（逗号分隔）'],
  ['notes', '备注'],
];
const fieldsByType = {
  character: characterFields,
  location: locationFields,
  item: itemFields,
  organization: organizationFields,
};
function openEntityDialog(type: EntityType, item: any = null) {
  const form = $<HTMLFormElement>('entityForm');
  form.dataset.type = type;
  form.dataset.id = item?.id ?? '';
  $('entityDialogTitle').textContent = `${item ? '编辑' : '新增'}${entityConfig[type].label}`;
  const fields = $('entityFields');
  fields.replaceChildren();
  for (const [key, label] of fieldsByType[type]) {
    const wrap = document.createElement('label');
    wrap.textContent = label;
    const multi = !['name', 'aliases', 'role', 'tags', 'type'].includes(key);
    const input = multi ? document.createElement('textarea') : document.createElement('input');
    input.name = key;
    if (multi) (input as HTMLTextAreaElement).rows = 3;
    const value = item?.[key] ?? '';
    input.value = Array.isArray(value) ? value.join(', ') : value;
    wrap.append(input);
    fields.append(wrap);
  }
  const customWrap = document.createElement('label');
  customWrap.className = 'wide';
  customWrap.textContent = '自定义字段（每行“字段名: 内容”）';
  const customInput = document.createElement('textarea');
  customInput.name = 'customFields';
  customInput.rows = 4;
  customInput.value = Object.entries(item?.customFields ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  customWrap.append(customInput);
  fields.append(customWrap);
  dialog('entityDialog');
}
async function saveEntity() {
  if (!current) return;
  const form = $<HTMLFormElement>('entityForm'),
    type = form.dataset.type as EntityType,
    id = form.dataset.id,
    path = entityConfig[type].path,
    data: any = Object.fromEntries(new FormData(form));
  for (const key of ['aliases', 'tags'])
    data[key] = String(data[key] ?? '')
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean);
  data.customFields = Object.fromEntries(
    String(data.customFields ?? '')
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([^:：]+)[:：]\s*(.*)$/))
      .filter(Boolean)
      .map((match: any) => [match[1].trim(), match[2].trim()]),
  );
  data.expectedRevision = current.revision;
  data.trust = 'manual';
  try {
    const result = await api<Json>(`/projects/${current.id}/${path}${id ? `/${id}` : ''}`, {
      method: id ? 'PATCH' : 'POST',
      body: JSON.stringify(data),
    });
    current.revision = result.revision;
    bundle!.revision = result.revision;
    const items = bundle![path];
    if (id) {
      const i = items.findIndex((x: any) => x.id === id);
      items[i] = result.entity;
    } else items.push(result.entity);
    closeDialog('entityDialog');
    renderBible();
    setSaveStatus('已保存');
  } catch (e) {
    handleSaveError(e as any);
  }
}
async function deleteEntity(type: EntityType, item: any) {
  if (!current || !confirm(`删除“${item.name}”？关联关系也会删除。`)) return;
  const path = entityConfig[type].path;
  try {
    const result = await api<Json>(`/projects/${current.id}/${path}/${item.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: current.revision }),
    });
    current.revision = result.revision;
    bundle![path] = bundle![path].filter((x: any) => x.id !== item.id);
    bundle!.relations = bundle!.relations.filter(
      (x: any) => x.sourceId !== item.id && x.targetId !== item.id,
    );
    renderBible();
  } catch (e) {
    handleSaveError(e as any);
  }
}
function entityOptions() {
  const map = new Map<string, string>();
  for (const type of Object.keys(entityConfig) as EntityType[])
    for (const x of bundle?.[entityConfig[type].bundleKey] ?? [])
      map.set(x.id, `${entityConfig[type].label}：${x.name}`);
  return map;
}
function openRelationDialog() {
  const form = $<HTMLFormElement>('relationForm'),
    options = entityOptions();
  for (const name of ['source', 'target']) {
    const select = form.elements.namedItem(name) as HTMLSelectElement;
    select.replaceChildren();
    for (const [id, label] of options) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = label;
      select.append(o);
    }
  }
  dialog('relationDialog');
}
async function saveRelation() {
  if (!current) return;
  const form = $<HTMLFormElement>('relationForm'),
    data: any = Object.fromEntries(new FormData(form)),
    all = (Object.keys(entityConfig) as EntityType[]).flatMap((type) =>
      (bundle![entityConfig[type].bundleKey] ?? []).map((x: any) => ({ ...x, _type: type })),
    ),
    source = all.find((x) => x.id === data.source),
    target = all.find((x) => x.id === data.target);
  if (!source || !target) return;
  const body = {
    sourceType: source._type,
    sourceId: source.id,
    targetType: target._type,
    targetId: target.id,
    label: data.label,
    description: data.description,
    tags: String(data.tags ?? '')
      .split(/[,，]/)
      .map((x) => x.trim())
      .filter(Boolean),
    customFields: Object.fromEntries(
      String(data.customFields ?? '')
        .split(/\r?\n/)
        .map((line) => line.match(/^\s*([^:：]+)[:：]\s*(.*)$/))
        .filter(Boolean)
        .map((match: any) => [match[1].trim(), match[2].trim()]),
    ),
    trust: 'manual',
    expectedRevision: current.revision,
  };
  try {
    const result = await api<Json>(`/projects/${current.id}/relations`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    current.revision = result.revision;
    bundle!.relations.push(result.relation);
    closeDialog('relationDialog');
    renderBible();
  } catch (e) {
    handleSaveError(e as any);
  }
}
async function deleteRelation(relation: any) {
  if (!current || !confirm('删除这条关系？')) return;
  try {
    const result = await api<Json>(`/projects/${current.id}/relations/${relation.id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: current.revision }),
    });
    current.revision = result.revision;
    bundle!.relations = bundle!.relations.filter((x: any) => x.id !== relation.id);
    renderBible();
  } catch (e) {
    handleSaveError(e as any);
  }
}

async function openSettings() {
  settings = await api<Json>('/settings/runtime');
  renderApiConfigs();
  dialog('settingsDialog');
}
function renderApiConfigs() {
  const list = $('apiConfigList');
  list.replaceChildren();
  for (const [index, cfg] of (settings.apiConfigs ??= []).entries()) {
    const row = document.createElement('div');
    row.className = 'api-config';
    for (const [key, placeholder, type] of [
      ['name', '名称', 'text'],
      ['baseURL', 'Base URL', 'url'],
      ['model', '模型', 'text'],
      ['apiKey', 'API Key', 'password'],
    ]) {
      const input = document.createElement('input');
      input.placeholder = placeholder;
      input.type = type;
      input.value = cfg[key] ?? '';
      input.oninput = () => (cfg[key] = input.value);
      row.append(input);
    }
    row.append(
      button(
        '删除',
        () => {
          settings.apiConfigs.splice(index, 1);
          renderApiConfigs();
        },
        false,
        true,
      ),
    );
    list.append(row);
  }
}
async function saveSettings() {
  try {
    await api('/settings', { method: 'PUT', body: JSON.stringify(settings) });
    closeDialog('settingsDialog');
    toast('API 设置已保存');
  } catch (e) {
    toast((e as Error).message);
  }
}

async function readLegacyState(): Promise<Json | null> {
  if ('databases' in indexedDB) {
    const dbs = await indexedDB.databases();
    if (!dbs.some((x) => x.name === 'novelWriterDB')) {
      const raw = localStorage.getItem('novelWriterState');
      return raw ? JSON.parse(raw) : null;
    }
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('novelWriterDB');
    request.onerror = () => reject(request.error);
    request.onsuccess = async () => {
      const db = request.result;
      try {
        const getAll = (store: string) =>
          new Promise<any[]>((r) => {
            if (!db.objectStoreNames.contains(store)) return r([]);
            const tx = db.transaction(store),
              q = tx.objectStore(store).getAll();
            q.onsuccess = () => r(q.result ?? []);
            q.onerror = () => r([]);
          });
        const rows = await Promise.all(
          [
            'appState',
            'chapters',
            'chatWindows',
            'referenceWorks',
            'methodologyCards',
            'chapterSnapshots',
            'operationLogs',
            'agentEditHistory',
          ].map(getAll),
        );
        const app = rows[0].find((x) => x.key === 'main')?.value ?? {};
        resolve({
          ...app,
          chapters: rows[1],
          chatWindows: rows[2],
          referenceText: rows[3].find((x) => x.id === 'main')?.text ?? app.referenceText ?? '',
          methodologyCards: rows[4],
          chapterSnapshots: rows[5],
          operationLogs: rows[6],
          agentEditHistory: rows[7],
        });
      } catch (e) {
        reject(e);
      } finally {
        db.close();
      }
    };
  });
}
async function importLegacy(state: Json) {
  try {
    const result = await api<Json>('/import/legacy-browser', {
      method: 'POST',
      body: JSON.stringify({ state }),
    });
    closeDialog('importDialog');
    toast(result.duplicate ? '该数据已经迁移过' : '迁移完成');
    await loadProjects();
    if (!result.duplicate) openWorkbench(result.projectId);
  } catch (e) {
    toast((e as Error).message);
  }
}
function normalizeImport(data: Json) {
  if (data.type === 'novel-writer-server-project') return data;
  if (data.state) return data.state;
  return data;
}
function downloadCurrent() {
  if (!current) return;
  window.location.href = `/api/projects/${current.id}/export`;
}
function switchTab(tab: string) {
  document
    .querySelectorAll('.workspace-tabs button')
    .forEach((x) => x.classList.toggle('active', (x as HTMLElement).dataset.tab === tab));
  document.querySelectorAll('.tab-panel').forEach((x) => x.classList.toggle('hidden', x.id !== `tab-${tab}`));
}

$<HTMLFormElement>('authForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await api(`/auth/${(e.currentTarget as HTMLFormElement).dataset.mode}`, {
      method: 'POST',
      body: JSON.stringify({ pin: $<HTMLInputElement>('pin').value }),
    });
    await openLibrary();
  } catch (error) {
    toast((error as Error).message);
  }
};
$('logoutButton').onclick = async () => {
  await api('/auth/logout', { method: 'POST' });
  location.reload();
};
$('newProjectButton').onclick = () => dialog('projectDialog');
$<HTMLFormElement>('inspirationForm').onsubmit = async (event) => {
  event.preventDefault();
  const seed = $<HTMLTextAreaElement>('inspirationSeed').value.trim();
  if (!seed) return;
  const submit = $<HTMLButtonElement>('startInspirationButton');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    const project = await api<Project>('/projects', {
      method: 'POST',
      body: JSON.stringify({ title: seed.split('\n')[0].slice(0, 24), inspiration: seed }),
    });
    location.href = `/workbench.html?project=${encodeURIComponent(project.id)}&mode=inspiration&start=1`;
  } catch (error) {
    toast((error as Error).message);
    submit.disabled = false;
  }
};
$<HTMLFormElement>('projectForm').onsubmit = async (e) => {
  const form = e.currentTarget as HTMLFormElement;
  if ((e as SubmitEvent).submitter?.getAttribute('value') === 'cancel') {
    e.preventDefault();
    form.reset();
    closeDialog('projectDialog');
    return;
  }
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form));
  try {
    const p = await api<Project>('/projects', { method: 'POST', body: JSON.stringify(data) });
    closeDialog('projectDialog');
    form.reset();
    openWorkbench(p.id);
  } catch (error) {
    toast((error as Error).message);
  }
};
$<HTMLSelectElement>('statusFilter').onchange = loadProjects;
$('backButton').onclick = async () => {
  await enqueueSave(saveChapterNow);
  if (projectDirty) await enqueueSave(saveProjectState);
  await openLibrary();
};
$('saveProjectButton').onclick = () => void enqueueSave(saveProjectState);
$('chapterEditor').oninput = queueChapterSave;
$('addChapterButton').onclick = () => {
  state().project.chapterCount = (Number(state().project.chapterCount) || 0) + 1;
  renderChapters();
  queueProjectSave();
};
for (const id of [
  'projectTitle',
  'projectGenre',
  'projectSetting',
  'projectCharacters',
  'chapterCount',
  'wordsPerChapter',
])
  $(id).addEventListener('input', queueProjectSave);
document
  .querySelectorAll('.workspace-tabs button')
  .forEach((x) => x.addEventListener('click', () => switchTab((x as HTMLElement).dataset.tab!)));
$('addCharacterButton').onclick = () => openEntityDialog('character');
$('addLocationButton').onclick = () => openEntityDialog('location');
$('addItemButton').onclick = () => openEntityDialog('item');
$('addOrganizationButton').onclick = () => openEntityDialog('organization');
$('generateBibleButton').onclick = generateStoryBible;
$('saveBibleTextButton').onclick = () => {
  state().storyBibleFreeText = $<HTMLTextAreaElement>('storyBibleFreeText').value;
  state().project.characters = state().storyBibleFreeText;
  projectDirty = true;
  void enqueueSave(saveProjectState);
};
$('addRelationButton').onclick = openRelationDialog;
$<HTMLFormElement>('entityForm').onsubmit = (e) => {
  if ((e as SubmitEvent).submitter?.getAttribute('value') === 'cancel') {
    e.preventDefault();
    closeDialog('entityDialog');
    return;
  }
  e.preventDefault();
  saveEntity();
};
$<HTMLFormElement>('relationForm').onsubmit = (e) => {
  if ((e as SubmitEvent).submitter?.getAttribute('value') === 'cancel') {
    e.preventDefault();
    closeDialog('relationDialog');
    return;
  }
  e.preventDefault();
  saveRelation();
};
$('settingsButton').onclick = openSettings;
$<HTMLFormElement>('settingsForm').onsubmit = (e) => {
  if ((e as SubmitEvent).submitter?.getAttribute('value') === 'cancel') {
    e.preventDefault();
    closeDialog('settingsDialog');
    return;
  }
  e.preventDefault();
  saveSettings();
};
$('addApiConfig').onclick = () => {
  settings.apiConfigs ??= [];
  settings.apiConfigs.push({
    id: crypto.randomUUID(),
    name: '新配置',
    baseURL: 'https://api.deepseek.com',
    model: '',
    apiKey: '',
  });
  renderApiConfigs();
};
$('importButton').onclick = () => dialog('importDialog');
$('detectLegacyButton').onclick = async () => {
  try {
    const old = await readLegacyState();
    if (!old) return toast('当前来源没有检测到旧版数据');
    await importLegacy(old);
  } catch (e) {
    toast(`读取失败：${(e as Error).message}`);
  }
};
$<HTMLInputElement>('importFile').onchange = async (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) await importLegacy(normalizeImport(JSON.parse(await file.text())));
};
document
  .querySelectorAll('[data-close-dialog]')
  .forEach((x) => x.addEventListener('click', () => closeDialog((x as HTMLElement).dataset.closeDialog!)));
$('exportButton').onclick = downloadCurrent;
window.addEventListener('beforeunload', (e) => {
  if (projectDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
boot();
