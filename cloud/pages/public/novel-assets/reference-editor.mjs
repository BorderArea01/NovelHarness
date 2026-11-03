import {
  COLLECTIONS,
  FIELDS,
  ENTITY_FIELDS,
  object,
  displayValue,
  splitTags,
  parseCanon,
  serializeCanon,
  canonEntries,
  editCanon,
  editCanonCandidate,
  candidateRecordState,
  trustOf,
  endpointOptions,
  endpointNames,
  relatedEntries,
} from './reference-core.mjs';
import { createRulesEditor } from './rules-editor.mjs';

// All edits flow back to the existing manuscript draft/save/conflict/history.
export function createReferenceEditor(React) {
  const h = React.createElement,
    { useState, useMemo, useRef, useEffect } = React;
  const RulesEditor = createRulesEditor(React);
  function TagField({ value, onChange, label }) {
    const encoded = JSON.stringify(value ?? []),
      own = useRef(encoded);
    const [draft, setDraft] = useState((value ?? []).join('、'));
    useEffect(() => {
      if (encoded !== own.current) setDraft((value ?? []).join('、'));
      own.current = encoded;
    }, [encoded]);
    return h('textarea', {
      'aria-label': label,
      rows: 2,
      value: draft,
      onChange: (e) => {
        const raw = e.target.value,
          next = splitTags(raw);
        own.current = JSON.stringify(next);
        setDraft(raw);
        onChange(next);
      },
    });
  }
  function CustomFields({ item, update }) {
    const [adding, setAdding] = useState(false),
      [name, setName] = useState(''),
      [value, setValue] = useState('');
    const fields = object(item.customFields) ? Object.entries(item.customFields) : [];
    return h(
      'details',
      { className: 'novel-custom-fields', open: fields.length > 0 || adding },
      h('summary', null, '自定义字段' + (fields.length ? ' · ' + fields.length : '')),
      item.customFields !== undefined && !object(item.customFields)
        ? h('p', null, '原自定义字段格式不同，保留在源文件中；不会替换。')
        : h(
            React.Fragment,
            null,
            ...fields.map(([key, data]) =>
              h(
                'div',
                { className: 'novel-custom-row', key },
                h('input', {
                  'aria-label': '字段名：' + key,
                  defaultValue: key,
                  maxLength: 100,
                  onBlur: (e) => {
                    if (
                      e.target.value !== key &&
                      !update({ kind: 'rename-custom', from: key, name: e.target.value })
                    )
                      e.target.value = key;
                  },
                  onKeyDown: (e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      e.currentTarget.blur();
                    }
                  },
                }),
                typeof data === 'string'
                  ? h('textarea', {
                      'aria-label': '字段内容：' + key,
                      rows: 2,
                      value: data,
                      onChange: (e) => update({ kind: 'custom', name: key, value: e.target.value }),
                    })
                  : h('pre', null, displayValue(data)),
                h(
                  'button',
                  {
                    type: 'button',
                    'aria-label': '删除字段：' + key,
                    onClick: () => update({ kind: 'delete-custom', name: key }),
                  },
                  '移除',
                ),
              ),
            ),
            adding
              ? h(
                  'div',
                  { className: 'novel-custom-new' },
                  h('input', {
                    'aria-label': '新字段名',
                    placeholder: '字段名，例如：底线',
                    value: name,
                    maxLength: 100,
                    onChange: (e) => setName(e.target.value),
                  }),
                  h('textarea', {
                    'aria-label': '新字段内容',
                    placeholder: '内容',
                    value,
                    rows: 2,
                    onChange: (e) => setValue(e.target.value),
                  }),
                  h(
                    'div',
                    { className: 'novel-reference-tools' },
                    h(
                      'button',
                      {
                        type: 'button',
                        onClick: () => {
                          if (update({ kind: 'custom', name, value, addOnly: true })) {
                            setAdding(false);
                            setName('');
                            setValue('');
                          }
                        },
                      },
                      '添加字段',
                    ),
                    h('button', { type: 'button', onClick: () => setAdding(false) }, '取消'),
                  ),
                )
              : h('button', { type: 'button', onClick: () => setAdding(true) }, '＋ 字段'),
          ),
    );
  }
  function EvidenceFields({ item, update, candidate, onReadSource, onStatus }) {
    const [source, setSource] = useState(null),
      serial = useRef(0);
    useEffect(
      () => () => {
        serial.current++;
      },
      [],
    );
    const fields = item.evidenceSources ?? [];
    if (
      !Array.isArray(fields) ||
      fields.length > 8 ||
      fields.some(
        (proof) => !object(proof) || typeof proof.path !== 'string' || typeof proof.quote !== 'string',
      )
    )
      return h('p', null, '原文依据格式或数量不兼容，请在候选源文件中修正；原字段保留。');
    const sources = candidate.sources ?? [];
    const emit = (value) => update({ kind: 'evidence', value });
    async function read(path) {
      const request = ++serial.current;
      setSource({ path, loading: true });
      try {
        const value = await onReadSource(path);
        if (serial.current === request)
          setSource({ ...value, changed: value.hash !== sources.find((row) => row.path === path)?.hash });
      } catch (error) {
        if (serial.current === request) {
          setSource(null);
          onStatus(error.message);
        }
      }
    }
    return h(
      'details',
      { className: 'novel-candidate-evidence', open: !fields.length },
      h('summary', null, '原文依据 · ' + fields.length),
      ...fields.map((proof, index) =>
        h(
          'div',
          { className: 'novel-proof-editor', key: index },
          h(
            'select',
            {
              'aria-label': '依据来源 ' + (index + 1),
              value: proof.path ?? '',
              onChange: (event) =>
                emit(fields.map((row, i) => (i === index ? { ...row, path: event.target.value } : row))),
            },
            h('option', { value: '' }, '选择本次原文'),
            proof.path && !sources.some((row) => row.path === proof.path)
              ? h('option', { value: proof.path }, '范围外：' + proof.path)
              : null,
            ...sources.map((row) => h('option', { key: row.path, value: row.path }, row.path)),
          ),
          h('textarea', {
            'aria-label': '原文引句 ' + (index + 1),
            value: typeof proof.quote === 'string' ? proof.quote : '',
            maxLength: 2000,
            rows: 3,
            onChange: (event) =>
              emit(fields.map((row, i) => (i === index ? { ...row, quote: event.target.value } : row))),
          }),
          h(
            'div',
            { className: 'novel-reference-tools' },
            onReadSource && sources.some((row) => row.path === proof.path)
              ? h(
                  'button',
                  { type: 'button', onClick: () => read(proof.path) },
                  '查看第 ' + (index + 1) + ' 段来源',
                )
              : null,
            h(
              'button',
              { type: 'button', onClick: () => emit(fields.filter((_, i) => i !== index)) },
              '移除依据 ' + (index + 1),
            ),
          ),
        ),
      ),
      h(
        'button',
        {
          type: 'button',
          disabled: fields.length >= 8 || !sources.length,
          onClick: () => emit([...fields, { path: sources[0].path, quote: '' }]),
        },
        '添加原文依据',
      ),
      source
        ? h(
            'section',
            { className: 'novel-canon-source' },
            h(
              'button',
              {
                type: 'button',
                onClick: () => {
                  serial.current++;
                  setSource(null);
                },
              },
              '收起依据原文',
            ),
            source.changed
              ? h('p', { role: 'alert' }, '来源已更新，与提案冻结版本不同；不能把这段新内容当作旧依据。')
              : null,
            h('pre', null, source.loading ? '正在读取…' : source.text),
          )
        : null,
    );
  }
  function CanonEditor({ text, onChange, onStatus, disabled, candidate, onReadSource }) {
    const parsed = useMemo(() => {
      try {
        return { value: parseCanon(text), ...(candidate ? { base: parseCanon(candidate.baseText) } : {}) };
      } catch (error) {
        return { error: error.message };
      }
    }, [text, candidate?.baseText]);
    const [collection, setCollection] = useState('characters'),
      [query, setQuery] = useState(''),
      [trust, setTrust] = useState('all');
    const [active, setActive] = useState(null),
      [selected, setSelected] = useState([]);
    const [newName, setNewName] = useState(''),
      [adding, setAdding] = useState(false),
      [from, setFrom] = useState(''),
      [to, setTo] = useState('');
    const [batch, setBatch] = useState('tags'),
      [batchName, setBatchName] = useState(''),
      [batchValue, setBatchValue] = useState('');
    const [extra, setExtra] = useState('');
    const [visibleCount, setVisibleCount] = useState(60);
    const ownText = useRef(text);
    useEffect(() => {
      if (text !== ownText.current) {
        setActive(null);
        setSelected([]);
      }
      ownText.current = text;
    }, [text]);
    useEffect(() => setVisibleCount(60), [collection, query, trust]);
    if (parsed.error) return h('div', { role: 'alert' }, parsed.error);
    const value = parsed.value,
      base = parsed.base,
      entries = canonEntries(value),
      current = entries.find((entry) => entry.key === active);
    const policy = (row) =>
      candidate ? candidateRecordState(base, row) : { existing: false, locked: false };
    const visible = entries.filter(
      (row) =>
        row.collection === collection &&
        (trust === 'all' || trustOf(row.item) === trust) &&
        JSON.stringify(row.item).toLocaleLowerCase().includes(query.toLocaleLowerCase()),
    );
    const options = endpointOptions(value),
      nameOf = endpointNames(options),
      label = COLLECTIONS.find(([key]) => key === collection)[1];
    const emit = (operation) => {
      try {
        const next = serializeCanon(
          candidate ? editCanonCandidate(value, operation, base) : editCanon(value, operation),
          text,
        );
        ownText.current = next;
        onChange(next);
        return true;
      } catch (error) {
        onStatus(error.message);
        return false;
      }
    };
    const update = (operation) => emit({ ...operation, key: current.key });
    const remove = (keys) => {
      const related = new Set(
        keys
          .flatMap((key) =>
            relatedEntries(
              value,
              entries.find((row) => row.key === key),
            ).map((row) => row.key),
          )
          .filter((key) => !keys.includes(key)),
      );
      if (
        !window.confirm(
          '删除 ' +
            keys.length +
            ' 条资料' +
            (related.size ? '及关联的 ' + related.size + ' 条关系' : '') +
            '？保存后可通过历史恢复。',
        )
      )
        return;
      if (emit({ kind: 'delete', keys })) {
        setActive(null);
        setSelected([]);
      }
    };
    return h(
      'div',
      { className: 'novel-canon', 'aria-label': '人物与资料编辑器' },
      h(
        'nav',
        { className: 'novel-document-strip', 'aria-label': '资料类型' },
        ...COLLECTIONS.map(([key, name]) =>
          h(
            'button',
            {
              type: 'button',
              key,
              'aria-pressed': collection === key,
              onClick: () => {
                setCollection(key);
                setActive(null);
                setAdding(false);
              },
            },
            name + ' ' + (value[key]?.length ?? 0),
          ),
        ),
      ),
      h(
        'div',
        { className: 'novel-reference-search' },
        h('input', {
          type: 'search',
          'aria-label': '搜索资料',
          placeholder: '搜索名称、笔记或字段',
          value: query,
          onChange: (e) => setQuery(e.target.value),
        }),
        h(
          'select',
          { 'aria-label': '资料确认状态', value: trust, onChange: (e) => setTrust(e.target.value) },
          h('option', { value: 'all' }, '全部'),
          h('option', { value: 'confirmed' }, '作者资料'),
          h('option', { value: 'pending' }, '待确认'),
        ),
        h('button', { type: 'button', onClick: () => setAdding(!adding), disabled }, '＋ ' + label),
      ),
      adding
        ? h(
            'form',
            {
              className: 'novel-reference-new',
              onSubmit: (event) => {
                event.preventDefault();
                if (!newName.trim()) {
                  onStatus('请先填写名称。');
                  return;
                }
                if (emit({ kind: 'add', collection, name: newName, from, to })) {
                  setActive(collection + ':' + (value[collection]?.length ?? 0));
                  setNewName('');
                  setAdding(false);
                }
              },
            },
            h('input', {
              'aria-label': '新' + label + '名称',
              value: newName,
              placeholder: label === '关系' ? '关系，例如：师徒' : label + '名称',
              maxLength: 200,
              onChange: (e) => setNewName(e.target.value),
              autoFocus: true,
            }),
            collection === 'relations'
              ? ['from', 'to'].map((side) =>
                  h(
                    'select',
                    {
                      key: side,
                      'aria-label': side === 'from' ? '关系起点' : '关系终点',
                      value: side === 'from' ? from : to,
                      onChange: (e) => (side === 'from' ? setFrom : setTo)(e.target.value),
                    },
                    h('option', { value: '' }, side === 'from' ? '选择起点' : '选择终点'),
                    ...options.map((row) =>
                      h(
                        'option',
                        { key: row.key, value: row.key },
                        COLLECTIONS.find(([key]) => key === row.collection)[1] + ' · ' + row.name,
                      ),
                    ),
                  ),
                )
              : null,
            h('button', { type: 'submit', disabled }, '创建'),
          )
        : null,
      h(
        'div',
        { className: 'novel-reference-tools' },
        visible.length && selected.length
          ? h(
              'button',
              {
                type: 'button',
                onClick: () =>
                  setSelected([
                    ...new Set([
                      ...selected,
                      ...visible.filter((row) => !policy(row).locked).map((row) => row.key),
                    ]),
                  ]),
              },
              '选择当前结果',
            )
          : null,
        selected.length ? h('button', { type: 'button', onClick: () => setSelected([]) }, '清空选择') : null,
      ),
      selected.length
        ? h(
            'section',
            { className: 'novel-reference-batch', 'aria-label': '批量修改资料' },
            h('strong', null, '已选 ' + selected.length + ' 条'),
            h(
              'select',
              { 'aria-label': '批量操作', value: batch, onChange: (e) => setBatch(e.target.value) },
              ...[
                ['tags', '添加标签'],
                ['remove-tags', '移除标签'],
                ['custom', '设置自定义字段'],
                ['append-custom', '追加自定义字段'],
                ['confirm', '确认为作者资料'],
                ['delete', '删除资料'],
              ]
                .filter(([key]) => !candidate || key !== 'confirm')
                .map(([key, name]) => h('option', { key, value: key }, name)),
            ),
            ['custom', 'append-custom'].includes(batch)
              ? h('input', {
                  'aria-label': '批量字段名',
                  placeholder: '字段名',
                  value: batchName,
                  onChange: (e) => setBatchName(e.target.value),
                })
              : null,
            ['tags', 'remove-tags', 'custom', 'append-custom'].includes(batch)
              ? h('textarea', {
                  'aria-label': '批量修改内容',
                  rows: 2,
                  value: batchValue,
                  placeholder: batch.includes('tags') ? '标签，用逗号分隔' : '字段内容',
                  onChange: (e) => setBatchValue(e.target.value),
                })
              : null,
            h(
              'button',
              {
                type: 'button',
                disabled,
                onClick: () => {
                  if (batch === 'delete') {
                    remove(selected);
                    return;
                  }
                  if (
                    batch === 'confirm' &&
                    !window.confirm(
                      '将选中的 ' + selected.length + ' 条资料确认为作者设定？AI 写作之后会据此核对。',
                    )
                  )
                    return;
                  const operation = batch.includes('tags')
                    ? { kind: 'tags', value: batchValue, remove: batch === 'remove-tags' }
                    : batch.includes('custom')
                      ? {
                          kind: 'custom',
                          name: batchName,
                          value: batchValue,
                          append: batch === 'append-custom',
                        }
                      : { kind: 'confirm' };
                  emit({ ...operation, keys: selected });
                },
              },
              '应用到所选',
            ),
          )
        : null,
      h(
        'div',
        { className: 'novel-canon-list' },
        ...visible.slice(0, visibleCount).map((row) =>
          h(
            'div',
            { key: row.key, className: 'novel-canon-card', 'data-active': active === row.key },
            h('input', {
              type: 'checkbox',
              'aria-label': '选择' + row.name,
              checked: selected.includes(row.key),
              disabled: disabled || policy(row).locked,
              onChange: (e) =>
                setSelected(
                  e.target.checked
                    ? [...new Set([...selected, row.key])]
                    : selected.filter((key) => key !== row.key),
                ),
            }),
            h(
              'button',
              {
                type: 'button',
                'aria-pressed': active === row.key,
                onClick: () => {
                  setActive(row.key);
                  setExtra('');
                },
              },
              h('strong', null, row.name),
              h(
                'small',
                null,
                row.collection === 'relations'
                  ? nameOf(row.item.sourceType, row.item.sourceId) +
                      ' → ' +
                      nameOf(row.item.targetType, row.item.targetId)
                  : displayValue(row.item.role || row.item.description || row.item.notes || ''),
              ),
              h(
                'span',
                { className: 'novel-trust', 'data-pending': trustOf(row.item) === 'pending' },
                trustOf(row.item) === 'pending'
                  ? '待确认'
                  : row.item.trust === 'manual'
                    ? '手工资料'
                    : '已确认',
              ),
            ),
          ),
        ),
        !visible.length
          ? h(
              'p',
              { className: 'novel-reference-empty' },
              query || trust !== 'all'
                ? '没有匹配的资料。'
                : '还没有' + label + '。随手记下即可，不必填写完整表格。',
            )
          : null,
      ),
      visible.length > visibleCount
        ? h(
            'button',
            { type: 'button', onClick: () => setVisibleCount(visibleCount + 60) },
            '继续显示（' + visibleCount + ' / ' + visible.length + '）',
          )
        : null,
      current
        ? h(
            candidate ? 'fieldset' : 'section',
            {
              className: 'novel-canon-detail',
              role: 'region',
              disabled: candidate ? disabled || policy(current).locked : undefined,
              'aria-label': '编辑' + current.name,
              key: current.key,
            },
            h(
              'div',
              { className: 'novel-reference-tools' },
              h('h3', null, current.name),
              !candidate && trustOf(current.item) === 'pending'
                ? h('button', { type: 'button', onClick: () => update({ kind: 'confirm' }) }, '确认为设定')
                : null,
              h(
                'button',
                {
                  type: 'button',
                  disabled: disabled || (candidate && policy(current).existing),
                  onClick: () => remove([current.key]),
                },
                '删除',
              ),
            ),
            candidate && policy(current).locked
              ? h('p', { role: 'note' }, '原资料在候选中只读；需要修改时请回正式人物与资料。')
              : null,
            candidate &&
              !policy(current).existing &&
              !(typeof current.item.id === 'string' && current.item.id.trim())
              ? h('button', { type: 'button', onClick: () => update({ kind: 'repair-id' }) }, '补全标识')
              : null,
            candidate &&
              !policy(current).existing &&
              (current.item.trust !== 'auto' || current.item.confirmed === true)
              ? h(
                  'button',
                  { type: 'button', onClick: () => update({ kind: 'as-suggestion' }) },
                  '改为待确认建议',
                )
              : null,
            h(
              'label',
              null,
              current.collection === 'relations' ? '关系名称' : '名称',
              typeof (current.item.name ?? current.item.label ?? '') === 'string'
                ? h('input', {
                    'aria-label': '资料名称',
                    value: current.item[current.collection === 'relations' ? 'label' : 'name'] ?? '',
                    maxLength: 200,
                    onChange: (e) =>
                      update({
                        kind: 'field',
                        field: current.collection === 'relations' ? 'label' : 'name',
                        value: e.target.value,
                      }),
                  })
                : h('pre', null, displayValue(current.item.name)),
            ),
            current.collection === 'relations'
              ? h(
                  'div',
                  { className: 'novel-relation-endpoints' },
                  ...['source', 'target'].map((side) => {
                    const chosen = options.find(
                      (row) =>
                        row.type === current.item[side + 'Type'] && row.item.id === current.item[side + 'Id'],
                    );
                    return h(
                      'label',
                      { key: side },
                      side === 'source' ? '起点' : '终点',
                      h(
                        'select',
                        {
                          'aria-label': side === 'source' ? '编辑关系起点' : '编辑关系终点',
                          value: chosen?.key ?? '',
                          onChange: (e) => update({ kind: 'endpoint', side, value: e.target.value }),
                        },
                        h(
                          'option',
                          { value: '' },
                          chosen
                            ? '选择资料'
                            : nameOf(current.item[side + 'Type'], current.item[side + 'Id']),
                        ),
                        ...options.map((row) => h('option', { key: row.key, value: row.key }, row.name)),
                      ),
                    );
                  }),
                )
              : null,
            ...ENTITY_FIELDS[current.collection]
              .filter((field) => current.item[field] !== undefined || field === 'notes')
              .map((field) => {
                const data = current.item[field],
                  list = ['tags', 'aliases'].includes(field),
                  simple = list
                    ? data === undefined ||
                      (Array.isArray(data) && data.every((item) => typeof item === 'string'))
                    : data === undefined || typeof data === 'string';
                return h(
                  'label',
                  { key: field },
                  FIELDS[field],
                  simple
                    ? list
                      ? h(TagField, {
                          label: '资料' + FIELDS[field],
                          value: data,
                          onChange: (value) => update({ kind: 'field', field, value }),
                        })
                      : h('textarea', {
                          'aria-label': '资料' + FIELDS[field],
                          value: data ?? '',
                          rows: field === 'notes' ? 5 : 3,
                          placeholder: field === 'notes' ? '自由写，不必补齐其他字段。' : '',
                          onChange: (e) => update({ kind: 'field', field, value: e.target.value }),
                        })
                    : h('pre', null, displayValue(data)),
                  current.item[field] !== undefined && field !== 'notes'
                    ? h(
                        'button',
                        {
                          className: 'novel-field-remove',
                          type: 'button',
                          'aria-label': '移除' + FIELDS[field],
                          onClick: () => update({ kind: 'remove-field', field }),
                        },
                        '移除字段',
                      )
                    : null,
                );
              }),
            h(
              'details',
              { className: 'novel-reference-optional' },
              h('summary', null, '更多信息'),
              h(
                'div',
                { className: 'novel-reference-tools' },
                h(
                  'select',
                  { 'aria-label': '添加资料字段', value: extra, onChange: (e) => setExtra(e.target.value) },
                  h('option', { value: '' }, '按需添加信息…'),
                  ...ENTITY_FIELDS[current.collection]
                    .filter((field) => current.item[field] === undefined && field !== 'notes')
                    .map((field) => h('option', { key: field, value: field }, FIELDS[field])),
                ),
                h(
                  'button',
                  {
                    type: 'button',
                    disabled: !extra,
                    onClick: () => {
                      if (
                        update({
                          kind: 'field',
                          field: extra,
                          value: ['tags', 'aliases'].includes(extra) ? [] : '',
                        })
                      )
                        setExtra('');
                    },
                  },
                  '添加信息',
                ),
              ),
            ),
            h(CustomFields, { item: current.item, update }),
            candidate
              ? h(EvidenceFields, { item: current.item, update, candidate, onReadSource, onStatus })
              : null,
            !candidate && Array.isArray(current.item.evidenceSources) && current.item.evidenceSources.length
              ? h(
                  'details',
                  { className: 'novel-reference-evidence' },
                  h('summary', null, '原文摘录'),
                  ...current.item.evidenceSources.map((proof, index) =>
                    h(
                      'figure',
                      { key: index },
                      h('figcaption', null, String(proof?.path ?? '未标注来源')),
                      h(
                        'blockquote',
                        null,
                        typeof proof?.quote === 'string' ? proof.quote : displayValue(proof),
                      ),
                    ),
                  ),
                  h(
                    'p',
                    { className: 'novel-reference-hint' },
                    '摘录是线索来源；原文可能已有更新，推论仍需核对。',
                  ),
                )
              : null,
            relatedEntries(value, current).length
              ? h(
                  'section',
                  { className: 'novel-related' },
                  h('h4', null, '相关关系'),
                  ...relatedEntries(value, current).map((row) =>
                    h(
                      'button',
                      {
                        key: row.key,
                        type: 'button',
                        onClick: () => {
                          setCollection('relations');
                          setActive(row.key);
                        },
                      },
                      nameOf(row.item.sourceType, row.item.sourceId) +
                        ' — ' +
                        row.name +
                        ' → ' +
                        nameOf(row.item.targetType, row.item.targetId),
                    ),
                  ),
                )
              : null,
            h('details', null, h('summary', null, '完整记录'), h('pre', null, displayValue(current.item))),
          )
        : null,
    );
  }
  // Readable, complete JSON tree for AI memory and unfamiliar imported records.
  // It does not infer confirmations or convert arbitrary legacy schemas.
  const LABELS = {
    ...FIELDS,
    memory: 'AI 记忆',
    chapterMemories: '章节记忆',
    characters: '人物',
    locations: '地点',
    items: '物品',
    organizations: '组织',
    relations: '关系',
    importantEvents: '重要事件',
    foreshadows: '伏笔',
    active: '未回收',
    resolved: '已回收',
    outline: '大纲',
    title: '标题',
    chapter: '章节',
    summary: '概要',
    keyEvents: '关键事件',
    creativeRules: '创作规则',
    methodologyCards: '写作卡片',
    savedPrompts: '提示词',
    referenceText: '参考风格',
    toneAtmosphere: '基调与氛围',
    forbiddenItems: '避免事项',
    styleConstraints: '风格约束',
    cardText: '卡片内容',
    name: '名称',
    content: '内容',
    notice: '说明',
  };
  function TreeNode({ title, data, depth, initiallyOpen }) {
    const [expanded, setExpanded] = useState(initiallyOpen);
    return h(
      'details',
      { open: expanded, onToggle: (e) => setExpanded(e.currentTarget.open) },
      h('summary', null, title),
      expanded
        ? depth >= 8
          ? h('pre', null, displayValue(data))
          : h(Tree, { value: data, depth: depth + 1 })
        : null,
    );
  }
  function Tree({ value, depth = 0 }) {
    const [visible, setVisible] = useState(40);
    if (!object(value) && !Array.isArray(value)) return h('pre', null, displayValue(value));
    const rows = Object.entries(value);
    if (!rows.length) return h('p', { className: 'novel-reference-empty' }, '暂无内容');
    return h(
      'div',
      { className: 'novel-reference-tree' },
      ...rows.slice(0, visible).map(([key, data], index) => {
        const title = Array.isArray(value)
          ? String(data?.title || data?.name || (data?.chapter && '第 ' + data.chapter + ' 章') || index + 1)
          : LABELS[key] || key;
        return h(TreeNode, { key, title, data, depth, initiallyOpen: depth === 0 && rows.length <= 8 });
      }),
      rows.length > visible
        ? h(
            'button',
            { type: 'button', onClick: () => setVisible(visible + 40) },
            '继续显示（' + visible + ' / ' + rows.length + '）',
          )
        : null,
    );
  }
  return function ReferenceEditor({
    path,
    text,
    onChange,
    onStatus,
    disabled,
    candidate,
    onReadSource,
    promptsOnly = false,
  }) {
    let value, error;
    try {
      value = JSON.parse(text.replace(/^\uFEFF/, ''));
    } catch {
      error = true;
    }
    return h(
      'div',
      { className: 'novel-reference-editor' },
      path === 'canon.json'
        ? candidate
          ? h(
              'fieldset',
              { className: 'novel-candidate-form', disabled: disabled || !candidate.editable },
              h(CanonEditor, { text, onChange, onStatus, disabled, candidate, onReadSource }),
            )
          : h(CanonEditor, { text, onChange, onStatus, disabled })
        : path === 'rules.json'
          ? h(RulesEditor, { text, onChange, onStatus, disabled, promptsOnly })
          : !error
            ? h(Tree, { value })
            : null,
      path === 'memory.json'
        ? h(
            'p',
            { className: 'novel-reference-hint' },
            'AI 记忆只作参考，不会因在这里查看就变成作者确认的设定。',
          )
        : null,
      error ? h('p', { role: 'alert' }, 'JSON 尚未完整，请在源文件中修正；原文件不会被覆盖。') : null,
      h(
        'details',
        { className: 'novel-reference-source', open: !!error },
        h('summary', null, '源文件 · 按需修改'),
        h('textarea', {
          className: 'novel-editor-text',
          'aria-label': '资料源文件',
          value: text,
          spellCheck: false,
          disabled: disabled || (candidate && !candidate.editable),
          onChange: (e) => onChange(e.target.value),
        }),
      ),
    );
  };
}
