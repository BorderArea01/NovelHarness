import { changedLines } from './manuscript-core.mjs';

export function historyFrameMatches(document, text, frame) {
  return (
    !!document &&
    !!frame &&
    document.path === frame.path &&
    document.hash === frame.hash &&
    text === frame.text
  );
}

// Metadata only; snapshot text remains lazy/read-only in the original reader.
export function mergeHistoryPage(current, result, after = null) {
  if (
    !Array.isArray(result?.versions) ||
    result.versions.length > 50 ||
    result.versions.some(
      (v) => !/^[a-f0-9]{64}$/.test(v.hash) || !Number.isFinite(v.updatedAt) || v.updatedAt < 0,
    )
  )
    throw new Error('历史列表返回格式不完整，当前稿未修改。');
  if (after !== null && current.nextCursor !== after) throw new Error('历史分页已变化，未追加旧页面。');
  const hasMore = result.hasMore === true;
  const unsupported = hasMore && result.nextCursor === undefined;
  const cursor = result.nextCursor ?? null;
  if (
    (hasMore && !result.versions.length) ||
    (!hasMore && cursor !== null) ||
    (!unsupported &&
      hasMore &&
      (typeof cursor !== 'string' || !cursor.length || cursor.length > 512 || cursor === after))
  )
    throw new Error('历史分页返回不完整，原列表已保留。');
  const versions = [...(after === null ? [] : current.versions), ...result.versions];
  if (new Set(versions.map((v) => v.hash)).size !== versions.length)
    throw new Error('历史分页返回重复版本，原列表已保留。');
  return {
    ...current,
    versions,
    hasMore,
    nextCursor: cursor,
    paginationUnavailable: unsupported,
    loading: false,
    listError: null,
  };
}

// Read-only views over original VFS snapshots. The existing manuscript still
// owns the only writable draft, save, conflict detection and persisted history.
export function createDocumentHistory(React, ProseEditor) {
  const h = React.createElement;
  return function DocumentHistory({
    data,
    document,
    text,
    busy,
    canLoad,
    onClose,
    onPreview,
    onLoad,
    onDownload,
    onRetry,
    onMore,
  }) {
    const [side, setSide] = React.useState('after'),
      [confirm, setConfirm] = React.useState(null),
      [jump, setJump] = React.useState(0);
    const root = React.useRef(null);
    const version = data.version,
      dirty = text !== document.text;
    const change = React.useMemo(
      () => (version ? changedLines(text, version.text) : null),
      [text, version?.text],
    );
    React.useEffect(() => {
      setConfirm(null);
      setJump(0);
    }, [version?.hash]);
    React.useLayoutEffect(() => {
      root.current?.querySelector('[data-history-return]')?.focus({ preventScroll: true });
    }, []);
    const stale =
      confirm && (!historyFrameMatches(document, text, confirm) || confirm.versionHash !== version?.hash);
    const different = !!version && version.text !== text;
    const frame = () => ({ path: document.path, hash: document.hash, text, versionHash: version.hash });
    return h(
      'section',
      { ref: root, className: 'novel-history', 'aria-label': '历史版本', 'data-side': side },
      h(
        'header',
        { className: 'novel-history-toolbar' },
        h('button', { type: 'button', 'data-history-return': '', onClick: onClose }, '返回编辑'),
        h('h2', null, '历史版本'),
        dirty ? h('button', { type: 'button', onClick: onDownload }, '下载当前稿') : null,
      ),
      data.versions?.length
        ? h(
            'label',
            { className: 'novel-history-picker' },
            h('span', null, document.chapterTitle || document.path.split('/').pop()),
            h(
              'select',
              {
                'aria-label': '选择历史版本',
                value: data.pending ?? version?.hash ?? '',
                disabled: busy,
                onChange: (e) => {
                  const entry = data.versions.find((v) => v.hash === e.target.value);
                  if (entry) onPreview(entry);
                },
              },
              h('option', { value: '', disabled: true }, '选择版本进行比较'),
              ...data.versions.map((entry) =>
                h(
                  'option',
                  { key: entry.hash, value: entry.hash },
                  new Date(entry.updatedAt).toLocaleString() + ' · ' + entry.hash.slice(0, 8),
                ),
              ),
            ),
          )
        : !data.loading && !data.error && !data.listError
          ? h('p', null, '首次修改保存后会保留原文。')
          : null,
      data.loading || data.pending ? h('p', { role: 'status' }, '正在读取历史，可随时返回编辑…') : null,
      data.error ? h('p', { role: 'alert' }, data.error) : null,
      data.listError
        ? h(
            'p',
            { role: 'alert' },
            data.listError,
            !data.versions?.length
              ? h('button', { type: 'button', disabled: !!data.loading, onClick: onRetry }, '重试读取历史')
              : null,
          )
        : null,
      data.hasMore
        ? data.paginationUnavailable
          ? h(
              'p',
              { className: 'novel-reference-hint' },
              '当前服务尚不支持读取更早版本，请刷新更新后的平台再试；历史文件未删除。',
            )
          : h(
              'div',
              { className: 'novel-history-controls' },
              h('span', { className: 'novel-reference-hint' }, '已载入 ' + data.versions.length + ' 份'),
              h(
                'button',
                { type: 'button', disabled: !!data.loading, onClick: onMore },
                data.listError ? '重试读取更早版本' : '读取更早版本',
              ),
            )
        : null,
      !version
        ? h('p', null, '查看历史不会修改当前稿。')
        : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'novel-history-controls' },
              h(
                'div',
                { className: 'novel-history-sides', role: 'group', 'aria-label': '比较内容' },
                h(
                  'button',
                  { type: 'button', 'aria-pressed': side === 'before', onClick: () => setSide('before') },
                  '当前稿',
                ),
                h(
                  'button',
                  { type: 'button', 'aria-pressed': side === 'after', onClick: () => setSide('after') },
                  '历史稿',
                ),
              ),
              different
                ? h('button', { type: 'button', onClick: () => setJump(jump + 1) }, '定位首处变化')
                : h('span', null, '与当前稿一致'),
              h(
                'button',
                {
                  type: 'button',
                  disabled: busy || !!data.pending || !canLoad || !different || !!confirm,
                  onClick: () => (dirty ? setConfirm(frame()) : onLoad(frame())),
                },
                '载入此版本（尚未保存）',
              ),
            ),
            !canLoad ? h('p', null, '此候选只读，可以比较，不能载入修改。') : null,
            confirm
              ? h(
                  'div',
                  { className: 'novel-history-confirm', role: 'group', 'aria-label': '确认替换未保存稿' },
                  h(
                    'p',
                    { role: stale ? 'status' : undefined },
                    stale
                      ? '当前稿已变化，请取消后重新核对。'
                      : '将替换本机未保存的修改；云端仍需另行保存。可以先下载当前稿。',
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy || !!data.pending || !!stale,
                      onClick: () => onLoad(confirm),
                    },
                    '确认替换未保存稿',
                  ),
                  h('button', { type: 'button', onClick: () => setConfirm(null) }, '取消替换'),
                )
              : null,
            different
              ? h(
                  'p',
                  { className: 'novel-reference-hint' },
                  '首处变化：第 ' + (change.start + 1) + ' 行 · 两份完整内容均可滚动查看',
                )
              : null,
            h(
              'div',
              { className: 'novel-history-panes' },
              ...[
                ['before', '当前稿（含未保存修改）', text, '当前稿比较'],
                ['after', '所选历史版本', version.text, '历史版本预览'],
              ].map(([key, title, value, label]) =>
                h(
                  'section',
                  { key, className: 'novel-history-pane', 'data-side': key },
                  h('h3', null, title),
                  h(ProseEditor, {
                    value,
                    readOnly: true,
                    label,
                    revealLine: jump
                      ? { line: Math.min(change.start + 1, value.split('\n').length), request: jump }
                      : null,
                  }),
                ),
              ),
            ),
          ),
    );
  };
}
