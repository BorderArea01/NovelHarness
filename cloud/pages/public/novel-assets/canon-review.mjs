import { FIELDS, displayValue } from './reference-core.mjs';
const label = (path) =>
  path === 'seed.md' ? '原始灵感' : path === 'setting.md' ? '作者设定' : path.split('/').pop();
export const selectableCanonKeys = (data) =>
  data.changes
    .filter((change) => change.valid && !change.requiresIndividualReview)
    .map((change) => change.key);
export function createCanonReview(React) {
  const h = React.createElement,
    { useState, useEffect } = React;
  function Record({ value }) {
    const hidden = ['id', 'trust', 'confirmed', 'name', 'label', 'createdAt', 'updatedAt', 'evidenceSources'];
    return h(
      'dl',
      { className: 'novel-canon-record' },
      ...Object.entries(value ?? {})
        .filter(([key, data]) => !hidden.includes(key) && data !== '' && data !== null && data !== undefined)
        .map(([key, data]) =>
          h(
            'div',
            { key },
            h('dt', null, FIELDS[key] || (key === 'customFields' ? '自定义字段' : key)),
            h('dd', null, displayValue(data)),
          ),
        ),
      h('details', null, h('summary', null, '完整记录'), h('pre', null, displayValue(value))),
    );
  }
  function Change({ change, checked, onCheck, openSource, disabled, initiallyOpen }) {
    const [expanded, setExpanded] = useState(initiallyOpen);
    return h(
      'article',
      { className: 'novel-canon-change' },
      h(
        'label',
        { className: 'novel-canon-choice' },
        h('input', {
          type: 'checkbox',
          'aria-label': '收录' + change.name,
          checked,
          disabled: disabled || !change.valid,
          onChange: (e) => onCheck(e.target.checked),
        }),
        h('strong', null, change.name),
        h(
          'small',
          null,
          change.label +
            ' · ' +
            (change.before ? '更新建议' : '新增建议') +
            (change.valid ? ' · 引文存在' : ' · 需修正'),
        ),
      ),
      ...(change.warnings ?? []).map((warning, index) =>
        h('p', { className: 'novel-canon-warning', key: 'warning-' + index }, warning),
      ),
      h(
        'details',
        { open: expanded, onToggle: (e) => setExpanded(e.currentTarget.open) },
        h('summary', null, '查看变化与原文依据'),
        expanded
          ? h(
              React.Fragment,
              null,
              ...change.issues.map((issue, index) =>
                h('p', { className: 'novel-canon-warning', key: index }, issue),
              ),
              change.before
                ? h('details', null, h('summary', null, '原资料'), h(Record, { value: change.before }))
                : null,
              h(Record, { value: change.after }),
              ...change.evidence.map((proof, index) =>
                h(
                  'figure',
                  { key: index },
                  h('figcaption', null, label(proof.path) + (proof.valid ? ' · 引用存在' : ' · 未通过')),
                  h('blockquote', null, proof.quote),
                  proof.error ? h('p', null, proof.error) : null,
                  proof.path &&
                    h('button', { type: 'button', onClick: () => openSource(proof.path) }, '查看原文'),
                ),
              ),
            )
          : null,
      ),
    );
  }
  return function CanonReview({ review, api, busy, onAccept, onStatus }) {
    const [selected, setSelected] = useState([]),
      [source, setSource] = useState(null),
      [visible, setVisible] = useState(30);
    useEffect(() => {
      setSelected([]);
      setSource(null);
      setVisible(30);
    }, [review.draft.hash, review.proposal.id]);
    const data = review.canon;
    if (!data) return h('p', { role: 'alert' }, '资料提案检查尚未就绪，未提供直接覆盖入口。');
    const bulkKeys = selectableCanonKeys(data);
    const stale = review.current.hash !== review.proposal.baseHash,
      blocked = stale || !!review.orderWarning || data.issues.length > 0;
    const openSource = async (path) => {
      try {
        setSource({ path, loading: true });
        setSource(await api('document', null, { path }));
      } catch (error) {
        setSource(null);
        onStatus(error.message);
      }
    };
    return h(
      'section',
      { className: 'novel-canon-review novel-reference-editor', 'aria-label': '资料整理提案' },
      h('h3', null, '资料建议'),
      h(
        'p',
        { className: 'novel-reference-hint' },
        '核对引用，不等于证明推论。勾选后收录为待确认资料，不会改成作者定稿。',
      ),
      data.changes.some((change) => change.valid && change.requiresIndividualReview)
        ? h(
            'p',
            { className: 'novel-reference-hint' },
            '带姓名或关系提示的建议不批量勾选，请逐条核对后选择。',
          )
        : null,
      stale ? h('p', { role: 'alert' }, '资料原文已变化，请基于新版本重新整理；旧候选仍保留。') : null,
      ...data.issues.map((issue, index) => h('p', { className: 'novel-canon-warning', key: index }, issue)),
      h(
        'div',
        { className: 'novel-reference-tools' },
        h(
          'button',
          {
            type: 'button',
            disabled: blocked || busy || !bulkKeys.length,
            onClick: () => setSelected(bulkKeys),
          },
          '选择可收录资料',
        ),
        selected.length ? h('button', { type: 'button', onClick: () => setSelected([]) }, '清空选择') : null,
        h(
          'button',
          {
            type: 'button',
            className: 'novel-canon-collect',
            disabled: blocked || busy || !selected.length,
            onClick: () => onAccept(selected),
          },
          '收录所选' + (selected.length ? ' · ' + selected.length : ''),
        ),
      ),
      !data.changes.length && !data.issues.length
        ? h('p', null, '没有新增或变化的资料，原设定未改动。')
        : null,
      ...data.changes.slice(0, visible).map((change, index) =>
        h(Change, {
          key: review.draft.hash + ':' + change.key,
          change,
          disabled: blocked,
          checked: selected.includes(change.key),
          initiallyOpen: index < 2,
          openSource,
          onCheck: (checked) =>
            setSelected(
              checked
                ? [...new Set([...selected, change.key])]
                : selected.filter((key) => key !== change.key),
            ),
        }),
      ),
      data.changes.length > visible
        ? h(
            'button',
            { type: 'button', onClick: () => setVisible(visible + 30) },
            '继续显示（' + visible + ' / ' + data.changes.length + '）',
          )
        : null,
      source
        ? h(
            'section',
            { className: 'novel-canon-source' },
            h(
              'div',
              { className: 'novel-reference-tools' },
              h('h4', null, label(source.path)),
              h('button', { type: 'button', onClick: () => setSource(null) }, '收起原文'),
            ),
            h('pre', null, source.loading ? '正在读取…' : source.text),
          )
        : null,
    );
  };
}
