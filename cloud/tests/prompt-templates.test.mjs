import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGACY_DEFAULT_PROMPTS,
  prepareTemplate,
  compileTemplate,
  PROMPT_LABELS,
} from '../worker/prompt-templates.mjs';
import { PROMPT_LABELS as editorLabels } from '../pages/public/novel-assets/rules-core.mjs';
import { templateContext } from '../pages/public/novel-assets/prompt-context.mjs';
import { novelGateway } from '../worker/novel-gateway.mjs';
const book = { title: '钟楼', root: '/workspace/novels/b-' + 'a'.repeat(32) };
test('five revised task defaults keep V4 keys while removing contradictory style bans, scores, numeric beat quotas and array-only planning', () => {
  assert.deepEqual(Object.keys(LEGACY_DEFAULT_PROMPTS).sort(), [
    'deai',
    'ending',
    'outline',
    'outlineContinue',
    'write',
  ]);
  for (const value of Object.values(LEGACY_DEFAULT_PROMPTS)) {
    assert.doesNotMatch(
      value,
      /禁止使用破折号|绝对不要使用|directness|全篇不超过|200-300|3-6 个|不模仿特定作家|关键点标记提醒/,
    );
  }
  for (const key of ['outline', 'outlineContinue']) {
    assert.match(LEGACY_DEFAULT_PROMPTS[key], /工具协议/);
    assert.doesNotMatch(LEGACY_DEFAULT_PROMPTS[key], /从 \[ 开始|JSON 数组/);
  }
  assert.match(LEGACY_DEFAULT_PROMPTS.ending, /结束故事/);
  assert.doesNotMatch(LEGACY_DEFAULT_PROMPTS.ending, /不要完结剧情|300-600/);
  assert.match(LEGACY_DEFAULT_PROMPTS.deai, /不凭单个词或修辞判错/);
  assert.deepEqual(PROMPT_LABELS, editorLabels);
});
test('template expansion is one-pass, literal, bounded and reports unknown fields without guessing or executing values', () => {
  const value = compileTemplate('{title} {chapter} {unknown} {unknown}', {
    title: '$& {chapter}',
    chapter: 7,
  });
  assert.equal(value.body, '$& {chapter} 7 {unknown} {unknown}');
  assert.deepEqual(value.unknownFields, ['unknown']);
  assert.throws(() => compileTemplate('中'.repeat(23000), {}), /64 KiB/);
  assert.throws(() => compileTemplate('{title}', { title: '中'.repeat(45000) }), /128 KiB/);
});

test('editable prose default distinguishes manuscript development from compact chat without paragraph quotas or overriding author style', () => {
  const template = prepareTemplate({ key: 'write', book, mode: 'write' });
  assert.equal(template.source, 'default');
  for (const text of [
    '小说正文',
    '落实章纲中的事件和变化',
    '连贯展开的场景',
    '段落随语意与说话人变化',
    '局部修改不扩成整章',
    '字数只作下限',
    '叙述清楚具体',
    '含混隐喻',
    '未定细节可以创作，不改已定事实',
  ])
    assert(template.body.includes(text), text);
  const custom = '只写两句，保持纯对白。';
  assert.equal(
    prepareTemplate({ key: 'write', book, rulesText: JSON.stringify({ savedPrompts: { write: custom } }) })
      .body,
    custom,
  );
  assert(!LEGACY_DEFAULT_PROMPTS.deai.includes('完整场景'));
  assert(!LEGACY_DEFAULT_PROMPTS.outline.includes('语意完整的段落'));
});
test('author overrides take precedence, empty overrides fall back, and task-specific bindings use known facts plus native references', () => {
  const input = {
    key: 'write',
    book,
    outline: { chapter: 3, title: '账簿', summary: '比对船票', note: '不揭密', plotPoints: ['取得账簿'] },
    mode: 'continue',
  };
  const original = prepareTemplate(input);
  assert.equal(original.source, 'default');
  assert.deepEqual(original.unknownFields, []);
  assert.match(original.body, /第 3 章/);
  assert.match(original.body, /只追加新增续文/);
  assert.match(original.body, /未设置/);
  // Defaults rely on task.materials instead of repeating file references.
  // All historical placeholders remain available to the author's templates.
  const references = prepareTemplate({
    ...input,
    rulesText: JSON.stringify({
      savedPrompts: { write: '{setting}\n{characters}\n{prevChapters}\n{memory}' },
    }),
  });
  for (const path of ['setting.md', 'canon.json', 'outline.json', 'memory.json'])
    assert(references.body.includes(path), path);
  const custom = prepareTemplate({
    ...input,
    rulesText: JSON.stringify({
      project: { genre: '悬疑' },
      savedPrompts: { write: '{title}/{genre}/{chapterTitle}/{future}' },
    }),
  });
  assert.equal(custom.source, 'custom');
  assert.equal(custom.body, '钟楼/悬疑/账簿/{future}');
  assert.deepEqual(custom.unknownFields, ['future']);
  assert.equal(prepareTemplate({ ...input, rulesText: '{"savedPrompts":{"write":""}}' }).body, original.body);
  for (const rulesText of ['[]', '{"savedPrompts":[]}', '{"savedPrompts":{"write":{}}}', '{bad'])
    assert.throws(() => prepareTemplate({ ...input, rulesText }));
  for (const key of Object.keys(LEGACY_DEFAULT_PROMPTS)) {
    const t = prepareTemplate({ ...input, key, range: { start: 4, end: 6 }, rows: [{ chapter: 1 }] });
    assert.deepEqual(t.unknownFields, [], key);
    assert.ok(t.body.length);
  }
});

test('unconfigured bindings are concise data labels, not hidden full-chapter or tool-permission instructions', () => {
  const savedPrompts = { write: '{genre}|{plotPoints}|{wordCount}|{mode}' };
  const input = { key: 'write', book, mode: 'write' };
  const rulesText = JSON.stringify({ savedPrompts });
  assert.equal(
    prepareTemplate({ ...input, rulesText }).body,
    '未设置|未提供|充分展开，不设字数上限|按本次要求写作',
  );
  const configured = prepareTemplate({
    ...input,
    rulesText: JSON.stringify({ savedPrompts, project: { genre: '科幻', wordsPerChapter: 3200 } }),
    outline: { plotPoints: ['关闭气闸'] },
  });
  assert.equal(configured.body, '科幻|["关闭气闸"]|至少 3200 字，不设上限|按本次要求写作');
  const frozen = structuredClone(configured);
  prepareTemplate({ ...input, rulesText });
  assert.deepEqual(configured, frozen);
});
test('dialogue guidance belongs to the selected editable template for drafting, continuation and revision, not an extra prompt source', () => {
  for (const mode of ['write', 'continue', 'rewrite']) {
    const t = prepareTemplate({ key: 'write', book, mode });
    for (const text of [
      '彼此的回应推动事情发展',
      '人物所知、指代、数量和物件状态一致',
      '人物为了眼前的事交谈、行动',
      '段落随语意与说话人变化',
      '不逐句解释对白',
      '只交付正文',
      '不改已定事实',
    ])
      assert(t.body.includes(text), mode + ': ' + text);
    assert.equal(t.source, 'default');
    assert.deepEqual(t.unknownFields, []);
    assert(!Object.hasOwn(t, 'executionPrompt'));
  }
  const polish = prepareTemplate({ key: 'deai', book });
  for (const text of ['指代、因果、应答与动作衔接', '可重组句段', '不把润色变成梗概'])
    assert(polish.body.includes(text), text);
  assert(prepareTemplate({ key: 'ending', book }).body.includes('不强制悬念或突然反转人物立场'));
  // These are template-wiring assertions, not an automated literary judgement.
  // No blacklisted snippet, minimum sentence length or semantic regex gate.
});
test('quality default changes never append hidden guidance to author overrides or mutate frozen tasks', () => {
  for (const key of ['write', 'deai', 'ending']) {
    const custom = '保留这一段克制的短答与反讽，不解释人物故意隐瞒的事。';
    const t = prepareTemplate({ key, book, rulesText: JSON.stringify({ savedPrompts: { [key]: custom } }) });
    assert.equal(t.source, 'custom');
    assert.equal(t.body, custom);
    const frozen = JSON.parse(templateContext({ promptTemplate: t }));
    prepareTemplate({ key, book });
    assert.deepEqual(JSON.parse(templateContext({ promptTemplate: frozen.template })), frozen);
  }
});
test('clarity guidance does not turn character cards into dialogue or require action tags after each line', () => {
  for (const key of ['write', 'deai']) {
    const t = prepareTemplate({ key, book });
    assert(t.body.includes(key === 'write' ? '不宣读人设' : '宣读人设'));
    assert(t.body.includes(key === 'write' ? '不逐句解释对白' : '不逐句解释台词'));
  }
  const prose = prepareTemplate({ key: 'write', book });
  for (const text of [
    '落实章纲中的事件和变化',
    '关系和性格从相处中显现',
    '未定细节可以创作',
    '保留必要的心理',
    '数量和物件状态一致',
  ])
    assert(prose.body.includes(text), text);
  assert(prepareTemplate({ key: 'deai', book }).body.includes('可重组句段'));
});
test('prose guidance does not impose a duplicate-submission workflow, checklist, or approval gate', () => {
  const t = prepareTemplate({ key: 'write', book });
  assert(t.body.includes('保持人物所知、指代、数量和物件状态一致'));
  assert(t.body.includes('novel_proposal_submit 保存入书'));
  assert(t.body.includes('不因超出目标停写或征询'));
  for (const s of ['complete:false', 'complete:true', '先用 novel_proposal_submit', '等待作者批准'])
    assert(!t.body.includes(s), s);
  assert(!t.body.includes('行文质地示例'));
  assert(!t.body.includes('/tmp/novel-check-'));
});

test('chapter length is a minimum, never an upper-bound approval or compression rule', () => {
  const t = prepareTemplate({
    key: 'write',
    book,
    mode: 'write',
    rulesText: JSON.stringify({ project: { wordsPerChapter: 1600 } }),
  });
  assert(t.body.includes('至少 1600 字，不设上限'));
  assert(t.body.includes('字数只作下限'));
  assert(t.body.includes('不因超出目标停写或征询'));
  assert(LEGACY_DEFAULT_PROMPTS.ending.includes('不设上限'));
  assert(LEGACY_DEFAULT_PROMPTS.deai.includes('不以压缩字数为目标'));
  assert(LEGACY_DEFAULT_PROMPTS.outline.includes('ask_user_question'));
});

test('maintainer defaults stay compact without imposing limits on author templates or story materials', () => {
  // Code-maintenance budget only, never a story-length or runtime filter.
  assert(Object.values(LEGACY_DEFAULT_PROMPTS).reduce((n, text) => n + text.length, 0) <= 1150);
  assert(LEGACY_DEFAULT_PROMPTS.write.length <= 450);
  const custom = '作者自定要求\n'.repeat(1000);
  assert.equal(
    prepareTemplate({ key: 'write', book, rulesText: JSON.stringify({ savedPrompts: { write: custom } }) })
      .body,
    custom,
  );
});
test('historical tasks remain unchanged and restored formatting/score requests cannot replace the current candidate protocol', () => {
  assert.equal(templateContext({}), '');
  const promptTemplate = prepareTemplate({ key: 'deai', book });
  assert.deepEqual(JSON.parse(templateContext({ promptTemplate })).template, promptTemplate);
  assert(!Object.hasOwn(JSON.parse(templateContext({ promptTemplate })), 'executionPrompt'));
  assert.throws(() => templateContext({ promptTemplate: { version: 8 } }), /快照无效/);
});
test('default-template API requires native authentication, is read-only and returns the same server-owned defaults', async () => {
  for (const authenticated of [false, true]) {
    const native = { fetch: async () => Response.json({ authenticated }) };
    const result = await novelGateway(
      new Request('https://fixture/api/novel-prompt-templates'),
      {},
      {},
      native,
    );
    assert.equal(result.status, authenticated ? 200 : 401);
    if (authenticated) assert.deepEqual((await result.json()).defaults, LEGACY_DEFAULT_PROMPTS);
    const write = await novelGateway(
      new Request('https://fixture/api/novel-prompt-templates', { method: 'POST' }),
      {},
      {},
      native,
    );
    assert.equal(write.status, authenticated ? 405 : 401);
  }
});
