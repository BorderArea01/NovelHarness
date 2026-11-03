import { createProseEditor } from './prose-editor.mjs';
import { openTaskProposal } from './proposal-navigation.mjs';

// Presentation only, read directly from the ORIGINAL native Tool block and its
// incremental PartialArguments. No provider stream, copied transcript or draft.
export function proposalToolModel(toolName, block) {
  const settled = 'kind' in block;
  const raw = settled
    ? (block.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n')
    : '';
  let result;
  try {
    result = JSON.parse(raw);
  } catch {
    /* The actual non-JSON error remains visible. */
  }
  const submit = toolName === 'novel_proposal_submit';
  const stopped = block.error?.code === 'interrupted';
  return {
    settled,
    raw,
    result,
    content: submit ? (block.args?.text?.('content') ?? '') : '',
    failed: settled && !!block.isError,
    label: stopped
      ? '写作已停止，草稿保留'
      : settled && block.isError
        ? '本次操作失败'
        : !submit
          ? settled
            ? '执行详情'
            : '准备写作…'
          : !settled
            ? block.phase === 'preparing'
              ? '正在写作…'
              : '正在保存…'
            : result?.published === true
              ? '已保存到书稿'
              : result?.saved === true && result?.published === false
                ? result.publicationIssue || result.warning
                  ? '未保存到书稿，草稿已保留'
                  : '草稿已保留'
                : '执行详情',
  };
}

export function installProposalToolViews(ctx, React) {
  const h = React.createElement,
    ProseEditor = createProseEditor(React);
  function ProposalToolView({ toolName, block, useDisclosure }) {
    const model = proposalToolModel(toolName, block);
    const { expanded, toggle } = useDisclosure();
    const open = expanded;
    return h(
      'section',
      { className: 'novel-proposal-tool', 'aria-label': model.label },
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': open,
          onClick: toggle,
        },
        model.label,
      ),
      model.failed ? h('p', { role: 'alert' }, '操作未完成。展开执行详情查看原因；未声称已保存。') : null,
      open && model.result?.bookId && model.result?.proposalId
        ? h(
            'button',
            {
              type: 'button',
              onClick: () =>
                openTaskProposal(ctx, { bookId: model.result.bookId, proposalId: model.result.proposalId }),
            },
            '打开生成记录',
          )
        : null,
      open
        ? h(
            React.Fragment,
            null,
            model.content
              ? h(ProseEditor, { value: model.content, readOnly: true, label: '候选流式预览' })
              : null,
            model.result?.warning ? h('p', { role: 'note' }, model.result.warning) : null,
            model.result?.publicationIssue ? h('p', { role: 'alert' }, model.result.publicationIssue) : null,
            model.result?.validation?.issues?.length
              ? h('ul', null, ...model.result.validation.issues.map((issue, i) => h('li', { key: i }, issue)))
              : null,
            model.settled
              ? h('details', null, h('summary', null, '调用结果'), h('pre', null, model.raw))
              : null,
          )
        : null,
    );
  }
  ctx.effect(
    () =>
      ctx.slots.inject('tool.call.toolview', function* () {
        for (const key of ['novel_proposal_prepare', 'novel_proposal_inspect', 'novel_proposal_submit'])
          yield ctx.slots.register({ name: 'tool.call.toolview', key }, ProposalToolView);
      }),
    'novel: original native proposal tool presentation',
  );
}
