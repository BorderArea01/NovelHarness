// Inline manuscript operations. No dialogs, synthetic Agent calls, or local
// authoritative store: the native content endpoint owns atomic mutations.
export const CONTENT_LABELS = {
  clearChapter: '清空本章正文',
  deleteChapter: '删除本章',
  removeOutline: '删除这条章纲',
  clearOutline: '清空章节大纲',
  clearDirection: '清空全篇方向',
  clearPlanning: '清空大纲与全篇方向',
};
const descriptions = {
  clearChapter:
    '只清空本章正文；章纲、记忆、设定、草稿和聊天仍保留，仍可能影响后续写作。原文可恢复。要换掉旧故事，请在书库选择“重新开始”。',
  deleteChapter: '章节移入回收站，解除章纲关联；不删除章纲，也不改其他章号。',
  removeOutline: '只删除这条章纲，正文和其他章纲保留。',
  clearOutline: '只删除章纲；全篇方向、正文、记忆、设定、草稿和聊天仍保留，仍可能影响后续写作。',
  clearDirection: '只清空全篇方向，章节大纲和正文保留。',
  clearPlanning:
    '清空章纲与全篇方向；正文、记忆、设定、草稿和聊天仍保留。要完全换掉旧故事，请在书库选择“重新开始”。',
};
export function createContentManagement(React) {
  const h = React.createElement;
  return function ContentManagement({ request, api, busy, onClose, onCommit }) {
    const [preview, setPreview] = React.useState(null),
      [error, setError] = React.useState(''),
      [loading, setLoading] = React.useState(true),
      [page, setPage] = React.useState(null),
      [restoring, setRestoring] = React.useState(null),
      [reload, setReload] = React.useState(0);
    const owner = React.useRef(null),
      heading = React.useRef(null);
    const list = request.action === 'list';
    React.useEffect(() => {
      const token = {};
      owner.current = token;
      setLoading(true);
      setError('');
      setPreview(null);
      const fetch = list
        ? api('content')
        : api('content', {
            action: 'inspect',
            targetAction: request.action,
            path: request.path,
          });
      fetch
        .then((value) => {
          if (owner.current !== token) return;
          if (list) setPage(value);
          else {
            const visible = request.frame;
            const version =
              visible?.path === request.path
                ? value.expected.document
                : visible?.path === 'outline.json' &&
                    !['clearChapter', 'clearDirection'].includes(request.action)
                  ? value.expected.outline
                  : visible?.path === 'notes/story-plan.md'
                    ? value.expected.direction
                    : undefined;
            if (version !== undefined && version !== visible?.hash)
              throw new Error('已保存内容有更新，请返回并重新读取后操作；未删除或清空。');
            setPreview(value);
          }
        })
        .catch((e) => {
          if (owner.current === token) setError(e.message);
        })
        .finally(() => {
          if (owner.current === token) setLoading(false);
        });
      return () => {
        owner.current = null;
      };
    }, [request, reload]);
    React.useLayoutEffect(() => {
      heading.current?.focus();
    }, []);
    async function commit(data) {
      setError('');
      try {
        await onCommit(data);
      } catch (e) {
        if (owner.current) setError(e.message);
      }
    }
    async function more() {
      setLoading(true);
      setError('');
      const token = owner.current;
      try {
        const next = await api('content', null, { after: page.nextCursor });
        if (token === owner.current) setPage({ ...next, items: [...page.items, ...next.items] });
      } catch (e) {
        if (token === owner.current) setError(e.message);
      } finally {
        if (token === owner.current) setLoading(false);
      }
    }
    return h(
      'section',
      { className: 'novel-content-management', 'aria-label': list ? '回收与恢复' : '确认手动操作' },
      h(
        'header',
        null,
        h('h2', { ref: heading, tabIndex: -1 }, list ? '回收与恢复' : CONTENT_LABELS[request.action]),
        h('button', { type: 'button', disabled: busy, onClick: onClose }, '返回书稿'),
      ),
      loading ? h('p', { role: 'status' }, '正在核对…') : null,
      error ? h('p', { role: 'alert' }, error) : null,
      error && !busy ? h('button', { onClick: () => setReload(reload + 1) }, '重新核对') : null,
      list
        ? h(
            React.Fragment,
            null,
            !loading && page && !page.items.length ? h('p', null, '还没有手动删除或清空记录。') : null,
            ...(page?.items ?? []).map((row) =>
              h(
                'article',
                { key: row.id, className: 'novel-content-recovery-row' },
                h(
                  'div',
                  null,
                  h('strong', null, row.title || '恢复记录异常'),
                  h(
                    'small',
                    null,
                    (CONTENT_LABELS[row.action] || '') +
                      ' · ' +
                      (row.at ? new Date(row.at).toLocaleString() : ''),
                  ),
                  row.warning ? h('p', { role: 'alert' }, row.warning) : null,
                ),
                row.status === 'available'
                  ? h('button', { disabled: busy, onClick: () => setRestoring(row) }, '恢复')
                  : h('span', null, row.status === 'restored' ? '已恢复' : '暂不可恢复'),
                restoring?.id === row.id
                  ? h(
                      'div',
                      { className: 'novel-content-confirm', role: 'group', 'aria-label': '确认恢复' },
                      h('p', null, '恢复操作前的已保存内容；如目标已有新修改，将拒绝覆盖。'),
                      h(
                        'button',
                        {
                          disabled: busy,
                          'data-variant': 'primary',
                          onClick: () => commit({ action: 'restore', id: row.id }),
                        },
                        '确认恢复',
                      ),
                      h('button', { disabled: busy, onClick: () => setRestoring(null) }, '取消恢复'),
                    )
                  : null,
              ),
            ),
            page?.hasMore ? h('button', { disabled: busy || loading, onClick: more }, '更早的记录') : null,
          )
        : preview
          ? h(
              React.Fragment,
              null,
              preview.title ? h('h3', null, preview.title) : null,
              h('p', null, descriptions[request.action]),
              ['clearOutline', 'clearPlanning'].includes(request.action)
                ? h(
                    'p',
                    null,
                    preview.outlineCount === null
                      ? '大纲格式异常；仍会保留原文件快照。'
                      : '当前 ' + preview.outlineCount + ' 条章纲。',
                  )
                : null,
              preview.generating
                ? h('p', { role: 'status' }, '本书 AI 正在生成；结束后重新核对即可，不会中断任务。')
                : null,
              h(
                'div',
                { className: 'novel-content-confirm' },
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: busy || preview.generating,
                    'data-variant': 'danger',
                    onClick: () =>
                      commit({
                        action: request.action,
                        path: request.path,
                        index: request.index,
                        expected: preview.expected,
                      }),
                  },
                  busy ? '正在处理…' : '确认' + CONTENT_LABELS[request.action],
                ),
                h('button', { type: 'button', disabled: busy, onClick: onClose }, '取消'),
              ),
            )
          : null,
    );
  };
}
