import { pointText } from './outline-core.mjs';
import { documentReadHint, writingReferences } from './reference-core.mjs';

export const REVIEW_FOCUS = Object.freeze({
  general: '审稿',
  coverage: '剧情覆盖',
  continuity: '前后矛盾',
});
export function chapterFocus(document) {
  const plan = document?.outline;
  if (!plan) return null;
  return {
    chapter: plan.chapter,
    title: plan.title,
    summary: plan.summary,
    note: plan.note,
    points: (Array.isArray(plan.plotPoints) ? plan.plotPoints : []).map((point, index) => ({
      number: index + 1,
      text: pointText(point),
      authorMarked: typeof point === 'object' && point?.done === true,
    })),
  };
}
export function reviewPrompt(book, document, documents, { focus = 'general', instruction = '' } = {}) {
  if (!Object.hasOwn(REVIEW_FOCUS, focus)) throw new Error('审稿类型无效，未发送。');
  if (focus === 'coverage' && !document.outline) throw new Error('本章未关联章纲；请先关联或使用普通审稿。');
  return JSON.stringify({
    request: instruction.trim() || REVIEW_FOCUS[focus],
    kind: 'review',
    book: book.root,
    target: { path: documentReadHint(book, document), hash: document.hash },
    focus,
    ...(document.outline ? { chapterOutline: document.outline } : {}),
    materials: JSON.parse(writingReferences(book, documents)).materials,
  });
}
export function createChapterFocus(React) {
  const h = React.createElement;
  return function ChapterFocus({ document, disabled, onReview }) {
    const [visible, setVisible] = React.useState(20);
    React.useEffect(() => setVisible(20), [document?.path]);
    const value = chapterFocus(document);
    if (!value) return null;
    return h(
      'details',
      { className: 'novel-chapter-focus' },
      h('summary', null, '本章目标' + (value.points.length ? ' · ' + value.points.length + ' 个剧情点' : '')),
      h(
        'section',
        { 'aria-label': '本章目标对照' },
        value.summary
          ? h('p', null, typeof value.summary === 'string' ? value.summary : JSON.stringify(value.summary))
          : null,
        h(
          'ol',
          null,
          ...value.points
            .slice(0, visible)
            .map((point) =>
              h(
                'li',
                { key: point.number },
                point.text,
                point.authorMarked ? h('small', null, ' · 旧标记为完成，仍需核对正文') : null,
              ),
            ),
        ),
        value.points.length > visible
          ? h('button', { type: 'button', onClick: () => setVisible(visible + 20) }, '显示更多目标')
          : null,
        value.note
          ? h(
              'details',
              null,
              h('summary', null, '章内要求'),
              h('p', null, typeof value.note === 'string' ? value.note : JSON.stringify(value.note)),
            )
          : null,
        h('button', { type: 'button', disabled, onClick: () => onReview('coverage') }, '核对剧情覆盖'),
      ),
    );
  };
}
