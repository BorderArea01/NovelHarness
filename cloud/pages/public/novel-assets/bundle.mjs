export const FORMAT = 'novel-harness-book-v1';
export const FILE_LIMIT = 512 * 1024;
export const IMPORT_LIMIT = 32 * 1024 * 1024;
const encoder = new TextEncoder();
const SECRET_KEYS =
  /^(?:api_?key|apiConfigs|activeConfigId|authorization|access_?token|refresh_?token|password|pin|pinHash|sessions|serverKey|cloudflare_?api_?token)$/i;

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// Preserve character "secret" fields and all story text; remove credential FIELDS,
// not arbitrary prose. An original backup stays on the user's machine.
export function removeCredentials(value, removed = []) {
  if (Array.isArray(value)) return value.map((item) => removeCredentials(item, removed));
  if (!object(value)) return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (SECRET_KEYS.test(key)) {
        removed.push(key);
        return [];
      }
      return [[key, removeCredentials(item, removed)]];
    }),
  );
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (object(value))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stable(value[key])]),
    );
  return value;
}

export async function digest(text) {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    text instanceof Uint8Array ? text : encoder.encode(text),
  );
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function splitText(text, maxBytes = FILE_LIMIT) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 4) throw new Error('分片长度无效。');
  const parts = [];
  let start = 0,
    length = 0,
    index = 0;
  for (const char of text) {
    const size = encoder.encode(char).length;
    if (length + size > maxBytes) {
      parts.push(text.slice(start, index));
      start = index;
      length = 0;
    }
    length += size;
    index += char.length;
  }
  if (index > start || !parts.length) parts.push(text.slice(start));
  return parts;
}

function count(value) {
  return Array.isArray(value) ? value.length : object(value) ? Object.keys(value).length : 0;
}

export async function makeBookBundle(input, { seed = '', title = '' } = {}) {
  const removed = [];
  let source;
  if (input != null) {
    if (!object(input)) throw new Error('请选择单本小说的项目 JSON，而不是数组或完整书库。');
    const state = object(input.state) ? input.state : input;
    if (!object(state.project) || (!('outline' in state) && !('chapters' in state))) {
      throw new Error('未识别的项目格式。请使用局域网书库中的“导出项目 JSON”。');
    }
    source = removeCredentials(input, removed);
  } else {
    if (!seed.trim()) throw new Error('写下一点灵感就可以开始。');
    if (encoder.encode(seed).length > 32 * 1024) throw new Error('灵感过长，请改用项目导入。');
    const seedTitle = [...seed.trim().split(/\r?\n/)[0]].slice(0, 24).join('');
    source = {
      state: {
        project: { title: title.trim() || seedTitle, setting: '', characters: '' },
        outline: [],
        chapters: [],
        seed,
      },
    };
  }
  const serialized = JSON.stringify(source);
  if (encoder.encode(serialized).length > IMPORT_LIMIT)
    throw new Error('本轮导入上限为 32 MiB，原文件未改动。');
  const state = object(source.state) ? source.state : source;
  const identity = { ...source };
  delete identity.exportedAt;
  const fingerprint = await digest(JSON.stringify(stable(identity)));
  const id = `b-${fingerprint.slice(0, 32)}`;
  const root = `/workspace/novels/${id}`;
  const files = [];
  async function add(path, text, kind) {
    const parts = splitText(String(text));
    const paths = [];
    for (let index = 0; index < parts.length; index++) {
      const target = parts.length === 1 ? path : `${path}.part-${String(index + 1).padStart(4, '0')}`;
      const content = parts[index];
      files.push({
        path: target,
        content,
        bytes: encoder.encode(content).length,
        sha256: await digest(content),
        kind,
      });
      paths.push(target);
    }
    return paths;
  }
  const json = (value) => JSON.stringify(value ?? {}, null, 2);
  await add(
    'setting.md',
    `# 背景设定\n\n${state.project.setting ?? ''}\n\n# 人物 / 关键设定（作者原文）\n\n${state.project.characters ?? ''}\n\n${state.storyBibleFreeText ?? ''}${typeof state.assistantPrompt === 'string' && state.assistantPrompt.trim() ? '\n\n# 作者写作要求\n\n' + state.assistantPrompt : ''}`,
    'setting',
  );
  await add('seed.md', seed || state.seed || state.uiDrafts?.inspirationWriter?.seed || '', 'seed');
  await add('outline.json', json(state.outline ?? []), 'outline');
  await add(
    'canon.json',
    json({
      notice: '仅人工确认资料可作为权威；保留各条记录原有 source / confirmed 状态。',
      characters: source.characters ?? [],
      locations: source.locations ?? [],
      items: source.items ?? [],
      organizations: source.organizations ?? [],
      relations: source.relations ?? [],
    }),
    'canon',
  );
  await add(
    'memory.json',
    json({ memory: state.memory ?? {}, chapterMemories: state.chapterMemories ?? {} }),
    'memory',
  );
  await add(
    'rules.json',
    json({
      savedPrompts: state.savedPrompts ?? {},
      project: {
        genre: state.project.genre ?? '',
        chapterCount: state.project.chapterCount ?? null,
        wordsPerChapter: state.project.wordsPerChapter ?? null,
        novelNote: state.project.novelNote ?? '',
      },
    }),
    'rules',
  );
  let chapters = [];
  if (Array.isArray(state.chapters)) chapters = state.chapters;
  else if (object(state.chapters))
    chapters = Object.entries(state.chapters).map(([chapter, value]) => ({
      chapter,
      ...(object(value) ? value : { content: value }),
    }));
  else if (state.chapters != null) throw new Error('章节格式不正确，未上传任何数据。');
  const seen = new Set();
  const chapterIndex = [];
  for (const chapter of chapters) {
    const number = Number(chapter.chapter ?? chapter.id);
    if (!Number.isFinite(number) || seen.has(number) || typeof chapter.content !== 'string') {
      throw new Error('存在重复编号或无法识别的章节正文，未上传任何数据。');
    }
    seen.add(number);
    // Filenames never derive from titles, user-controlled paths or raw IDs.
    const name = `chapters/${String(chapterIndex.length + 1).padStart(5, '0')}.md`;
    chapterIndex.push({
      chapter: number,
      paths: await add(name, chapter.content, 'chapter'),
      sha256: await digest(chapter.content),
    });
  }
  await add('chapter-index.json', json(chapterIndex), 'index');
  const archive = await add('archive/source.json', serialized, 'archive');
  const manifest = {
    format: FORMAT,
    id,
    root,
    fingerprint,
    title: String(state.project.title || source.project?.title || '未命名小说').slice(0, 200),
    stats: {
      chapters: chapters.length,
      chats: count(state.chatWindows),
      snapshots: count(state.chapterSnapshots),
      operationLogs: count(state.operationLogs),
      agentHistory: count(state.agentEditHistory),
    },
    removedCredentialFields: [...new Set(removed)],
    archive,
    files: files.map(({ content: _content, ...metadata }) => metadata),
  };
  if (encoder.encode(json(manifest)).length > FILE_LIMIT || files.length > 2048)
    throw new Error('项目文件过多，请拆分后导入；未上传任何数据。');
  return { manifest, files };
}

export function writingPrompt(book) {
  if (book?.format !== FORMAT || !/^b-[a-f0-9]{32}$/.test(book.id)) throw new Error('无效的小说收据。');
  const root = `/workspace/novels/${book.id}`;
  return JSON.stringify({ book: root });
}
