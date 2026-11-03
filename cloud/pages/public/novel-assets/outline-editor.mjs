import { parseOutline, editOutline, pointText, DIRECTION_PATH } from './outline-core.mjs';
import { displayValue } from './reference-core.mjs';
import { createTitleEditor } from './title-editor.mjs';
export function createOutlineEditor(React) {
  const h = React.createElement,
    { useState, useRef, useEffect } = React;
  const TitleEditor = createTitleEditor(React);
  function Point({ point, index, count, update }) {
    const start = useRef(null);
    return h(
      'li',
      { className: 'novel-outline-point', 'data-point-index': index },
      h(
        'button',
        {
          type: 'button',
          className: 'novel-outline-grip',
          'aria-label': '拖动剧情点 ' + (index + 1),
          title: '拖动排序；也可使用上移 / 下移',
          onPointerDown: (event) => {
            start.current = index;
            event.currentTarget.setPointerCapture(event.pointerId);
          },
          onPointerUp: (event) => {
            if (start.current !== null) {
              const target = document
                .elementFromPoint(event.clientX, event.clientY)
                ?.closest('[data-point-index]');
              if (
                target &&
                Number(target.dataset.pointIndex) !== start.current &&
                target.parentElement === event.currentTarget.closest('li').parentElement
              )
                update({ kind: 'move-point', point: start.current, to: Number(target.dataset.pointIndex) });
              start.current = null;
            }
          },
          onPointerCancel: () => {
            start.current = null;
          },
        },
        '⠿',
      ),
      h('textarea', {
        'aria-label': '剧情点 ' + (index + 1),
        rows: 3,
        value: pointText(point),
        onChange: (e) => update({ kind: 'point', point: index, value: e.target.value }),
      }),
      h(
        'div',
        { className: 'novel-outline-point-actions' },
        h(
          'button',
          {
            type: 'button',
            disabled: index === 0,
            'aria-label': '上移剧情点 ' + (index + 1),
            onClick: () => update({ kind: 'move-point', point: index, to: index - 1 }),
          },
          '↑',
        ),
        h(
          'button',
          {
            type: 'button',
            disabled: index === count - 1,
            'aria-label': '下移剧情点 ' + (index + 1),
            onClick: () => update({ kind: 'move-point', point: index, to: index + 1 }),
          },
          '↓',
        ),
        h(
          'button',
          {
            type: 'button',
            'aria-label': '删除剧情点 ' + (index + 1),
            onClick: () => update({ kind: 'remove-point', point: index }),
          },
          '移除',
        ),
      ),
    );
  }
  function Direction({ api, direction, onEdit, onClear, disabled }) {
    const [expanded, setExpanded] = useState(false),
      [content, setContent] = useState(null);
    useEffect(() => {
      let alive = true;
      if (expanded && direction) {
        setContent(null);
        api('document', null, { path: DIRECTION_PATH })
          .then((doc) => {
            if (alive) setContent(doc.text);
          })
          .catch((error) => {
            if (alive) setContent(error.message);
          });
      }
      return () => {
        alive = false;
      };
    }, [expanded, direction?.updatedAt]);
    return h(
      'details',
      {
        className: 'novel-outline-direction',
        open: expanded,
        onToggle: (e) => setExpanded(e.currentTarget.open),
      },
      h('summary', null, '全篇方向'),
      expanded
        ? h(
            React.Fragment,
            null,
            h(
              'pre',
              null,
              direction
                ? content === null
                  ? '正在读取…'
                  : content || '方向尚为空，可手工补充或让首批规划提出。'
                : '尚未设定；可先从灵感试写，也可在首批 AI 规划时提出。',
            ),
            h('button', { type: 'button', onClick: onEdit }, '编辑方向'),
            onClear
              ? h(
                  'button',
                  { type: 'button', disabled: disabled || !direction, onClick: onClear },
                  '清空全篇方向',
                )
              : null,
          )
        : null,
    );
  }
  return function OutlineEditor({
    text,
    savedHash,
    dirty,
    onChange,
    onStatus,
    disabled,
    api,
    documents,
    bindings = [],
    onOpenChapter,
    onEditDirection,
    onPlan,
    onReorder,
    onRenameTitle,
    onManage,
  }) {
    const [editing, setEditing] = useState(null),
      [query, setQuery] = useState(''),
      [visible, setVisible] = useState(30);
    const [start, setStart] = useState(''),
      [count, setCount] = useState('6'),
      [instruction, setInstruction] = useState('');
    const own = useRef(text);
    useEffect(() => {
      if (text !== own.current) setEditing(null);
      own.current = text;
    }, [text]);
    // A committed baseline, not keystrokes or dirty -> clean local undo,
    // ends chapter editing. Keep any newer unsaved input open.
    useEffect(() => {
      if (savedHash && !dirty) setEditing(null);
    }, [savedHash]);
    useEffect(() => setVisible(30), [query]);
    let shape, error;
    try {
      shape = parseOutline(text);
    } catch (reason) {
      error = reason.message;
    }
    const rows = shape?.rows ?? [],
      defaultStart =
        Math.max(
          0,
          ...rows
            .map((row) => Number(row.chapter))
            .filter((number) => Number.isSafeInteger(number) && number > 0),
        ) + 1;
    const update = (operation) => {
      try {
        const next = editOutline(text, operation);
        own.current = next;
        onChange(next);
      } catch (reason) {
        onStatus(reason.message);
      }
    };
    const matches = rows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => JSON.stringify(row).toLocaleLowerCase().includes(query.toLocaleLowerCase()));
    return h(
      'section',
      { className: 'novel-outline-editor novel-reference-editor', 'aria-label': '章节大纲' },
      h(Direction, {
        api,
        direction: documents.find((doc) => doc.path === DIRECTION_PATH),
        onEdit: onEditDirection,
        onClear: onManage ? () => onManage('clearDirection') : undefined,
        disabled: disabled || dirty,
      }),
      onManage
        ? h(
            'div',
            { className: 'novel-content-tools', 'aria-label': '大纲管理' },
            h(
              'button',
              {
                type: 'button',
                disabled: disabled || dirty,
                title: dirty ? '先保存当前大纲修改' : '保留所有正文',
                onClick: () => onManage('clearOutline'),
              },
              '清空章节大纲',
            ),
            h(
              'button',
              { type: 'button', disabled: disabled || dirty, onClick: () => onManage('clearPlanning') },
              '清空大纲与方向',
            ),
            h(
              'button',
              { type: 'button', disabled: disabled || dirty, onClick: () => onManage('list') },
              '回收与恢复',
            ),
          )
        : null,
      h(
        'details',
        { className: 'novel-outline-planner', open: rows.length === 0 },
        h('summary', null, rows.length ? 'AI 续规划 / 调整' : '从灵感规划大纲'),
        h(
          'p',
          { className: 'novel-reference-hint' },
          '每次 1–12 章，长篇沿用同一全篇方向分批展开；只生成候选，不自动写正文。',
        ),
        h(
          'div',
          { className: 'novel-outline-range' },
          h(
            'label',
            null,
            '从第几章',
            h('input', {
              type: 'number',
              min: 1,
              max: 10000,
              'aria-label': '规划起始章',
              value: start || String(defaultStart),
              onChange: (e) => setStart(e.target.value),
            }),
          ),
          h(
            'label',
            null,
            '本批章数',
            h('input', {
              type: 'number',
              min: 1,
              max: 12,
              'aria-label': '本批规划章数',
              value: count,
              onChange: (e) => setCount(e.target.value),
            }),
          ),
        ),
        h('textarea', {
          'aria-label': '本次规划要求',
          value: instruction,
          rows: 3,
          maxLength: 6000,
          placeholder: '可选：让姐姐线索与钟楼禁令发生冲突，不要新增救场角色。',
          onChange: (e) => setInstruction(e.target.value),
        }),
        h(
          'button',
          {
            type: 'button',
            'data-variant': 'primary',
            disabled: disabled || !!error,
            onClick: () =>
              onPlan(
                {
                  start: Number(start || defaultStart),
                  end: Number(start || defaultStart) + Number(count) - 1,
                },
                instruction,
              ),
          },
          '生成规划候选',
        ),
      ),
      error
        ? h('p', { role: 'alert' }, error)
        : h(
            React.Fragment,
            null,
            h(
              'div',
              { className: 'novel-reference-tools' },
              h('input', {
                type: 'search',
                'aria-label': '搜索章节大纲',
                placeholder: '搜索章节、概要或事件',
                value: query,
                onChange: (e) => setQuery(e.target.value),
              }),
              h(
                'button',
                {
                  type: 'button',
                  disabled,
                  onClick: () => {
                    update({ kind: 'add' });
                    setQuery('');
                    setVisible(Math.max(visible, rows.length + 1));
                    setEditing(rows.length);
                  },
                },
                '＋ 章纲',
              ),
              rows.length > 1 ? h('button', { disabled, onClick: onReorder }, '调整顺序') : null,
            ),
            !rows.length
              ? h(
                  'p',
                  { className: 'novel-reference-hint' },
                  '还没有章纲。它是可选的规划工具，不是开始写作的门槛。',
                )
              : null,
            ...matches.slice(0, visible).map(({ row, index }) => {
              const paths =
                typeof row.chapterPath === 'string' && row.chapterPath
                  ? [row.chapterPath]
                  : (bindings.find((binding) => binding.chapter === Number(row.chapter))?.paths ?? []);
              const points = Array.isArray(row.plotPoints) ? row.plotPoints : [],
                editable = editing === index;
              return h(
                'article',
                { className: 'novel-outline-chapter', key: index, 'data-outline-index': index },
                h(
                  'header',
                  null,
                  h(
                    'h3',
                    null,
                    '第 ' + String(row.chapter ?? '?') + ' 章 · ' + String(row.title || '未命名'),
                  ),
                  h(
                    'div',
                    { className: 'novel-reference-tools' },
                    onRenameTitle
                      ? h(TitleEditor, {
                          value: row.title || '',
                          label: '章纲标题',
                          buttonLabel: '改标题',
                          disabled: disabled || dirty,
                          hint: dirty ? '先保存大纲修改，再改标题' : '同步关联正文标题，不更改路径和章号',
                          onSave: (title) => onRenameTitle(index, title),
                        })
                      : null,
                    h(
                      'button',
                      { type: 'button', onClick: () => setEditing(editable ? null : index) },
                      editable ? '阅读' : '编辑章纲',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: disabled || paths.length > 1,
                        onClick: () => onOpenChapter(Number(row.chapter)),
                      },
                      paths.length > 1 ? '正文为分片' : paths.length ? '打开正文' : '起草本章',
                    ),
                    h(
                      'button',
                      {
                        type: 'button',
                        disabled: disabled || (onManage && dirty),
                        title: dirty && onManage ? '先保存当前大纲修改' : '只删除章纲，正文保留',
                        onClick: () => {
                          if (onManage) onManage('removeOutline', { index });
                          else if (window.confirm('只删除这条章纲，正文文件不会删除。继续？')) {
                            update({ kind: 'remove', index });
                            setEditing(null);
                          }
                        },
                      },
                      '删除章纲',
                    ),
                  ),
                ),
                editable
                  ? h(
                      React.Fragment,
                      null,
                      h(
                        'label',
                        null,
                        '章节编号',
                        h('input', {
                          type: 'number',
                          min: 1,
                          'aria-label': '章节编号',
                          value: row.chapter ?? '',
                          onChange: (e) =>
                            update({
                              kind: 'field',
                              index,
                              field: 'chapter',
                              value: e.target.value === '' ? '' : Number(e.target.value),
                            }),
                        }),
                      ),
                      h(
                        'label',
                        null,
                        '标题',
                        h('input', {
                          'aria-label': '大纲标题',
                          value: typeof row.title === 'string' ? row.title : '',
                          onChange: (e) =>
                            update({ kind: 'field', index, field: 'title', value: e.target.value }),
                        }),
                      ),
                      h(
                        'label',
                        null,
                        '概要',
                        h('textarea', {
                          'aria-label': '大纲概要',
                          rows: 7,
                          value: typeof row.summary === 'string' ? row.summary : '',
                          onChange: (e) =>
                            update({ kind: 'field', index, field: 'summary', value: e.target.value }),
                        }),
                      ),
                      h(
                        'ol',
                        null,
                        ...points.map((point, pointIndex) =>
                          h(Point, {
                            key: (typeof point === 'object' && point?.id) || pointIndex,
                            point,
                            index: pointIndex,
                            count: points.length,
                            update: (op) => update({ ...op, index }),
                          }),
                        ),
                      ),
                      h(
                        'button',
                        { type: 'button', onClick: () => update({ kind: 'add-point', index }) },
                        '＋ 剧情点',
                      ),
                      h(
                        'details',
                        null,
                        h('summary', null, '章内要求 / 正文关联'),
                        h('textarea', {
                          'aria-label': '章内写作要求',
                          rows: 3,
                          value: typeof row.note === 'string' ? row.note : '',
                          onChange: (e) =>
                            update({ kind: 'field', index, field: 'note', value: e.target.value }),
                          placeholder: '只针对本章的写作要求',
                        }),
                        h(
                          'label',
                          null,
                          '关联正文',
                          h(
                            'select',
                            {
                              'aria-label': '关联正文',
                              value:
                                paths.length === 1 && documents.some((doc) => doc.path === paths[0])
                                  ? paths[0]
                                  : '',
                              onChange: (e) => {
                                update({
                                  kind: 'field',
                                  index,
                                  field: 'chapterPath',
                                  value: e.target.value,
                                });
                              },
                            },
                            h('option', { value: '' }, '不关联正文（可另起新章）'),
                            ...documents
                              .filter((doc) => doc.category === 'chapter')
                              .map((doc) =>
                                h('option', { key: doc.path, value: doc.path }, doc.path.split('/').pop()),
                              ),
                          ),
                        ),
                      ),
                    )
                  : h(
                      React.Fragment,
                      null,
                      h(
                        'p',
                        { className: 'novel-outline-summary' },
                        typeof row.summary === 'string' ? row.summary : displayValue(row.summary),
                      ),
                      h(
                        'ol',
                        null,
                        ...points.map((point, n) =>
                          h('li', { key: n }, pointText(point) || displayValue(point)),
                        ),
                      ),
                      typeof row.note === 'string' && row.note
                        ? h('details', null, h('summary', null, '章内写作要求'), h('p', null, row.note))
                        : null,
                    ),
                h('details', null, h('summary', null, '完整章节记录'), h('pre', null, displayValue(row))),
              );
            }),
            matches.length > visible
              ? h(
                  'button',
                  { type: 'button', onClick: () => setVisible(visible + 30) },
                  '继续显示（' + visible + ' / ' + matches.length + '）',
                )
              : null,
          ),
      h(
        'details',
        { className: 'novel-reference-source', open: !!error },
        h('summary', null, '大纲源文件 · 按需修改'),
        h('textarea', {
          className: 'novel-editor-text',
          'aria-label': '大纲源文件',
          value: text,
          spellCheck: false,
          onChange: (e) => onChange(e.target.value),
        }),
      ),
    );
  };
}
export function createOutlineReview(React) {
  const h = React.createElement;
  return function OutlineReview({ review, busy, onAccept, onResume }) {
    const data = review.outline;
    if (!data) return h('p', { role: 'alert' }, '规划检查未就绪，未提供直接覆盖入口。');
    const stale = review.current.hash !== review.proposal.baseHash || !!review.orderWarning;
    return h(
      'section',
      { className: 'novel-outline-review novel-reference-editor', 'aria-label': '大纲规划提案' },
      h(
        'div',
        { className: 'novel-outline-review-bar' },
        h(
          'button',
          {
            type: 'button',
            'data-variant': 'primary',
            disabled: busy || stale || !data.valid,
            onClick: onAccept,
          },
          '接受本批规划',
        ),
        h(
          'button',
          { type: 'button', disabled: busy || stale || data.staleSources, onClick: onResume },
          '补全 / 修正规划',
        ),
      ),
      stale ? h('p', { role: 'alert' }, '大纲已更新，不能用旧候选覆盖。') : null,
      ...data.issues.map((issue, index) => h('p', { className: 'novel-canon-warning', key: index }, issue)),
      data.storyPlan
        ? h(
            'details',
            { open: !data.previousStoryPlan },
            h('summary', null, data.previousStoryPlan ? '沿用的全篇方向' : '候选全篇方向'),
            h('pre', null, data.storyPlan),
          )
        : null,
      ...data.chapters.map((row) =>
        h(
          'article',
          { className: 'novel-outline-chapter', key: row.chapter },
          h('h3', null, '第 ' + row.chapter + ' 章 · ' + String(row.title ?? '')),
          row.locked ? h('p', { className: 'novel-reference-hint' }, '已有正文 · 原规划保留') : null,
          h(
            'p',
            { className: 'novel-outline-summary' },
            typeof row.summary === 'string' ? row.summary : displayValue(row.summary),
          ),
          h('ol', null, ...row.plotPoints.map((point, n) => h('li', { key: n }, point))),
          row.before
            ? h(
                'details',
                null,
                h('summary', null, '对比原规划'),
                h('h4', null, displayValue(row.before.title)),
                h('p', null, displayValue(row.before.summary)),
                h(
                  'ol',
                  null,
                  ...(Array.isArray(row.before.plotPoints) ? row.before.plotPoints : []).map((point, n) =>
                    h('li', { key: n }, pointText(point)),
                  ),
                ),
              )
            : null,
        ),
      ),
    );
  };
}
