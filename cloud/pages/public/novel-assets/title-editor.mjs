// Metadata edits use original native owners, not an AI prompt or copied title map.
export function cleanTitle(value) {
  const title = String(value ?? '')
    .trim()
    .normalize('NFC');
  if (!title || [...title].length > 120 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(title))
    throw new Error('标题需为 1–120 字的单行文本。');
  return title;
}
export async function renameConversation(ctx, id, value, previous) {
  const title = cleanTitle(value);
  const result = await ctx.sessions.using(id, { source: 'workspaceOperation' }, (reference) => {
    const row = ctx.sessions.list.getSnapshot().byId[id];
    if (!row || row.title !== previous) throw new Error('对话标题已更新，请取消后重新编辑。');
    return reference.binding.session.rename(title);
  });
  if (!result.ok) throw new Error(result.error.message);
}
export async function renameBook(ctx, book, value, previous) {
  const title = cleanTitle(value);
  const workspace = await ctx.workspaces.create({ path: book.root });
  if (workspace.path !== book.root) throw new Error('作品目录不匹配，未更改书名。');
  const current = ctx.workspaces.list
    .getSnapshot()
    .items.find((row) => row.workspaceId === workspace.workspaceId);
  if (previous !== undefined && current && current.title !== previous)
    throw new Error('书名已更新，请取消后重新编辑。');
  await ctx.workspaces.rename(workspace.workspaceId, title);
}
export function createTitleEditor(React) {
  const h = React.createElement;
  return function TitleEditor({ value, label, buttonLabel = '改名', onSave, disabled = false, hint = '' }) {
    const [editing, setEditing] = React.useState(false),
      [draft, setDraft] = React.useState(''),
      [original, setOriginal] = React.useState(''),
      [busy, setBusy] = React.useState(false),
      [error, setError] = React.useState('');
    const input = React.useRef(null),
      launcher = React.useRef(null),
      pending = React.useRef(false),
      wasEditing = React.useRef(false);
    React.useEffect(() => {
      if (editing) {
        input.current?.focus();
        input.current?.select();
      } else if (wasEditing.current) launcher.current?.focus();
      wasEditing.current = editing;
    }, [editing]);
    const cancel = () => {
      if (!pending.current) {
        setEditing(false);
        setError('');
        launcher.current?.focus();
      }
    };
    return h(
      'div',
      {
        className: 'novel-title-control',
        'data-editing': editing ? 'true' : 'false',
        onKeyDown: (event) => {
          if (event.key === 'Escape' && editing) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        },
      },
      h(
        'button',
        {
          type: 'button',
          ref: launcher,
          className: 'novel-title-edit-button',
          disabled: disabled || busy,
          'aria-label': '修改' + label,
          'aria-expanded': editing,
          title: hint || '手动修改' + label + '，不调用 AI',
          onClick: () => {
            if (editing) cancel();
            else {
              setOriginal(value);
              setDraft(value ?? '');
              setError('');
              setEditing(true);
            }
          },
        },
        h('span', { 'aria-hidden': true }, '✎ '),
        buttonLabel,
      ),
      editing
        ? h(
            'form',
            {
              className: 'novel-title-form',
              'aria-label': '修改' + label,
              onSubmit: async (event) => {
                event.preventDefault();
                if (pending.current || disabled) return;
                try {
                  const title = cleanTitle(draft);
                  if (value !== original) throw new Error('标题已更新，请取消后重新编辑，未覆盖其他修改。');
                  pending.current = true;
                  setBusy(true);
                  setError('');
                  await onSave(title);
                  setEditing(false);
                  launcher.current?.focus();
                } catch (reason) {
                  setError(reason.message || '标题未能保存，请重试。');
                } finally {
                  pending.current = false;
                  setBusy(false);
                }
              },
            },
            h(
              'label',
              null,
              label,
              h('input', {
                ref: input,
                'aria-label': label,
                value: draft,
                maxLength: 240,
                disabled: busy || disabled,
                autoComplete: 'off',
                onChange: (e) => setDraft(e.target.value),
              }),
            ),
            h(
              'div',
              { className: 'novel-title-actions' },
              h(
                'button',
                { type: 'submit', disabled: busy || disabled || !draft.trim(), 'data-variant': 'primary' },
                busy ? '保存中…' : '保存标题',
              ),
              h('button', { type: 'button', disabled: busy, onClick: cancel }, '取消'),
            ),
            error ? h('p', { role: 'alert' }, error) : null,
          )
        : null,
    );
  };
}
