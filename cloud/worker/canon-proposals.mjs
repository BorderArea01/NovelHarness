import { STORY_PLAN_PATH } from './outline-plans.mjs';
// Server authority for AI canon proposals. The browser consumes this assessment,
// rather than duplicating validation or keeping a second canon store.
const groups = ['characters', 'locations', 'items', 'organizations', 'relations'];
const types = ['character', 'location', 'item', 'organization', 'relation'];
const labels = ['人物', '地点', '物品', '组织', '关系'];
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const stable = (v) =>
  Array.isArray(v)
    ? v.map(stable)
    : object(v)
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((key) => [key, stable(v[key])]),
        )
      : v;
const same = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const parse = (text) => {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  if (
    !object(value) ||
    groups.some(
      (key) =>
        value[key] !== undefined && (!Array.isArray(value[key]) || value[key].some((row) => !object(row))),
    )
  )
    throw new Error('资料结构不兼容，请保留原结构，不要转换成文本或另一种索引。');
  return value;
};
export function evidencePath(path) {
  return (
    path !== STORY_PLAN_PATH &&
    typeof path === 'string' &&
    path.length <= 240 &&
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    !path.split('/').some((p) => !p || p === '.' || p === '..') &&
    (['seed.md', 'setting.md'].includes(path) || /^(chapters|notes)\/.+\.(md|txt)$/.test(path))
  );
}
const isPending = (row) => row.trust === 'auto' && row.confirmed !== true;
export function checkCanonBase(text) {
  return parse(text);
}

export function assessCanon(beforeText, afterText, sources, readSource) {
  const result = { issues: [], changes: [], validCount: 0 };
  let before, after;
  try {
    before = parse(beforeText);
    after = parse(afterText);
  } catch (error) {
    result.issues.push(
      error instanceof SyntaxError ? '候选 JSON 尚未完整；可以继续浏览，完成后会自动检查。' : error.message,
    );
    return result;
  }
  if (!Array.isArray(sources) || !sources.length)
    result.issues.push('提案缺少原文范围，请重新发起资料整理；原文件未变动。');
  const rootKeys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of rootKeys)
    if (!groups.includes(key) && !same(before[key], after[key]))
      result.issues.push('候选改动了资料根字段“' + key + '”，请保留原值。');
  const cache = new Map(),
    sourceMap = new Map((sources ?? []).map((source) => [source.path, source.hash]));
  const sourceFor = (path) => {
    if (!cache.has(path)) {
      try {
        cache.set(path, { document: readSource(path) });
      } catch {
        cache.set(path, { error: '原文无法读取或已删除。' });
      }
    }
    return cache.get(path);
  };
  for (const [groupIndex, collection] of groups.entries()) {
    const previous = before[collection] ?? [],
      next = after[collection] ?? [],
      ids = new Map();
    const nameCounts = new Map();
    const namesOf = (item) => [
      ...new Set(
        [item.name, ...(Array.isArray(item.aliases) ? item.aliases : [])]
          .filter((name) => typeof name === 'string' && name.trim())
          .map((name) => name.normalize('NFC').trim().toLocaleLowerCase()),
      ),
    ];
    if (collection !== 'relations')
      for (const item of next)
        for (const name of namesOf(item)) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    for (const item of next)
      if (typeof item.id === 'string' && item.id) ids.set(item.id, (ids.get(item.id) ?? 0) + 1);
    if (next.length < previous.length)
      result.issues.push(labels[groupIndex] + '记录被删除；整理只能补充建议，不能删掉旧资料。');
    for (let index = 0; index < next.length; index++) {
      const item = next[index],
        original = previous[index];
      if (same(original, item)) continue;
      const change = {
        key: collection + ':' + index,
        collection,
        type: types[groupIndex],
        label: labels[groupIndex],
        name: String(item.name || item.label || '未命名'),
        before: original ?? null,
        after: item,
        issues: [],
        evidence: [],
        warnings: [],
      };
      if (original && (!isPending(original) || typeof original.id !== 'string' || original.id !== item.id))
        change.issues.push('不能改动作者资料、无标识旧记录或原有顺序；请保留原文。');
      if (!isPending(item)) change.issues.push('AI 新增和更新的记录必须为 trust="auto"，不能自行确认。');
      if (typeof item.id !== 'string' || !item.id.trim() || item.id.length > 200 || ids.get(item.id) !== 1)
        change.issues.push('资料需要唯一、非空的 id，不能与本类型旧记录重复。');
      if (
        typeof item[collection === 'relations' ? 'label' : 'name'] !== 'string' ||
        !item[collection === 'relations' ? 'label' : 'name'].trim()
      )
        change.issues.push('资料缺少名称。');
      if (collection !== 'relations' && namesOf(item).some((name) => nameCounts.get(name) > 1))
        change.issues.push('存在同名或别名重合的资料，请复用原记录；同名不同人需要作者先区分。');
      // Unknown imported fields must not disappear while revising an AI record.
      if (original)
        for (const key of Object.keys(original))
          if (!Object.hasOwn(item, key)) change.issues.push('不能丢弃旧字段“' + key + '”。');
      const anchors = item.evidenceSources;
      if (!Array.isArray(anchors) || anchors.length < 1 || anchors.length > 8)
        change.issues.push('每条建议需有 1–8 段原文依据。');
      else
        for (const anchor of anchors) {
          const proof = {
            path: typeof anchor?.path === 'string' ? anchor.path : '',
            quote: typeof anchor?.quote === 'string' ? anchor.quote : '',
            valid: false,
          };
          if (!evidencePath(proof.path) || !sourceMap.has(proof.path))
            proof.error = '引用不在本次选择的原文范围内。';
          else if (!proof.quote.trim() || proof.quote.length > 2000)
            proof.error = '引用必须是非空且不超过 2000 字符的原文片段。';
          else {
            const source = sourceFor(proof.path);
            if (source.error) proof.error = source.error;
            else if (source.document.hash !== sourceMap.get(proof.path))
              proof.error = '原文版本已变化，请基于新版本重新整理。';
            else if (!source.document.text.includes(proof.quote))
              proof.error = '引用不在原文中，未把编造的依据当成事实。';
            else proof.valid = true;
          }
          change.evidence.push(proof);
          if (!proof.valid) change.issues.push(proof.error);
        }
      // Lexical identity hints, NOT a semantic correctness certificate.
      // Useful derived names remain selectable after individual author review.
      if (collection === 'relations') {
        change.warnings.push('关系标签包含解释，请逐条核对两端身份与未知属性；引句存在不等于关系推论成立。');
      } else if (
        !change.evidence.some(
          (proof) =>
            proof.valid &&
            namesOf(item).some((name) => proof.quote.normalize('NFC').toLocaleLowerCase().includes(name)),
        )
      ) {
        change.warnings.push(
          '名称或别名未出现在本条有效引文中，请核对姓名归因；不要把范围外信息或未知身份补成事实。',
        );
      }
      change.requiresIndividualReview = change.warnings.length > 0;
      change.valid = change.issues.length === 0;
      result.changes.push(change);
    }
  }
  // Resolve relationships against the actual candidate identities, not names.
  const identities = new Map();
  for (let i = 0; i < groups.length - 1; i++)
    for (const item of after[groups[i]] ?? [])
      if (typeof item.id === 'string') {
        const key = types[i] + ':' + item.id;
        identities.set(key, (identities.get(key) ?? 0) + 1);
      }
  for (const change of result.changes) {
    if (change.collection === 'relations')
      for (const side of ['source', 'target'])
        if (identities.get(change.after[side + 'Type'] + ':' + change.after[side + 'Id']) !== 1) {
          change.issues.push('关系的' + (side === 'source' ? '起点' : '终点') + '不存在或不唯一。');
          change.valid = false;
        }
    if (change.valid) result.validCount++;
  }
  return result;
}

export function mergeCanonSelection(beforeText, assessment, keys) {
  if (assessment.issues.length) throw new Error(assessment.issues[0]);
  if (!Array.isArray(keys) || !keys.length || new Set(keys).size !== keys.length)
    throw new Error('请选择要收录的资料。');
  const base = parse(beforeText),
    changes = new Map(assessment.changes.map((change) => [change.key, change]));
  const selected = keys.map((key) => {
    const change = changes.get(key);
    if (!change?.valid) throw new Error('所选资料不存在或依据尚未通过检查。');
    return change;
  });
  // Apply onto the ORIGINAL base, never publish a candidate's unrelated edits.
  for (const change of selected) {
    base[change.collection] ??= [];
    if (change.before) {
      const index = Number(change.key.slice(change.key.lastIndexOf(':') + 1));
      base[change.collection][index] = change.after;
    } else base[change.collection].push(change.after);
  }
  for (const change of selected)
    if (base[change.collection].filter((item) => item.id === change.after.id).length !== 1)
      throw new Error('所选建议会与保留的原资料标识重复，未收录。');
  const identities = new Map();
  for (let i = 0; i < groups.length - 1; i++)
    for (const item of base[groups[i]] ?? [])
      if (typeof item.id === 'string') {
        const key = types[i] + ':' + item.id;
        identities.set(key, (identities.get(key) ?? 0) + 1);
      }
  for (const change of selected)
    if (change.collection === 'relations')
      for (const side of ['source', 'target'])
        if (identities.get(change.after[side + 'Type'] + ':' + change.after[side + 'Id']) !== 1)
          throw new Error('请同时勾选该关系所连接的新增资料，或先收录人物 / 地点再整理关系。');
  return (
    (beforeText.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(base, null, 2) +
    (beforeText.endsWith('\n') ? '\n' : '')
  );
}
