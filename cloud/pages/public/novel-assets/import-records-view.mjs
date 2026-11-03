import { RECORD_TYPES, loadImportRecords, recordText, importReference } from './import-records.mjs';
import { makeWorkspaceClient } from './workspace.mjs';
import { createProseEditor } from './prose-editor.mjs';

export function createImportRecords(React) {
  const h = React.createElement;
  const ProseEditor = createProseEditor(React);
  return function ImportRecords({ bookId, onReference }) {
    const [archive, setArchive] = React.useState(null),
      [error, setError] = React.useState('');
    const [progress, setProgress] = React.useState('读取导入记录…'),
      [attempt, setAttempt] = React.useState(0);
    const [type, setType] = React.useState('chatWindows'),
      [query, setQuery] = React.useState('');
    const [page, setPage] = React.useState(0),
      [selected, setSelected] = React.useState(null);
    const [raw, setRaw] = React.useState(false),
      [actionError, setActionError] = React.useState('');
    React.useEffect(() => {
      setRaw(false);
      setActionError('');
    }, [selected]);
    React.useEffect(() => {
      const controller = new AbortController();
      setError('');
      setArchive(null);
      setSelected(null);
      setProgress('读取导入记录…');
      loadImportRecords(bookId, makeWorkspaceClient().readFile, {
        signal: controller.signal,
        onProgress: ({ done, total }) => setProgress('读取导入记录 ' + done + ' / ' + total),
      })
        .then((value) => {
          if (controller.signal.aborted) return;
          setArchive(value);
          setType(value.records[0]?.type ?? 'chatWindows');
          setProgress('');
        })
        .catch((e) => {
          if (!controller.signal.aborted) {
            setError(e.message);
            setProgress('');
          }
        });
      return () => controller.abort();
    }, [bookId, attempt]);
    const search = React.useDeferredValue(query.trim().toLocaleLowerCase());
    const filtered = React.useMemo(
      () =>
        archive?.records.filter(
          (record) =>
            record.type === type &&
            (!search || JSON.stringify(record.value).toLocaleLowerCase().includes(search)),
        ) ?? [],
      [archive, type, search],
    );
    const record = filtered.find((item) => item.pointer === selected);
    const text = React.useMemo(
      () => (record ? (raw ? JSON.stringify(record.value, null, 2) : recordText(record)) : ''),
      [record, raw],
    );
    const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / 30) - 1));
    return h(
      'section',
      { className: 'novel-import-records', 'aria-label': '导入记录' },
      h('p', { className: 'novel-reference-hint' }, '导入时的历史资料 · 只读，不代表当前书稿'),
      progress ? h('p', { role: 'status' }, progress) : null,
      error
        ? h(
            'div',
            { role: 'alert' },
            error,
            h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, '重新读取'),
          )
        : null,
      actionError ? h('p', { role: 'alert' }, actionError) : null,
      archive
        ? h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'novel-import-filters' },
              h(
                'select',
                {
                  'aria-label': '记录类型',
                  value: type,
                  onChange: (e) => {
                    setType(e.target.value);
                    setPage(0);
                    setSelected(null);
                  },
                },
                ...RECORD_TYPES.map(([key, label]) =>
                  h(
                    'option',
                    { key, value: key },
                    label + ' · ' + archive.records.filter((r) => r.type === key).length,
                  ),
                ),
              ),
              h('input', {
                'aria-label': '查找导入记录',
                type: 'search',
                placeholder: '查找内容',
                value: query,
                onChange: (e) => {
                  setQuery(e.target.value);
                  setPage(0);
                  setSelected(null);
                },
              }),
            ),
            record
              ? h(
                  'article',
                  null,
                  h(
                    'div',
                    { className: 'novel-ms-actions' },
                    h('button', { type: 'button', onClick: () => setSelected(null) }, '返回记录列表'),
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          try {
                            onReference(importReference(archive, record));
                            setActionError('');
                          } catch (e) {
                            setActionError(e.message);
                          }
                        },
                      },
                      '引用到对话',
                    ),
                    h(
                      'button',
                      { type: 'button', 'aria-pressed': raw, onClick: () => setRaw(!raw) },
                      '原始字段',
                    ),
                  ),
                  h('h3', null, record.title),
                  h(ProseEditor, { key: record.pointer, value: text, readOnly: true, label: '导入记录全文' }),
                )
              : h(
                  React.Fragment,
                  null,
                  h(
                    'ul',
                    { className: 'novel-import-list' },
                    ...filtered.slice(currentPage * 30, (currentPage + 1) * 30).map((item) =>
                      h(
                        'li',
                        {
                          key: item.pointer,
                        },
                        h('button', { type: 'button', onClick: () => setSelected(item.pointer) }, item.title),
                      ),
                    ),
                  ),
                  !filtered.length ? h('p', null, search ? '没有匹配记录。' : '没有这类导入记录。') : null,
                  filtered.length > 30
                    ? h(
                        'div',
                        { className: 'novel-ms-actions', 'aria-label': '记录翻页' },
                        h(
                          'button',
                          { disabled: currentPage === 0, onClick: () => setPage(currentPage - 1) },
                          '上一页',
                        ),
                        h('span', null, currentPage + 1 + ' / ' + Math.ceil(filtered.length / 30)),
                        h(
                          'button',
                          {
                            disabled: (currentPage + 1) * 30 >= filtered.length,
                            onClick: () => setPage(currentPage + 1),
                          },
                          '下一页',
                        ),
                      )
                    : null,
                ),
          )
        : null,
    );
  };
}
