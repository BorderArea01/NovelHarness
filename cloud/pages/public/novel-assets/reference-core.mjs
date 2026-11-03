// Views/reducers over the ORIGINAL canon.json, not a second canon database.
// Every edit retains unknown fields and goes through the manuscript CAS/history.

export const COLLECTIONS = [
  ['characters', '人物', 'character'],
  ['locations', '地点', 'location'],
  ['items', '物品', 'item'],
  ['organizations', '组织', 'organization'],
  ['relations', '关系', 'relation'],
];
export const FIELDS = {
  aliases: '别名',
  role: '角色定位',
  basicInfo: '基础信息',
  appearance: '外貌',
  personality: '性格',
  speechStyle: '说话方式',
  background: '背景',
  motivation: '动机',
  goals: '目标',
  secrets: '秘密',
  currentStatus: '当前状态',
  tags: '标签',
  notes: '笔记',
  type: '类型',
  description: '描述',
  geography: '地理',
  culture: '文化',
  rules: '规则',
  owner: '持有者',
  abilities: '能力',
  origin: '来源',
  purpose: '宗旨',
  leaders: '领导者',
  headquarters: '总部',
  evidence: '原文依据',
};
export const ENTITY_FIELDS = {
  characters: [
    'role',
    'basicInfo',
    'appearance',
    'personality',
    'speechStyle',
    'background',
    'motivation',
    'goals',
    'secrets',
    'currentStatus',
    'aliases',
    'tags',
    'notes',
    'evidence',
  ],
  locations: [
    'type',
    'description',
    'geography',
    'culture',
    'rules',
    'currentStatus',
    'aliases',
    'tags',
    'notes',
    'evidence',
  ],
  items: [
    'type',
    'description',
    'owner',
    'abilities',
    'origin',
    'currentStatus',
    'aliases',
    'tags',
    'notes',
    'evidence',
  ],
  organizations: [
    'type',
    'description',
    'purpose',
    'culture',
    'rules',
    'leaders',
    'headquarters',
    'currentStatus',
    'aliases',
    'tags',
    'notes',
    'evidence',
  ],
  relations: ['description', 'tags', 'notes', 'evidence'],
};
export const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const displayValue = (value) =>
  typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? '');
export const splitTags = (value) => [
  ...new Set(
    value
      .split(/[,，、\n]/)
      .map((s) => s.trim())
      .filter(Boolean),
  ),
];
export function parseCanon(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (!object(value)) throw new Error('资料不是对象，请在源文件中检查；原内容未改动。');
  for (const [key] of COLLECTIONS) {
    if (value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((item) => !object(item))))
      throw new Error(
        '“' +
          COLLECTIONS.find(([k]) => k === key)[1] +
          '”格式不兼容，请在源文件中检查；不会自动转换或丢弃内容。',
      );
  }
  return value;
}
export function serializeCanon(value, original = '') {
  return (
    (original.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(value, null, 2) +
    (original.endsWith('\n') ? '\n' : '')
  );
}
export function trustOf(item) {
  if (item.trust === 'auto') return 'pending';
  if (item.trust === 'manual' || item.trust === 'confirmed' || item.confirmed === true) return 'confirmed';
  return 'pending';
}
export function canonEntries(value, collection) {
  const groups = collection ? COLLECTIONS.filter(([key]) => key === collection) : COLLECTIONS;
  return groups.flatMap(([key, label, type]) =>
    (value[key] ?? []).map((item, index) => ({
      key: key + ':' + index,
      collection: key,
      type,
      index,
      item,
      name: String(item.name || item.label || '未命名' + label),
    })),
  );
}
function entry(value, key) {
  const found = canonEntries(value).find((row) => row.key === key);
  if (!found) throw new Error('资料已变化，请重新选择。');
  return found;
}
export function endpointOptions(value) {
  const entries = canonEntries(value).filter(
    (row) => row.collection !== 'relations' && typeof row.item.id === 'string' && row.item.id,
  );
  const counts = new Map();
  for (const row of entries) {
    const key = JSON.stringify([row.type, row.item.id]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return entries.filter((row) => counts.get(JSON.stringify([row.type, row.item.id])) === 1);
}
export function endpointNames(options) {
  const names = new Map(options.map((row) => [JSON.stringify([row.type, row.item.id]), row.name]));
  return (type, id) => names.get(JSON.stringify([type, id])) || '未找到的资料（' + String(id ?? '') + '）';
}
export function relatedEntries(value, selected) {
  if (!selected || selected.collection === 'relations' || !selected.item.id) return [];
  return canonEntries(value, 'relations').filter(
    ({ item }) =>
      (item.sourceType === selected.type && item.sourceId === selected.item.id) ||
      (item.targetType === selected.type && item.targetId === selected.item.id),
  );
}
export function endpointName(value, type, id) {
  return (
    endpointOptions(value).find((row) => row.type === type && row.item.id === id)?.name ||
    '未找到的资料（' + String(id ?? '') + '）'
  );
}
function custom(item) {
  if (item.customFields !== undefined && !object(item.customFields))
    throw new Error('自定义字段格式不兼容，未覆盖它；请在源文件中检查。');
  return Object.entries(item.customFields ?? {});
}
function fieldName(name) {
  const key = String(name).trim();
  if (!key || key.length > 100 || /[\u0000-\u001f\u007f]/.test(key))
    throw new Error('字段名需为 1–100 个可见字符。');
  return key;
}
export function editCanon(
  original,
  operation,
  { uuid = () => crypto.randomUUID(), now = () => new Date().toISOString(), newTrust = 'manual' } = {},
) {
  const value = structuredClone(original);
  // Validate before mutation, including callers other than the visual editor.
  parseCanon(JSON.stringify(value));
  if (operation.kind === 'add') {
    if (!COLLECTIONS.some(([key]) => key === operation.collection)) throw new Error('未知资料类型。');
    if (!['manual', 'auto'].includes(newTrust)) throw new Error('新增资料状态无效。');
    const item = {
      id: uuid(),
      trust: newTrust,
      createdAt: now(),
      ...(newTrust === 'auto' ? { evidenceSources: [] } : {}),
    };
    if (operation.collection === 'relations') {
      const options = endpointOptions(value);
      const from = options.find((row) => row.key === operation.from),
        to = options.find((row) => row.key === operation.to);
      if (!from || !to)
        throw new Error('请选择两个具有唯一标识的资料；旧版缺少标识的记录请先在源文件中补充 id。');
      if (!operation.name?.trim()) throw new Error('请填写关系名称。');
      Object.assign(item, {
        sourceType: from.type,
        sourceId: from.item.id,
        targetType: to.type,
        targetId: to.item.id,
        label: operation.name.trim(),
      });
    } else
      item.name =
        operation.name?.trim() || '未命名' + COLLECTIONS.find(([key]) => key === operation.collection)[1];
    value[operation.collection] ??= [];
    value[operation.collection].push(item);
    return value;
  }
  const keys = [...new Set(operation.keys ?? [operation.key])];
  if (!keys.length || keys.some((key) => typeof key !== 'string')) throw new Error('请先选择资料。');
  const targets = keys.map((key) => entry(value, key));
  if (operation.kind === 'delete') {
    const deleting = new Set(keys);
    for (const row of targets) {
      if (
        row.collection !== 'relations' &&
        row.item.id &&
        canonEntries(value, row.collection).filter((other) => other.item.id === row.item.id).length > 1 &&
        relatedEntries(value, row).length
      )
        throw new Error('存在重复资料标识，无法判断关联关系；请先在源文件中消除重复 id。');
      for (const relation of relatedEntries(value, row)) deleting.add(relation.key);
    }
    for (const [collection] of COLLECTIONS)
      if (value[collection])
        value[collection] = value[collection].filter((_, index) => !deleting.has(collection + ':' + index));
    return value;
  }
  for (const row of targets) {
    const item = row.item;
    if (operation.kind === 'field') {
      const allowed = [...ENTITY_FIELDS[row.collection], row.collection === 'relations' ? 'label' : 'name'];
      if (!allowed.includes(operation.field)) throw new Error('不支持的资料字段。');
      item[operation.field] = operation.value;
    } else if (operation.kind === 'remove-field') {
      if (!ENTITY_FIELDS[row.collection].includes(operation.field)) throw new Error('不能移除该字段。');
      delete item[operation.field];
    } else if (operation.kind === 'endpoint') {
      const target = endpointOptions(value).find((candidate) => candidate.key === operation.value);
      if (row.collection !== 'relations' || !['source', 'target'].includes(operation.side) || !target)
        throw new Error('请选择有效的关系端点。');
      item[operation.side + 'Type'] = target.type;
      item[operation.side + 'Id'] = target.item.id;
    } else if (operation.kind === 'evidence') {
      if (
        !Array.isArray(operation.value) ||
        operation.value.length > 8 ||
        operation.value.some(
          (proof) => !object(proof) || typeof proof.path !== 'string' || typeof proof.quote !== 'string',
        )
      )
        throw new Error('原文依据格式无效；请保留路径和引句，最多 8 段。');
      item.evidenceSources = structuredClone(operation.value);
    } else if (operation.kind === 'repair-id') {
      if (typeof item.id === 'string' && item.id.trim())
        throw new Error('已有标识不能自动替换，避免破坏关系。');
      const id = uuid();
      if (canonEntries(value, row.collection).some((other) => other.item.id === id))
        throw new Error('生成的标识重复，未修改。');
      item.id = id;
    } else if (operation.kind === 'as-suggestion') {
      item.trust = 'auto';
      delete item.confirmed;
    } else if (operation.kind === 'confirm') {
      item.trust = 'confirmed';
      item.confirmed = true;
    } else if (operation.kind === 'tags') {
      if (
        item.tags !== undefined &&
        (!Array.isArray(item.tags) || item.tags.some((t) => typeof t !== 'string'))
      )
        throw new Error('标签格式不兼容，未替换原内容。');
      const tags = splitTags(operation.value);
      item.tags = operation.remove
        ? (item.tags ?? []).filter((tag) => !tags.includes(tag))
        : [...new Set([...(item.tags ?? []), ...tags])];
    } else if (operation.kind === 'custom') {
      const key = fieldName(operation.name),
        fields = custom(item);
      const previous = fields.find(([name]) => name === key);
      if (operation.addOnly && previous) throw new Error('字段名已存在，未覆盖它。');
      if (operation.append && previous && typeof previous[1] !== 'string')
        throw new Error('不能将文字追加到复杂字段；原内容已保留。');
      const next = operation.append && previous?.[1] ? previous[1] + '\n' + operation.value : operation.value;
      item.customFields = Object.fromEntries([...fields.filter(([name]) => name !== key), [key, next]]);
    } else if (operation.kind === 'rename-custom') {
      const key = fieldName(operation.name),
        fields = custom(item);
      if (!fields.some(([name]) => name === operation.from)) throw new Error('原字段不存在。');
      if (key !== operation.from && fields.some(([name]) => name === key))
        throw new Error('字段名已存在，未覆盖它。');
      item.customFields = Object.fromEntries(
        fields.map(([name, data]) => [name === operation.from ? key : name, data]),
      );
    } else if (operation.kind === 'delete-custom') {
      item.customFields = Object.fromEntries(custom(item).filter(([name]) => name !== operation.name));
    } else throw new Error('未知资料操作。');
    item.updatedAt = now();
    // Editing AI evidence is not silently equivalent to author confirmation.
  }
  return value;
}

export function candidateRecordState(base, row) {
  const original = base?.[row.collection]?.[row.index];
  const existing = row.index < (base?.[row.collection]?.length ?? 0);
  return {
    existing,
    locked:
      existing &&
      !(
        original?.trust === 'auto' &&
        original.confirmed !== true &&
        original.id &&
        original.id === row.item.id
      ),
  };
}

// Same record operations as the formal editor, constrained to an unpublished
// candidate. The server remains publication authority; source JSON is still an
// explicit advanced editor, not a permission boundary or another canon store.
export function editCanonCandidate(original, operation, base, options = {}) {
  parseCanon(JSON.stringify(base));
  if (operation.kind === 'confirm') throw new Error('请先收录到人物与资料，再确认为作者设定。');
  const keys = operation.kind === 'add' ? [] : [...new Set(operation.keys ?? [operation.key])];
  for (const key of keys) {
    const row = entry(original, key),
      policy = candidateRecordState(base, row);
    if (policy.locked) throw new Error('原作者资料在候选中只读；请回正式人物与资料编辑。');
    if (policy.existing && ['delete', 'repair-id', 'as-suggestion'].includes(operation.kind))
      throw new Error('候选不能删除或替换原资料身份；只能修正建议，正式资料未修改。');
  }
  const next = editCanon(original, operation, { ...options, newTrust: 'auto' });
  for (const [collection] of COLLECTIONS)
    for (let index = 0; index < (base[collection]?.length ?? 0); index++) {
      const before = original[collection]?.[index],
        after = next[collection]?.[index];
      if (!before || !after || before.id !== after.id)
        throw new Error('本次操作会挪动或删除旧资料，请先修正候选源文件；未应用修改。');
      const row = { collection, index, item: before };
      if (candidateRecordState(base, row).locked && JSON.stringify(before) !== JSON.stringify(after))
        throw new Error('本次操作会改动原作者资料，未应用修改。');
    }
  return next;
}

export { documentReadHint, writingReferences } from '../../../worker/shared/writing-context.mjs';
