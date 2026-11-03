import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCanon,
  serializeCanon,
  editCanon,
  editCanonCandidate,
  candidateRecordState,
  canonEntries,
  trustOf,
  relatedEntries,
  endpointOptions,
  endpointName,
  endpointNames,
  writingReferences,
} from '../pages/public/novel-assets/reference-core.mjs';
import { proposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';

function fixture() {
  return {
    notice: '保留原文',
    extension: { unknown: [1, 2, 3] },
    characters: [
      {
        id: 'p1',
        name: '沈澄',
        trust: 'confirmed',
        notes: '听见钟声',
        tags: ['主角'],
        customFields: { 底线: '不伤害无辜', 复杂字段: { nested: [1] } },
        unknown: { keep: true },
      },
      { id: 'p2', name: '祝余', trust: 'auto', evidence: '第二章对话', tags: ['待核实'] },
    ],
    locations: [{ id: 'l1', name: '钟楼', trust: 'manual' }],
    relations: [
      {
        id: 'r1',
        sourceType: 'character',
        sourceId: 'p1',
        targetType: 'location',
        targetId: 'l1',
        label: '居于',
        trust: 'auto',
        extra: { keep: true },
      },
    ],
  };
}
test('candidate editing reuses canon operations without confirming or replacing original author records', () => {
  const base = fixture(),
    original = structuredClone(base);
  original.items = [{ name: '银铃', trust: 'auto', extension: { keep: true } }];
  const before = structuredClone(original);
  let next = editCanonCandidate(original, { kind: 'repair-id', key: 'items:0' }, base, {
    uuid: () => 'bell',
  });
  next = editCanonCandidate(
    next,
    { kind: 'evidence', key: 'items:0', value: [{ path: 'setting.md', quote: '银铃', extension: 'keep' }] },
    base,
  );
  next = editCanonCandidate(
    next,
    { kind: 'custom', keys: ['items:0', 'characters:1'], name: '线索', value: '钟声' },
    base,
  );
  assert.equal(next.items[0].id, 'bell');
  assert.equal(next.items[0].trust, 'auto');
  assert.equal(next.items[0].customFields.线索, '钟声');
  assert.equal(next.characters[1].customFields.线索, '钟声');
  assert.equal(next.items[0].evidenceSources[0].extension, 'keep');
  assert.deepEqual(next.items[0].extension, { keep: true });
  assert.deepEqual(original, before);
  assert.deepEqual(next.characters[0], base.characters[0]);
  assert.deepEqual(next.locations[0], base.locations[0]);
  assert.throws(() => editCanonCandidate(next, { kind: 'confirm', key: 'items:0' }, base), /先收录/);
  assert.throws(
    () =>
      editCanonCandidate(next, { kind: 'field', key: 'characters:0', field: 'notes', value: '覆盖' }, base),
    /只读/,
  );
  assert.throws(() => editCanonCandidate(next, { kind: 'delete', key: 'characters:1' }, base), /不能删除/);
  assert.throws(() => editCanonCandidate(next, { kind: 'repair-id', key: 'characters:1' }, base), /不能删除/);
  assert.equal(candidateRecordState(base, canonEntries(next)[0]).locked, true);
});
test('candidate creation stays pending, supports relationships and explicit malformed-output repair', () => {
  const base = fixture();
  let next = editCanonCandidate(base, { kind: 'add', collection: 'items', name: '银铃' }, base, {
    uuid: () => 'bell',
  });
  assert.equal(next.items[0].trust, 'auto');
  assert.deepEqual(next.items[0].evidenceSources, []);
  next = editCanonCandidate(
    next,
    { kind: 'add', collection: 'relations', name: '持有', from: 'characters:0', to: 'items:0' },
    base,
    { uuid: () => 'owns' },
  );
  assert.equal(next.relations.at(-1).id, 'owns');
  assert.equal(next.relations.at(-1).targetId, 'bell');
  assert.equal(next.relations.at(-1).trust, 'auto');
  delete next.relations.at(-1).id;
  next = editCanonCandidate(next, { kind: 'repair-id', key: 'relations:1' }, base, {
    uuid: () => 'repaired',
  });
  assert.equal(next.relations[1].id, 'repaired');
  next.items[0].confirmed = true;
  next.items[0].trust = 'manual';
  next = editCanonCandidate(next, { kind: 'as-suggestion', key: 'items:0' }, base);
  assert.equal(next.items[0].trust, 'auto');
  assert.equal(Object.hasOwn(next.items[0], 'confirmed'), false);
  assert.throws(() => editCanonCandidate(next, { kind: 'repair-id', key: 'items:0' }, base), /已有标识/);
  assert.throws(() =>
    editCanonCandidate(next, { kind: 'evidence', key: 'items:0', value: [{ path: 'x', quote: {} }] }, base),
  );
  const removed = editCanonCandidate(next, { kind: 'delete', key: 'items:0' }, base);
  assert.equal(removed.items.length, 0);
  assert.deepEqual(removed.relations, base.relations);
  const bad = structuredClone(next);
  bad.relations[0].targetType = 'item';
  bad.relations[0].targetId = 'bell';
  assert.throws(() => editCanonCandidate(bad, { kind: 'delete', key: 'items:0' }, base), /挪动或删除旧资料/);
  const formal = editCanon(base, { kind: 'add', collection: 'items', name: '作者资料' });
  assert.equal(formal.items[0].trust, 'manual');
});
test('canon field edits preserve imported unknown fields, evidence, source and authority', () => {
  const original = fixture(),
    before = structuredClone(original);
  const next = editCanon(original, {
    kind: 'field',
    key: 'characters:1',
    field: 'notes',
    value: '人工补充，但尚未确认',
  });
  assert.deepEqual(original, before, 'Editing never mutates the baseline used for CAS/history.');
  assert.equal(next.characters[1].trust, 'auto');
  assert.equal(next.characters[1].evidence, '第二章对话');
  assert.deepEqual(next.characters[0], original.characters[0]);
  assert.deepEqual(next.extension, original.extension);
  assert.throws(() =>
    editCanon(original, { kind: 'field', key: 'characters:0', field: 'trust', value: 'confirmed' }),
  );
});
test('canon authority is explicit, including conflicting auto/confirmed legacy fields', () => {
  for (const item of [{ trust: 'auto' }, {}, { source: 'ai' }, { trust: 'auto', confirmed: true }])
    assert.equal(trustOf(item), 'pending');
  for (const item of [{ trust: 'manual' }, { trust: 'confirmed' }, { confirmed: true }])
    assert.equal(trustOf(item), 'confirmed');
  const next = editCanon(fixture(), { kind: 'confirm', keys: ['characters:1', 'relations:0'] });
  assert.equal(trustOf(next.characters[1]), 'confirmed');
  assert.equal(trustOf(next.relations[0]), 'confirmed');
  assert.deepEqual(next.relations[0].extra, { keep: true });
});
test('batch labels and custom fields update multiple types without replacing records or existing fields', () => {
  let next = editCanon(fixture(), {
    kind: 'tags',
    keys: ['characters:0', 'locations:0'],
    value: '钟楼，主角、钟楼',
  });
  assert.deepEqual(next.characters[0].tags, ['主角', '钟楼']);
  assert.deepEqual(next.locations[0].tags, ['钟楼', '主角']);
  next = editCanon(next, {
    kind: 'custom',
    keys: ['characters:0', 'locations:0'],
    name: '伏笔',
    value: '第三声钟',
  });
  next = editCanon(next, {
    kind: 'custom',
    keys: ['characters:0', 'locations:0'],
    name: '伏笔',
    value: '缺失的敲钟人',
    append: true,
  });
  assert.equal(next.locations[0].customFields.伏笔, '第三声钟\n缺失的敲钟人');
  assert.equal(next.characters[0].customFields.底线, '不伤害无辜');
  assert.deepEqual(next.characters[0].customFields.复杂字段, { nested: [1] });
  assert.equal(next.characters[0].trust, 'confirmed');
  next = editCanon(next, {
    kind: 'tags',
    keys: ['characters:0', 'locations:0'],
    value: '钟楼',
    remove: true,
  });
  assert.deepEqual(next.characters[0].tags, ['主角']);
});
test('custom field rename/delete is lossless and rejects collisions, blank names and incompatible records atomically', () => {
  const value = fixture(),
    before = structuredClone(value);
  const next = editCanon(value, {
    kind: 'rename-custom',
    key: 'characters:0',
    from: '复杂字段',
    name: '未知结构',
  });
  assert.deepEqual(next.characters[0].customFields.未知结构, { nested: [1] });
  assert.throws(
    () => editCanon(value, { kind: 'rename-custom', key: 'characters:0', from: '底线', name: '复杂字段' }),
    /已存在/,
  );
  assert.throws(
    () =>
      editCanon(value, { kind: 'custom', key: 'characters:0', name: '底线', value: '覆盖', addOnly: true }),
    /已存在/,
  );
  assert.throws(() => editCanon(value, { kind: 'custom', key: 'characters:0', name: '  ', value: 'x' }));
  assert.throws(
    () =>
      editCanon(value, {
        kind: 'custom',
        keys: ['locations:0', 'characters:0'],
        name: '复杂字段',
        value: 'x',
        append: true,
      }),
    /复杂字段/,
  );
  assert.deepEqual(value, before);
  const removed = editCanon(next, { kind: 'delete-custom', key: 'characters:0', name: '未知结构' });
  assert.equal(Object.hasOwn(removed.characters[0].customFields, '未知结构'), false);
  // Untrusted JSON field names must remain inert own properties.
  const special = editCanon(value, {
    kind: 'custom',
    key: 'characters:0',
    name: '__proto__',
    value: 'plain data',
  });
  assert.equal(Object.hasOwn(special.characters[0].customFields, '__proto__'), true);
  assert.equal({}.polluted, undefined);
});
test('relations support both directions and deletion removes incident links, not unrelated records', () => {
  const value = fixture();
  assert.equal(relatedEntries(value, canonEntries(value, 'characters')[0]).length, 1);
  assert.equal(relatedEntries(value, canonEntries(value, 'locations')[0]).length, 1);
  assert.equal(endpointName(value, 'character', 'p1'), '沈澄');
  const next = editCanon(
    value,
    { kind: 'add', collection: 'relations', name: '师徒', from: 'characters:0', to: 'characters:1' },
    { uuid: () => 'new-relation' },
  );
  assert.equal(next.relations[1].trust, 'manual');
  const relinked = editCanon(next, {
    kind: 'endpoint',
    key: 'relations:1',
    side: 'target',
    value: 'locations:0',
  });
  assert.equal(relinked.relations[1].targetId, 'l1');
  assert.equal(relinked.relations[1].trust, 'manual');
  const removed = editCanon(next, { kind: 'delete', keys: ['characters:0'] });
  assert.deepEqual(
    removed.characters.map((p) => p.id),
    ['p2'],
  );
  assert.equal(removed.relations.length, 0);
  assert.equal(removed.locations[0].name, '钟楼');
  assert.deepEqual(removed.extension, value.extension);
  const dup = fixture();
  dup.characters.push({ id: 'p1', name: '另一人' });
  assert.equal(
    endpointOptions(dup).some((p) => p.item.id === 'p1'),
    false,
  );
  assert.throws(() => editCanon(dup, { kind: 'delete', keys: ['characters:0'] }), /重复资料标识/);
});
test('canon parsing never silently normalizes unsupported imports and keeps BOM and unknown sections', () => {
  assert.throws(() => parseCanon('{"characters": {"沈澄": "旧记忆"}}'), /格式不兼容/);
  assert.throws(() => parseCanon('{"characters":[null]}'), /格式不兼容/);
  assert.throws(() => parseCanon('[]'));
  const source = '\ufeff' + JSON.stringify(fixture()) + '\n';
  const next = serializeCanon(
    editCanon(parseCanon(source), { kind: 'add', collection: 'organizations', name: '守钟人' }),
    source,
  );
  assert.ok(next.startsWith('\ufeff') && next.endsWith('\n'));
  assert.equal(parseCanon(next).organizations[0].trust, 'manual');
  assert.deepEqual(parseCanon(next).extension, fixture().extension);
});
test('writing and review reference the same actual files and distinguish author decisions from AI/planning', () => {
  const book = { root: '/workspace/novels/b-' + 'a'.repeat(32) };
  const documents = ['seed.md', 'canon.json', 'rules.json', 'memory.json', 'outline.json'].map((path) => ({
    path,
  }));
  const context = writingReferences(book, documents);
  assert.match(context, /rules.json/);
  const materials = JSON.parse(context).materials;
  assert.equal(
    materials.find((m) => m.path.endsWith('/canon.json')).role,
    'confirmed-records-and-ai-suggestions',
  );
  assert.equal(materials.find((m) => m.path.endsWith('/outline.json')).role, 'planned-chapters');
  assert.equal(materials.find((m) => m.path.endsWith('/memory.json')).role, 'retrieval-notes');
  assert(!materials.some((m) => m.path.endsWith('/setting.md')));
  assert.deepEqual(JSON.parse(writingReferences(book, [])).materials, []);
});
test('large canon endpoint indexing is linear and reuses constant-time labels without rescanning each relation', () => {
  let idReads = 0;
  const records = Array.from({ length: 2000 }, (_, n) => ({
    get id() {
      idReads++;
      return String(n);
    },
    name: '人物 ' + n,
  }));
  const options = endpointOptions({ characters: records });
  const nameOf = endpointNames(options);
  for (let n = 0; n < 2000; n++) assert.equal(nameOf('character', String(n)), '人物 ' + n);
  assert.ok(idReads < 2000 * 12, 'Repeated full-array identity scans must not return.');
});
