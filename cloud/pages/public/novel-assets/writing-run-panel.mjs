import {
  bookActivities,
  subscribeBookActivities,
  requireBookSession,
  stopBookActivity,
} from './native-activity.mjs';
import { openProposalConversation } from './proposal-navigation.mjs';
import { runItemStatus } from './writing-run-core.mjs';
import { watchBookChanges } from './book-sync.mjs';

export function createWritingRunPanel(React) {
  const h = React.createElement;
  return function WritingRunPanel({
    ctx,
    api,
    book,
    sessionId,
    initialRunId,
    onSelect,
    busy,
    onStart,
    onResume,
    onReview,
    onChapter,
  }) {
    const [catalog, setCatalog] = React.useState(null),
      [run, setRun] = React.useState(null),
      [selected, setSelected] = React.useState(initialRunId ?? null),
      [error, setError] = React.useState(''),
      [loading, setLoading] = React.useState(false),
      [start, setStart] = React.useState('1'),
      [end, setEnd] = React.useState('3'),
      [visible, setVisible] = React.useState(30),
      [, render] = React.useReducer((n) => n + 1, 0);
    React.useEffect(() => subscribeBookActivities(ctx, render), [ctx]);
    React.useEffect(() => {
      if (initialRunId) setSelected(initialRunId);
    }, [initialRunId]);
    React.useEffect(() => {
      let alive = true,
        polling = false;
      const refresh = async () => {
        if (polling || document.visibilityState === 'hidden') return false;
        polling = true;
        try {
          const listing = await api('writing-run');
          const detail = selected ? await api('writing-run', null, { id: selected }) : null;
          if (alive) {
            setCatalog((previous) =>
              previous?.items.length > 20
                ? {
                    ...listing,
                    items: [
                      ...listing.items,
                      ...previous.items.filter((r) => !listing.items.some((p) => p.id === r.id)),
                    ],
                    nextOffset: previous.nextOffset,
                  }
                : listing,
            );
            setRun(detail);
            setError('');
          }
        } catch (e) {
          if (alive) setError(e.message);
          throw e;
        } finally {
          polling = false;
        }
      };
      setRun(null);
      setVisible(30);
      const release = watchBookChanges(api, {
        refresh,
        ready: () => !polling,
        active: () => bookActivities(ctx, book).rows.some((r) => ['running', 'pending'].includes(r.kind)),
        error: (e) => {
          if (alive) setError(e.message);
        },
      });
      return () => {
        alive = false;
        release();
      };
    }, [api, selected]);
    const activities = bookActivities(ctx, book),
      activity = activities.rows.find((r) => r.id === (run?.originSessionId ?? sessionId));
    const unavailable = activities.phase !== 'ready';
    const executing = ['running', 'waiting', 'pending'].includes(activity?.kind);
    let originAvailable = true;
    if (run)
      try {
        requireBookSession(ctx, book, run.originSessionId);
      } catch {
        originAvailable = false;
      }
    const act = async (fn) => {
      setLoading(true);
      setError('');
      try {
        return await fn();
      } catch (e) {
        setError(e.message);
      } finally {
        setLoading(false);
      }
    };
    const disabled = busy || loading;
    return h(
      'section',
      { className: 'novel-run-panel novel-reference-editor', 'aria-label': '按纲连写' },
      h('h2', null, '按纲连写'),
      h(
        'details',
        { open: !selected },
        h('summary', null, '新建连写'),
        h(
          'div',
          { className: 'novel-outline-range' },
          h(
            'label',
            null,
            '起始章',
            h('input', {
              type: 'number',
              min: 1,
              max: 10000,
              value: start,
              'aria-label': '连写起始章',
              onChange: (e) => setStart(e.target.value),
            }),
          ),
          h(
            'label',
            null,
            '结束章',
            h('input', {
              type: 'number',
              min: 1,
              max: 10000,
              value: end,
              'aria-label': '连写结束章',
              onChange: (e) => setEnd(e.target.value),
            }),
          ),
        ),
        h(
          'p',
          { className: 'novel-reference-hint' },
          '新章自动保存，已有正文跳过。先完成章纲，写作要求使用当前对话框。',
        ),
        h(
          'button',
          {
            type: 'button',
            'data-variant': 'primary',
            disabled:
              disabled ||
              unavailable ||
              ['running', 'waiting', 'pending'].includes(
                activities.rows.find((r) => r.id === sessionId)?.kind,
              ),
            onClick: () =>
              act(async () => {
                const range = { start: Number(start), end: Number(end) };
                if (
                  !Number.isSafeInteger(range.start) ||
                  !Number.isSafeInteger(range.end) ||
                  range.start < 1 ||
                  range.end < range.start ||
                  range.end > 10000 ||
                  range.end - range.start >= 1000
                )
                  throw new Error('请输入 1–10000 内的有效范围，每次最多 1000 章。');
                const created = await onStart(range, 'new-chapters');
                if (created) setSelected(created.id);
              }),
          },
          '开始按纲连写',
        ),
      ),
      error ? h('p', { role: 'alert' }, error) : null,
      unavailable ? h('p', { role: 'status' }, activities.notice) : null,
      selected && !run
        ? h('p', { role: 'status' }, error ? '检查点尚不可用，未重新发起或清空进度。' : '正在读取检查点…')
        : null,
      run
        ? h(
            'div',
            { className: 'novel-run-detail' },
            h('h3', null, `第 ${run.range.start}–${run.range.end} 章`),
            h(
              'p',
              { role: 'status' },
              `${run.phase === 'closed' ? '授权已关闭' : run.phase === 'blocked' ? '需处理冲突' : run.completed ? '本批写作已完成' : '连写检查点'} · ${run.generated}/${run.total} 章 · 跳过 ${run.skipped} 章`,
            ),
            h('p', null, run.publication === 'review' ? '逐章审阅模式' : '自动保存新章模式'),
            run.instruction
              ? h('details', null, h('summary', null, '本次要求'), h('p', null, run.instruction))
              : null,
            run.notice ? h('p', { role: 'alert' }, run.notice) : null,
            activity ? h('p', { role: 'status' }, '原对话：' + activity.text) : null,
            h(
              'div',
              { className: 'novel-ms-actions' },
              h(
                'button',
                {
                  type: 'button',
                  disabled: disabled || !originAvailable,
                  onClick: () => act(() => openProposalConversation(ctx, book, run)),
                },
                originAvailable ? '查看发起对话' : '发起对话不可用',
              ),
              activity?.canStop
                ? h(
                    'button',
                    {
                      type: 'button',
                      disabled: disabled,
                      onClick: () => act(() => stopBookActivity(ctx, book, run.originSessionId)),
                    },
                    '停止连写',
                  )
                : null,
              run.phase === 'open' && !run.completed
                ? h(
                    'button',
                    {
                      type: 'button',
                      disabled:
                        disabled ||
                        unavailable ||
                        executing ||
                        !originAvailable ||
                        run.originSessionId !== sessionId,
                      title:
                        run.originSessionId !== sessionId
                          ? '先打开原对话，再继续此检查点'
                          : '明确点击才会再次调用模型',
                      onClick: () => act(() => onResume(run)),
                    },
                    '从检查点继续',
                  )
                : null,
              run.phase !== 'closed'
                ? h(
                    'details',
                    null,
                    h('summary', null, '关闭授权'),
                    h('p', null, '不删除候选或正文，也不等于停止原生对话。'),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: disabled,
                        onClick: () =>
                          act(async () => setRun(await api('writing-run', { action: 'close', id: run.id }))),
                      },
                      '确认关闭连写授权',
                    ),
                  )
                : null,
            ),
            h(
              'ol',
              { className: 'novel-run-chapters' },
              ...run.items
                .slice(0, visible)
                .map((item) =>
                  h(
                    'li',
                    { key: item.chapter },
                    h('span', null, `第 ${item.chapter} 章 · ${runItemStatus(item)}`),
                    item.proposalId
                      ? h(
                          'button',
                          { type: 'button', disabled: disabled, onClick: () => onReview(item.proposalId) },
                          item.published ? '查看生成记录' : '查看候选',
                        )
                      : null,
                    item.published
                      ? h(
                          'button',
                          { type: 'button', disabled: disabled, onClick: () => onChapter(item.path) },
                          '打开正文',
                        )
                      : null,
                  ),
                ),
            ),
            run.items.length > visible
              ? h('button', { type: 'button', onClick: () => setVisible(visible + 30) }, '显示更多章节')
              : null,
          )
        : null,
      h(
        'details',
        { open: !selected },
        h('summary', null, '连写记录'),
        !catalog
          ? h('p', null, '正在读取…')
          : !catalog.items.length
            ? h('p', null, '暂无连写记录。')
            : h(
                'ul',
                { className: 'novel-run-history' },
                ...catalog.items.map((row) =>
                  h(
                    'li',
                    { key: row.id },
                    row.error
                      ? h('span', { role: 'alert' }, row.error + ' · ' + row.id)
                      : h(
                          'button',
                          {
                            type: 'button',
                            'aria-pressed': selected === row.id,
                            onClick: () => {
                              setSelected(row.id);
                              onSelect(row.id);
                            },
                          },
                          `第 ${row.range.start}–${row.range.end} 章 · ${row.generated}/${row.total}${row.phase === 'closed' ? ' · 已关闭' : row.phase === 'blocked' ? ' · 冲突' : ''}`,
                        ),
                  ),
                ),
              ),
        catalog?.nextOffset !== null && catalog
          ? h(
              'button',
              {
                type: 'button',
                disabled: disabled,
                onClick: () =>
                  act(async () => {
                    const more = await api('writing-run', { action: 'list', offset: catalog.nextOffset });
                    setCatalog({
                      ...more,
                      items: [
                        ...catalog.items,
                        ...more.items.filter((r) => !catalog.items.some((p) => p.id === r.id)),
                      ],
                    });
                  }),
              },
              '更早记录',
            )
          : null,
      ),
    );
  };
}
