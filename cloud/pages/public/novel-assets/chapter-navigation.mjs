export function createChapterNavigation(React) {
  const h = React.createElement;
  return function ChapterNavigation({
    documents,
    path,
    disabled,
    warning,
    outlineCount = 0,
    onSelect,
    onAdd,
    onRename,
    renameDisabled,
    renameHint,
    onReorder,
    onRecovery,
    expanded,
    onExpandedChange,
  }) {
    const [query, setQuery] = React.useState('');
    const [visible, setVisible] = React.useState(40);
    const directoryId = React.useId();
    const titleId = React.useId();
    const chapters = documents.filter((doc) => doc.category === 'chapter');
    const drafts = documents.filter((doc) => doc.category === 'draft' && !doc.managed);
    const current = chapters.findIndex((doc) => doc.path === path);
    const needle = query.trim().toLocaleLowerCase();
    const matches = chapters.filter((doc) =>
      [doc.title, doc.path, doc.chapter === undefined ? '' : '第' + doc.chapter + '章']
        .join(' ')
        .toLocaleLowerCase()
        .includes(needle),
    );
    const choose = async (target) => {
      await onSelect(target);
      onExpandedChange(false);
    };
    return h(
      'nav',
      { className: 'novel-chapter-navigation', 'aria-label': '章节导航' },
      h(
        'div',
        { className: 'novel-chapter-toolbar' },
        h(
          'button',
          {
            type: 'button',
            className: 'novel-chapter-selector',
            disabled,
            'aria-label': '展开章节目录',
            'aria-expanded': expanded,
            'aria-controls': expanded ? directoryId : undefined,
            'aria-describedby': titleId,
            onClick: () => onExpandedChange(!expanded),
          },
          h('span', { 'aria-hidden': true }, expanded ? '▾' : '▸'),
          h(
            'span',
            { id: titleId, className: 'novel-chapter-current' },
            chapters[current]?.chapter ? '第' + chapters[current].chapter + '章 · ' : '',
            chapters[current]?.title ||
              (drafts.some((d) => d.path === path) ? '草稿 · ' + path.split('/').pop() : '选择章节'),
          ),
          h('small', null, chapters.length + ' 章' + (drafts.length ? ' · ' + drafts.length + ' 草稿' : '')),
        ),
        h(
          'div',
          { className: 'novel-chapter-controls' },
          onRename
            ? h(
                'button',
                {
                  type: 'button',
                  disabled: disabled || renameDisabled,
                  title: renameHint,
                  'aria-label': '改标题',
                  onClick: onRename,
                },
                '✎ 改标题',
              )
            : null,
          h(
            'button',
            {
              disabled: disabled || current <= 0,
              'aria-label': '上一章',
              onClick: () => choose(chapters[current - 1].path),
            },
            '←',
          ),
          h(
            'button',
            {
              disabled: disabled || current < 0 || current >= chapters.length - 1,
              'aria-label': '下一章',
              onClick: () => choose(chapters[current + 1].path),
            },
            '→',
          ),
          h(
            'button',
            { type: 'button', disabled, onClick: onAdd, 'aria-label': '＋ 新章', title: '新建章节' },
            h('span', { 'aria-hidden': true }, '＋'),
            h('span', { className: 'novel-chapter-add-label', 'aria-hidden': true }, ' 新章'),
          ),
        ),
      ),
      expanded
        ? h(
            'section',
            { id: directoryId, className: 'novel-chapter-directory', 'aria-label': '章节目录' },
            h('input', {
              type: 'search',
              'aria-label': '搜索章节',
              placeholder: '标题、编号或路径',
              value: query,
              onChange: (e) => {
                setQuery(e.target.value);
                setVisible(40);
              },
            }),
            warning ? h('p', { role: 'status' }, warning) : null,
            onRecovery ? h('button', { type: 'button', disabled, onClick: onRecovery }, '回收与恢复') : null,
            chapters.length > 1 || outlineCount > 1
              ? h('button', { disabled, onClick: onReorder }, '调整顺序')
              : null,
            h(
              'div',
              { className: 'novel-chapter-matches' },
              ...matches.slice(0, visible).map((doc) =>
                h(
                  'button',
                  {
                    key: doc.path,
                    disabled,
                    'data-document-path': doc.path,
                    'aria-pressed': path === doc.path,
                    title: doc.path,
                    onClick: () => choose(doc.path),
                  },
                  doc.chapter ? h('small', null, '第' + doc.chapter + '章') : null,
                  h('span', null, doc.title || doc.path.split('/').pop()),
                ),
              ),
              matches.length ? null : h('p', null, chapters.length ? '没有匹配章节' : '还没有正文'),
            ),
            matches.length > visible
              ? h('button', { onClick: () => setVisible(visible + 40) }, '显示更多章节')
              : null,
            drafts.length
              ? h(
                  'details',
                  { className: 'novel-loose-drafts', open: !chapters.length },
                  h('summary', null, '未收录草稿 · ' + drafts.length),
                  ...drafts
                    .filter((d) => d.path.toLocaleLowerCase().includes(needle))
                    .slice(0, visible)
                    .map((d) =>
                      h(
                        'button',
                        {
                          key: d.path,
                          disabled,
                          'data-document-path': d.path,
                          'aria-pressed': path === d.path,
                          onClick: () => choose(d.path),
                        },
                        d.path.slice('drafts/'.length),
                      ),
                    ),
                )
              : null,
          )
        : null,
    );
  };
}
