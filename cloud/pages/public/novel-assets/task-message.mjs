// An explicit, versioned presentation envelope INSIDE the original sent text.
// No transcript replacement, text-phrase guessing, task store or authority claim.
import { openTaskProposal, openTaskRun, validProposalId } from './proposal-navigation.mjs';
import { validRunId } from './writing-run-core.mjs';
import { TASK_LABELS } from './conversation-title.mjs';
export { TASK_LABELS } from './conversation-title.mjs';
const PREFIX = '[novel-task:v1]\n';
const LINKED_PREFIX = '[novel-task:v2]\n';
const RUN_PREFIX = '[novel-task:v3]\n';
const SEPARATOR = '\n[/novel-task]\n';
function valid(value) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length ===
      (Object.hasOwn(value, 'proposalId') || Object.hasOwn(value, 'runId') ? 4 : 3) &&
    ['kind', 'bookId', 'instruction'].every((key) => Object.hasOwn(value, key)) &&
    typeof value.kind === 'string' &&
    Object.hasOwn(TASK_LABELS, value.kind) &&
    typeof value.bookId === 'string' &&
    /^b-[a-f0-9]{32}$/.test(value.bookId) &&
    typeof value.instruction === 'string' &&
    (value.kind === 'writing-run'
      ? validRunId(value.runId) && !Object.hasOwn(value, 'proposalId')
      : !Object.hasOwn(value, 'runId')) &&
    (!Object.hasOwn(value, 'proposalId') || (value.kind !== 'review' && validProposalId(value.proposalId)))
  );
}
function header(value) {
  return JSON.stringify({
    kind: value.kind,
    bookId: value.bookId,
    instruction: value.instruction,
    ...(Object.hasOwn(value, 'proposalId') ? { proposalId: value.proposalId } : {}),
    ...(Object.hasOwn(value, 'runId') ? { runId: value.runId } : {}),
  });
}
export function taskMessage(prompt, metadata) {
  if (!valid(metadata) || typeof prompt !== 'string' || !prompt.trim())
    throw new Error('创作任务格式不正确，未发送。');
  return (
    (Object.hasOwn(metadata, 'runId')
      ? RUN_PREFIX
      : Object.hasOwn(metadata, 'proposalId')
        ? LINKED_PREFIX
        : PREFIX) +
    header(metadata) +
    SEPARATOR +
    prompt
  );
}
export function parseTaskMessage(text) {
  if (typeof text !== 'string') return null;
  const prefix = text.startsWith(RUN_PREFIX)
    ? RUN_PREFIX
    : text.startsWith(LINKED_PREFIX)
      ? LINKED_PREFIX
      : text.startsWith(PREFIX)
        ? PREFIX
        : null;
  if (!prefix) return null;
  const end = text.indexOf(SEPARATOR, prefix.length);
  if (end < 0) return null;
  try {
    const rawHeader = text.slice(prefix.length, end),
      metadata = JSON.parse(rawHeader);
    // Reject duplicate/extra keys and alternative interpretations of a header.
    if (
      !valid(metadata) ||
      Object.hasOwn(metadata, 'proposalId') !== (prefix === LINKED_PREFIX) ||
      Object.hasOwn(metadata, 'runId') !== (prefix === RUN_PREFIX) ||
      rawHeader !== header(metadata)
    )
      return null;
    const prompt = text.slice(end + SEPARATOR.length);
    return prompt.trim() ? { ...metadata, prompt } : null;
  } catch {
    return null;
  }
}
export const taskMessageRule = {
  id: 'novel-task',
  order: 0,
  match(text, from) {
    if (from !== 0) return;
    const data = parseTaskMessage(text);
    if (data) return { id: 'novel-task', start: 0, end: text.length, data };
  },
};
export function installTaskMessages(ctx, React) {
  const h = React.createElement;
  function TaskMessage({ node, raw, interactive }) {
    const [expanded, setExpanded] = React.useState(false),
      [error, setError] = React.useState(''),
      contentId = React.useId(),
      data = node.data;
    // Compact native queue previews remain text, not a second interactive view.
    if (!interactive)
      return h('span', null, TASK_LABELS[data.kind], data.instruction ? ' · ' + data.instruction : '');
    return h(
      'span',
      { className: 'novel-task-card', 'data-task-kind': data.kind },
      h('strong', null, TASK_LABELS[data.kind]),
      data.instruction ? h('span', { className: 'novel-task-intent' }, data.instruction) : null,
      expanded && (data.proposalId || data.runId)
        ? h(
            'button',
            {
              type: 'button',
              onClick: () => {
                try {
                  if (data.runId) openTaskRun(ctx, data);
                  else openTaskProposal(ctx, data);
                  setError('');
                } catch (fault) {
                  setError(fault.message);
                }
              },
            },
            data.runId ? '查看连写进度' : '打开生成记录',
          )
        : null,
      error ? h('span', { role: 'alert' }, error) : null,
      h(
        'button',
        {
          type: 'button',
          'aria-expanded': expanded,
          'aria-controls': contentId,
          onClick: () => setExpanded(!expanded),
        },
        expanded ? '收起执行详情' : '执行详情',
      ),
      expanded ? h('span', { id: contentId, className: 'novel-task-source' }, raw) : null,
    );
  }
  ctx.effect(() => ctx.uiConversation.userText.register(taskMessageRule), 'novel: native task text rule');
  ctx.slots.inject('conversation.user.text.node', () =>
    ctx.slots.register(
      {
        name: 'conversation.user.text.node',
        key: 'novel-task',
      },
      TaskMessage,
    ),
  );
}
