import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMergePlan, resolveMerge, MERGE_LIMITS } from '../pages/public/novel-assets/merge-core.mjs';
const textPlan = (base, local, remote) => createMergePlan({ path: 'chapters/1.md', base, local, remote });
const jsonPlan = (base, local, remote) =>
  createMergePlan({
    path: 'canon.json',
    base: JSON.stringify(base),
    local: JSON.stringify(local),
    remote: JSON.stringify(remote),
  });
test('a JSON candidate merges by target type without inventing another physical file identity', () => {
  const base = { characters: [{ id: 'p', notes: '旧笔记', role: '旧角色' }] };
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.characters[0].notes = '本机修正';
  remote.characters[0].role = '另一设备修正';
  const path = 'drafts/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.md';
  const plan = createMergePlan({
    path,
    json: true,
    base: JSON.stringify(base),
    local: JSON.stringify(local, null, 2),
    remote: JSON.stringify(remote),
  });
  assert.equal(plan.json, true);
  assert.equal(plan.conflicts.length, 0);
  assert.deepEqual(JSON.parse(resolveMerge(plan)).characters[0], {
    id: 'p',
    notes: '本机修正',
    role: '另一设备修正',
  });
  const incomplete = createMergePlan({ path, json: true, base: '{}', local: '{broken', remote: '{"a":1}' });
  assert.throws(() => resolveMerge(incomplete, { 0: { source: 'local' } }));
  assert.throws(
    () => createMergePlan({ path, json: 'json', base: '{}', local: '{}', remote: '{}' }),
    /类型无效/,
  );
});
test('three-way text merge combines separate edits and preserves BOM, CRLF, emoji and missing terminal newline byte-for-byte', () => {
  const base = '\ufeff开场。\r\n保持。\r\n结尾🌧️',
    local = base.replace('开场', '本机开场'),
    remote = base.replace('结尾', '云端结尾');
  const p = textPlan(base, local, remote);
  assert.equal(p.conflicts.length, 0);
  assert.equal(resolveMerge(p), '\ufeff本机开场。\r\n保持。\r\n云端结尾🌧️');
  for (const [a, o, b, expected] of [
    ['', '', '', ''],
    [base, base, remote, remote],
    [local, base, base, local],
    [local, base, local, local],
  ])
    assert.equal(resolveMerge(textPlan(o, a, b)), expected);
});
test('overlapping text and identical-position inserts require an explicit choice, including intentional empty-text deletion', () => {
  const p = textPlan('甲\n乙\n丙\n', '甲\n本机\n丙\n', '甲\n云端\n丙\n');
  assert.equal(p.conflicts.length, 1);
  assert.throws(() => resolveMerge(p), /未处理/);
  assert.equal(resolveMerge(p, { 0: { source: 'local' } }), '甲\n本机\n丙\n');
  assert.equal(resolveMerge(p, { 0: { source: 'remote' } }), '甲\n云端\n丙\n');
  assert.equal(resolveMerge(p, { 0: { source: 'manual', text: '' } }), '甲\n丙\n');
  const same = textPlan('甲\n', '甲\n新增\n', '甲\n新增\n');
  assert.equal(same.conflicts.length, 0);
  assert.equal(resolveMerge(same), '甲\n新增\n');
});
test('JSON merge ignores formatting, preserves unknown fields and merges independent edits within stable identified arrays', () => {
  const base = {
    extension: { old: true },
    characters: [
      { id: 'p1', notes: '旧笔记', extra: { keep: true } },
      { id: 'p2', name: '姐姐' },
    ],
  };
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.characters[0].notes = '本机笔记';
  remote.characters[1].name = '云端的姐姐';
  remote.extension.new = [1, 2];
  const p = jsonPlan(base, local, remote);
  assert.equal(p.conflicts.length, 0);
  const result = JSON.parse(resolveMerge(p));
  assert.equal(result.characters[0].notes, '本机笔记');
  assert.equal(result.characters[1].name, '云端的姐姐');
  assert.deepEqual(result.extension, { old: true, new: [1, 2] });
  assert.deepEqual(result.characters[0].extra, { keep: true });
  assert.equal(base.characters[0].notes, '旧笔记');
  const bomPlan = createMergePlan({
    path: 'rules.json',
    base: '\ufeff{"a":1,"b":1}\r\n',
    local: '\ufeff{"a":2,"b":1}\r\n',
    remote: '\ufeff{\r\n"a":1,\r\n"b":2\r\n}\r\n',
  });
  const bomResult = resolveMerge(bomPlan);
  assert.ok(bomResult.startsWith('\ufeff'));
  assert.ok(bomResult.endsWith('\r\n'));
  assert.equal(bomResult.replaceAll('\r\n', '').includes('\n'), false);
  assert.deepEqual(JSON.parse(bomResult.slice(1)), { a: 2, b: 2 });
});
test('JSON delete-versus-edit remains explicit; choosing deletion differs from null or an empty string', () => {
  const p = jsonPlan({ notes: '原文', keep: true }, { notes: '本机', keep: true }, { keep: true });
  assert.equal(p.conflicts.length, 1);
  assert.equal(p.conflicts[0].remote.exists, false);
  assert.deepEqual(JSON.parse(resolveMerge(p, { 0: { source: 'remote' } })), { keep: true });
  assert.equal(JSON.parse(resolveMerge(p, { 0: { source: 'local' } })).notes, '本机');
  assert.equal(JSON.parse(resolveMerge(p, { 0: { source: 'manual', text: 'null' } })).notes, null);
});
test('array reordering, ambiguous IDs and simultaneous additions are not silently guessed or unioned', () => {
  const p = jsonPlan(
    [
      { id: 'a', n: 1 },
      { id: 'b', n: 2 },
    ],
    [
      { id: 'b', n: 2 },
      { id: 'a', n: 1 },
    ],
    [
      { id: 'a', n: 3 },
      { id: 'b', n: 2 },
    ],
  );
  assert.equal(p.conflicts.length, 1);
  assert.throws(() => resolveMerge(p), /未处理/);
  const tags = jsonPlan({ tags: ['旧'] }, { tags: ['旧', '本机'] }, { tags: ['旧', '云端'] });
  assert.equal(tags.conflicts.length, 1);
});
test('prototype-looking text and JSON keys remain plain data, not object-prototype mutations', () => {
  const base = JSON.parse('{"__proto__":{"notes":"原"},"constructor":{"keep":true}}');
  const local = structuredClone(base),
    remote = structuredClone(base);
  local.__proto__.notes = '本机';
  remote.constructor.added = true;
  const merged = JSON.parse(resolveMerge(jsonPlan(base, local, remote)));
  assert.equal(Object.hasOwn(merged, '__proto__'), true);
  assert.equal(merged.__proto__.notes, '本机');
  assert.equal(merged.constructor.added, true);
  assert.equal({}.notes, undefined);
  const p = textPlan(
    'constructor\n__proto__\n中间\ntoString',
    'constructor\n本机\n中间\ntoString',
    'constructor\n__proto__\n中间\n云端',
  );
  assert.equal(resolveMerge(p), 'constructor\n本机\n中间\n云端');
});
test('incomplete JSON stays a whole-file conflict and cannot be applied until the resolved result is valid', () => {
  const p = createMergePlan({ path: 'rules.json', base: '{}', local: '{', remote: '{"remote":true}' });
  assert.equal(p.conflicts.length, 1);
  assert.throws(() => resolveMerge(p, { 0: { source: 'local' } }), SyntaxError);
  assert.deepEqual(JSON.parse(resolveMerge(p, { 0: { source: 'manual', text: '{"both":true}' } })), {
    both: true,
  });
});
test('repetitive matching, excessive structure and oversized versions fail visibly before unbounded work or truncation', () => {
  const base = '重复\n'.repeat(1500),
    local = '本机\n' + base.slice(3),
    remote = base.slice(0, -3) + '云端\n';
  assert.throws(() => textPlan(base, local, remote), /重复文本.*预算/);
  assert.throws(() => textPlan('a'.repeat(MERGE_LIMITS.bytesPerVersion + 1), '', ''), /2 MiB/);
  assert.throws(() => textPlan(null, '', ''), /共同基线/);
  const deep = (value) => {
    for (let i = 0; i < 70; i++) value = { nested: value };
    return value;
  };
  assert.throws(() => jsonPlan(deep(0), deep(1), deep(2)), /结构复杂度.*预算/);
});

test('the deployed merge algorithm is pinned, self-contained and carries its upstream license', async () => {
  const asset = await readFile(new URL('../pages/public/novel-assets/diff3-vendor.mjs', import.meta.url));
  const lock = JSON.parse(await readFile(new URL('../tools/package-lock.json', import.meta.url), 'utf8'));
  assert.equal(lock.packages['node_modules/node-diff3'].version, '3.2.1');
  assert.equal(
    lock.packages['node_modules/node-diff3'].integrity,
    'sha512-eKZcJ8RtMQ3cIaA15EgmtwG927fYnRlhtdA4Q9HAcCpAZPQhhU2XptnTH9GeAkMiX2bAXxlJSAFa9shFbztPgw==',
  );
  assert.equal(
    createHash('sha256').update(asset).digest('hex'),
    'd2e0db3cf82c0da836c44eeeac7fcde41de35e0fc45de2b28bf9e5a1d9cefa26',
  );
  assert.match(asset.toString('utf8'), /Permission is hereby granted/);
});
test('many independent randomized line changes never discard either side', () => {
  for (let seed = 0; seed < 120; seed++) {
    const base = Array.from({ length: 40 }, (_, i) => '第 ' + i + ' 段\n'),
      local = [...base],
      remote = [...base];
    const a = seed % 15,
      b = 24 + (seed % 15);
    local[a] = '本机 ' + seed + '\n';
    remote[b] = '云端 ' + seed + '\n';
    const p = textPlan(base.join(''), local.join(''), remote.join(''));
    assert.equal(p.conflicts.length, 0);
    const result = resolveMerge(p);
    assert.ok(result.includes(local[a]) && result.includes(remote[b]));
  }
});
