import { TASK_LABELS } from './task-message.mjs';
import { pointText } from './outline-core.mjs';

// A read-only view of the original proposal's author request and its verified
// planning version, not a second task list or an automatic quality score.
export function writingBasis(review) {
  const task = review?.proposal?.writing;
  if (
    task?.version !== 1 ||
    !['begin', 'continue', 'rewrite'].includes(task.mode) ||
    typeof task.instruction !== 'string'
  )
    return null;
  const context = review.writingContext;
  const current =
    !!context &&
    Object.hasOwn(context, 'outlineHash') &&
    !review.orderWarning &&
    !review.contextWarning &&
    context.outlineHash === review.proposal.contextOutlineHash;
  return {
    label:
      task.templateKey === 'deai'
        ? '润色'
        : task.templateKey === 'ending'
          ? '章节收尾'
          : task.purpose === 'chapter'
            ? TASK_LABELS.chapter
            : task.purpose === 'free-chapter'
              ? '自由生成本章'
              : TASK_LABELS[task.mode],
    template: review.proposal.promptTemplate,
    instruction: task.instruction,
    outline: current ? context.outline : undefined,
    warning: current ? context.planningWarning : '规划版本已变化，不把当前章纲冒充此候选的旧依据。',
  };
}

export function createWritingBasis(React) {
  const h = React.createElement;
  return function WritingBasis({ review }) {
    const [open, setOpen] = React.useState(false),
      [visible, setVisible] = React.useState(20);
    const basis = writingBasis(review);
    if (!basis) return null;
    const plan = basis.outline;
    const points = Array.isArray(plan?.plotPoints) ? plan.plotPoints : [];
    return h(
      'details',
      { className: 'novel-writing-basis', open, onToggle: (event) => setOpen(event.currentTarget.open) },
      h('summary', null, '本次写作依据'),
      open
        ? h(
            React.Fragment,
            null,
            h('strong', null, basis.label),
            h('p', null, basis.instruction || '未追加要求；沿用本书规则。'),
            basis.template?.version === 1
              ? h(
                  'details',
                  null,
                  h(
                    'summary',
                    null,
                    '本次实际提示词 · ' + (basis.template.source === 'custom' ? '自定义' : '旧版默认'),
                  ),
                  h(
                    'pre',
                    { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } },
                    basis.template.body,
                  ),
                  basis.template.unknownFields?.length
                    ? h('p', { role: 'note' }, '未识别占位符：' + basis.template.unknownFields.join('、'))
                    : null,
                )
              : null,
            basis.warning ? h('p', { role: 'note' }, basis.warning) : null,
            plan
              ? h(
                  'section',
                  { 'aria-label': '本次关联章纲' },
                  h('h4', null, '第 ' + String(plan.chapter) + ' 章 · ' + String(plan.title ?? '')),
                  h('p', null, String(plan.summary ?? '')),
                  plan.note
                    ? h('p', null, typeof plan.note === 'string' ? plan.note : JSON.stringify(plan.note))
                    : null,
                  points.length
                    ? h(
                        'ol',
                        null,
                        ...points
                          .slice(0, visible)
                          .map((point, index) => h('li', { key: index }, pointText(point))),
                      )
                    : null,
                  points.length > visible
                    ? h(
                        'button',
                        { type: 'button', onClick: () => setVisible(visible + 20) },
                        '继续显示剧情点',
                      )
                    : null,
                )
              : null,
            h(
              'p',
              { className: 'novel-reference-hint' },
              '对照人物视角、动作与物品连续性、章纲的关键事实；这里不自动判定候选已达标。',
            ),
          )
        : null,
    );
  };
}
