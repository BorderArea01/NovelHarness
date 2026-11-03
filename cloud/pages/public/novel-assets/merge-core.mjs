import { diff3Merge } from './diff3-vendor.mjs';
// Visible safety budget: avoid quadratic matching on huge repetitive buffers.
export const MERGE_LIMITS = Object.freeze({
  bytesPerVersion: 2 * 1024 * 1024,
  matchingPairs: 2000000,
  nodes: 100000,
  depth: 64,
});
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const missing = () => ({ exists: false });
const present = (value) => ({ exists: true, value });
const lines = (text) => text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
export function createMergePlan({ path, base, local, remote, json = path.endsWith('.json') }) {
  if (typeof json !== 'boolean') throw new Error('文稿合并类型无效，未应用修改。');
  if (![base, local, remote].every((s) => typeof s === 'string'))
    throw new Error('缺少三方原文，不能猜测共同基线。');
  if ([base, local, remote].some((s) => new TextEncoder().encode(s).length > MERGE_LIMITS.bytesPerVersion))
    throw new Error('文件超过单版本 2 MiB 合并上限；三份原文仍可手工比较。');
  const conflicts = [];
  let visits = 0;
  const visit = (depth) => {
    if (++visits > MERGE_LIMITS.nodes || depth > MERGE_LIMITS.depth)
      throw new Error('结构复杂度超过自动合并预算；未截断内容，请手工处理。');
  };
  const conflict = (at, b, l, r, kind) => {
    const id = String(conflicts.length);
    conflicts.push({ id, path: at, base: b, local: l, remote: r, kind });
    return { kind: 'conflict', id };
  };
  const equal = (a, b, depth = 0) => {
    visit(depth);
    if (a === b) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b))
      return false;
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.hasOwn(b, k) && equal(a[k], b[k], depth + 1))
    );
  };
  function textNode(b, l, r, at) {
    if (l === r || r === b) return { kind: 'value', value: l };
    if (l === b) return { kind: 'value', value: r };
    let a = lines(l),
      o = lines(b),
      z = lines(r),
      prefix = 0,
      suffix = 0;
    while (
      prefix < Math.min(a.length, o.length, z.length) &&
      a[prefix] === o[prefix] &&
      o[prefix] === z[prefix]
    )
      prefix++;
    while (
      suffix < Math.min(a.length, o.length, z.length) - prefix &&
      a[a.length - 1 - suffix] === o[o.length - 1 - suffix] &&
      o[o.length - 1 - suffix] === z[z.length - 1 - suffix]
    )
      suffix++;
    const leading = o.slice(0, prefix).join(''),
      trailing = suffix ? o.slice(-suffix).join('') : '';
    a = a.slice(prefix, suffix ? -suffix : undefined);
    o = o.slice(prefix, suffix ? -suffix : undefined);
    z = z.slice(prefix, suffix ? -suffix : undefined);
    const frequencies = new Map();
    for (const token of o) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    let pairs = 0;
    for (const token of [...a, ...z]) pairs += frequencies.get(token) ?? 0;
    if (pairs > MERGE_LIMITS.matchingPairs)
      throw new Error('重复文本超过自动合并预算；未截断内容，请手工处理。');
    const chunks = [{ kind: 'value', value: leading }];
    for (const part of diff3Merge(a, o, z, { excludeFalseConflicts: true })) {
      if (part.ok) chunks.push({ kind: 'value', value: part.ok.join('') });
      else
        chunks.push(
          conflict(
            at + ' · 原第 ' + (prefix + part.conflict.oIndex + 1) + ' 行',
            present(part.conflict.o.join('')),
            present(part.conflict.a.join('')),
            present(part.conflict.b.join('')),
            'text',
          ),
        );
    }
    chunks.push({ kind: 'value', value: trailing });
    return { kind: 'text', chunks };
  }
  const sameState = (a, b) => a.exists === b.exists && (!a.exists || equal(a.value, b.value));
  function jsonNode(b, l, r, at, depth = 0) {
    visit(depth);
    if (sameState(l, r) || sameState(r, b)) return { kind: 'state', state: l };
    if (sameState(l, b)) return { kind: 'state', state: r };
    if (b.exists && l.exists && r.exists) {
      if ([b.value, l.value, r.value].every(object)) {
        const keys = [
          ...new Set([...Object.keys(r.value), ...Object.keys(l.value), ...Object.keys(b.value)]),
        ];
        return {
          kind: 'object',
          entries: keys.map((key) => [
            key,
            jsonNode(
              ...[b, l, r].map((s) => (Object.hasOwn(s.value, key) ? present(s.value[key]) : missing())),
              at + '/' + key.replaceAll('~', '~0').replaceAll('/', '~1'),
              depth + 1,
            ),
          ]),
        };
      }
      if ([b.value, l.value, r.value].every((v) => typeof v === 'string'))
        return textNode(b.value, l.value, r.value, at);
      if ([b.value, l.value, r.value].every(Array.isArray)) {
        // Arrays with identical unique identities/order can merge independent
        // record edits. Reordering, insertion or ambiguous IDs stay explicit.
        for (const key of ['id', 'chapter']) {
          const ids = [b.value, l.value, r.value].map((rows) =>
            rows.every((row) => object(row) && (typeof row[key] === 'string' || typeof row[key] === 'number'))
              ? rows.map((row) => typeof row[key] + ':' + row[key])
              : null,
          );
          if (
            ids.every((v) => v && new Set(v).size === v.length) &&
            equal(ids[0], ids[1]) &&
            equal(ids[0], ids[2])
          )
            return {
              kind: 'array',
              items: b.value.map((row, index) =>
                jsonNode(
                  present(row),
                  present(l.value[index]),
                  present(r.value[index]),
                  at + '/[' + key + '=' + row[key] + ']',
                  depth + 1,
                ),
              ),
            };
        }
      }
    }
    return conflict(at || '/', b, l, r, 'json');
  }
  let tree,
    format = 'text',
    note = '';
  if (json) {
    try {
      const parsed = [base, local, remote].map((s) => JSON.parse(s.replace(/^\uFEFF/, '')));
      tree = jsonNode(...parsed.map(present), '');
      format = 'json';
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      conflicts.length = 0;
      tree = conflict('/', present(base), present(local), present(remote), 'text');
      note = '有一份 JSON 尚未完整，保留三份原文；手动结果需通过 JSON 检查。';
    }
  } else tree = textNode(base, local, remote, path);
  return {
    tree,
    conflicts,
    format,
    json,
    note,
    bom: (local.startsWith('\uFEFF') === base.startsWith('\uFEFF') ? remote : local).startsWith('\uFEFF'),
    ending: remote.match(/\s*$/)?.[0] ?? '',
    newline: remote.includes('\r\n') ? '\r\n' : '\n',
    exact: local === remote ? local : local === base ? remote : remote === base ? local : null,
  };
}
export function resolveMerge(plan, choices = {}) {
  function walk(node) {
    if (node.kind === 'value') return present(node.value);
    if (node.kind === 'state') return node.state;
    if (node.kind === 'conflict') {
      const c = plan.conflicts[Number(node.id)],
        choice = choices[node.id];
      if (!choice) throw new Error('还有未处理的冲突。');
      if (['local', 'remote', 'base'].includes(choice.source)) return c[choice.source];
      if (choice.source !== 'manual' || typeof choice.text !== 'string') throw new Error('冲突选择无效。');
      return present(c.kind === 'text' ? choice.text : JSON.parse(choice.text));
    }
    if (node.kind === 'text') return present(node.chunks.map((part) => walk(part).value ?? '').join(''));
    if (node.kind === 'array') return present(node.items.map((part) => walk(part).value));
    const value = Object.create(null);
    for (const [key, part] of node.entries) {
      const resolved = walk(part);
      if (resolved.exists) Object.defineProperty(value, key, { value: resolved.value, enumerable: true });
    }
    return present(value);
  }
  const result = walk(plan.tree);
  if (!result.exists) throw new Error('不能把整份文件的删除当作普通保存。');
  const text =
    plan.exact !== null && plan.conflicts.length === 0
      ? plan.exact
      : plan.format === 'json'
        ? (plan.bom ? '\uFEFF' : '') +
          JSON.stringify(result.value, null, 2).replaceAll('\n', plan.newline) +
          plan.ending
        : result.value;
  if (plan.json) JSON.parse(text.replace(/^\uFEFF/, ''));
  if (new TextEncoder().encode(text).length > MERGE_LIMITS.bytesPerVersion)
    throw new Error('合并结果超过 2 MiB，未截断，也未应用。');
  return text;
}
