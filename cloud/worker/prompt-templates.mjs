import { LEGACY_DEFAULT_PROMPTS } from './legacy-default-prompts.mjs';
export { LEGACY_DEFAULT_PROMPTS };
export const PROMPT_LABELS = Object.freeze({
  outline: '大纲',
  write: '正文',
  outlineContinue: '扩展大纲',
  deai: '润色去套路',
  ending: '收尾',
});
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const TEMPLATE_LIMIT = 64 * 1024;
export function compileTemplate(text, bindings) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > TEMPLATE_LIMIT)
    throw new Error('提示词需为文本且不超过 64 KiB；原模板保留，请缩短后重试。');
  const unknown = new Set();
  const body = text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (all, key) => {
    if (Object.hasOwn(bindings, key)) return String(bindings[key]);
    unknown.add(key);
    return all;
  });
  if (new TextEncoder().encode(body).length > 128 * 1024)
    throw new Error('展开后的提示词超过 128 KiB，未截短；请精简模板或章纲。');
  return { body, unknownFields: [...unknown] };
}
// Long-material placeholders use explicit native read references, not copied
// whole-book text or model-guessed values. Small known metadata is expanded once.
export function prepareTemplate({ key, rulesText, rulesHash, book, outline, range, rows = [], mode }) {
  if (!Object.hasOwn(LEGACY_DEFAULT_PROMPTS, key)) throw new Error('未知提示词类型，未发起任务。');
  const rules = rulesText == null ? {} : JSON.parse(rulesText.replace(/^\uFEFF/, ''));
  if (!object(rules) || (rules.savedPrompts !== undefined && !object(rules.savedPrompts)))
    throw new Error('提示词旧结构不兼容，请先核对 rules.json；未自动转换。');
  const custom = rules.savedPrompts?.[key];
  if (custom !== undefined && typeof custom !== 'string')
    throw new Error('所选提示词不是文本，原值保留；请先在提示词页检查。');
  const project = object(rules.project) ? rules.project : {};
  const ref = (path, meaning) =>
    `【通过原生读取工具读取 ${book.root}/${path}：${meaning}；若文件不存在请如实说明，不编造】`;
  const number = outline?.chapter ?? '未关联章号，不从文件名猜测';
  const planValue = (value, meaning) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return new TextEncoder().encode(text ?? '').length <= 4096
      ? text
      : ref('outline.json', '读取第 ' + number + ' 章的完整' + meaning + '，不要截短或猜测');
  };
  const positive = (v) => Number.isSafeInteger(v) && v > 0;
  const bindings = {
    title: book.title ?? '未命名小说',
    genre: typeof project.genre === 'string' && project.genre.trim() ? project.genre : '未设置',
    setting: ref('setting.md', '作者背景设定'),
    characters: ref('setting.md', '作者人物与关键设定；相关资料另核对 canon.json'),
    chapterCount: positive(project.chapterCount)
      ? project.chapterCount
      : '未指定全书总章数，不把本批章数当总数',
    chapterNumber: number,
    chapter: number,
    chapterTitle: outline?.title ?? '未关联章纲标题，以当前正文为准',
    chapterSummary:
      outline?.summary === undefined
        ? '无关联章纲；按作者要求自由创作，不编造既定规划'
        : planValue(outline.summary, '概要'),
    previousSummary: ref('memory.json', '仅把前情摘要当检索线索，与实际前文核对'),
    prevChapters: ref('outline.json', '按当前 chapterPath 查找并按需读取相关前章正文，不重读整本书'),
    memory: ref('memory.json', '仅作记忆线索，不能覆盖作者确认的事实'),
    note: typeof outline?.note === 'string' ? planValue(outline.note, '章内要求') : '',
    novelNote: typeof project.novelNote === 'string' ? project.novelNote : '',
    plotPoints: outline?.plotPoints === undefined ? '未提供' : planValue(outline.plotPoints, '剧情点'),
    wordCount: positive(project.wordsPerChapter)
      ? `至少 ${project.wordsPerChapter} 字，不设上限`
      : '充分展开，不设字数上限',
    mode:
      mode === 'write'
        ? '按本次要求写作'
        : mode === 'continue'
          ? '只追加新增续文，不重复旧正文'
          : mode === 'rewrite'
            ? '只改本次冻结范围'
            : '起草当前章节',
    existingChapterCount: rows.length,
    existingOutline: ref('outline.json', '原规划，保持本次范围外内容不变'),
    writtenChapters: ref('outline.json', '按关联读取本批及相邻已写正文；规划不是已发生事实'),
    startChapter: range?.start ?? '不适用',
    endChapter: range?.end ?? '不适用',
    missingChapterCount: range ? range.end - range.start + 1 : '不适用',
  };
  return {
    version: 1,
    key,
    source: custom ? 'custom' : 'default',
    rulesHash: rulesHash ?? null,
    ...compileTemplate(custom || LEGACY_DEFAULT_PROMPTS[key], bindings),
  };
}
export const validTemplate = (value) =>
  object(value) &&
  value.version === 1 &&
  Object.hasOwn(LEGACY_DEFAULT_PROMPTS, value.key) &&
  ['custom', 'default'].includes(value.source) &&
  typeof value.body === 'string' &&
  new TextEncoder().encode(value.body).length <= 128 * 1024 &&
  Array.isArray(value.unknownFields) &&
  value.unknownFields.every((s) => typeof s === 'string');
