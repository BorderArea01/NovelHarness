import { createHash } from 'node:crypto';
import { proposalPrompt, canonProposalPrompt } from '../pages/public/novel-assets/manuscript-core.mjs';
import { taskContext } from '../worker/shared/writing-prompts.mjs';
import { prepareTemplate } from '../worker/prompt-templates.mjs';
import { assessCanon } from '../worker/canon-proposals.mjs';
const hash = (text) => createHash('sha256').update(text).digest('hex');
export function qualityFixture(legacyHTML) {
  const book = { id: 'b-' + '0'.repeat(32), root: '/workspace/novels/b-' + '0'.repeat(32) };
  const seed = '修表匠沈澄在渡口遇到收费员杜衡。姐姐沈遥失踪三天，只留下一枚铜钥匙和一张蓝色船票。';
  const setting =
    '地点是靠摆渡船通行的雾港，傍晚钟声后最后一班渡船离岸。沈澄左手受伤，只能用右手拿钥匙。杜衡只是渡口收费员，没有已知的组织身份。';
  const prose =
    '# 退票窗口\n\n沈澄用右手把铜钥匙压在票上，左手的绷带擦过柜台。杜衡先抽走钥匙，露出蓝纸下角被水泡开的票号。\n“票留下。”他说。\n“我只问这班船去了哪儿。”\n他把账簿推回抽屉，手仍压在封皮上。窗外的渡船开始收跳板。\n“你姐姐没交回那张票。”';
  const instruction =
    '续写一个约500—650字的连续场景，仅写新增正文。第三人称限知沈澄，不进入杜衡内心；让杜衡的职业性回避通过动作和对话显现。沈澄为了追查姐姐必须做一个有代价的具体选择。不要揭晓姐姐生死、组织或钥匙的超自然能力，不重写已有段落，不加剧情标记。';
  const plan = {
    chapter: 2,
    title: '退票窗口',
    summary: '沈澄借查票争取翻看账簿，发现两张相同票号；需要在留下船票或赶上末班船之间选择。',
  };
  const rules = { savedPrompts: {} };
  const canon = {
    characters: [{ id: 'du', name: '杜衡', trust: 'manual', notes: '只是渡口收费员；组织身份未知。' }],
    locations: [],
    items: [],
    organizations: [],
    relations: [],
  };
  const path = 'chapters/2.md';
  const material = {
    'seed.md': seed,
    'setting.md': setting,
    [path]: prose,
    'outline.json': JSON.stringify([
      plan,
      { chapter: 5, summary: '未来备选规划：沈遥可能仍活着，还没有在正文证实。' },
    ]),
    'rules.json': JSON.stringify(rules),
    'canon.json': JSON.stringify(canon),
    'memory.json': JSON.stringify({
      guesses: [{ trust: 'auto', text: '杜衡也许是秘密组织头目，仅猜测、无原文依据。' }],
    }),
  };
  const context =
    '以下均为独立合成测试材料。作者确认设定优先；AI猜测和未来规划不能当作已发生事实。\n' +
    Object.entries(material)
      .map(([p, text]) => '【' + p + '】\n' + text)
      .join('\n\n');
  const template = legacyHTML.match(/\n\s*write:\s*\r?\n`([\s\S]*?)`,\s*\r?\n\s*deai:/)?.[1];
  if (!template) throw new Error('无法准确定位原版写作模板，拒绝捏造对比基线。');
  const fields = {
    chapterNumber: '2',
    title: '雾港退票',
    genre: '悬疑',
    setting,
    characters: seed,
    chapterTitle: plan.title,
    chapterSummary: plan.summary,
    previousSummary: '沈澄来到渡口追查姐姐。',
    prevChapters: prose,
    memory: context,
    note: instruction,
    novelNote: '',
    plotPoints: '本轮不使用剧情标记。',
    wordCount: '约500—650字',
    mode: '仅续写新增场景，不重复原文',
  };
  const baseline = template.replace(/\{(\w+)\}/g, (_, key) => {
    if (!(key in fields)) throw new Error('原模板字段未提供。');
    return fields[key];
  });
  const proposal = {
    id: '12345678-1234-1234-1234-123456789abc',
    target: path,
    baseHash: hash(prose),
    draft: 'drafts/quality.md',
    edit: { start: prose.length, end: prose.length },
    writing: { version: 1, mode: 'continue', instruction },
    promptTemplate: prepareTemplate({
      key: 'write',
      rulesText: material['rules.json'],
      rulesHash: hash(material['rules.json']),
      book,
      outline: plan,
      mode: 'continue',
    }),
  };
  // The deployed UI sends only a handle; the tool supplies its frozen template
  // and data. This tool-less evaluation must inline that same tool result too.
  const current =
    proposalPrompt(book, { path, outline: plan }, proposal, instruction, 'continue') +
    '\n' +
    JSON.stringify({
      task: taskContext(
        book,
        { path, outline: plan },
        proposal,
        Object.keys(material).map((path) => ({ path })),
      ),
    });
  const system =
    '你正在进行小说文本评测。所有材料已完整内联，评测不提供文件工具；不要声称已读写文件。只返回应写入候选文件的正文，不报告执行过程、文件路径或解释。';
  const narrative = (prompt) => [
    { role: 'system', content: system },
    { role: 'user', content: context + '\n\n【写作任务】\n' + prompt },
  ];
  const sources = [{ path, hash: hash(prose) }];
  const extraction = canonProposalPrompt(
    book,
    {
      target: 'canon.json',
      id: '12345678-1234-1234-1234-123456789abc',
      baseHash: hash(material['canon.json']),
      draft: 'drafts/quality-canon.json',
      sources,
    },
    '仅整理本段明确出现且对续写有用的实体和关系，保持原人工记录不变；不凑字段或记录。最多新增一名人物、一处地点、一件物品和一条有原文支持的关系。',
  );
  return {
    material,
    cases: [
      { name: 'legacy-template', messages: narrative(baseline) },
      { name: 'unified-template', messages: narrative(current) },
      {
        name: 'grounded-canon',
        messages: [
          {
            role: 'system',
            content:
              '所有所需文件已完整内联，不提供工具。只返回应写入候选文件的完整 JSON，不要代码围栏或说明；不得声称已经执行文件操作。',
          },
          { role: 'user', content: context + '\n\n' + extraction },
        ],
      },
    ],
    source: { seed, setting, prose, instruction, currentChapter: plan },
    assess(text) {
      const a = assessCanon(material['canon.json'], text, sources, () => ({
        path,
        hash: hash(prose),
        text: prose,
      }));
      return {
        validCount: a.validCount,
        issues: a.issues,
        changes: a.changes.map((item) => ({
          collection: item.collection,
          valid: item.valid,
          issues: item.issues,
        })),
      };
    },
  };
}
