// Sequence lives in the original outline; physical chapter paths remain identity.
// No parallel chapter table, mirror text, or heuristic replacement of prose.
export const ORDER_REVIEW_FORMAT = 'novel-chapter-order-review-v1';
export const ORDER_BUDGET = 8 * 1024 * 1024;
export class ChapterOrderError extends Error {}
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const number = (v) =>
  (typeof v === 'number' || (typeof v === 'string' && /^[1-9]\d*$/.test(v))) &&
  Number.isSafeInteger(Number(v)) &&
  Number(v) > 0 &&
  Number(v) <= 10000
    ? Number(v)
    : null;
export const serializeOrderJSON = (value, text = '') =>
  (text.startsWith('\uFEFF') ? '\uFEFF' : '') +
  JSON.stringify(value, null, 2) +
  (text.endsWith('\n') ? '\n' : '');
export function orderReview(value) {
  return object(value?.chapterOrderReview) &&
    value.chapterOrderReview.format === ORDER_REVIEW_FORMAT &&
    value.chapterOrderReview.required === true
    ? value.chapterOrderReview
    : null;
}
export function markOrderReview(value, version, remapping) {
  if (!object(value)) throw new ChapterOrderError('章节关联文件格式不兼容，未转换或覆盖原结构。');
  if (Object.hasOwn(value, 'chapterOrderReview') && value.chapterOrderReview?.format !== ORDER_REVIEW_FORMAT)
    throw new ChapterOrderError('文件已有不同格式的 chapterOrderReview 字段，未覆盖。');
  value.chapterOrderReview = {
    ...value.chapterOrderReview,
    format: ORDER_REVIEW_FORMAT,
    required: true,
    version,
    remapping,
    notice: '章节顺序已调整；结构化章号已同步，自由文本章号、旧前文记忆与接力需人工复核。',
  };
  return value;
}
export function prepareChapterOrder(value, bindings, files, legacy) {
  value = structuredClone(value);
  const rows = Array.isArray(value) ? value : value.chapters;
  if (!Array.isArray(rows) || rows.some((row) => !object(row)))
    throw new ChapterOrderError('大纲结构不兼容，未转换。');
  const used = new Set(),
    paths = new Set(),
    entries = [];
  const bodyFiles = files.filter((f) => f.category === 'chapter');
  const bodies = new Map(bodyFiles.map((f) => [f.path, f]));
  function add(row, linked, added = false, imported = false) {
    const chapter = number(row.chapter);
    if (!chapter || used.has(chapter))
      throw new ChapterOrderError('大纲章号必须为唯一的 1–10000 正整数；请先修正重复或无效编号。');
    if (linked.length > 1)
      throw new ChapterOrderError('一个章纲关联了多份正文，未猜测移动对象；请先明确绑定。');
    const path = linked[0] ?? null;
    if (path && (!bodies.has(path) || paths.has(path)))
      throw new ChapterOrderError('正文缺失或重复关联，未重排；请先核对章纲绑定。');
    used.add(chapter);
    if (path) {
      paths.add(path);
      row.chapterPath = path;
    } else row.chapterPath = null; // Explicit absence must not rebind through the old import index after renumbering.
    entries.push({
      key: path ?? 'outline:' + chapter,
      chapter,
      path,
      added,
      imported,
      title:
        typeof row.title === 'string' && row.title.trim()
          ? row.title
          : bodies.get(path)?.title || '未命名章纲',
      row,
    });
  }
  rows.forEach((row, i) => add(row, bindings[i]?.paths ?? []));
  for (const file of bodyFiles.filter((f) => !paths.has(f.path)))
    if (legacy.filter((item) => !used.has(Number(item.chapter)) && item.paths.includes(file.path)).length > 1)
      throw new ChapterOrderError('旧索引将同一正文关联到多个章号，未猜测旧身份；请先明确章纲绑定。');
  // Freeze import fallback paths into the current outline BEFORE changing keys.
  // The provenance index itself is never rewritten or treated as live progress.
  for (const item of legacy) {
    if (used.has(Number(item.chapter))) continue;
    if (item.paths.some((path) => bodies.has(path) && !paths.has(path))) {
      const path = item.paths.length === 1 ? item.paths[0] : null;
      add(
        { chapter: item.chapter, title: bodies.get(path)?.title || '导入章节', summary: '', plotPoints: [] },
        item.paths,
        true,
        true,
      );
    }
  }
  for (const file of bodyFiles)
    if (!paths.has(file.path)) {
      const chapter = Math.max(0, ...used) + 1;
      add({ chapter, title: file.title, summary: '', plotPoints: [] }, [file.path], true);
    }
  entries.sort((a, b) => a.chapter - b.chapter);
  return { value, entries };
}
const typed = (old, next) => (typeof old === 'string' ? String(next) : next);
const remapValue = (value, map) => (map.has(number(value)) ? typed(value, map.get(number(value))) : value);
function remapDictionary(value, map) {
  if (!object(value)) throw new ChapterOrderError('按章号索引的旧字段格式不兼容，未覆盖。');
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    const next = number(key) && map.has(Number(key)) ? String(map.get(Number(key))) : key;
    if (Object.hasOwn(result, next))
      throw new ChapterOrderError('重排会碰撞未关联的章节引用，未覆盖；请先核对相关章号。');
    Object.defineProperty(result, next, {
      value: item,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
function chapterFields(value, map) {
  if (!object(value)) return value;
  for (const key of [
    'chapter',
    'sourceChapter',
    'introducedChapter',
    'resolvedChapter',
    'firstSeenChapter',
    'lastSeenChapter',
  ])
    if (Object.hasOwn(value, key)) value[key] = remapValue(value[key], map);
  if (Array.isArray(value.sourceChapters))
    value.sourceChapters = value.sourceChapters.map((v) => remapValue(v, map));
  return value;
}
function memoryFields(value, map) {
  if (!object(value)) throw new ChapterOrderError('旧记忆不是对象，未自动转换。');
  if (object(value.characters)) Object.values(value.characters).forEach((row) => chapterFields(row, map));
  for (const key of ['locations', 'factions', 'importantEvents', 'worldBuilding', 'chapterCards'])
    if (Array.isArray(value[key])) value[key].forEach((row) => chapterFields(row, map));
  for (const key of ['active', 'resolved'])
    if (Array.isArray(value.foreshadows?.[key]))
      value.foreshadows[key].forEach((row) => chapterFields(row, map));
  for (const key of ['characters', 'foreshadows', 'locations', 'factions'])
    if (object(value.indexes?.[key]))
      for (const name of Object.keys(value.indexes[key]))
        if (Array.isArray(value.indexes[key][name]))
          value.indexes[key][name] = value.indexes[key][name].map((v) => remapValue(v, map));
}
const meaningful = (v) =>
  object(v)
    ? Object.entries(v).some(([k, item]) => k !== 'chapterOrderReview' && meaningful(item))
    : Array.isArray(v)
      ? v.some(meaningful)
      : typeof v === 'string'
        ? !!v.trim()
        : !!v;
export function reorderChapterFiles(prepared, keys, documents, version) {
  const { entries, value } = prepared;
  if (entries.length < 2) throw new ChapterOrderError('至少两章才能调整顺序。');
  if (!Array.isArray(keys) || keys.length !== entries.length || new Set(keys).size !== keys.length)
    throw new ChapterOrderError('重排必须保留全部章节且不重复，未删除或补猜章节。');
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  if (keys.some((key) => typeof key !== 'string' || !byKey.has(key)))
    throw new ChapterOrderError('章节列表已变化，请重新读取顺序。');
  if (keys.every((key, i) => key === entries[i].key))
    throw new ChapterOrderError('章节位置没有变化，未写入文件。');
  const mapping = new Map(),
    changes = [];
  const rows = keys.map((key, index) => {
    const entry = byKey.get(key),
      to = entries[index].chapter;
    // A previously unnumbered free-writing file has no old numeric identity.
    if (!entry.added || entry.imported) mapping.set(entry.chapter, to);
    changes.push({ key, title: entry.title, path: entry.path, from: entry.chapter, to, added: entry.added });
    return { ...entry.row, chapter: typed(entry.row.chapter, to) };
  });
  const remapping = [...mapping].filter(([from, to]) => from !== to).map(([from, to]) => ({ from, to }));
  const outlineValue = Array.isArray(value) ? rows : { ...value, chapters: rows };
  const writes = [
    { path: 'outline.json', text: serializeOrderJSON(outlineValue, documents['outline.json']?.text) },
  ];
  for (const path of ['rules.json', 'memory.json', 'canon.json']) {
    const original = documents[path];
    if (!original) continue;
    const data = JSON.parse(original.text.replace(/^\uFEFF/, ''));
    if (!object(data)) throw new ChapterOrderError(path + ' 结构不兼容；未转换原资料。');
    if (Object.hasOwn(data, 'chapterOrderReview') && data.chapterOrderReview?.format !== ORDER_REVIEW_FORMAT)
      throw new ChapterOrderError('文件已有不同格式的 chapterOrderReview 字段，未覆盖。');
    if (path === 'rules.json' && data.creativeRules !== undefined) {
      if (!object(data.creativeRules)) throw new ChapterOrderError('创作规则格式不同，未覆盖。');
      if (data.creativeRules.chapterPOVOverrides !== undefined)
        data.creativeRules.chapterPOVOverrides = remapDictionary(
          data.creativeRules.chapterPOVOverrides,
          mapping,
        );
    }
    if (path === 'memory.json') {
      memoryFields(data, mapping);
      if (data.memory !== undefined) memoryFields(data.memory, mapping);
      if (data.chapterMemories !== undefined) {
        if (!object(data.chapterMemories)) throw new ChapterOrderError('章节记忆旧格式不同，未重排。');
        for (const [key, record] of Object.entries(data.chapterMemories)) {
          if (
            number(key) &&
            object(record) &&
            record.chapter !== undefined &&
            number(record.chapter) !== Number(key)
          )
            throw new ChapterOrderError('章节记忆的键与章号不一致，未猜测关联。');
          chapterFields(record, mapping);
        }
        data.chapterMemories = remapDictionary(data.chapterMemories, mapping);
      }
    }
    if (path === 'canon.json')
      for (const group of ['characters', 'locations', 'items', 'organizations', 'relations']) {
        if (data[group] !== undefined && !Array.isArray(data[group]))
          throw new ChapterOrderError('资料列表旧格式不同，未重排。');
        for (const row of data[group] ?? []) chapterFields(row, mapping);
      }
    if (meaningful(data)) markOrderReview(data, version, remapping);
    const text = serializeOrderJSON(data, original.text);
    if (text !== original.text) writes.push({ path, text });
  }
  return { writes, changes, remapping };
}
