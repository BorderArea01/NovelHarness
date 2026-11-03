import { resolveMerge } from './merge-core.mjs';
const show = (s, kind) =>
  !s.exists ? '（此处被删除）' : kind === 'text' ? s.value || '（空文本）' : JSON.stringify(s.value, null, 2);
export function createConflictEditor(React) {
  const h = React.createElement;
  return function ConflictEditor({
    base,
    local,
    remote,
    busy,
    onApply,
    onManual,
    onCopy,
    json = base.path.endsWith('.json'),
  }) {
    const [calculation, setCalculation] = React.useState(null),
      [choices, setChoices] = React.useState({}),
      [computing, setComputing] = React.useState(false),
      [error, setError] = React.useState(''),
      [visible, setVisible] = React.useState(20);
    const job = React.useRef(null);
    const stop = () => {
      if (job.current) {
        clearTimeout(job.current.timer);
        job.current.worker.terminate();
        job.current = null;
      }
    };
    React.useEffect(() => stop, []);
    const frame = { path: base.path, baseHash: base.hash, remoteHash: remote.hash, local, json };
    const stale =
      calculation &&
      (calculation.frame.path !== frame.path ||
        calculation.frame.json !== frame.json ||
        calculation.frame.baseHash !== frame.baseHash ||
        calculation.frame.remoteHash !== frame.remoteHash ||
        calculation.frame.local !== local);
    const unresolved = calculation?.plan.conflicts.filter((c) => !choices[c.id]).length ?? 0;
    const resolved = React.useMemo(() => {
      if (!calculation || unresolved) return null;
      try {
        return { text: resolveMerge(calculation.plan, choices) };
      } catch (e) {
        return { error: e.message };
      }
    }, [calculation, choices, unresolved]);
    function calculate() {
      stop();
      setError('');
      setComputing(true);
      try {
        const worker = new Worker(new URL('./merge-worker.mjs', import.meta.url), {
          type: 'module',
          name: 'novel-three-way-merge',
        });
        const timer = setTimeout(() => {
          stop();
          setComputing(false);
          setError('合并计算超过 6 秒，已停止；三份原文仍保留，可手工处理或明确重试。');
        }, 6000);
        job.current = { worker, timer };
        const finish = (result) => {
          if (job.current?.worker !== worker) return;
          stop();
          setComputing(false);
          if (result.error) setError(result.error);
          else {
            setCalculation({ plan: result.plan, frame });
            setChoices({});
            setVisible(20);
          }
        };
        worker.onmessage = ({ data }) => finish(data);
        worker.onerror = (event) => {
          event.preventDefault();
          finish({ error: '合并线程未能完成，未修改原稿；可继续手工处理。' });
        };
        worker.postMessage({ ...frame, base: base.text, remote: remote.text });
      } catch {
        stop();
        setComputing(false);
        setError('浏览器未能启动合并线程，原文仍保留；可使用手工比较。');
      }
    }
    return h(
      'section',
      { className: 'novel-conflict', 'aria-label': '三方冲突处理' },
      h('h3', null, '保存冲突'),
      h(
        'p',
        null,
        remote.deleted
          ? '云端文件已删除。本机稿仍保留，请另存或下载；不会自动重建旧文件。'
          : '共同基线、本机修改、云端修改都保留。合并只载入编辑区，确认后再保存。',
      ),
      h(
        'div',
        { className: 'novel-merge-actions' },
        h(
          'button',
          { type: 'button', disabled: busy || computing || remote.deleted, onClick: calculate },
          calculation ? '重新对比并合并' : '对比并合并',
        ),
        computing
          ? h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  stop();
                  setComputing(false);
                  setError('已停止合并计算，原文未改动。');
                },
              },
              '停止合并计算',
            )
          : null,
        h(
          'button',
          { type: 'button', disabled: busy || remote.deleted, onClick: () => onManual(frame) },
          '以云端为基线，手工合并',
        ),
        h('button', { type: 'button', disabled: busy, onClick: onCopy }, '另存本机稿'),
      ),
      computing ? h('p', { role: 'status' }, '正在独立线程比较，可以继续浏览…') : null,
      error ? h('p', { role: 'alert' }, error) : null,
      calculation
        ? h(
            React.Fragment,
            null,
            stale ? h('p', { role: 'status' }, '原文或本机稿已有变化，旧比较已失效；请重新对比。') : null,
            calculation.plan.note ? h('p', null, calculation.plan.note) : null,
            h(
              'p',
              { role: 'status' },
              calculation.plan.conflicts.length
                ? '共 ' + calculation.plan.conflicts.length + ' 处冲突，剩余 ' + unresolved + ' 处'
                : '没有重叠冲突，已合并双方的独立修改。',
            ),
            ...calculation.plan.conflicts.slice(0, visible).map((c, index) =>
              h(
                'section',
                { className: 'novel-merge-hunk', key: c.id, 'aria-label': '冲突 ' + (index + 1) },
                h('h4', null, index + 1 + '. ' + c.path),
                h(
                  'div',
                  { className: 'novel-merge-panes' },
                  ...[
                    ['local', '本机修改'],
                    ['remote', '云端修改'],
                  ].map(([source, label]) =>
                    h(
                      'div',
                      { key: source },
                      h('strong', null, label),
                      h('pre', null, show(c[source], c.kind)),
                      h(
                        'button',
                        {
                          type: 'button',
                          disabled: stale || busy,
                          'aria-pressed': choices[c.id]?.source === source,
                          onClick: () => setChoices({ ...choices, [c.id]: { source } }),
                        },
                        '冲突 ' + (index + 1) + ' 使用' + (source === 'local' ? '本机' : '云端'),
                      ),
                    ),
                  ),
                ),
                h('details', null, h('summary', null, '共同基线'), h('pre', null, show(c.base, c.kind))),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: stale || busy,
                    'aria-pressed': choices[c.id]?.source === 'manual',
                    onClick: () =>
                      setChoices({
                        ...choices,
                        [c.id]: {
                          source: 'manual',
                          text: c.local.exists
                            ? c.kind === 'text'
                              ? c.local.value
                              : JSON.stringify(c.local.value, null, 2)
                            : c.kind === 'text'
                              ? ''
                              : 'null',
                        },
                      }),
                  },
                  '手动解决冲突 ' + (index + 1),
                ),
                choices[c.id]?.source === 'manual'
                  ? h('textarea', {
                      'aria-label': '冲突 ' + (index + 1) + ' 手动结果',
                      rows: 5,
                      disabled: stale || busy,
                      value: choices[c.id].text,
                      onChange: (e) =>
                        setChoices({ ...choices, [c.id]: { source: 'manual', text: e.target.value } }),
                    })
                  : null,
              ),
            ),
            calculation.plan.conflicts.length > visible
              ? h(
                  'button',
                  { type: 'button', onClick: () => setVisible(visible + 20) },
                  '继续显示冲突（' + visible + ' / ' + calculation.plan.conflicts.length + '）',
                )
              : null,
            resolved?.error ? h('p', { role: 'alert' }, '合并结果尚不可用：' + resolved.error) : null,
            resolved?.text !== undefined
              ? h(
                  'details',
                  { open: true },
                  h('summary', null, '合并结果预览'),
                  h('textarea', {
                    className: 'novel-editor-text',
                    'aria-label': '合并结果预览',
                    readOnly: true,
                    rows: 12,
                    value: resolved.text,
                  }),
                  h(
                    'button',
                    {
                      type: 'button',
                      disabled: busy || stale || computing,
                      onClick: () => onApply(resolved.text, calculation.frame),
                    },
                    '载入合并结果（尚未保存）',
                  ),
                )
              : null,
          )
        : null,
      h(
        'details',
        null,
        h('summary', null, '三份完整原文'),
        ...[
          ['base', '共同基线', base.text],
          ['local', '本机稿', local],
          ['remote', '云端稿', remote.deleted ? '（文件已删除）' : remote.text],
        ].map(([key, title, text]) => h('details', { key }, h('summary', null, title), h('pre', null, text))),
      ),
    );
  };
}
