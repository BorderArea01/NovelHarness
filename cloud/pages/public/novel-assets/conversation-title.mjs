export const TASK_LABELS = Object.freeze({
  begin: '试写开场',
  chapter: '按纲生成本章',
  polish: '润色',
  ending: '章节收尾',
  continue: '接着写',
  rewrite: '按想法改写',
  review: '审稿',
  canon: '整理资料',
  outline: '规划大纲',
  'outline-resume': '补全规划',
  'writing-run': '按纲连写',
});
// Native provisional titles may be truncated or whitespace-normalized first
// messages. This is a label only, never a parser, receipt or history rewrite.
export function conversationTitle(raw) {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (/^\[novel-task:v[123]\]/.test(text)) {
    const kind = /^\[novel-task:v[123]\]\s*\{"kind":"([a-z-]+)"/.exec(text)?.[1];
    return Object.hasOwn(TASK_LABELS, kind) ? TASK_LABELS[kind] : '创作对话';
  }
  return text || '新对话';
}
