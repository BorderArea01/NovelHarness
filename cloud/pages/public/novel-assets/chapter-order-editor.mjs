import { moveChapter } from './chapter-order-core.mjs';
// An editing mode inside the existing manuscript pane, not another workflow root.
export function createChapterOrderEditor(React) {
  const h = React.createElement;
  return function ChapterOrderEditor({
    snapshot,
    disabled,
    onCancel,
    onReload,
    onPreview,
    onApply,
    onDraft,
  }) {
    const [keys, setKeys] = React.useState(() => snapshot.keys ?? snapshot.entries.map((e) => e.key));
    const [visible, setVisible] = React.useState(40);
    const [selected, setSelected] = React.useState(snapshot.entries[0]?.key ?? null);
    const [target, setTarget] = React.useState('1');
    const [preview, setPreview] = React.useState(snapshot.preview ?? null);
    const [status, setStatus] = React.useState('');
    const [over, setOver] = React.useState(null);
    const list = React.useRef(null),
      drag = React.useRef(null),
      frame = React.useRef(null);
    const rows = new Map(snapshot.entries.map((e) => [e.key, e]));
    const changed = keys.some((key, i) => key !== snapshot.entries[i]?.key);
    React.useEffect(() => {
      if (!changed) return;
      const warn = (event) => {
        event.preventDefault();
        event.returnValue = '';
      };
      window.addEventListener('beforeunload', warn);
      return () => window.removeEventListener('beforeunload', warn);
    }, [changed]);
    const stopDrag = () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      drag.current = null;
      setOver(null);
    };
    React.useEffect(() => stopDrag, []);
    function move(key, position) {
      const next = moveChapter(keys, key, position);
      setKeys(next);
      setSelected(key);
      setTarget(String(position + 1));
      setPreview(null);
      onDraft({ keys: next, preview: null });
      if (position === visible) setVisible(visible + 40);
      setStatus('《' + rows.get(key).title + '》移到第 ' + (position + 1) + ' 位，尚未保存。');
    }
    function scrollDrag() {
      const active = drag.current,
        element = list.current;
      if (!active || !element) return;
      const rect = element.getBoundingClientRect();
      const distance =
        active.y < rect.top + 40
          ? Math.max(-16, (active.y - rect.top - 40) / 3)
          : active.y > rect.bottom - 40
            ? Math.min(16, (active.y - rect.bottom + 40) / 3)
            : 0;
      if (distance) element.scrollTop += distance;
      frame.current = requestAnimationFrame(scrollDrag);
    }
    const grip = (key) => ({
      type: 'button',
      className: 'novel-order-grip',
      disabled: disabled || !!preview,
      'aria-label': '拖动章节：' + rows.get(key).title,
      title: '拖动；键盘 Alt + ↑ / ↓ 移动，Escape 取消拖动',
      onPointerDown: (event) => {
        if (event.button !== 0 || event.isPrimary === false) return;
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        setSelected(key);
        setTarget(String(keys.indexOf(key) + 1));
        drag.current = { key, y: event.clientY };
        event.currentTarget.setPointerCapture(event.pointerId);
        frame.current = requestAnimationFrame(scrollDrag);
      },
      onPointerMove: (event) => {
        if (!drag.current) return;
        drag.current.y = event.clientY;
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-order-key]');
        setOver(row?.parentElement === list.current ? row.dataset.orderKey : null);
      },
      onPointerUp: (event) => {
        const active = drag.current;
        const row = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-order-key]');
        if (active && row?.parentElement === list.current && row.dataset.orderKey !== active.key) {
          const from = keys.indexOf(active.key),
            to = keys.indexOf(row.dataset.orderKey);
          const rect = row.getBoundingClientRect();
          let position = to + (event.clientY >= rect.top + rect.height / 2 ? 1 : 0);
          if (from < position) position--;
          move(active.key, position);
        }
        stopDrag();
      },
      onPointerCancel: stopDrag,
      onLostPointerCapture: stopDrag,
      onKeyDown: (event) => {
        if (event.key === 'Escape') {
          stopDrag();
          return;
        }
        if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
          event.preventDefault();
          const position = keys.indexOf(key) + (event.key === 'ArrowUp' ? -1 : 1);
          if (position >= 0 && position < keys.length) move(key, position);
        }
      },
    });
    return h(
      'section',
      { className: 'novel-chapter-order', 'aria-label': '调整章节顺序' },
      h(
        'div',
        { className: 'novel-ms-actions novel-order-heading' },
        h('strong', null, '调整章节顺序'),
        h('button', { disabled, onClick: onCancel }, '取消排序'),
      ),
      h(
        'p',
        { className: 'novel-reference-hint' },
        '拖动把手或用 ↑ ↓ 调整。先预览，再确认；正文与文件路径不改动。',
      ),
      h(
        'div',
        { className: 'novel-order-jump' },
        h(
          'label',
          null,
          '移动章节',
          h(
            'select',
            {
              'aria-label': '要移动的章节',
              disabled: disabled || !!preview,
              value: selected ?? '',
              onChange: (e) => {
                setSelected(e.target.value);
                setTarget(String(keys.indexOf(e.target.value) + 1));
              },
            },
            ...keys.map((key, i) => h('option', { key, value: key }, i + 1 + '. ' + rows.get(key).title)),
          ),
        ),
        h(
          'label',
          null,
          '目标位置',
          h('input', {
            type: 'number',
            min: 1,
            max: keys.length,
            'aria-label': '章节目标位置',
            value: target,
            disabled: disabled || !!preview,
            onChange: (e) => setTarget(e.target.value),
          }),
        ),
        h(
          'button',
          {
            disabled:
              disabled ||
              !!preview ||
              !selected ||
              !Number.isSafeInteger(Number(target)) ||
              Number(target) < 1 ||
              Number(target) > keys.length,
            onClick: () => move(selected, Number(target) - 1),
          },
          '移动',
        ),
      ),
      h('div', { role: 'status', 'aria-live': 'polite', className: 'novel-order-status' }, status),
      h(
        'ol',
        { className: 'novel-order-list', ref: list },
        ...keys.slice(0, visible).map((key, position) => {
          const row = rows.get(key),
            to = snapshot.entries[position].chapter;
          return h(
            'li',
            { key, 'data-order-key': key, 'data-drag-over': over === key },
            h('button', grip(key), '⠿'),
            h(
              'div',
              { className: 'novel-order-label' },
              h('strong', null, row.title),
              h(
                'small',
                null,
                row.added ? '补入章纲' : '第 ' + row.chapter + ' 章',
                row.chapter !== to ? ' → 第 ' + to + ' 章' : '',
                row.path ? '' : ' · 仅章纲',
              ),
            ),
            h(
              'div',
              { className: 'novel-order-arrows' },
              h(
                'button',
                {
                  disabled: disabled || !!preview || position === 0,
                  'aria-label': '上移章节：' + row.title,
                  onClick: () => move(key, position - 1),
                },
                '↑',
              ),
              h(
                'button',
                {
                  disabled: disabled || !!preview || position === keys.length - 1,
                  'aria-label': '下移章节：' + row.title,
                  onClick: () => move(key, position + 1),
                },
                '↓',
              ),
            ),
          );
        }),
      ),
      keys.length > visible ? h('button', { onClick: () => setVisible(visible + 40) }, '显示更多章节') : null,
      preview
        ? h(
            'div',
            { className: 'novel-order-preview', 'aria-label': '重排影响预览' },
            h(
              'strong',
              null,
              '将更新 ' +
                preview.files.filter((f) => !f.path.endsWith('.proposal.json')).length +
                ' 份关联文件',
            ),
            h(
              'p',
              null,
              preview.pendingProposals
                ? preview.pendingProposals + ' 份未接受候选将标为待复核。'
                : '未接受的候选不会自动发布。',
            ),
            h(
              'details',
              null,
              h('summary', null, '影响与保护范围'),
              h('p', null, preview.notice),
              h('ul', null, ...preview.files.map((file) => h('li', { key: file.path }, file.path))),
            ),
            ...preview.issues.map((issue) => h('p', { key: issue, role: 'alert' }, issue)),
            h(
              'div',
              { className: 'novel-ms-actions' },
              h(
                'button',
                { disabled: disabled || !preview.valid, onClick: () => onApply(keys, preview) },
                '确认重排',
              ),
              h(
                'button',
                {
                  disabled,
                  onClick: () => {
                    setPreview(null);
                    onDraft({ keys, preview: null });
                  },
                },
                '继续调整',
              ),
            ),
          )
        : h(
            'button',
            {
              disabled: disabled || !changed,
              onClick: async () => {
                const result = await onPreview(keys);
                if (result) {
                  setPreview(result);
                  onDraft({ keys, preview: result });
                }
              },
            },
            '预览重排',
          ),
      h(
        'button',
        { className: 'novel-order-reload', disabled, onClick: onReload },
        '重新读取（放弃本次排序）',
      ),
    );
  };
}
