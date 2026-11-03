/* global Store, state, toast, DEFAULT_PROMPTS */
/* Canvas-first creative workflow layered onto the legacy AI workbench. */
(() => {
  const upgradeBuiltInPrompts = () => {
    if (typeof DEFAULT_PROMPTS !== 'object' || !DEFAULT_PROMPTS) return;

    const outlineQualityMarker = '【长篇结构质量要求】';
    const outlineFormatMarker = '请按以下 JSON 格式输出，不要包含其他说明文字：';
    if (
      typeof DEFAULT_PROMPTS.outline === 'string' &&
      !DEFAULT_PROMPTS.outline.includes(outlineQualityMarker)
    ) {
      const qualityBrief = [
        outlineQualityMarker,
        '- 让本作独有的世界规则、人物关系或社会矛盾真正驱动事件；不要只把专有名词贴在可套用的通用剧情模板上。设定不充分时不冒充既定事实。',
        '- 每章围绕具体目标、阻力、人物选择和局势变化展开；相邻章节要有因果承接，前一章的结果必须改变后续选择。章节功能与节奏要有变化，避免重复“发现线索—受阻—他人解围”。',
        '- 逐章比较叙事功能与章末状态：人物新知道、失去、决定、欠下或冒险的东西是什么；同一母题可以回环，但事件、选择或结果不能只是换词重讲。',
        '- 每章概要内部不重复同一句或换词重述同一因果来凑篇幅；需要扩展时补充新的行动、阻力、选择、证据或后果。',
        '- 让读者能说出这部作品独有的戏剧承诺，并让关键揭示兑现已有铺垫；升级应改变冲突机制、人物策略或代价，不只是换一个更强的对手。',
        '- 让人物弧光和关系变化由选择与代价累积；伏笔要有可追溯的铺垫，揭示要改变人物判断或行动。反转、升级和章末悬念都服务于故事，不为刺激而硬加。',
        '- 关键剧情点必须是可写、会改变信息/关系/资源/处境的事件；不以主题句、情绪结论或重复摘要凑数。遵守作者设定、视角与题材承诺，不套固定幕数或套路。',
      ].join('\n');
      DEFAULT_PROMPTS.outline = DEFAULT_PROMPTS.outline.replace(
        outlineFormatMarker,
        `${qualityBrief}\n\n${outlineFormatMarker}`,
      );
    }

    const writeMarker = '【场景推进与作者声音】';
    if (typeof DEFAULT_PROMPTS.write === 'string' && !DEFAULT_PROMPTS.write.includes(writeMarker)) {
      const legacyStyleStart = DEFAULT_PROMPTS.write.indexOf('【⚠️ 严格避免以下 AI 写作痕迹】');
      const expressionPrinciplesStart = DEFAULT_PROMPTS.write.indexOf('【表达原则】');
      const qualityBlockStart = legacyStyleStart >= 0 ? legacyStyleStart : expressionPrinciplesStart;
      const plotMarkerStart = DEFAULT_PROMPTS.write.indexOf('【🎯 关键点标记提醒】', qualityBlockStart);
      if (qualityBlockStart >= 0 && plotMarkerStart > qualityBlockStart) {
        const qualityBrief = [
          writeMarker,
          '- 让读者身处具体场景：角色此刻想做什么、被什么挡住、采取什么行动，场面因此发生什么变化。关键事件要实际演出来，不把冲突、发现或关系转折一笔概述。',
          '- 选择能影响行动、判断或氛围的细节，不堆感官清单和形容词。对白呈现人物各自的目的、关系与说话节奏，不替作者复述已知设定。',
          '- 关键场景要把本作独有的人物关系、规则或物件落实到具体选择与后果；同一信息再次出现，须带来新含义、新决定或新代价，否则删改。',
          '- 情绪变化要有言行和处境上的依据；句长、段落和场景节奏随内容变化。不要求每一场都升级冲突，也不强迫每章都用反转或悬崖式钩子收尾。',
          '- 避免重复、空泛解释、套路化场面和拿掉专有设定仍能套用的段落。尊重作者指定的视角、文风、资料与明确禁用项。',
          '',
          '【语言质量】',
          '避免的是词语、句式和段落结构的机械重复，不是某个词或标点单独出现。不要执行通用词语黑名单，不要为躲避某一种句式而扭曲自然中文；只有作者明确提出的禁用项才是硬约束。',
        ].join('\n');
        DEFAULT_PROMPTS.write =
          DEFAULT_PROMPTS.write.slice(0, qualityBlockStart) +
          qualityBrief +
          '\n\n' +
          DEFAULT_PROMPTS.write.slice(plotMarkerStart);
      }
    }

    const continueQualityMarker = '【续写质量要求】';
    if (
      typeof DEFAULT_PROMPTS.outlineContinue === 'string' &&
      !DEFAULT_PROMPTS.outlineContinue.includes(continueQualityMarker)
    ) {
      DEFAULT_PROMPTS.outlineContinue += [
        '',
        continueQualityMarker,
        '从已有大纲最后一章的事实、人物状态和未解压力继续；不复述已发生事件，不把尚未确认的推测写成正史。新增章节要兑现、扭转或加深已有伏笔，并让每次选择改变下一步的处境。节奏按故事自然变化，避免重复使用相同的线索发现、误会和解围结构。',
      ].join('\n');
    }

    const endingMarker = '【章节结尾收束要求】';
    if (typeof DEFAULT_PROMPTS.ending === 'string' && !DEFAULT_PROMPTS.ending.includes(endingMarker)) {
      const rigidStyleRule =
        '5. 避免使用破折号「——」、避免「不是……而是」句式、减少「然而」「但是」等转折词或递进关系';
      DEFAULT_PROMPTS.ending = DEFAULT_PROMPTS.ending.replace(
        rigidStyleRule,
        '5. 避免重复转折、空泛总结和刻意煽情；结尾可以安静，也可以留有压力，但不要为了悬念强行反转。',
      );
      DEFAULT_PROMPTS.ending += [
        '',
        endingMarker,
        '让结尾从本章已经发生的行动与情绪自然落下，为读者留下一个具体的余韵、局势变化或未解压力。不要复述本章，不要补进新的主线事实，不替作者解决核心冲突。尊重作者明确的禁用项；其余词语和标点按人物声音与语境自然使用，不套固定的悬念句式。',
      ].join('\n');
    }
  };

  upgradeBuiltInPrompts();

  const stages = [
    {
      id: 'premise',
      tab: 'project',
      icon: '✦',
      title: '故事起点',
      focus: 'novelSetting',
      kind: 'core',
    },
    {
      id: 'bible',
      tab: 'service-bible',
      icon: '◈',
      title: '人物与世界',
      focus: 'workbenchBibleFreeText',
    },
    {
      id: 'outline',
      tab: 'outline',
      icon: '☷',
      title: '故事结构',
      focus: 'btnGenOutline',
      kind: 'core',
    },
    {
      id: 'draft',
      tab: 'write',
      icon: '⌁',
      title: '章节写作',
      focus: 'chapterEditor',
      kind: 'core',
    },
    {
      id: 'revise',
      tab: 'editor',
      icon: '✎',
      title: '编辑与审阅',
      focus: 'editorAgentInput',
      kind: 'core',
    },
    {
      id: 'publish',
      tab: 'export',
      icon: '↗',
      title: '整理与发布',
      kind: 'core',
    },
    {
      id: 'spark',
      tab: 'chat',
      icon: '✧',
      title: '灵感共创',
      focus: 'chatInput',
    },
  ];
  const canvasStageModelRoutes = {
    premise: 'outline',
    bible: 'outline',
    outline: 'outline',
    draft: 'chapter',
    revise: 'editing',
    publish: 'editing',
    spark: 'outline',
  };
  const seeds = [
    '如果主角最想守住的东西，恰好是引爆这场危机的原因呢？',
    '一个人人都相信的世界规则，可能被谁、用什么代价打破？',
    '让对手先做一件读者完全赞同的事，故事会因此变成什么样？',
    '多年后，主角会怎样误解今天的自己？把这个误解埋进第一章。',
    '如果胜利必须让主角失去一段重要关系，他还会选择赢吗？',
    '找一个不起眼的日常物件，让它在故事中三次改变含义。',
  ];
  const STORY_ENGINE_QUALITY_CONTRACT = 'story-engine-v1';
  const STORY_ENGINE_SECTIONS = [
    { label: '读者承诺 / 核心戏剧问题', minimum: 28 },
    { label: '主角欲望 / 错误信念 / 代价', minimum: 28 },
    { label: '对抗力量的目标与策略', minimum: 28 },
    { label: '作品独有的因果机制', minimum: 28 },
    { label: '三段升级链', minimum: 72 },
    { label: '开篇场景与长线承诺', minimum: 32 },
  ];
  const normalizeStoryEngineHeading = (value) =>
    String(value || '')
      .normalize('NFKC')
      .replace(/[^\p{L}\p{N}]/gu, '');
  const analyzeStoryEngineArtifact = (value) => {
    const lines = String(value || '').split(/\r?\n/u);
    const required = new Map(
      STORY_ENGINE_SECTIONS.map((section) => [normalizeStoryEngineHeading(section.label), section]),
    );
    const headings = [];
    lines.forEach((line, index) => {
      const match = line.match(/^\s*(?:(?:[1-6]|[一二三四五六])[.、)）．｜|]\s*)?【([^】]+)】\s*(.*)$/u);
      if (!match) return;
      const section = required.get(normalizeStoryEngineHeading(match[1]));
      if (section) headings.push({ section, lineIndex: index, inlineContent: match[2] || '' });
    });

    const issues = [];
    for (const section of STORY_ENGINE_SECTIONS) {
      const heading = headings.find((item) => item.section === section);
      if (!heading) {
        issues.push(`缺少必需分节「${section.label}」。`);
        continue;
      }
      const nextHeading = headings.find((item) => item.lineIndex > heading.lineIndex);
      const content = [
        heading.inlineContent,
        ...lines.slice(heading.lineIndex + 1, nextHeading?.lineIndex ?? lines.length),
      ]
        .join('\n')
        .trim();
      const length = Array.from(content.replace(/\s/gu, '')).length;
      if (length < section.minimum)
        issues.push(`「${section.label}」过于简略（${length} 字，至少 ${section.minimum} 字）。`);
      if (section.label === '三段升级链') {
        const beats = content
          .split(/\r?\n/u)
          .filter((line) => /^\s*(?:[1-3][.、)）．｜|]|第[一二三123]段)/u.test(line));
        if (beats.length !== 3)
          issues.push(
            `「三段升级链」需恰好写出编号 1、2、3 的三个因果递进段，当前检测到 ${beats.length} 段。`,
          );
      }
    }
    return issues;
  };
  const projectId = new URLSearchParams(location.search).get('project') || 'local';
  const cameraKey = `novel-writer-ui:${projectId}:creative-canvas-camera`;
  const worldSize = { width: 6000, height: 4000 };
  let flowPage = null;
  let announce = null;
  let canvasViewport = null;
  let canvasWorld = null;
  let canvasSvg = null;
  let canvasCamera = { x: 16, y: 16, scale: 0.8 };
  let canvasGesture = null;
  let canvasConnectPreview = null;
  const activeTouches = new Map();
  let connectMode = false;
  let connectSourceId = null;
  let selectedEdgeId = null;
  let suppressCanvasClickUntil = 0;
  let noteSaveTimer = null;
  const pendingCanvasBranches = new Map();
  let canvasNeedsFit = false;
  let pendingCanvasBrainstorm = null;
  let activeCanvasBrainstorm = null;
  let activeCanvasGenerationRequest = null;
  let activeMainQualityRequest = null;
  let canvasOutlineRequest = null;
  let canvasOutlineProposal = null;
  let pendingSnapshotComparison = null;
  let canvasContextTargetOverride = null;

  const defaultStagePositions = {
    premise: { x: 80, y: 350 },
    bible: { x: 410, y: 55 },
    outline: { x: 420, y: 350 },
    spark: { x: 770, y: 55 },
    draft: { x: 760, y: 350 },
    revise: { x: 1100, y: 210 },
    publish: { x: 1100, y: 590 },
  };
  const legacyStarterEdges = [
    ['edge:default:0', 'stage:premise', 'stage:outline', 'main'],
    ['edge:default:1', 'stage:outline', 'stage:draft', 'main'],
    ['edge:default:2', 'stage:draft', 'stage:revise', 'main'],
    ['edge:default:3', 'stage:revise', 'stage:publish', 'main'],
    ['edge:default:4', 'stage:bible', 'stage:outline', 'reference'],
    ['edge:default:5', 'stage:spark', 'stage:outline', 'reference'],
    ['edge:default:6', 'stage:spark', 'stage:draft', 'reference'],
  ];
  let legacyStarterWasHidden = false;

  const isUntouchedLegacyStarter = (model) => {
    const stageNodes = model.nodes.filter((node) => node.kind === 'stage');
    if (model.legacyStarterReviewed) return false;
    if (stageNodes.length !== stages.length) return false;
    if (model.hiddenStageIds.length) return false;
    const nodesById = new Map(stageNodes.map((node) => [node.id, node]));
    const hasDefaultPositions = stages.every((stage) => {
      const node = nodesById.get(`stage:${stage.id}`);
      const position = defaultStagePositions[stage.id];
      return node && node.x === position.x && node.y === position.y;
    });
    const defaultEdgeIds = new Set(legacyStarterEdges.map(([id]) => id));
    const hasDefaultEdges = legacyStarterEdges.every(([id, from, to, kind]) =>
      model.edges.some(
        (edge) => edge.id === id && edge.from === from && edge.to === to && edge.kind === kind,
      ),
    );
    const hasCustomStageLinks = model.edges.some(
      (edge) => !defaultEdgeIds.has(edge.id) && (nodesById.has(edge.from) || nodesById.has(edge.to)),
    );
    return hasDefaultPositions && hasDefaultEdges && !hasCustomStageLinks;
  };

  const canvasModel = () => {
    state.uiDrafts = state.uiDrafts || {};
    let model = state.uiDrafts.creativeCanvas;
    if (!model || model.version !== 1 || !Array.isArray(model.nodes) || !Array.isArray(model.edges)) {
      model = {
        version: 1,
        nodes: [],
        edges: [],
        hiddenStageIds: [],
        arcPositions: {},
      };
      state.uiDrafts.creativeCanvas = model;
    }
    if (!model.arcPositions || typeof model.arcPositions !== 'object' || Array.isArray(model.arcPositions)) {
      model.arcPositions = {};
    }
    const knownStageIds = new Set(stages.map((stage) => `stage:${stage.id}`));
    const knownStageKeys = new Set(stages.map((stage) => stage.id));
    model.hiddenStageIds = Array.isArray(model.hiddenStageIds)
      ? [...new Set(model.hiddenStageIds.filter((stageId) => knownStageKeys.has(stageId)))]
      : [];
    const retainedNodeIds = new Set();
    model.nodes = model.nodes.filter((node) => {
      if (!node || typeof node.id !== 'string' || !node.id.trim()) return false;
      const isKnownStage = knownStageIds.has(node.id);
      if ((isKnownStage && node.kind !== 'stage') || (!isKnownStage && node.kind === 'stage')) return false;
      if (retainedNodeIds.has(node.id)) return false;
      retainedNodeIds.add(node.id);
      return true;
    });
    if (isUntouchedLegacyStarter(model)) {
      model.hiddenStageIds = stages.map((stage) => stage.id);
      legacyStarterWasHidden = true;
      canvasNeedsFit = true;
    }
    const validNodeIds = new Set(model.nodes.map((node) => node.id));
    model.edges = model.edges.filter(
      (edge) => edge && validNodeIds.has(edge.from) && validNodeIds.has(edge.to),
    );
    return model;
  };

  const saveCamera = () => {
    try {
      localStorage.setItem(cameraKey, JSON.stringify(canvasCamera));
    } catch {
      // The canvas remains usable when browser storage is unavailable.
    }
  };

  const loadCamera = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(cameraKey) || 'null');
      if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y) && Number.isFinite(saved.scale)) {
        canvasCamera = { x: saved.x, y: saved.y, scale: Math.min(1.8, Math.max(0.08, saved.scale)) };
        return true;
      }
    } catch {
      // Start with a useful view if saved camera data is unavailable.
    }
    return false;
  };

  const hasBibleContent = () => {
    const bundle = globalThis.storyBibleBundle || {};
    return Boolean(
      String(state.storyBibleFreeText || state.project?.characters || '').trim() ||
      ['characters', 'locations', 'items', 'organizations', 'relations'].some(
        (key) => (bundle[key] || []).length,
      ),
    );
  };

  const chapterStats = () => {
    const chapters = (state.chapters || []).filter((chapter) => String(chapter.content || '').trim());
    const words = chapters.reduce(
      (sum, chapter) => sum + String(chapter.content || '').replace(/\s/g, '').length,
      0,
    );
    return { count: chapters.length, words };
  };

  const getNextWritingChapter = () => {
    const written = new Set(
      (state.chapters || [])
        .filter((chapter) => String(chapter.content || '').trim())
        .map((chapter) => Number(chapter.chapter))
        .filter((chapter) => Number.isInteger(chapter) && chapter > 0),
    );
    const outlined = (state.outline || [])
      .map((chapter, index) => {
        const number = Number(chapter.chapter);
        return Number.isInteger(number) && number > 0 ? number : index + 1;
      })
      .filter((chapter, index, all) => all.indexOf(chapter) === index)
      .sort((left, right) => left - right);
    const targetCount = Math.max(1, Math.floor(Number(state.project?.chapterCount) || 24));
    const chapterLimit = Math.max(targetCount, outlined.at(-1) || 0);
    const candidates = Array.from({ length: chapterLimit }, (_, index) => index + 1);
    return (
      candidates.find((chapter) => !written.has(chapter)) ||
      Number(state.currentChapter) ||
      candidates.at(-1) ||
      1
    );
  };

  const stageState = (stage) => {
    const chapters = chapterStats();
    const outlineCount = (state.outline || []).length;
    const reviews = state.reviewReports && Object.keys(state.reviewReports).length;
    const hasAgentWork = (state.agentEditHistory || []).length > 0 || reviews;
    const projectReady = Boolean(
      String(state.project?.title || '').trim() &&
      state.project?.title !== '无题' &&
      String(state.project?.setting || '').trim(),
    );
    const result = {
      premise: projectReady ? '完成' : '待开始',
      bible: hasBibleContent() ? '已整理' : '可选',
      outline: outlineCount ? `${outlineCount} 章` : '待生成',
      draft: chapters.count ? `${chapters.count} 章 · ${chapters.words.toLocaleString()} 字` : '待写作',
      revise: hasAgentWork ? '已有修改' : chapters.count ? '可以开始' : '待写作',
      publish: chapters.count ? '可以导出' : '待有正文',
      spark: '',
    };
    return result[stage.id];
  };

  const openStage = (stageId) => {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) return;
    globalThis.switchTab(stage.tab);
    if (
      stage.id === 'draft' &&
      !state.generating &&
      Number(state.currentChapter) !== getNextWritingChapter() &&
      typeof globalThis.navChapter === 'function'
    ) {
      globalThis.navChapter(getNextWritingChapter() - Number(state.currentChapter || 0));
    }
    if (stage.focus) requestAnimationFrame(() => document.getElementById(stage.focus)?.focus());
  };

  const canvasStepNextStage = (stepId) => {
    const model = canvasModel();
    const nodeIds = new Set(model.edges.filter((edge) => edge.from === stepId).map((edge) => edge.to));
    return model.nodes.find((node) => node.kind === 'stage' && nodeIds.has(node.id)) || null;
  };

  const canvasStepHandoffLabel = (step) => {
    const outputState = step ? canvasStepOutputState(step) : { status: 'missing' };
    if (!step || outputState.status !== 'ready') return '';
    const target = canvasStepNextStage(step.id);
    const stage = target ? stages.find((item) => item.id === target.stageId) : null;
    if (!stage) return '';
    if (stage.id === 'outline') return '生成大纲';
    if (stage.id === 'draft') return `写第${getNextWritingChapter()}章`;
    if (stage.id === 'revise') return '打开审阅';
    return `进入${stage.title}`;
  };

  const runCanvasStepHandoff = (stepId) => {
    const step = canvasModel().nodes.find((node) => node.id === stepId && node.kind === 'step');
    const target = canvasStepNextStage(stepId);
    if (!step || !target) return;
    const freshness = canvasStepOutputState(step).status;
    if (freshness !== 'ready') {
      if (typeof toast === 'function') toast('先完成这一步；过期成果不会推进到下游。');
      return;
    }
    const stage = stages.find((item) => item.id === target.stageId);
    if (!stage) return;
    if (stage.id === 'outline' && (state.outline || []).length) {
      if (!window.confirm('当前已有大纲；生成新大纲会替换当前大纲，确定继续吗？')) return;
    }
    if (stage.id === 'draft') {
      const chapter = getNextWritingChapter();
      const existing = (state.chapters || []).find(
        (item) => Number(item.chapter) === Number(chapter) && String(item.content || '').trim(),
      );
      if (existing && !window.confirm(`第${chapter}章已有正文；重新生成会替换它，确定继续吗？`)) return;
    }
    openStage(stage.id);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (stage.id === 'outline') globalThis.generateOutline?.();
        else if (stage.id === 'draft') globalThis.generateChapter?.();
        else if (announce) announce.textContent = `已打开「${stage.title}」，成果沿连线保留在上下文中。`;
      });
    });
  };

  const openChapterFromCanvas = (chapterNumber) => {
    const chapter = Math.max(1, Math.floor(Number(chapterNumber) || 1));
    globalThis.switchTab('write');
    const delta = chapter - Number(state.currentChapter || 0);
    if (delta && typeof globalThis.navChapter === 'function') globalThis.navChapter(delta);
    requestAnimationFrame(() => document.getElementById('chapterEditor')?.focus());
  };

  const escapeHtml = (value) =>
    String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          '&': '&amp;',
          '<': '&lt;',
          '>': '&gt;',
          '"': '&quot;',
          "'": '&#39;',
        })[character],
    );

  const persistCreativeInbox = async () => {
    if (typeof globalThis.syncAllEditableStateFromUI === 'function') globalThis.syncAllEditableStateFromUI();
    await Store.save();
    refreshWorkflow();
  };

  const inbox = () => {
    state.uiDrafts = state.uiDrafts || {};
    state.uiDrafts.creativeInbox = Array.isArray(state.uiDrafts.creativeInbox)
      ? state.uiDrafts.creativeInbox
      : [];
    return state.uiDrafts.creativeInbox;
  };

  const renderInbox = () => {
    if (!flowPage) return;
    const list = flowPage.querySelector('#creativeInboxList');
    const items = inbox();
    flowPage.querySelector('#creativeInboxCount').textContent = String(items.length);
    if (!items.length) {
      list.innerHTML = '';
      return;
    }
    list.innerHTML = items
      .map(
        (item) => `<article class="creative-idea-card" data-idea-id="${escapeHtml(item.id)}">
          <p>${escapeHtml(item.text)}</p>
          <div class="creative-idea-actions"><button type="button" class="creative-idea-chat" data-idea-id="${escapeHtml(item.id)}">AI 推演</button><button type="button" class="creative-idea-archive" data-idea-id="${escapeHtml(item.id)}" aria-label="收起灵感" title="收起">×</button></div>
        </article>`,
      )
      .join('');
  };

  const moveNode = (container, node, direction) => {
    const siblings = [...container.querySelectorAll(':scope > [data-sort-item]')];
    const index = siblings.indexOf(node);
    const nextIndex = Math.max(0, Math.min(siblings.length - 1, index + direction));
    if (index < 0 || index === nextIndex) return false;
    const reference = siblings[nextIndex];
    container.insertBefore(node, direction < 0 ? reference : reference.nextSibling);
    return true;
  };

  const attachPointerSort = (container, options) => {
    if (!container || container.dataset.pointerSortReady) return;
    container.dataset.pointerSortReady = 'true';
    const { itemSelector, handleSelector, onCommit, axis = 'y' } = options;
    let session = null;

    const finish = (didCancel = false) => {
      if (!session) return;
      const { item, placeholder, captureTarget, pointerId, moved, originalIndex } = session;
      if (pointerId !== undefined && captureTarget.hasPointerCapture?.(pointerId))
        captureTarget.releasePointerCapture(pointerId);
      item.classList.remove('creative-is-dragging');
      item.style.position = '';
      item.style.left = '';
      item.style.top = '';
      item.style.width = '';
      item.style.height = '';
      item.style.zIndex = '';
      item.style.pointerEvents = '';
      if (didCancel) {
        placeholder.remove();
        const siblings = [...container.querySelectorAll(itemSelector)].filter((node) => node !== item);
        container.insertBefore(item, siblings[originalIndex] || null);
      } else if (placeholder.isConnected) {
        placeholder.replaceWith(item);
      }
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', cancel);
      session = null;
      if (!didCancel && moved) onCommit();
    };

    const move = (event) => {
      if (!session) return;
      if (event.cancelable) event.preventDefault();
      const { item, placeholder, offsetX, offsetY } = session;
      if (Math.abs(event.clientX - session.startX) + Math.abs(event.clientY - session.startY) > 4)
        session.moved = true;
      item.style.left = `${event.clientX - offsetX}px`;
      item.style.top = `${event.clientY - offsetY}px`;
      if (!session.moved) return;
      const scrollEdge = 54;
      if (event.clientY < scrollEdge) window.scrollBy(0, -14);
      else if (event.clientY > window.innerHeight - scrollEdge) window.scrollBy(0, 14);
      const containerRect = container.getBoundingClientRect();
      if (container.scrollHeight > container.clientHeight) {
        if (event.clientY < containerRect.top + scrollEdge) container.scrollTop -= 12;
        else if (event.clientY > containerRect.bottom - scrollEdge) container.scrollTop += 12;
      }
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest(itemSelector);
      if (!target || target === item || !container.contains(target)) return;
      const rect = target.getBoundingClientRect();
      const computedStyle = getComputedStyle(container);
      const columns =
        computedStyle.display === 'grid' ? computedStyle.gridTemplateColumns.split(' ').length : 1;
      const isMultiColumnGrid = axis === 'grid' && columns > 1;
      const verticalOffset = event.clientY - (rect.top + rect.height / 2);
      const before =
        isMultiColumnGrid && Math.abs(verticalOffset) < 8
          ? event.clientX < rect.left + rect.width / 2
          : verticalOffset < 0;
      const marker = before ? target : target.nextElementSibling;
      if (marker !== placeholder && marker !== item) container.insertBefore(placeholder, marker);
    };

    const end = () => finish(false);
    const cancel = () => finish(true);

    container.addEventListener('pointerdown', (event) => {
      if (event.button !== undefined && event.button !== 0) return;
      const handle = event.target.closest(handleSelector);
      const item = handle?.closest(itemSelector);
      if (!item || !container.contains(item) || item.classList.contains('creative-is-dragging')) return;
      event.preventDefault();
      const rect = item.getBoundingClientRect();
      const originalIndex = [...container.querySelectorAll(itemSelector)].indexOf(item);
      const placeholder = document.createElement(item.tagName.toLowerCase());
      placeholder.className = 'creative-sort-placeholder';
      placeholder.setAttribute('aria-hidden', 'true');
      placeholder.style.width = `${rect.width}px`;
      placeholder.style.height = `${rect.height}px`;
      item.before(placeholder);
      session = {
        item,
        placeholder,
        captureTarget: handle,
        pointerId: event.pointerId,
        originalIndex,
        startX: event.clientX,
        startY: event.clientY,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        moved: false,
      };
      item.classList.add('creative-is-dragging');
      item.style.position = 'fixed';
      item.style.left = `${rect.left}px`;
      item.style.top = `${rect.top}px`;
      item.style.width = `${rect.width}px`;
      item.style.height = `${rect.height}px`;
      item.style.zIndex = '999';
      item.style.pointerEvents = 'none';
      window.addEventListener('pointermove', move, { passive: false });
      window.addEventListener('pointerup', end, { once: true });
      window.addEventListener('pointercancel', cancel, { once: true });
      try {
        handle.setPointerCapture(event.pointerId);
      } catch {
        // Pointer capture is an enhancement; window-level listeners provide the fallback.
      }
    });
  };

  const installNavigation = () => {
    const tabBar = document.getElementById('tabBar');
    if (!tabBar) return;
    const onboarding = document.getElementById('onboardingModal');
    if (onboarding) {
      const heading = onboarding.querySelector('.modal h2');
      const description = onboarding.querySelector('.modal > p');
      if (heading) heading.textContent = '从画布开始';
      if (description) description.textContent = '双击建便笺，拖线连思路。';
      onboarding.querySelector('.guide-steps')?.remove();
    }
    document.querySelector('button[onclick="requestOnboardingOnNextReload()"]')?.remove();
    const flowTab = document.createElement('button');
    flowTab.type = 'button';
    flowTab.id = 'creativeWorkflowTab';
    flowTab.className = 'tab-btn';
    flowTab.dataset.tab = 'creative-flow';
    flowTab.setAttribute('aria-label', '创作流程');
    flowTab.addEventListener('click', () => globalThis.switchTab('creative-flow'));

    const page = document.createElement('section');
    page.id = 'tab-creative-flow';
    page.className = 'tab-content creative-workflow-page';
    page.style.display = 'none';
    page.innerHTML = `<div class="creative-workflow-shell">
      <header class="creative-map-header">
        <h2 id="creativeHeroTitle">新故事</h2>
      </header>
      <section class="creative-canvas-section">
        <div class="creative-canvas-frame">
          <div id="creativeCanvasViewport" class="creative-canvas-viewport" role="application" aria-label="可平移缩放的小说创作画布">
            <div id="creativeCanvasWorld" class="creative-canvas-world"><svg id="creativeCanvasEdges" class="creative-canvas-edges" aria-label="创作关系连线"></svg><div id="creativeCanvasNodes" class="creative-canvas-nodes"></div></div>
            <div id="creativeCanvasEmpty" class="creative-canvas-empty">
              <div class="creative-canvas-empty-card">
                <h3>从一个念头开始</h3>
                <p class="creative-canvas-empty-route">故事引擎 → 大纲 → 正文 → 审阅 · 也可以先玩一局分支实验</p>
                <div class="creative-canvas-empty-actions">
                  <button type="button" data-canvas-action="starter-path">布置高质量起步路径</button>
                  <button type="button" data-canvas-action="add-experiment">开一个玩法实验</button>
                  <button type="button" data-canvas-action="add-note">写下灵感</button>
                  <button type="button" data-canvas-action="prompt">随机灵感</button>
                </div>
              </div>
            </div>
            <div class="creative-canvas-toolbar" role="toolbar" aria-label="画布工具">
              <button type="button" data-canvas-action="zoom-out" aria-label="缩小画布" title="缩小">−</button><span id="creativeCanvasZoom" aria-live="polite">100%</span><button type="button" data-canvas-action="zoom-in" aria-label="放大画布" title="放大">＋</button>
              <span class="creative-canvas-toolbar-divider"></span><button type="button" data-canvas-action="fit" aria-label="显示全部节点" title="显示全图">⤢</button><button type="button" data-canvas-action="toggle-add-menu" aria-label="添加节点" aria-expanded="false" title="添加或恢复节点">＋</button><button type="button" data-canvas-action="delete-edge" aria-label="删除选中连线" title="删除连线" hidden>×</button>
            </div>
            <div id="creativeCanvasAddMenu" class="creative-canvas-add-menu" role="menu" aria-label="添加到画布" hidden></div>
            <div id="creativeCanvasHint" class="creative-sr-only" aria-live="polite"></div>
          </div>
        </div>
      </section>
      <details id="creativeInboxTray" class="creative-idea-tray"><summary>灵感 <span id="creativeInboxCount">0</span><span class="creative-idea-tray-indicator" aria-hidden="true">＋</span></summary><div class="creative-idea-tray-body"><form id="creativeInboxForm"><label class="creative-sr-only" for="creativeInboxInput">记录灵感</label><textarea id="creativeInboxInput" rows="1" placeholder="记一句，之后再决定它去哪……"></textarea><button class="creative-inbox-add" type="submit" aria-label="保存灵感">＋</button></form><div id="creativeInboxList" class="creative-inbox-list"></div></div></details>
    </div>`;
    flowPage = page;
    announce = document.createElement('div');
    announce.id = 'creativeSortGlobalAnnouncement';
    announce.className = 'creative-sr-only';
    announce.setAttribute('role', 'status');
    announce.setAttribute('aria-live', 'polite');
    document.body.append(announce);

    const tabs = [...tabBar.querySelectorAll('.tab-btn')];
    const byId = new Map(tabs.map((button) => [button.dataset.tab, button]));
    byId.set('creative-flow', flowTab);
    const primaryTabs = ['creative-flow', 'project', 'service-bible', 'outline', 'write'];
    tabBar.replaceChildren();
    for (const id of primaryTabs) {
      const button = byId.get(id);
      if (!button) continue;
      const meta = {
        'creative-flow': ['✦', '创作流程'],
        project: ['◉', '故事设定'],
        'service-bible': ['◈', '人物与世界'],
        outline: ['☷', '章节大纲'],
        write: ['⌁', '章节写作'],
      }[id];
      const badge = button.querySelector('#chBadge');
      button.replaceChildren();
      const icon = document.createElement('span');
      icon.className = 'studio-nav-icon';
      icon.textContent = meta[0];
      const text = document.createElement('span');
      text.className = 'studio-nav-text';
      text.textContent = meta[1];
      button.append(icon, text);
      if (badge) button.append(badge);
      button.setAttribute('aria-label', meta[1]);
      tabBar.append(button);
    }
    tabBar.setAttribute('role', 'navigation');
    tabBar.setAttribute('aria-label', '创作工作区');
    const nativeSwitchTab = globalThis.switchTab;
    if (typeof nativeSwitchTab === 'function' && !nativeSwitchTab.creativeStageWrapped) {
      const wrappedSwitchTab = function (tab, ...args) {
        const result = nativeSwitchTab.call(this, tab, ...args);
        if (['chat', 'editor', 'export'].includes(tab))
          tabBar.querySelector('[data-tab="creative-flow"]')?.classList.add('active');
        return result;
      };
      wrappedSwitchTab.creativeStageWrapped = true;
      globalThis.switchTab = wrappedSwitchTab;
    }
    tabBar.insertAdjacentElement('afterend', page);
    installCanvasController();
    installChatCanvasBranchLoop();
    installOutlineBranchBridge();
    installWorkflowEvents();
    renderInbox();
    refreshWorkflow();
  };

  const isStageComplete = (stage) => {
    if (stage.id === 'premise') return stageState(stage) === '完成';
    if (stage.id === 'bible') return hasBibleContent();
    if (stage.id === 'outline') return (state.outline || []).length > 0;
    if (stage.id === 'draft' || stage.id === 'publish') return chapterStats().count > 0;
    if (stage.id === 'revise')
      return (state.agentEditHistory || []).length > 0 || Object.keys(state.reviewReports || {}).length > 0;
    return false;
  };

  const saveCanvasModel = async () => {
    if (typeof globalThis.syncAllEditableStateFromUI === 'function') globalThis.syncAllEditableStateFromUI();
    const result = await Store.save();
    return result && typeof result.projectSaved === 'boolean'
      ? result
      : { ok: true, projectSaved: true, settingsSaved: true };
  };

  const announceCanvasSave = (result, savedText, unsavedText) => {
    if (announce) announce.textContent = result.projectSaved ? savedText : unsavedText;
  };

  const flushCanvasNoteSave = () => {
    if (!noteSaveTimer) return;
    clearTimeout(noteSaveTimer);
    noteSaveTimer = null;
    void saveCanvasModel().then((result) => {
      refreshCanvasStepStatuses();
      announceCanvasSave(result, '节点修改已保存。', '节点修改尚未保存，当前页面仍保留草稿。');
    });
  };

  const canvasNodeSize = (node) => {
    if (node.kind === 'note') return { width: 248, height: 184 };
    if (node.kind === 'step') return { width: 264, height: node.output?.text ? 352 : 222 };
    if (node.kind === 'experiment') return { width: 322, height: 318 };
    if (node.kind === 'arc') return { width: 248, height: 144 };
    return { width: 264, height: 138 };
  };

  const isCanvasBrainstormBranch = (node) => {
    if (node.aiBranch) return true;
    const text = String(node.text || '').replace(/^【[^】]*】\s*/, '');
    return (state.chatWindows || []).some((win) =>
      (win.messages || []).some(
        (message) =>
          Array.isArray(message.creativeCanvasBranchesAdded) &&
          message.creativeCanvasBranchesAdded.includes(text),
      ),
    );
  };

  const renderCanvasEdges = () => {
    if (!canvasSvg) return;
    const model = canvasModel();
    const visibleNodes = canvasNodes();
    const nodes = new Map(visibleNodes.map((node) => [node.id, node]));
    const derivedEdges = visibleNodes
      .filter((node) => node.kind === 'arc')
      .map((node) => ({
        edge: {
          id: `arc-link:${node.id}`,
          from: node.branchId,
          to: node.id,
          kind: 'reference',
        },
        derived: true,
      }));
    const paths = [...model.edges.map((edge) => ({ edge, derived: false })), ...derivedEdges]
      .map(({ edge, derived }) => {
        const from = nodes.get(edge.from);
        const to = nodes.get(edge.to);
        if (!from || !to) return '';
        const fromSize = canvasNodeSize(from);
        const toSize = canvasNodeSize(to);
        const fromCenter = { x: from.x + fromSize.width / 2, y: from.y + fromSize.height / 2 };
        const toCenter = { x: to.x + toSize.width / 2, y: to.y + toSize.height / 2 };
        const dx = toCenter.x - fromCenter.x;
        const dy = toCenter.y - fromCenter.y;
        let start;
        let end;
        if (Math.abs(dx) >= Math.abs(dy)) {
          start = { x: from.x + (dx >= 0 ? fromSize.width : 0), y: fromCenter.y };
          end = { x: to.x + (dx >= 0 ? 0 : toSize.width), y: toCenter.y };
        } else {
          start = { x: fromCenter.x, y: from.y + (dy >= 0 ? fromSize.height : 0) };
          end = { x: toCenter.x, y: to.y + (dy >= 0 ? 0 : toSize.height) };
        }
        const curve = Math.max(48, Math.min(180, Math.hypot(end.x - start.x, end.y - start.y) * 0.42));
        const control1 =
          Math.abs(dx) >= Math.abs(dy)
            ? { x: start.x + Math.sign(dx || 1) * curve, y: start.y }
            : { x: start.x, y: start.y + Math.sign(dy || 1) * curve };
        const control2 =
          Math.abs(dx) >= Math.abs(dy)
            ? { x: end.x - Math.sign(dx || 1) * curve, y: end.y }
            : { x: end.x, y: end.y - Math.sign(dy || 1) * curve };
        const d = `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`;
        const kind = ['main', 'reference', 'custom'].includes(edge.kind) ? edge.kind : 'custom';
        const edgeAttributes = derived
          ? ''
          : `data-canvas-edge="${escapeHtml(edge.id)}" tabindex="0" role="button" aria-label="选择连线并删除"`;
        return `<path class="creative-canvas-edge ${kind} ${derived ? 'story-arc' : ''} ${edge.id === selectedEdgeId ? 'is-selected' : ''}" ${edgeAttributes} d="${d}" marker-end="url(#creativeCanvasArrow)" />`;
      })
      .join('');
    let previewPath = '';
    if (canvasConnectPreview) {
      const source = nodes.get(canvasConnectPreview.sourceId);
      if (source && Number.isFinite(canvasConnectPreview.x) && Number.isFinite(canvasConnectPreview.y)) {
        const size = canvasNodeSize(source);
        const startX = source.x + size.width / 2;
        const startY = source.y + size.height / 2;
        previewPath = `<path class="creative-canvas-edge-preview" d="M ${startX} ${startY} L ${canvasConnectPreview.x} ${canvasConnectPreview.y}" />`;
      }
    }
    canvasSvg.innerHTML = `<defs><marker id="creativeCanvasArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>${paths}${previewPath}`;
    const deleteButton = flowPage?.querySelector('[data-canvas-action="delete-edge"]');
    if (deleteButton) {
      deleteButton.hidden = !selectedEdgeId;
      deleteButton.disabled = !selectedEdgeId;
    }
  };

  const renderCanvasAddMenu = () => {
    const menu = flowPage?.querySelector('#creativeCanvasAddMenu');
    if (!menu) return;
    const model = canvasModel();
    const existingStageIds = new Set(
      model.nodes.filter((node) => node.kind === 'stage').map((node) => node.stageId),
    );
    const hiddenStages = model.hiddenStageIds
      .map((stageId) => stages.find((stage) => stage.id === stageId))
      .filter(Boolean);
    const availableStages = stages.filter(
      (stage) => !existingStageIds.has(stage.id) && !model.hiddenStageIds.includes(stage.id),
    );
    menu.innerHTML = [
      '<button type="button" role="menuitem" data-canvas-action="add-note">便笺</button>',
      '<button type="button" role="menuitem" data-canvas-action="add-experiment">玩法实验</button>',
      '<button type="button" role="menuitem" data-canvas-action="add-step">AI 步骤</button>',
      '<button type="button" role="menuitem" data-canvas-action="prompt">随机灵感</button>',
      availableStages.length || hiddenStages.length
        ? '<div class="creative-canvas-add-menu-divider" role="separator"></div>'
        : '',
      ...availableStages.map(
        (stage) =>
          `<button type="button" role="menuitem" data-canvas-add-stage="${stage.id}">${escapeHtml(stage.title)}</button>`,
      ),
      ...hiddenStages.map(
        (stage) =>
          `<button type="button" role="menuitem" data-canvas-restore-stage="${stage.id}">恢复：${escapeHtml(stage.title)}</button>`,
      ),
    ]
      .filter(Boolean)
      .join('');
  };

  const renderCanvasNodes = () => {
    if (!flowPage) return;
    const container = flowPage.querySelector('#creativeCanvasNodes');
    if (!container) return;
    const nodes = canvasNodes();
    container.innerHTML = nodes
      .map((node) => {
        const size = canvasNodeSize(node);
        const x = Number.isFinite(Number(node.x))
          ? Math.max(0, Math.min(worldSize.width - size.width, Number(node.x)))
          : 0;
        const y = Number.isFinite(Number(node.y))
          ? Math.max(0, Math.min(worldSize.height - size.height, Number(node.y)))
          : 0;
        node.x = x;
        node.y = y;
        if (node.kind === 'note') {
          const outlineAction = isCanvasBrainstormBranch(node)
            ? `<button type="button" class="creative-canvas-note-outline" data-note-outline="${escapeHtml(node.id)}" aria-label="发展成章节大纲" title="发展成章节大纲">☷</button>`
            : '';
          return `<article class="creative-canvas-node creative-canvas-note" data-canvas-node data-canvas-node-id="${escapeHtml(node.id)}" style="left:${x}px;top:${y}px">
          <button type="button" class="creative-canvas-connect-port" data-node-connect="${escapeHtml(node.id)}" aria-label="从此便笺拖出连线；点击后选择目标" title="拖拽连线">↗</button>
          <div class="creative-canvas-node-head"><button type="button" class="creative-canvas-node-grip" data-node-drag aria-label="移动便笺" title="拖动">⠿</button><button type="button" class="creative-canvas-note-ai" data-note-ai="${escapeHtml(node.id)}" aria-label="让 AI 推演这条灵感" title="AI 推演">✦</button>${outlineAction}<button type="button" class="creative-canvas-note-delete" data-node-delete="${escapeHtml(node.id)}" aria-label="删除便笺" title="删除">×</button></div>
            <textarea data-canvas-note="${escapeHtml(node.id)}" aria-label="便笺内容" placeholder="写下一个画面、问题或转折……">${escapeHtml(node.text || '')}</textarea>
          </article>`;
        }
        if (node.kind === 'experiment') {
          const options = Array.isArray(node.options) ? node.options : [];
          const optionCards = options.length
            ? options
                .map(
                  (option, index) =>
                    `<div class="creative-experiment-option ${node.chosenOptionId === option.id ? 'is-chosen' : ''}"><button type="button" class="creative-experiment-option-pick" data-experiment-pick="${escapeHtml(node.id)}" data-experiment-option="${escapeHtml(option.id)}" title="选中这条路线">${index + 1}</button><input data-experiment-option-text="${escapeHtml(node.id)}" data-experiment-option-id="${escapeHtml(option.id)}" value="${escapeHtml(option.text || '')}" aria-label="路线 ${index + 1}" placeholder="写一条可能的路"></div>`,
                )
                .join('')
            : '<p class="creative-experiment-empty">先写一个困境，再抽取三条不同方向。</p>';
          return `<article class="creative-canvas-node creative-canvas-experiment ${node.chosenOptionId ? 'has-choice' : ''}" data-canvas-node data-canvas-node-kind="experiment" data-canvas-node-id="${escapeHtml(node.id)}" style="left:${x}px;top:${y}px">
          <button type="button" class="creative-canvas-connect-port" data-node-connect="${escapeHtml(node.id)}" aria-label="从玩法实验拖出连线；点击后选择目标" title="拖拽连线">↗</button>
          <div class="creative-canvas-node-head"><button type="button" class="creative-canvas-node-grip" data-node-drag aria-label="移动玩法实验" title="拖动">⠿</button><span class="creative-experiment-badge">PLAY</span><button type="button" class="creative-canvas-note-delete" data-node-delete="${escapeHtml(node.id)}" aria-label="删除玩法实验" title="删除">×</button></div>
          <input class="creative-experiment-title" data-canvas-experiment-title="${escapeHtml(node.id)}" value="${escapeHtml(node.title || '')}" maxlength="48" placeholder="实验标题，例如：主角会怎么选">
          <textarea class="creative-experiment-prompt" data-canvas-experiment-prompt="${escapeHtml(node.id)}" rows="3" placeholder="写下一个具体困境：谁想要什么，哪条代价不能逃？">${escapeHtml(node.prompt || '')}</textarea>
          <div class="creative-experiment-options">${optionCards}</div>
          <div class="creative-experiment-actions"><button type="button" class="btn btn-sm" data-experiment-branch="${escapeHtml(node.id)}">抽三条路线</button><button type="button" class="btn btn-sm btn-ghost" data-experiment-twist="${escapeHtml(node.id)}">掷意外</button><button type="button" class="btn btn-sm btn-ghost" data-experiment-ai="${escapeHtml(node.id)}">AI 推演</button>${node.chosenOptionId ? `<button type="button" class="btn btn-sm btn-primary" data-experiment-commit="${escapeHtml(node.id)}">落到画布</button><button type="button" class="btn btn-sm btn-ghost" data-experiment-handoff="${escapeHtml(node.id)}">送入大纲</button>` : ''}</div>
          </article>`;
        }
        if (node.kind === 'step') {
          const outputText = String(node.output?.text || '').trim();
          const hasOutput = !!outputText;
          let outputFreshness = canvasStepOutputState(node).status;
          const handoffLabel = hasOutput ? canvasStepHandoffLabel(node) : '';
          // Reading the input fingerprint can synchronize UI-backed rules. If that
          // synchronization settles the result, prefer the stable handoff state so
          // the next action is not hidden for one render frame.
          if (handoffLabel) outputFreshness = 'ready';
          const qualityLabel =
            node.output?.qualityStatus === 'reviewed'
              ? '审校通过'
              : node.output?.qualityStatus === 'repaired'
                ? '修复通过'
                : '未完成审校';
          const outputPanel = hasOutput
            ? `<section class="creative-canvas-step-output ${outputFreshness === 'stale' ? 'is-stale' : ''}" aria-label="最近一次生成成果">
                <div class="creative-canvas-step-output-head"><span>最近成果 · ${outputFreshness === 'stale' ? '输入已变更' : qualityLabel}</span><span>${String(outputText.replace(/\s/gu, '').length)} 字</span></div>
                <pre class="creative-canvas-step-output-text">${escapeHtml(outputText)}</pre>
                ${outputFreshness === 'stale' ? '<div class="creative-canvas-step-output-hint">过期成果不会传给下游</div>' : ''}
                ${handoffLabel ? `<button type="button" class="creative-canvas-step-handoff" data-step-handoff="${escapeHtml(node.id)}">${escapeHtml(handoffLabel)} <span aria-hidden="true">→</span></button>` : ''}
              </section>`
            : '';
          return `<article class="creative-canvas-node creative-canvas-step ${hasOutput ? 'has-output' : ''} ${outputFreshness === 'stale' ? 'is-output-stale' : ''} ${node.execution?.status === 'running' ? 'is-running' : ''}" data-canvas-node data-canvas-node-id="${escapeHtml(node.id)}" style="left:${x}px;top:${y}px">
          <button type="button" class="creative-canvas-connect-port" data-node-connect="${escapeHtml(node.id)}" aria-label="从此步骤拖出连线；点击后选择目标" title="拖拽连线">↗</button>
          <div class="creative-canvas-node-head"><button type="button" class="creative-canvas-node-grip" data-node-drag aria-label="移动创作步骤" title="拖动">⠿</button><span class="creative-canvas-step-status" data-canvas-step-status="${escapeHtml(node.id)}">${escapeHtml(canvasStepStatusLabel(node))}</span><button type="button" class="creative-canvas-note-ai" data-step-ai="${escapeHtml(node.id)}" aria-label="让 AI 执行此步骤" title="AI 执行">✦</button><button type="button" class="creative-canvas-note-delete" data-node-delete="${escapeHtml(node.id)}" aria-label="删除创作步骤" title="删除">×</button></div>
          <input class="creative-canvas-step-title" data-canvas-step-title="${escapeHtml(node.id)}" aria-label="步骤名称" placeholder="步骤名称" maxlength="48" value="${escapeHtml(node.title || '')}">
          <textarea data-canvas-step-instruction="${escapeHtml(node.id)}" aria-label="步骤要求" placeholder="写下这一步要完成什么…">${escapeHtml(node.instruction || '')}</textarea>${outputPanel}
          </article>`;
        }
        if (node.kind === 'arc') {
          const chapter = node.actionChapter;
          const action = node.nextChapter ? `写第${chapter}章` : `回看第${chapter}章`;
          return `<article class="creative-canvas-node creative-canvas-arc" data-canvas-node data-canvas-node-kind="arc" data-canvas-node-id="${escapeHtml(node.id)}" data-story-arc="${escapeHtml(node.branchId)}" style="left:${x}px;top:${y}px">
          <div class="creative-canvas-node-head"><button type="button" class="creative-canvas-node-grip" data-node-drag aria-label="移动剧情段" title="拖动">⠿</button><span class="creative-phase-status">${node.writtenCount}/${node.chapters.length} 章</span></div>
          <h4><span aria-hidden="true">◇</span>${escapeHtml(node.title)}</h4>
          <div class="creative-arc-progress" role="progressbar" aria-label="剧情段正文进度" aria-valuemin="0" aria-valuemax="${node.chapters.length}" aria-valuenow="${node.writtenCount}"><span style="width:${node.progress}%"></span></div>
          <button type="button" class="creative-phase-open" data-arc-open="${chapter}">${action} <span>↗</span></button>
        </article>`;
        }
        const stage = stages.find((item) => item.id === node.stageId);
        if (!stage) return '';
        const status = stageState(stage);
        const completeStatus = isStageComplete(stage);
        const statusLabel = status;
        const draftChapter = stage.id === 'draft' ? getNextWritingChapter() : null;
        const draftHasContent = draftChapter
          ? (state.chapters || []).some(
              (chapter) => Number(chapter.chapter) === draftChapter && String(chapter.content || '').trim(),
            )
          : false;
        const openLabel =
          stage.id === 'draft' ? `${draftHasContent ? '打开' : '写'}第${draftChapter}章` : '打开';
        return `<article class="creative-canvas-node creative-canvas-stage ${completeStatus ? 'is-complete' : ''}" data-canvas-node data-canvas-node-id="${escapeHtml(node.id)}" data-workflow-id="${stage.id}" style="left:${x}px;top:${y}px">
          <button type="button" class="creative-canvas-connect-port" data-node-connect="${escapeHtml(node.id)}" aria-label="从${escapeHtml(stage.title)}拖出连线；点击后选择目标" title="拖拽连线">↗</button>
          <div class="creative-canvas-node-head"><button type="button" class="creative-canvas-node-grip" data-node-drag aria-label="移动${stage.title}" title="拖动">⠿</button>${statusLabel ? `<span class="creative-phase-status">${escapeHtml(statusLabel)}</span>` : ''}<button type="button" class="creative-canvas-stage-hide" data-canvas-hide-stage="${stage.id}" aria-label="从画布隐藏${escapeHtml(stage.title)}" title="隐藏此节点（项目内容保留）">×</button></div>
          <h4><span aria-hidden="true">${stage.icon}</span>${escapeHtml(stage.title)}</h4><button type="button" class="creative-phase-open" data-workflow-open="${stage.id}">${openLabel} <span>↗</span></button>
        </article>`;
      })
      .join('');
    const emptyState = flowPage.querySelector('#creativeCanvasEmpty');
    if (emptyState) emptyState.hidden = nodes.length > 0;
    renderCanvasEdges();
    renderCanvasAddMenu();
  };

  const refreshCanvasStepStatuses = () => {
    for (const step of canvasModel().nodes.filter((node) => node.kind === 'step')) {
      const element = canvasWorld?.querySelector(`[data-canvas-node-id="${CSS.escape(step.id)}"]`);
      if (!element) continue;
      const freshness = canvasStepOutputState(step).status;
      element.classList.toggle('is-output-stale', freshness === 'stale');
      element.classList.toggle('is-running', step.execution?.status === 'running');
      const status = element.querySelector('[data-canvas-step-status]');
      if (status) status.textContent = canvasStepStatusLabel(step);
      const outputHeader = element.querySelector('.creative-canvas-step-output-head span:first-child');
      if (outputHeader && step.output) {
        const qualityLabel =
          step.output.qualityStatus === 'reviewed'
            ? '审校通过'
            : step.output.qualityStatus === 'repaired'
              ? '修复通过'
              : '未完成审校';
        outputHeader.textContent = `最近成果 · ${freshness === 'stale' ? '输入已变更' : qualityLabel}`;
      }
      const handoffLabel = canvasStepHandoffLabel(step);
      const handoff = element.querySelector('[data-step-handoff]');
      if (handoffLabel && freshness === 'ready') {
        if (handoff) handoff.innerHTML = `${escapeHtml(handoffLabel)} <span aria-hidden="true">→</span>`;
        else {
          const outputPanel = element.querySelector('.creative-canvas-step-output');
          if (outputPanel) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'creative-canvas-step-handoff';
            button.dataset.stepHandoff = step.id;
            button.innerHTML = `${escapeHtml(handoffLabel)} <span aria-hidden="true">→</span>`;
            outputPanel.append(button);
          }
        }
      } else handoff?.remove();
    }
  };

  const applyCanvasCamera = () => {
    if (!canvasWorld) return;
    canvasWorld.style.transform = `translate(${canvasCamera.x}px, ${canvasCamera.y}px) scale(${canvasCamera.scale})`;
    const zoom = flowPage?.querySelector('#creativeCanvasZoom');
    if (zoom) zoom.textContent = `${Math.round(canvasCamera.scale * 100)}%`;
  };

  const fitCanvas = (persist = true) => {
    if (!canvasViewport) return;
    const nodes = canvasNodes();
    if (!nodes.length) {
      canvasCamera = {
        scale: 1,
        x: canvasViewport.clientWidth / 2 - worldSize.width / 2,
        y: canvasViewport.clientHeight / 2 - worldSize.height / 2,
      };
      applyCanvasCamera();
      if (persist) saveCamera();
      return;
    }
    const bounds = nodes.reduce(
      (acc, node) => {
        const size = canvasNodeSize(node);
        return {
          left: Math.min(acc.left, node.x),
          top: Math.min(acc.top, node.y),
          right: Math.max(acc.right, node.x + size.width),
          bottom: Math.max(acc.bottom, node.y + size.height),
        };
      },
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
    const width = Math.max(bounds.right - bounds.left, 1);
    const height = Math.max(bounds.bottom - bounds.top, 1);
    const toolbarHeight =
      flowPage?.querySelector('.creative-canvas-toolbar')?.getBoundingClientRect().height || 44;
    const topReserve = Math.ceil(toolbarHeight + 18);
    const availableHeight = Math.max(canvasViewport.clientHeight - topReserve - 18, 1);
    const scale = Math.max(
      0.03,
      Math.min(1.1, (canvasViewport.clientWidth - 54) / width, availableHeight / height),
    );
    canvasCamera = {
      scale,
      x: (canvasViewport.clientWidth - width * scale) / 2 - bounds.left * scale,
      y: topReserve + (availableHeight - height * scale) / 2 - bounds.top * scale,
    };
    applyCanvasCamera();
    if (persist) saveCamera();
  };

  const zoomCanvasAt = (scale, clientX, clientY) => {
    if (!canvasViewport) return;
    const rect = canvasViewport.getBoundingClientRect();
    const minScale = 0.03;
    const nextScale = Math.max(minScale, Math.min(1.8, scale));
    const localX = clientX - rect.left;
    const localY = clientY - rect.top;
    const worldX = (localX - canvasCamera.x) / canvasCamera.scale;
    const worldY = (localY - canvasCamera.y) / canvasCamera.scale;
    canvasCamera = {
      scale: nextScale,
      x: localX - worldX * nextScale,
      y: localY - worldY * nextScale,
    };
    applyCanvasCamera();
    saveCamera();
  };

  const centerCanvasOnNode = (nodeId) => {
    const node = canvasNodes().find((item) => item.id === nodeId);
    if (!node || !canvasViewport) return;
    const size = canvasNodeSize(node);
    canvasCamera.x = canvasViewport.clientWidth / 2 - (node.x + size.width / 2) * canvasCamera.scale;
    canvasCamera.y = canvasViewport.clientHeight / 2 - (node.y + size.height / 2) * canvasCamera.scale;
    applyCanvasCamera();
    saveCamera();
  };

  const focusStarterPathStart = () => {
    const model = canvasModel();
    if (model.starterTemplateVersion !== 1 || !model.nodes.some((node) => node.id === 'stage:premise'))
      return false;
    canvasCamera.scale = 0.9;
    centerCanvasOnNode('stage:premise');
    return true;
  };

  const setNodePosition = (nodeId, x, y) => {
    const node = canvasNodes().find((item) => item.id === nodeId);
    if (!node) return;
    const size = canvasNodeSize(node);
    const nextPosition = {
      x: Math.max(0, Math.min(worldSize.width - size.width, x)),
      y: Math.max(0, Math.min(worldSize.height - size.height, y)),
    };
    if (node.kind === 'arc') canvasModel().arcPositions[node.branchId] = nextPosition;
    else Object.assign(node, nextPosition);
    node.x = nextPosition.x;
    node.y = nextPosition.y;
    const element = canvasWorld?.querySelector(`[data-canvas-node-id="${CSS.escape(nodeId)}"]`);
    if (element) {
      element.style.left = `${node.x}px`;
      element.style.top = `${node.y}px`;
    }
    renderCanvasEdges();
  };

  const findOpenPosition = (x, y, size, existingNodes) => {
    const normalize = (candidate) => ({
      x: Math.max(0, Math.min(worldSize.width - size.width, candidate.x)),
      y: Math.max(0, Math.min(worldSize.height - size.height, candidate.y)),
    });
    const isClear = (candidate) =>
      existingNodes.every((node) => {
        const otherSize = canvasNodeSize(node);
        const gap = 24;
        return (
          candidate.x + size.width + gap <= node.x ||
          candidate.x >= node.x + otherSize.width + gap ||
          candidate.y + size.height + gap <= node.y ||
          candidate.y >= node.y + otherSize.height + gap
        );
      });
    const offsets = [{ x: 0, y: 0 }];
    for (let radius = 64; radius <= 960; radius += 64) {
      for (let offset = -radius; offset <= radius; offset += 64) {
        offsets.push(
          { x: offset, y: -radius },
          { x: offset, y: radius },
          { x: -radius, y: offset },
          { x: radius, y: offset },
        );
      }
    }
    for (const offset of offsets) {
      const candidate = normalize({ x: x + offset.x, y: y + offset.y });
      if (isClear(candidate)) return candidate;
    }
    return normalize({ x, y });
  };

  const findOpenNotePosition = (x, y) => findOpenPosition(x, y, { width: 248, height: 184 }, canvasNodes());

  const canvasNodeSourceContent = (node) => {
    if (node?.kind === 'step') {
      return [
        `【创作步骤：${String(node.title || '未命名步骤').trim()}】`,
        String(node.instruction || '').trim(),
      ]
        .filter(Boolean)
        .join('\n');
    }
    if (node?.kind === 'experiment') {
      const options = (Array.isArray(node.options) ? node.options : [])
        .map((option, index) => `${index + 1}. ${String(option.text || '').trim()}`)
        .filter((text) => !/^\d+\.\s*$/u.test(text));
      const chosen = (node.options || []).find((option) => option.id === node.chosenOptionId);
      return [
        `【玩法实验：${String(node.title || '未命名实验').trim()}】`,
        String(node.prompt || '').trim(),
        options.length ? `可能路线：\n${options.join('\n')}` : '',
        chosen?.text ? `作者暂选：${chosen.text}` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    return String(node?.text || '').trim();
  };

  const canvasNodeContent = (node) => {
    const source = canvasNodeSourceContent(node);
    if (node?.kind !== 'step') return source;
    const output = node.output;
    if (!output?.text) {
      const status =
        node.execution?.status === 'running'
          ? '此 AI 步骤正在执行，尚无可接力成果'
          : '此 AI 步骤尚无可接力成果';
      return [source, `【${status}】`].filter(Boolean).join('\n');
    }
    const freshness = canvasStepOutputState(node).status;
    if (freshness !== 'ready')
      return [source, '【最近成果已过期；因输入发生变化，本次生成不可沿用】'].filter(Boolean).join('\n');
    const qualityLabel =
      output.qualityStatus === 'reviewed'
        ? '审校通过的创作提案'
        : output.qualityStatus === 'repaired'
          ? '修复后通过的创作提案'
          : '尚未完成审校的草稿提案';
    return [source, `【${qualityLabel}｜不是已确认正史】\n${String(output.text).trim()}`]
      .filter(Boolean)
      .join('\n\n');
  };

  const canvasNodeLabel = (node) => {
    if (!node) return '未知节点';
    if (node.kind === 'stage') return stages.find((stage) => stage.id === node.stageId)?.title || '创作阶段';
    if (node.kind === 'step') return `步骤「${String(node.title || '未命名步骤').trim()}」`;
    if (node.kind === 'experiment') return `实验「${String(node.title || '未命名实验').trim()}」`;
    const firstLine = String(node.text || '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean);
    const heading = firstLine?.match(/^【([^】]+)】/u)?.[1] || firstLine || '未命名便笺';
    return `便笺「${heading.slice(0, 56)}${heading.length > 56 ? '…' : ''}」`;
  };

  const collectIncomingCanvasGraph = (
    startNodeId,
    { traverseStages = false, limit = 24, visitLimit = 256 } = {},
  ) => {
    const model = canvasModel();
    const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
    if (!nodesById.has(startNodeId)) return { startNodeId, nodesById, nodes: [], notes: [], edges: [] };
    const incoming = new Map();
    for (const edge of model.edges) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to).push(edge.from);
    }
    const visited = new Set([startNodeId]);
    const queue = [startNodeId];
    const notes = [];
    while (queue.length && notes.length < limit && visited.size < visitLimit) {
      const currentId = queue.shift();
      for (const parentId of incoming.get(currentId) || []) {
        if (visited.has(parentId)) continue;
        visited.add(parentId);
        const parent = nodesById.get(parentId);
        if (!parent) continue;
        if (['note', 'step', 'experiment'].includes(parent.kind)) {
          notes.push(parent);
          queue.push(parent.id);
        } else if (traverseStages && parent.kind === 'stage') {
          queue.push(parent.id);
        }
        if (notes.length >= limit || visited.size >= visitLimit) break;
      }
    }
    const nodeOrder = new Map(model.nodes.map((node, index) => [node.id, index]));
    const relatedEdges = model.edges.filter((edge) => visited.has(edge.from) && visited.has(edge.to));
    const outgoing = new Map();
    const indegree = new Map([...visited].map((id) => [id, 0]));
    for (const edge of relatedEdges) {
      if (!outgoing.has(edge.from)) outgoing.set(edge.from, []);
      outgoing.get(edge.from).push(edge.to);
      indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
    }
    const ready = [...visited]
      .filter((id) => indegree.get(id) === 0)
      .sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));
    const orderedIds = [];
    while (ready.length) {
      const id = ready.shift();
      orderedIds.push(id);
      for (const nextId of outgoing.get(id) || []) {
        indegree.set(nextId, indegree.get(nextId) - 1);
        if (indegree.get(nextId) === 0) {
          ready.push(nextId);
          ready.sort((left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0));
        }
      }
    }
    // Cycles are allowed on a freeform canvas. Keep those nodes visible in context,
    // while the explicit edge list below prevents their order from being guessed.
    for (const id of [...visited].sort(
      (left, right) => (nodeOrder.get(left) ?? 0) - (nodeOrder.get(right) ?? 0),
    )) {
      if (!orderedIds.includes(id)) orderedIds.push(id);
    }
    const nodes = orderedIds
      .filter((id) => id !== startNodeId)
      .map((id) => nodesById.get(id))
      .filter(Boolean);
    return {
      startNodeId,
      nodesById,
      nodes,
      notes: nodes.filter((node) => ['note', 'step', 'experiment'].includes(node.kind)),
      edges: relatedEdges,
    };
  };

  const canvasInputFingerprint = (value) => {
    const source = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${source.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  };

  const canvasStepWritingTarget = (stepId) => {
    const route = resolveCanvasStepModelRoute(stepId);
    return ['chapter', 'editing'].includes(route) ? 'chapter' : 'outline';
  };

  const canvasStepInputFingerprint = (step, writingTarget = 'outline') => {
    if (typeof globalThis.syncCreativeRulesFromUI === 'function') globalThis.syncCreativeRulesFromUI();
    const project = state.project || {};
    const chapterNumber = writingTarget === 'chapter' ? Math.floor(Number(state.currentChapter || 0)) : 0;
    const targetOutline = chapterNumber
      ? (state.outline || []).find((chapter) => Number(chapter.chapter) === chapterNumber)
      : null;
    const previousChapters = (state.chapters || [])
      .filter((chapter) => !chapterNumber || Number(chapter.chapter) < chapterNumber)
      .filter((chapter) => String(chapter.content || '').trim())
      .slice(-3)
      .map((chapter) => ({
        chapter: chapter.chapter,
        summary:
          (state.outline || []).find((item) => Number(item.chapter) === Number(chapter.chapter))?.summary ||
          '',
        ending: String(chapter.content || '').slice(-420),
      }));
    const graph = collectIncomingCanvasGraph(step.id, {
      traverseStages: true,
      limit: 24,
      visitLimit: 256,
    });
    const projectContext = {
      title: project.title || '',
      genre: project.genre || '',
      setting: document.getElementById('novelSetting')?.value || project.setting || '',
      characters: document.getElementById('novelCharacters')?.value || project.characters || '',
      novelNote: project.novelNote || '',
      chapterCount: project.chapterCount || 0,
      wordsPerChapter: project.wordsPerChapter || 0,
    };
    const outlineContext = chapterNumber
      ? {
          target: targetOutline || null,
          previous: (state.outline || [])
            .filter((chapter) => Number(chapter.chapter) < chapterNumber)
            .slice(-8),
        }
      : (state.outline || []).slice(-24);
    const upstreamNodes = graph.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      content: canvasNodeSourceContent(node),
      output:
        node.kind === 'step' && node.output
          ? {
              text: node.output.text || '',
              qualityStatus: node.output.qualityStatus || 'unverified',
              inputFingerprint: node.output.inputFingerprint || '',
              writingTarget: node.output.writingTarget || 'outline',
            }
          : null,
    }));
    const material = {
      task: {
        title: step.title || '',
        instruction: step.instruction || '',
        qualityContract: step.qualityContract || '',
      },
      writingTarget,
      project: projectContext,
      creativeRules: state.creativeRules || {},
      methodologyCards: (state.methodologyCards || []).map((card) => ({
        id: card.id,
        name: card.name,
        cardText: card.cardText,
        enabledForOutline: card.enabledForOutline,
        enabledForChapter: card.enabledForChapter,
      })),
      storyBible: state.storyBibleFreeText || '',
      storyBibleBundle: globalThis.storyBibleBundle || {},
      confirmedMemory:
        typeof buildConfirmedMemoryContext === 'function' ? buildConfirmedMemoryContext(chapterNumber) : '',
      outline: outlineContext,
      previousChapters,
      recentProseStyle: globalThis.buildRecentProseStyleContext?.(writingTarget) || '',
      upstreamNodes,
      upstreamEdges: graph.edges.map((edge) => ({ from: edge.from, to: edge.to, kind: edge.kind || '' })),
    };
    return canvasInputFingerprint(JSON.stringify(material));
  };

  const canvasStepOutputState = (step) => {
    const output = step?.output;
    if (!String(output?.text || '').trim()) return { status: 'missing' };
    const writingTarget = canvasStepWritingTarget(step.id);
    const expectedFingerprint = canvasStepInputFingerprint(step, writingTarget);
    if (output.writingTarget !== writingTarget || output.inputFingerprint !== expectedFingerprint)
      return { status: 'stale', writingTarget };
    return { status: 'ready', writingTarget };
  };

  const canvasStepStatusLabel = (step) => {
    const outputState = canvasStepOutputState(step);
    if (step.execution?.status === 'running') return '执行中';
    if (outputState.status === 'stale') return '成果已过期';
    if (outputState.status === 'ready') {
      if (step.output.qualityStatus === 'reviewed') return '审校通过';
      if (step.output.qualityStatus === 'repaired') return '修复通过';
      return '保留草稿';
    }
    return step.execution?.status === 'failed' ? '执行失败' : '待执行';
  };

  const collectIncomingCanvasNotes = (startNodeId, options = {}) =>
    collectIncomingCanvasGraph(startNodeId, options).notes;

  const serializeCanvasGraphEdges = (graph, excludedNodeIds = new Set()) => {
    const excluded = excludedNodeIds instanceof Set ? excludedNodeIds : new Set(excludedNodeIds || []);
    const connected = graph.edges.filter((edge) => !excluded.has(edge.from) && !excluded.has(edge.to));
    const lines = connected.slice(0, 48).map((edge) => {
      const source = graph.nodesById.get(edge.from);
      const target = graph.nodesById.get(edge.to);
      const label =
        edge.kind === 'main'
          ? '主流程（创作阶段顺序）'
          : edge.kind === 'reference'
            ? '参考输入（背景材料，不规定情节先后）'
            : source?.kind === 'stage' || target?.kind === 'stage'
              ? '工作阶段关联 / 模型路由'
              : '作者输入连线（上游供下游参考，不自动断言因果）';
      return `- [${label}] ${canvasNodeLabel(source)} → ${canvasNodeLabel(target)}`;
    });
    if (connected.length > lines.length)
      lines.push(`- 其余 ${connected.length - lines.length} 条连线省略，避免上下文过长。`);
    return lines.length ? `【画布连线意图】\n${lines.join('\n')}` : '';
  };

  const resolveCanvasStepModelRoute = (stepId) => {
    const model = canvasModel();
    const nodesById = new Map(model.nodes.map((node) => [node.id, node]));
    const incoming = new Map();
    for (const edge of model.edges) {
      if (!incoming.has(edge.to)) incoming.set(edge.to, []);
      incoming.get(edge.to).push(edge.from);
    }

    const visited = new Set([stepId]);
    let frontier = [stepId];
    while (frontier.length) {
      const next = [];
      const routes = new Set();
      for (const currentId of frontier) {
        for (const parentId of incoming.get(currentId) || []) {
          if (visited.has(parentId)) continue;
          visited.add(parentId);
          const parent = nodesById.get(parentId);
          if (!parent) continue;
          if (parent.kind === 'stage') {
            if (model.hiddenStageIds.includes(parent.stageId)) continue;
            const route = canvasStageModelRoutes[parent.stageId];
            if (route) routes.add(route);
          } else if (['note', 'step', 'experiment'].includes(parent.kind)) {
            next.push(parent.id);
          }
        }
      }
      if (routes.size === 1) return [...routes][0];
      if (routes.size > 1) return null;
      frontier = next;
    }
    return null;
  };

  const buildCanvasStageContext = (target, excludedNodeIds = []) => {
    const stageId =
      target === 'outline'
        ? 'stage:outline'
        : ['chapter', 'continue'].includes(target)
          ? 'stage:draft'
          : target === 'review'
            ? 'stage:revise'
            : null;
    if (!stageId) return '';

    const notesById = new Map(canvasModel().nodes.map((node) => [node.id, node]));
    const included = new Set(excludedNodeIds);
    const sections = [];
    let remainingCharacters = 8000;
    const appendNotes = (label, notes) => {
      const lines = [];
      for (const note of notes) {
        if (included.has(note.id)) continue;
        included.add(note.id);
        const content = canvasNodeContent(note);
        if (!content || remainingCharacters <= 0) continue;
        const perNodeLimit = note.kind === 'step' && note.output?.text ? 2100 : 900;
        const excerpt = content.slice(0, Math.min(perNodeLimit, remainingCharacters));
        remainingCharacters -= excerpt.length;
        lines.push(`- ${excerpt}${excerpt.length < content.length ? '…' : ''}`);
      }
      if (lines.length) sections.push(`【${label}】\n${lines.join('\n')}`);
    };

    if (['stage:draft', 'stage:revise'].includes(stageId)) {
      const chapterNumber = Number(state.currentChapter || 1);
      const chapter = (state.outline || []).find((item) => Number(item.chapter) === chapterNumber);
      const branch = notesById.get(String(chapter?.sourceCanvasBranchId || ''));
      if (branch?.kind === 'note') {
        appendNotes('本章所属画布分支', [
          branch,
          ...collectIncomingCanvasNotes(branch.id, { limit: 6, visitLimit: 64 }),
        ]);
      }
    }

    const stageGraph = collectIncomingCanvasGraph(stageId, {
      traverseStages: true,
      limit: 24,
      visitLimit: 256,
    });
    appendNotes(
      target === 'outline'
        ? '连入大纲流程的画布节点'
        : stageId === 'stage:revise'
          ? '连入编辑审阅流程的画布节点'
          : '连入章节写作流程的画布节点',
      stageGraph.notes,
    );
    const graphEdges = serializeCanvasGraphEdges(stageGraph, new Set(excludedNodeIds));
    if (graphEdges) sections.push(graphEdges);
    return sections.length ? `\n\n${sections.join('\n\n')}` : '';
  };

  const canvasNodes = () => {
    const model = canvasModel();
    const hiddenStages = new Set(model.hiddenStageIds);
    const visibleNodes = model.nodes.filter(
      (node) => node.kind !== 'stage' || !hiddenStages.has(node.stageId),
    );
    const groups = new Map();
    const chapters = Array.isArray(state.outline) ? state.outline : [];
    chapters.forEach((chapter, index) => {
      const branchId = String(chapter?.sourceCanvasBranchId || '').trim();
      if (!branchId) return;
      const chapterNumber = Number(chapter.chapter);
      const record = {
        chapter: Number.isInteger(chapterNumber) && chapterNumber > 0 ? chapterNumber : index + 1,
        title: String(chapter.title || '').trim(),
      };
      if (!groups.has(branchId)) groups.set(branchId, []);
      groups.get(branchId).push(record);
    });
    if (!groups.size) return visibleNodes;

    const notes = new Map(visibleNodes.filter((node) => node.kind === 'note').map((node) => [node.id, node]));
    const outlineStage = visibleNodes.find((node) => node.id === 'stage:outline');
    const written = new Set(
      (state.chapters || [])
        .filter((chapter) => String(chapter.content || '').trim())
        .map((chapter) => Number(chapter.chapter)),
    );
    const occupied = [...visibleNodes];
    const arcs = [];

    for (const [branchId, group] of groups) {
      group.sort((left, right) => left.chapter - right.chapter);
      const source = notes.get(branchId);
      const sourceSize = source ? canvasNodeSize(source) : null;
      const origin = source
        ? { x: source.x + sourceSize.width + 40, y: source.y }
        : { x: (outlineStage?.x || 420) + 304, y: outlineStage?.y || 350 };
      const savedPosition = model.arcPositions[branchId];
      const position =
        savedPosition && Number.isFinite(savedPosition.x) && Number.isFinite(savedPosition.y)
          ? {
              x: Math.max(0, Math.min(worldSize.width - 248, savedPosition.x)),
              y: Math.max(0, Math.min(worldSize.height - 144, savedPosition.y)),
            }
          : findOpenPosition(origin.x, origin.y, { width: 248, height: 144 }, occupied);
      model.arcPositions[branchId] = position;

      const writtenCount = group.filter((chapter) => written.has(chapter.chapter)).length;
      const nextChapter = group.find((chapter) => !written.has(chapter.chapter));
      const fallbackChapter = group.at(-1);
      const branchTitle = String(source?.text || '')
        .match(/^【([^】]+)】/)?.[1]
        ?.trim();
      const arc = {
        id: `arc:${branchId}`,
        kind: 'arc',
        branchId,
        title: branchTitle || group[0]?.title || '剧情段',
        chapters: group,
        writtenCount,
        nextChapter: nextChapter?.chapter || null,
        actionChapter: nextChapter?.chapter || fallbackChapter?.chapter || 1,
        progress: group.length ? Math.round((writtenCount / group.length) * 100) : 0,
        ...position,
      };
      arcs.push(arc);
      occupied.push(arc);
    }
    return [...visibleNodes, ...arcs];
  };

  const createCanvasNote = async (
    text = '',
    sourceIdeaId = null,
    explicitPosition = null,
    linkedFromId = null,
  ) => {
    const existing = sourceIdeaId && canvasModel().nodes.find((node) => node.sourceIdeaId === sourceIdeaId);
    if (existing) {
      centerCanvasOnNode(existing.id);
      if (announce) announce.textContent = '这条灵感已在画布上。';
      return existing;
    }
    const viewportWidth = canvasViewport?.clientWidth || 900;
    const viewportHeight = canvasViewport?.clientHeight || 620;
    const x =
      explicitPosition?.x ?? Math.max(24, (viewportWidth / 2 - canvasCamera.x) / canvasCamera.scale - 136);
    const y =
      explicitPosition?.y ?? Math.max(24, (viewportHeight / 2 - canvasCamera.y) / canvasCamera.scale - 107);
    const position = explicitPosition ? { x, y } : findOpenNotePosition(x, y);
    const node = {
      id: `note:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'note',
      text,
      sourceIdeaId,
      createdAt: Date.now(),
      x: position.x,
      y: position.y,
    };
    const model = canvasModel();
    model.nodes.push(node);
    if (linkedFromId && model.nodes.some((item) => item.id === linkedFromId)) {
      model.edges.push({
        id: `edge:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        from: linkedFromId,
        to: node.id,
        kind: 'custom',
      });
    }
    renderCanvasNodes();
    if (!explicitPosition || linkedFromId) centerCanvasOnNode(node.id);
    const saveResult = await saveCanvasModel();
    requestAnimationFrame(() =>
      canvasWorld?.querySelector(`[data-canvas-node-id="${CSS.escape(node.id)}"] textarea`)?.focus(),
    );
    announceCanvasSave(saveResult, '已添加便笺节点。', '便笺尚未保存，当前页面仍保留草稿。');
    return node;
  };

  const createCanvasNoteAt = (x, y) => createCanvasNote('', null, { x: x - 124, y: y - 24 });

  const createCanvasStep = async () => {
    const viewportWidth = canvasViewport?.clientWidth || 900;
    const viewportHeight = canvasViewport?.clientHeight || 620;
    const x = Math.max(24, (viewportWidth / 2 - canvasCamera.x) / canvasCamera.scale - 132);
    const y = Math.max(24, (viewportHeight / 2 - canvasCamera.y) / canvasCamera.scale - 111);
    const position = findOpenPosition(x, y, { width: 264, height: 222 }, canvasNodes());
    const step = {
      id: `step:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'step',
      title: '',
      instruction: '',
      createdAt: Date.now(),
      ...position,
    };
    canvasModel().nodes.push(step);
    renderCanvasNodes();
    centerCanvasOnNode(step.id);
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, '已添加工作步骤。', '工作步骤尚未保存，当前页面仍保留草稿。');
    requestAnimationFrame(() =>
      canvasWorld?.querySelector(`[data-canvas-step-title="${CSS.escape(step.id)}"]`)?.focus(),
    );
  };

  const experimentTwists = [
    '关键证据是真的，但所有人都把它理解反了',
    '主角必须在十分钟内做决定，而且不能解释原因',
    '看似无关的人突然拥有否决权',
    '解决问题会让更大的问题提前暴露',
    '主角最信任的线索只提供了一半真相',
    '这次选择会改变一个配角，而不是改变主角',
  ];

  const experimentRouteSeeds = [
    (focus) => `抢先行动：主角先做一件不可逆的事，把「${focus}」变成对手必须回应的现场。`,
    (focus) => `交换代价：主角暂时得到想要的结果，但要把「${focus}」的代价转交给一个具体的人。`,
    (focus) => `错误信息：主角根据一个看似可靠的细节处理「${focus}」，中途才发现自己正在帮对手完成目标。`,
    (focus) => `关系下注：把「${focus}」交给两名立场相反的人，他们必须当场决定谁来承担后果。`,
    (focus) => `反向目标：从对手的胜利开始倒推，让「${focus}」成为主角必须阻止、却又不得不借用的方案。`,
    (focus) => `公开选择：让主角在众人面前说出对「${focus}」的选择，随后用一个小动作证明他可能在撒谎。`,
  ];

  const createCanvasExperiment = async () => {
    const viewportWidth = canvasViewport?.clientWidth || 900;
    const viewportHeight = canvasViewport?.clientHeight || 620;
    const x = Math.max(24, (viewportWidth / 2 - canvasCamera.x) / canvasCamera.scale - 161);
    const y = Math.max(24, (viewportHeight / 2 - canvasCamera.y) / canvasCamera.scale - 150);
    const position = findOpenPosition(x, y, { width: 322, height: 318 }, canvasNodes());
    const experiment = {
      id: `experiment:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      kind: 'experiment',
      title: '一局故事实验',
      prompt: '',
      options: [],
      chosenOptionId: null,
      createdAt: Date.now(),
      ...position,
    };
    canvasModel().nodes.push(experiment);
    renderCanvasNodes();
    centerCanvasOnNode(experiment.id);
    const saveResult = await saveCanvasModel();
    announceCanvasSave(
      saveResult,
      '玩法实验已开局：写下困境或直接抽三条路线。',
      '玩法实验尚未保存，当前页面仍保留草稿。',
    );
    requestAnimationFrame(() =>
      canvasWorld?.querySelector(`[data-canvas-experiment-prompt="${CSS.escape(experiment.id)}"]`)?.focus(),
    );
    return experiment;
  };

  const experimentFocusText = (node) => {
    const source = String(
      node.prompt ||
        document.getElementById('novelSetting')?.value ||
        state.project?.setting ||
        '这个故事困境',
    )
      .replace(/\s+/gu, ' ')
      .trim();
    return source.length > 76 ? `${source.slice(0, 76)}…` : source;
  };

  const rollExperimentRoutes = async (nodeId) => {
    const node = canvasModel().nodes.find((item) => item.id === nodeId && item.kind === 'experiment');
    if (!node) return;
    const focus = experimentFocusText(node);
    const offset = Math.floor(Math.random() * experimentRouteSeeds.length);
    node.options = Array.from({ length: 3 }, (_, index) => {
      const route = experimentRouteSeeds[(offset + index) % experimentRouteSeeds.length];
      return {
        id: `${node.id}:option:${index + 1}`,
        text: route(focus),
      };
    });
    node.chosenOptionId = null;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(
      saveResult,
      '三条路线已掷出；可以改写、选一条，或继续掷意外。',
      '实验路线尚未保存，当前页面仍保留草稿。',
    );
  };

  const rollExperimentTwist = async (nodeId) => {
    const node = canvasModel().nodes.find((item) => item.id === nodeId && item.kind === 'experiment');
    if (!node) return;
    if (!Array.isArray(node.options) || node.options.length < 3) {
      await rollExperimentRoutes(nodeId);
      return;
    }
    const twist = experimentTwists[Math.floor(Math.random() * experimentTwists.length)];
    node.options = node.options.map((option) => {
      const clean = String(option.text || '')
        .replace(/（意外：[^）]+）$/u, '')
        .trim();
      return { ...option, text: `${clean}（意外：${twist}）` };
    });
    node.chosenOptionId = null;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, `意外条件已加入：${twist}`, '意外条件尚未保存，当前页面仍保留草稿。');
  };

  const pickExperimentRoute = async (nodeId, optionId) => {
    const node = canvasModel().nodes.find((item) => item.id === nodeId && item.kind === 'experiment');
    if (!node || !(node.options || []).some((option) => option.id === optionId)) return;
    node.chosenOptionId = optionId;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(
      saveResult,
      '路线已选定；现在可以落到画布或送进大纲。',
      '路线选择尚未保存，当前页面仍保留草稿。',
    );
  };

  const commitExperimentRoute = async (nodeId, toOutline = false) => {
    const node = canvasModel().nodes.find((item) => item.id === nodeId && item.kind === 'experiment');
    const selected = node && (node.options || []).find((option) => option.id === node.chosenOptionId);
    if (!node || !selected) return;
    const text =
      `【${node.title || '玩法实验'}｜已选路线】\n${String(node.prompt || '').trim()}\n\n${selected.text}`.trim();
    const position = findOpenNotePosition(node.x + canvasNodeSize(node).width + 48, node.y);
    const note = await createCanvasNote(text, null, position, node.id);
    if (!toOutline || !note) return;
    let outlineStage = canvasModel().nodes.find((item) => item.id === 'stage:outline');
    if (!outlineStage) {
      outlineStage = {
        id: 'stage:outline',
        kind: 'stage',
        stageId: 'outline',
        ...defaultStagePositions.outline,
      };
      canvasModel().nodes.push(outlineStage);
    }
    await addCanvasConnection(note.id, outlineStage.id);
    if (announce) announce.textContent = '路线已接入大纲入口；打开大纲即可继续加工。';
  };

  const createStarterPath = async () => {
    if (canvasNodes().length) return;
    const model = canvasModel();
    const stagePositions = {
      premise: { x: 64, y: 105 },
      outline: { x: 64, y: 535 },
      draft: { x: 64, y: 705 },
      revise: { x: 64, y: 875 },
    };
    const pathStages = ['premise', 'outline', 'draft', 'revise'];
    for (const stageId of pathStages) {
      let node = model.nodes.find((item) => item.id === `stage:${stageId}`);
      if (!node) {
        node = { id: `stage:${stageId}`, kind: 'stage', stageId };
        model.nodes.push(node);
      }
      Object.assign(node, stagePositions[stageId]);
      model.hiddenStageIds = model.hiddenStageIds.filter((hiddenId) => hiddenId !== stageId);
    }

    const stepId = model.nodes.some((node) => node.id === 'step:starter-story-engine')
      ? `step:starter-story-engine:${Date.now().toString(36)}`
      : 'step:starter-story-engine';
    const step = {
      id: stepId,
      kind: 'step',
      title: '提炼故事引擎',
      instruction: [
        '把上游作品材料提炼成能驱动长篇、而非只像一句梗概的故事引擎。只依据作者提供的正史；新增内容标为「提案」，缺失信息写「待作者决定」，不要静默补成设定。',
        '严格按以下标题交付，每节都给出具体、可继续写作的内容：',
        '【读者承诺 / 核心戏剧问题】一句话说明读者会持续追看的独特冲突与悬念。',
        '【主角欲望 / 错误信念 / 代价】写清眼前目标、阻碍其改变的信念，以及最不愿失去之物。',
        '【对抗力量的目标与策略】给出对方独立的目标、正在采取的行动和持续施压的理由，不写成等待主角打败的脸谱反派。',
        '【作品独有的因果机制】说明某条世界规则、关系或资源怎样具体改变人物能做的选择与必须付出的代价；不能只罗列名词。',
        '【三段升级链】严格写 1、2、3 三段；每段依次写「前因 → 主动选择 → 对抗反制 → 真实代价 → 新局面」，后段必须由前段结果逼出。',
        '【开篇场景与长线承诺】给出一个能直接演出的开篇行动场景，并说明它如何种下长线冲突。',
        '避免套用通用套路、空泛主题和强行反转。遮去人名与专名后若仍可原样套进同题材作品，重做最弱的因果环节。',
      ].join('\n'),
      qualityContract: STORY_ENGINE_QUALITY_CONTRACT,
      createdAt: Date.now(),
      x: 64,
      y: 275,
    };
    model.nodes.push(step);
    model.legacyStarterReviewed = true;
    model.starterTemplateVersion = 1;
    const legacyEdgeIds = new Set(legacyStarterEdges.map(([id]) => id));
    const starterEdgeIds = new Set([
      `edge:starter:${stepId}:premise`,
      `edge:starter:${stepId}:outline`,
      `edge:starter:${stepId}:draft`,
      `edge:starter:${stepId}:revise`,
    ]);
    model.edges = model.edges.filter((edge) => !legacyEdgeIds.has(edge.id) && !starterEdgeIds.has(edge.id));
    model.edges.push(
      { id: `edge:starter:${stepId}:premise`, from: 'stage:premise', to: stepId, kind: 'main' },
      { id: `edge:starter:${stepId}:outline`, from: stepId, to: 'stage:outline', kind: 'main' },
      { id: `edge:starter:${stepId}:draft`, from: 'stage:outline', to: 'stage:draft', kind: 'main' },
      { id: `edge:starter:${stepId}:revise`, from: 'stage:draft', to: 'stage:revise', kind: 'main' },
    );
    renderCanvasNodes();
    focusStarterPathStart();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(
      saveResult,
      '高质量起步路径已布置；故事引擎成果会沿连线进入大纲。',
      '路径尚未同步，当前页面仍保留草稿。',
    );
  };

  const rollStorySpark = async () => {
    const model = canvasModel();
    const notes = model.nodes.filter((node) => node.kind === 'note' && node.text?.trim());
    const source = notes.length ? notes[Math.floor(Math.random() * notes.length)] : null;
    const premise = String(
      document.getElementById('novelSetting')?.value || state.project?.setting || '',
    ).trim();
    const sourceText = String(source?.text || premise)
      .replace(/\s+/g, ' ')
      .trim();
    const fallbackStage = model.nodes.find((node) => node.id === 'stage:premise');
    const parent = source || fallbackStage;
    let text;
    if (sourceText) {
      const focus = sourceText.length > 68 ? `${sourceText.slice(0, 68)}…` : sourceText;
      const prompts = [
        `让「${focus}」制造一个自相矛盾的证据：什么才是真相？`,
        `如果「${focus}」成为主角必须付出的代价，他会失去什么？`,
        `换成对手的视角，「${focus}」其实是一次什么行动？`,
        `把「${focus}」变成一个具体场景：谁先行动，谁被迫回应？`,
        `让「${focus}」被一个不起眼的细节反转；那个细节是什么？`,
        `让两个人对「${focus}」有相反解释，并立刻逼他们选边。`,
      ];
      text = prompts[Math.floor(Math.random() * prompts.length)];
    } else {
      text = seeds[Math.floor(Math.random() * seeds.length)];
    }
    const position = parent
      ? findOpenNotePosition(parent.x + canvasNodeSize(parent).width + 48, parent.y)
      : null;
    await createCanvasNote(text, null, position, parent?.id || null);
    if (announce) announce.textContent = '新灵感已落到画布，并连回它的来源。';
  };

  const buildConfirmedMemoryContext = (targetChapterNumber = 0) => {
    const memory = state.memory || {};
    const targetChapter = Math.floor(Number(targetChapterNumber) || 0);
    const chapterScoped = targetChapter > 0;
    const isConfirmed = (key) =>
      typeof globalThis.trustStatusOf === 'function' && globalThis.trustStatusOf(key) === 'confirmed';
    const memoryText = (value) =>
      typeof globalThis.memoryTextOf === 'function' ? globalThis.memoryTextOf(value) : String(value || '');
    const hash = (value) =>
      typeof globalThis.simpleHash === 'function' ? globalThis.simpleHash(memoryText(value)) : '';
    const sections = [];
    const characters = Object.entries(memory.characters || {})
      .filter(([name]) => isConfirmed(`character:${name}`))
      .map(([name, info]) =>
        chapterScoped
          ? name
          : [
              name,
              info?.currentStatus ? `状态：${info.currentStatus}` : '',
              info?.goal ? `目标：${info.goal}` : '',
            ]
              .filter(Boolean)
              .join('；'),
      );
    if (characters.length)
      sections.push(
        `${chapterScoped ? '人物索引（当前章状态以此前章节为准）' : '人物'}：\n${characters.join('\n')}`,
      );
    const events = (memory.importantEvents || [])
      .filter((event) => {
        const chapter = Number(event?.chapter);
        return (
          (!chapterScoped || (Number.isFinite(chapter) && chapter < targetChapter)) &&
          hash(event) &&
          isConfirmed(`event:${event.chapter || ''}:${hash(event)}`)
        );
      })
      .slice(-8)
      .map((event) => `第${event.chapter || '?'}章：${event.event || memoryText(event)}`);
    if (events.length) sections.push(`已确认事件：\n${events.join('\n')}`);
    const cards = (memory.chapterCards || [])
      .filter((card) => {
        const chapter = Number(card?.chapter);
        return (
          isConfirmed(`chapterCard:${chapter}`) &&
          (!chapterScoped || (Number.isFinite(chapter) && chapter < targetChapter))
        );
      })
      .sort((left, right) => Number(left.chapter) - Number(right.chapter))
      .slice(-6);
    if (cards.length)
      sections.push(
        `已确认章节记忆卡：\n${cards
          .map((card) =>
            typeof globalThis.formatChapterCard === 'function'
              ? globalThis.formatChapterCard(card)
              : `第${card.chapter}章：${card.summary || card.title || ''}`,
          )
          .join('\n\n')}`,
      );

    const activeForeshadows = (memory.foreshadows?.active || [])
      .filter((item) => hash(item) && isConfirmed(`foreshadow:active:${hash(item)}`))
      .map((item) => ({
        item,
        text: memoryText(item?.desc || item).trim(),
        chapter: Number(item?.chapter ?? item?.sourceChapter ?? item?.introducedChapter),
      }))
      .filter((entry) => entry.text);
    if (!chapterScoped) {
      if (activeForeshadows.length)
        sections.push(`未解伏笔：\n${activeForeshadows.map((entry) => entry.text).join('\n')}`);
    } else {
      const normalizeForeshadow = (value) =>
        memoryText(value?.desc || value)
          .normalize('NFKC')
          .toLowerCase()
          .replace(/[\s\p{P}\p{S}]/gu, '');
      const established = new Map();
      for (const card of cards) {
        for (const foreshadow of card.foreshadowsAdded || []) {
          const key = normalizeForeshadow(foreshadow);
          const text = memoryText(foreshadow?.desc || foreshadow).trim();
          if (key && text) established.set(key, text);
        }
        for (const foreshadow of card.foreshadowsResolved || []) {
          const key = normalizeForeshadow(foreshadow);
          if (key) established.delete(key);
        }
      }
      const planned = new Map();
      for (const entry of activeForeshadows) {
        const key = normalizeForeshadow(entry.item);
        if (!key) continue;
        if (
          (Number.isFinite(entry.chapter) && entry.chapter > 0 && entry.chapter < targetChapter) ||
          established.has(key)
        ) {
          established.set(key, established.get(key) || entry.text);
        } else {
          planned.set(key, entry.text);
        }
      }
      if (established.size)
        sections.push(
          `第${targetChapter}章之前已出现且尚未回收的伏笔：\n${[...established.values()].join('\n')}`,
        );
      if (planned.size)
        sections.push(
          `后续或出现章节未标注的作者伏笔规划：\n${[...planned.values()].join('\n')}\n这些条目不代表已在目标章前发生或为视角人物所知，只能作为需要时提前铺垫的作者意图。`,
        );
    }
    return sections.length
      ? `【作者确认的长期记忆】\n${sections.join('\n\n')}\n自动提取但尚未确认的记忆不作为事实。`
      : '';
  };

  const buildGenerationContext = (sourceNodeId, writingTarget = 'outline') => {
    const bounded = (value, limit) => {
      const text = String(value || '').trim();
      return text.length <= limit ? text : `${text.slice(0, limit)}\n……（为控制上下文长度，后文略）`;
    };
    const project = state.project || {};
    const targetChapterNumber =
      writingTarget === 'chapter' ? Math.floor(Number(state.currentChapter || 0)) : 0;
    const setting = document.getElementById('novelSetting')?.value || project.setting || '';
    const characters =
      document.getElementById('novelCharacters')?.value ||
      state.storyBibleFreeText ||
      project.characters ||
      '';
    const sections = [
      project.title ? `书名：${project.title}` : '',
      project.genre ? `题材：${project.genre}` : '',
      setting ? `世界观与故事简介：\n${bounded(setting, 1800)}` : '',
      characters ? `人物与关键设定原文：\n${bounded(characters, 2400)}` : '',
      project.novelNote ? `全书写作注意事项：\n${bounded(project.novelNote, 900)}` : '',
      `创作规模：计划 ${Number(project.chapterCount) || '未定'} 章；单章目标 ${Number(project.wordsPerChapter) || '未定'} 字。`,
    ];
    if (typeof globalThis.syncCreativeRulesFromUI === 'function') globalThis.syncCreativeRulesFromUI();
    const rulesAndBible =
      typeof globalThis.buildExtraWritingContext === 'function'
        ? globalThis.buildExtraWritingContext(writingTarget)
        : '';
    if (rulesAndBible) sections.push(`作者规则、写作卡片与人工确认资料：\n${bounded(rulesAndBible, 7600)}`);
    if (targetChapterNumber)
      sections.push(
        `【章节时间边界】当前目标是第 ${targetChapterNumber} 章。不得把本章之后的事件、揭示或人物变化写成既成事实或角色已知信息；对全书当前人物状态，应以本章之前的章节记忆为准。`,
      );
    const confirmedMemory = buildConfirmedMemoryContext(targetChapterNumber);
    if (confirmedMemory) sections.push(confirmedMemory);

    const allOutline = Array.isArray(state.outline) ? state.outline : [];
    const targetOutlineChapter = targetChapterNumber
      ? allOutline.find((chapter) => Number(chapter.chapter) === targetChapterNumber)
      : null;
    if (targetOutlineChapter) {
      const plotPoints = (
        Array.isArray(targetOutlineChapter.plotPoints) ? targetOutlineChapter.plotPoints : []
      )
        .map((point) => String(typeof point === 'string' ? point : (point?.desc ?? point?.text ?? '')).trim())
        .filter(Boolean)
        .map((point, index) => `${index + 1}. ${bounded(point, 360)}`);
      sections.push(
        [
          `【当前写作目标｜第 ${targetChapterNumber} 章《${targetOutlineChapter.title || '未命名'}》】`,
          targetOutlineChapter.summary ? `大纲概要：${bounded(targetOutlineChapter.summary, 700)}` : '',
          plotPoints.length ? `剧情关键点：\n${plotPoints.join('\n')}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    }

    const relevantOutline = targetChapterNumber
      ? allOutline.filter((chapter) => Number(chapter.chapter) < targetChapterNumber)
      : allOutline;
    const outline = relevantOutline
      .slice(-8)
      .map(
        (chapter) =>
          `第${chapter.chapter}章《${chapter.title || '未命名'}》：${bounded(chapter.summary || '', 260)}`,
      );
    if (outline.length)
      sections.push(
        `${targetChapterNumber ? '本章之前的大纲（最近章节）' : '现有大纲（最近章节）'}：\n${outline.join('\n')}`,
      );
    const relevantChapters = Array.isArray(state.chapters)
      ? state.chapters.filter(
          (chapter) => !targetChapterNumber || Number(chapter.chapter) < targetChapterNumber,
        )
      : [];
    const written = relevantChapters
      .filter((chapter) => String(chapter.content || '').trim())
      .slice(-3)
      .map((chapter) => {
        const outlineChapter = (state.outline || []).find(
          (item) => Number(item.chapter) === Number(chapter.chapter),
        );
        return [
          `第${chapter.chapter}章《${outlineChapter?.title || '正文'}》`,
          outlineChapter?.summary ? `大纲：${bounded(outlineChapter.summary, 220)}` : '',
          `正文末尾：${bounded(String(chapter.content).slice(-420), 420)}`,
        ]
          .filter(Boolean)
          .join('\n');
      });
    if (written.length) sections.push(`已写正文连续性（最近章节）：\n${written.join('\n\n')}`);

    const styleSampleContext = globalThis.buildRecentProseStyleContext?.(writingTarget);
    if (styleSampleContext) sections.push(styleSampleContext);

    const upstreamGraph = collectIncomingCanvasGraph(sourceNodeId, {
      traverseStages: true,
      limit: 12,
      visitLimit: 128,
    });
    let upstreamBudget = 9200;
    const upstream = upstreamGraph.notes
      .map((node) => {
        if (upstreamBudget <= 0) return '';
        const perNodeLimit = node.kind === 'step' && node.output?.text ? 1900 : 700;
        const item = bounded(canvasNodeContent(node), Math.min(perNodeLimit, upstreamBudget));
        upstreamBudget -= item.length;
        return item;
      })
      .filter(Boolean);
    if (upstream.length)
      sections.push(`上游工作流节点（沿连线回溯）：\n${upstream.map((item) => `- ${item}`).join('\n')}`);
    const upstreamEdges = serializeCanvasGraphEdges(upstreamGraph);
    if (upstreamEdges) sections.push(upstreamEdges);
    sections.push(
      '事实优先级：作者填写的设定、人工确认资料和已有正文/大纲是正史；画布灵感是待选择的提案；未确认 AI 记忆不得覆盖正史。发现冲突时保留正史，并把提案改造成不冲突的可能性。',
    );
    return `\n\n【作品与创作上下文】\n${sections.filter(Boolean).join('\n\n')}`;
  };

  const sendCanvasPromptToChat = (
    prompt,
    sourceNodeId = null,
    mode = 'brainstorm',
    route = null,
    requestMetadata = {},
  ) => {
    globalThis.switchTab('chat');
    requestAnimationFrame(() => {
      const input = document.getElementById('chatInput');
      if (!input) return;
      const currentDraft = input.value.trim();
      if (currentDraft && currentDraft !== pendingCanvasBrainstorm?.prompt) {
        if (typeof toast === 'function')
          toast('聊天框有未发送内容，已为你保留；发送或清空后再运行画布任务。');
        input.focus();
        return;
      }
      input.value = prompt;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      pendingCanvasBrainstorm = { sourceNodeId, prompt, mode, route, ...requestMetadata };
      input.focus();
      if (state.baseURL && state.model && !state.generating) {
        requestAnimationFrame(() => {
          if (input.value.trim() === prompt && pendingCanvasBrainstorm?.prompt === prompt)
            globalThis.sendChatMessage?.();
        });
      } else if (!state.baseURL || !state.model) {
        if (typeof toast === 'function') toast('提示词已准备好；配置 AI 后可一键执行。');
      } else if (announce) {
        announce.textContent = '另一个 AI 任务正在运行；这条提示已保留在聊天框中。';
      }
    });
  };

  const BRAINSTORM_ROUTE_MIN_CHARS = 160;
  const BRAINSTORM_ROUTE_DUPLICATE_THRESHOLD = 0.9;

  const sendIdeaToChat = (text, sourceNodeId = null) => {
    const prompt = `你是与作者共同开发长篇小说的故事策划。请围绕这条灵感提出 3 条真正不同的剧情路线，不要替作者选定正史。

每条路线都必须：
- 从具体事件和人物主动选择开始，写清“选择 → 行动 → 阻力反制 → 代价 → 新局面”的因果链。
- 代价必须真实改变人物关系、目标、资源或处境；下一步悬念由本路线的行动自然引发。
- 与另外两条在冲突来源、人物选择或代价机制上明显不同，不可只换地点或措辞。
- 具体到可继续发展成章节的情节，避免抽象主题句、套路反派、巧合解围和空泛反转。

每条约 180—320 字（至少 ${BRAINSTORM_ROUTE_MIN_CHARS} 字），分行写成“行动因果 / 人物抉择 / 代价余波 / 后续悬念”。先在内部检查设定一致性、因果和差异度，只输出路线本身，不要开场、总结或替作者做决定。

当前灵感：\n${text}${buildGenerationContext(sourceNodeId)}`;
    sendCanvasPromptToChat(prompt, sourceNodeId, 'brainstorm');
  };

  const sendCanvasStepToChat = (step) => {
    const title = String(step.title || '').trim() || '未命名步骤';
    const instruction = String(step.instruction || '').trim();
    if (!instruction) {
      canvasWorld?.querySelector(`[data-canvas-step-instruction="${CSS.escape(step.id)}"]`)?.focus();
      if (announce) announce.textContent = '先写下这一步要完成的任务。';
      return;
    }
    const route = resolveCanvasStepModelRoute(step.id);
    const writingTarget = canvasStepWritingTarget(step.id);
    const upstreamGraph = collectIncomingCanvasGraph(step.id, {
      traverseStages: true,
      limit: 24,
      visitLimit: 256,
    });
    const unavailableSteps = upstreamGraph.notes.filter(
      (node) => node.kind === 'step' && canvasStepOutputState(node).status !== 'ready',
    );
    if (unavailableSteps.length) {
      const names = unavailableSteps
        .slice(0, 3)
        .map((node) => String(node.title || '未命名步骤').trim())
        .join('、');
      const message = `先完成上游步骤：${names}${unavailableSteps.length > 3 ? ' 等' : ''}`;
      if (typeof toast === 'function') toast(message);
      if (announce) announce.textContent = `${message}；过期或未生成的结果不会被下游误用。`;
      centerCanvasOnNode(unavailableSteps[0].id);
      return;
    }
    const generationContext = buildGenerationContext(step.id, writingTarget);
    const inputFingerprint = canvasStepInputFingerprint(step, writingTarget);
    const prompt = `执行作者自定义的创作步骤，并交付可直接使用的成果，不要只给建议或复述任务。不要改变作者已确认的事实。

【步骤】
${title}

【作者要求】
${instruction}${generationContext}

【成果质量门槛】
- 本步骤必须在上游成果上增加新的可用价值；不要只换词复述或靠增加篇幅伪装改进。上游未审校成果只是提案，不是事实。
- 剧情类写清“前因 → 人物选择 → 对抗阻力 → 真实代价 → 新局面”，并通过本作独有的规则、关系或人物缺陷推动因果；场景/正文要能直接演出，设定/人物要能改变角色可采取的行动。
- 交付前核对事实、动机、因果与重复；不成立的部分直接修正，无法确定的新增设定明确标为提案。只输出符合作者所需体裁的最终成果。

默认交付一个完整成果，不要机械拆成三个浅方案；只有作者明确要求多个选项时才提供多个彼此实质不同的方案。第一行用“【成果标题：简短标题】”，随后给出完整内容；不要开场白、自评或解释。`;
    sendCanvasPromptToChat(prompt, step.id, 'step', route, {
      writingTarget,
      inputFingerprint,
      qualityContract: step.qualityContract || '',
    });
  };

  const parseBrainstormBranches = (content) => {
    const lines = String(content || '').split(/\r?\n/);
    const options = [];
    let current = null;
    const flush = () => {
      if (!current) return;
      const text = current.lines.join('\n').trim();
      if (text) options.push({ title: current.title, text });
      current = null;
    };
    for (const line of lines) {
      const match = line.match(/^\s*(?:\d{1,2}[.)、．]|[一二三四五六七八九十]+[、.．])\s*(.+)$/);
      if (match) {
        flush();
        const text = match[1].trim();
        const title =
          (text.split(/[｜|：:—–]/, 1)[0] || text).trim().slice(0, 32) || `走向 ${options.length + 1}`;
        current = { title, lines: [text] };
      } else if (current && line.trim()) {
        current.lines.push(line.trim());
      }
    }
    flush();
    if (options.length) return options;
    const text = String(content || '').trim();
    const heading = text.match(/^\s*【(?:成果标题[：:])?([^】]{1,32})】/);
    return text ? [{ title: heading?.[1]?.trim() || '整段推演', text }] : [];
  };

  const branchCharacterBigrams = (branch) => {
    const normalized = String(branch?.text || '')
      .replace(String(branch?.title || ''), '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/行动因果|人物抉择|代价余波|后续悬念/gu, '')
      .replace(/[\s，。！？!?；;、：:,.“”‘’「」『』【】（）()《》<>—…·-]/gu, '');
    const characters = Array.from(normalized);
    const bigrams = new Set();
    for (let index = 0; index < characters.length - 1; index += 1)
      bigrams.add(characters[index] + characters[index + 1]);
    return bigrams;
  };

  const analyzeBrainstormBranches = (content) => {
    const branches = parseBrainstormBranches(content);
    const issues = [];
    if (branches.length !== 3) {
      issues.push(`剧情路线为 ${branches.length} 条，必须输出恰好 3 条。`);
      return issues;
    }
    branches.forEach((branch, index) => {
      const length = countWritingCharacters(branch.text);
      if (length < BRAINSTORM_ROUTE_MIN_CHARS)
        issues.push(
          `路线「${branch.title || `第 ${index + 1} 条`}」约 ${length} 字，少于至少 ${BRAINSTORM_ROUTE_MIN_CHARS} 字；需补足人物行动、阻力、代价与后续影响。`,
        );
    });
    for (let first = 0; first < branches.length; first += 1) {
      const left = branchCharacterBigrams(branches[first]);
      for (let second = first + 1; second < branches.length; second += 1) {
        const right = branchCharacterBigrams(branches[second]);
        const union = new Set([...left, ...right]);
        if (!union.size) continue;
        const shared = [...left].filter((ngram) => right.has(ngram)).length;
        const similarity = shared / union.size;
        if (similarity >= BRAINSTORM_ROUTE_DUPLICATE_THRESHOLD)
          issues.push(
            `路线「${branches[first].title}」与路线「${branches[second].title}」内容高度重复（字词特征重合约 ${Math.round(similarity * 100)}%）；必须改变冲突来源、人物选择和代价机制，而非只换标题或措辞。`,
          );
      }
    }
    return issues;
  };

  const persistChatMetadata = () => {
    try {
      const saving = typeof globalThis.saveState === 'function' ? globalThis.saveState() : Store.save();
      Promise.resolve(saving).catch((error) =>
        console.error('Unable to save canvas brainstorm metadata', error),
      );
    } catch (error) {
      console.error('Unable to save canvas brainstorm metadata', error);
    }
  };

  const persistCanvasStepResult = (request, response) => {
    if (request?.mode !== 'step' || !request.sourceNodeId) return;
    const step = canvasModel().nodes.find((node) => node.id === request.sourceNodeId && node.kind === 'step');
    if (!step) return;
    const content = String(response || '').trim();
    const failed = !content || content.startsWith('❌');
    const now = Date.now();
    if (failed) {
      step.execution = {
        status: 'failed',
        inputFingerprint: request.inputFingerprint || '',
        startedAt: Number(request.startedAt || now),
        updatedAt: now,
        error: content.slice(0, 240),
      };
    } else {
      const quality = getQualityMetadata(request);
      const writingTarget = request.writingTarget || canvasStepWritingTarget(step.id);
      step.output = {
        text: content,
        inputFingerprint: request.inputFingerprint || canvasStepInputFingerprint(step, writingTarget),
        writingTarget,
        qualityStatus: quality?.status || 'unverified',
        feedback: quality?.feedback || '',
        reason: quality?.reason || '',
        updatedAt: now,
      };
      step.execution = {
        status: 'completed',
        inputFingerprint: step.output.inputFingerprint,
        startedAt: Number(request.startedAt || now),
        updatedAt: now,
        error: '',
      };
    }
    renderCanvasNodes();
    void saveCanvasModel().then((result) =>
      announceCanvasSave(
        result,
        '步骤成果已保存，可沿连线交给下游。',
        '步骤成果暂未同步到服务端，当前页面仍保留草稿。',
      ),
    );
  };

  const startCanvasStepExecution = (request) => {
    if (request?.mode !== 'step' || !request.sourceNodeId) return;
    const step = canvasModel().nodes.find((node) => node.id === request.sourceNodeId && node.kind === 'step');
    if (!step) return;
    const now = Date.now();
    request.startedAt = now;
    step.execution = {
      status: 'running',
      inputFingerprint: request.inputFingerprint || '',
      startedAt: now,
      updatedAt: now,
      error: '',
    };
    renderCanvasNodes();
    void saveCanvasModel().then((result) => {
      if (!result?.projectSaved && typeof toast === 'function')
        toast('步骤运行状态暂未同步，成果仍会在完成后尝试保存。');
    });
  };

  const compactCanvasQualityText = (value, maxLength = 480) =>
    String(value || '')
      .replace(/\s+/gu, ' ')
      .trim()
      .slice(0, maxLength);

  const getQualityMetadata = (request) => {
    if (!request?.qualityPassStarted) return null;
    const status = request.qualityRejectionReason
      ? 'unverified'
      : request.qualityRepairAccepted
        ? 'repaired'
        : request.qualityReviewCompleted
          ? 'reviewed'
          : 'unverified';
    return {
      status,
      feedback: compactCanvasQualityText(
        [
          request.editorialFeedback,
          request.qualityContract === STORY_ENGINE_QUALITY_CONTRACT && request.qualityReviewIssues?.length
            ? `结构校验：${request.qualityReviewIssues.join('；')}`
            : '',
        ]
          .filter(Boolean)
          .join('；'),
        600,
      ),
      reason: compactCanvasQualityText(request.qualityRejectionReason, 600),
      ...(request.mode === 'outline' && String(request.outlineArchitecture || '').trim()
        ? { outlineArchitecture: String(request.outlineArchitecture).trim().slice(0, 12000) }
        : {}),
      ...(['chapter', 'continue'].includes(request.mode) && String(request.sceneBlueprint || '').trim()
        ? { sceneBlueprint: String(request.sceneBlueprint).trim().slice(0, 2400) }
        : {}),
    };
  };

  const qualityContentFingerprint = (value) => {
    const content = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${content.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  };

  // All editor surfaces compare reports with the same authored content. Progress
  // flags, generated IDs and record ordering do not change the story itself.
  const qualityReportContent = (target, value) => {
    if (target === 'outline')
      return JSON.stringify(
        (Array.isArray(value) ? value : [])
          .map((ch) => ({
            chapter: Number(ch.chapter) || ch.chapter,
            title: ch.title || '',
            summary: ch.summary || '',
            plotPoints: (ch.plotPoints || []).map((p) => (typeof p === 'string' ? p : p.desc || '')),
            note: ch.note || '',
          }))
          .sort((a, b) => Number(a.chapter) - Number(b.chapter)),
      );
    return typeof globalThis.sanitizeGeneratedText === 'function'
      ? globalThis.sanitizeGeneratedText(value)
      : String(value || '');
  };
  const createQualityReport = (metadata, target, chapterNumber, value) => ({
    ...metadata,
    target,
    chapterNumber: target === 'chapter' ? chapterNumber : undefined,
    fingerprintKind: 'story-content-v1',
    fingerprint: qualityContentFingerprint(qualityReportContent(target, value)),
    updatedAt: Date.now(),
  });
  const qualityReportFreshness = (report, target, value) => {
    if (!report?.fingerprint) return 'unknown';
    const content =
      report.fingerprintKind === 'story-content-v1'
        ? qualityReportContent(target, value)
        : target === 'outline'
          ? JSON.stringify(value || [])
          : qualityReportContent(target, value);
    return report.fingerprint === qualityContentFingerprint(content) ? 'current' : 'stale';
  };
  globalThis.generationQuality = Object.freeze({
    createReport: createQualityReport,
    freshness: qualityReportFreshness,
  });

  const qualityTargetContent = (target, chapterNumber = 0) => {
    if (target === 'outline') return JSON.stringify(state.outline || []);
    const content =
      Number(state.currentChapter) === chapterNumber
        ? document.getElementById('chapterEditor')?.value ||
          globalThis.getChapterContent?.(chapterNumber) ||
          ''
        : globalThis.getChapterContent?.(chapterNumber) || '';
    return typeof globalThis.sanitizeGeneratedText === 'function'
      ? globalThis.sanitizeGeneratedText(content)
      : String(content || '');
  };

  const generationQualityStore = () => state.uiDrafts?.generationQualityReports || null;

  const recordAuthorProseRevision = (event) => {
    if (!event?.isTrusted || window._bulkChapterRewriteActive) return;
    const target = event.target;
    const element = target?.nodeType === 1 ? target : target?.parentElement;
    const fullEditorBody = element?.closest?.('.full-editor-body');
    const proseEditor = element?.closest?.('#chapterEditor, #mobileChapterEditor, #inspirationEditor');
    if (!fullEditorBody && !proseEditor) return;

    const chapterNumber = Number(
      fullEditorBody?.dataset.chapter || proseEditor?.dataset.chapter || state.currentChapter || 0,
    );
    if (!Number.isInteger(chapterNumber) || chapterNumber <= 0) return;

    const rawContent = fullEditorBody ? fullEditorBody.innerText : proseEditor.value;
    const content =
      typeof globalThis.sanitizeGeneratedText === 'function'
        ? globalThis.sanitizeGeneratedText(rawContent)
        : String(rawContent || '').trim();
    state.uiDrafts = state.uiDrafts || {};
    const chapterKey = String(chapterNumber);
    const authorFeedback = (state.uiDrafts.authorProseFeedback ||= {});
    if (!content.trim()) {
      delete authorFeedback[chapterKey];
    } else {
      authorFeedback[chapterKey] = {
        fingerprint: qualityContentFingerprint(content),
        updatedAt: Date.now(),
      };
    }
    if (!Object.keys(authorFeedback).length) delete state.uiDrafts.authorProseFeedback;

    const report = generationQualityStore()?.chapters?.[chapterKey];
    if (report?.fingerprint) {
      if (content.trim() && qualityContentFingerprint(content) !== report.fingerprint)
        report.authorRevision = authorFeedback[chapterKey];
      else delete report.authorRevision;
    }
    requestAnimationFrame(refreshGenerationQualityReports);
  };

  const recordMainGenerationQuality = async (request) => {
    const metadata = getQualityMetadata(request);
    if (!request?.main || !metadata) return;
    const target = request.mode === 'outline' ? 'outline' : 'chapter';
    const chapterNumber = target === 'chapter' ? Number(request.chapterNumber || 0) : 0;
    if (target === 'chapter' && (!Number.isInteger(chapterNumber) || chapterNumber <= 0)) return;
    const content = qualityTargetContent(target, chapterNumber);
    if (!content.trim()) return;
    const report = createQualityReport(
      { ...metadata, mode: request.mode },
      target,
      chapterNumber,
      target === 'outline' ? state.outline : content,
    );
    state.uiDrafts = state.uiDrafts || {};
    const reports = state.uiDrafts.generationQualityReports || { outline: null, chapters: {} };
    reports.chapters = reports.chapters && typeof reports.chapters === 'object' ? reports.chapters : {};
    if (target === 'outline') reports.outline = report;
    else reports.chapters[String(chapterNumber)] = report;
    state.uiDrafts.generationQualityReports = reports;
    refreshGenerationQualityReports();
    try {
      const saving = typeof globalThis.saveState === 'function' ? globalThis.saveState() : Store.save();
      await Promise.resolve(saving);
    } catch (error) {
      console.error('Unable to save generation quality report', error);
      if (typeof toast === 'function') toast('审校说明暂未保存；正文和大纲不受影响。');
    }
  };

  const generationQualityReportNode = (target) => {
    const selector = `[data-generation-quality-target="${target}"]`;
    let report = document.querySelector(selector);
    if (report) return report;
    report = document.createElement('details');
    report.className = 'generation-quality-report';
    report.dataset.generationQualityTarget = target;
    report.innerHTML = '<summary></summary><div class="generation-quality-detail"></div>';
    if (target === 'outline') {
      const container = document.getElementById('outlineContainer');
      container?.insertAdjacentElement('beforebegin', report);
    } else {
      document.querySelector('#tab-write .writer-toolbar-options')?.append(report);
    }
    return report;
  };

  function refreshGenerationQualityReports() {
    const reports = generationQualityStore();
    const targets = [
      ['outline', reports?.outline, qualityTargetContent('outline')],
      [
        'chapter',
        reports?.chapters?.[String(Number(state.currentChapter || 0))],
        qualityTargetContent('chapter', Number(state.currentChapter || 0)),
      ],
    ];
    targets.forEach(([target, report, currentContent]) => {
      if (!report || !String(currentContent || '').trim()) {
        document.querySelector(`[data-generation-quality-target="${target}"]`)?.remove();
        return;
      }
      const reportNode = generationQualityReportNode(target);
      const stale =
        qualityReportFreshness(report, target, target === 'outline' ? state.outline : currentContent) !==
        'current';
      reportNode.className = `generation-quality-report is-${stale ? 'stale' : report.status}`;
      const summary = reportNode.querySelector('summary');
      const detail = reportNode.querySelector('.generation-quality-detail');
      if (summary)
        summary.textContent = stale
          ? '内容已改 · 审校已过期'
          : report.status === 'reviewed'
            ? '✓ 审校通过'
            : report.status === 'repaired'
              ? '↺ 修复后通过'
              : '! 审校未完成';
      if (detail) {
        const feedback = document.createElement('div');
        feedback.textContent = stale
          ? '内容在审校后发生了变化；这份诊断只对应生成时的版本。'
          : report.status === 'unverified'
            ? report.reason || '精修未完成，当前内容是保留的初稿。'
            : report.feedback || '独立内容审校已完成，修订结果通过结构检查。';
        detail.replaceChildren(feedback);
        const outlineArchitecture = String(report.outlineArchitecture || '').trim();
        if (outlineArchitecture) {
          const architectureDetails = document.createElement('details');
          architectureDetails.className = 'generation-quality-blueprint';
          architectureDetails.dataset.outlineArchitecture = 'true';
          const architectureSummary = document.createElement('summary');
          architectureSummary.textContent = stale ? '生成时的故事结构蓝图 · 内容已改' : '故事结构蓝图';
          const architectureText = document.createElement('div');
          architectureText.className = 'generation-quality-blueprint-text';
          architectureText.textContent = outlineArchitecture;
          architectureDetails.append(architectureSummary, architectureText);
          detail.append(architectureDetails);
        }
        const sceneBlueprint = String(report.sceneBlueprint || '').trim();
        if (sceneBlueprint) {
          const sceneDetails = document.createElement('details');
          sceneDetails.className = 'generation-quality-blueprint';
          sceneDetails.dataset.sceneBlueprint = 'true';
          const sceneSummary = document.createElement('summary');
          const blueprintLabel = report.mode === 'continue' ? '续写片段蓝图' : '场景蓝图';
          sceneSummary.textContent = stale ? `生成时的${blueprintLabel} · 内容已改` : blueprintLabel;
          const sceneText = document.createElement('div');
          sceneText.className = 'generation-quality-blueprint-text';
          sceneText.textContent = sceneBlueprint;
          sceneDetails.append(sceneSummary, sceneText);
          detail.append(sceneDetails);
        }
      }
    });
  }

  const installGenerationQualityReports = () => {
    const wrapAndRefresh = (name) => {
      const original = globalThis[name];
      if (typeof original !== 'function' || original.generationQualityWrapped) return;
      const wrapped = function (...args) {
        const result = original.apply(this, args);
        requestAnimationFrame(() => {
          refreshGenerationQualityReports();
          if (['renderOutline', 'renderWriteTab', 'navChapter'].includes(name)) refreshWorkflow();
        });
        return result;
      };
      wrapped.generationQualityWrapped = true;
      globalThis[name] = wrapped;
    };
    ['renderOutline', 'renderWriteTab', 'navChapter', 'switchTab'].forEach(wrapAndRefresh);
    document.getElementById('chapterEditor')?.addEventListener('input', refreshGenerationQualityReports);
    document.addEventListener('input', recordAuthorProseRevision, true);
    refreshGenerationQualityReports();
  };

  const canvasBranchActionKey = (chatId, messageIndex, optionText) =>
    JSON.stringify([chatId, messageIndex, optionText]);

  const parseOutlineOutputContract = (prompt) => {
    const source = String(prompt || '');
    const clauses = source
      .split(/[\n。！？；;]/u)
      .map((clause) => clause.trim())
      .filter(Boolean);
    const findContractRange = (labelPattern, rangePattern) => {
      for (const clause of clauses) {
        if (!labelPattern.test(clause)) continue;
        const match = clause.match(rangePattern);
        if (match) return match;
      }
      return null;
    };
    const summaryMatch = findContractRange(
      /(?:内容|章节|每章|每一章|各章|逐章)?(?:概要|摘要|概述)/u,
      /(\d{2,4})\s*(?:个字|汉字|字|字符)?\s*[-‐‑–—－~～至到]\s*(\d{2,4})\s*(?:个字|汉字|字|字符)/u,
    );
    const plotPointMatch = findContractRange(
      /(?:剧情关键点|关键剧情点|关键点|剧情点|情节点|事件点)/u,
      /(\d{1,2})\s*(?:个|项|条)?\s*[-‐‑–—－~～至到]\s*(\d{1,2})\s*(?:个|项|条)/u,
    );
    const readRange = (match) => {
      if (!match) return null;
      const minimum = Number(match[1]);
      const maximum = Number(match[2]);
      return Number.isInteger(minimum) && Number.isInteger(maximum) && maximum >= minimum
        ? { minimum, maximum }
        : null;
    };
    const summaryRange = readRange(summaryMatch);
    const plotPointRange = readRange(plotPointMatch);
    return summaryRange || plotPointRange ? { summaryRange, plotPointRange } : null;
  };

  const EDITORIAL_DIAGNOSIS_MARKER = '【精修诊断】';
  const EDITORIAL_ARTIFACT_MARKER = '【修订稿】';
  const OUTLINE_ARCHITECTURE_MARKER = '【故事结构蓝图】';
  const CHAPTER_SCENE_BLUEPRINT_MARKER = '【本章场景蓝图】';
  const CHAPTER_SCENE_BODY_MARKER = '【本章正文开始】';
  const CHAPTER_SCENE_CARD_LINE =
    /^\s*(?:[-*•]\s*)?(?:\*\*)?(?:场景\s*[0-9０-９一二三四五六七八九十]+|[0-9０-９]+)\s*[.、)）:：|｜—-]/u;
  const CHAPTER_SCENE_BODY_HEADING =
    /(?:^|\r?\n)[ \t]*(?:【(?:本章)?正文(?:开始)?】|#{1,3}[ \t]*正文(?:开始)?|正文开始[：:]?)[ \t]*(?:\r?\n|$)/u;
  const outlineArchitecturePlanningProtocol = (expectation) =>
    [
      '【故事结构规划任务】',
      '你现在只做故事架构，不输出 JSON，不写章节正文，也不回答或解释作者。把题材承诺、读者期待、已确认设定、人物目标和作者要求组织成一条有辨识度、能持续推进的故事因果链。',
      '先明确：一句话故事核心、贯穿全书的戏剧问题、主角可行动的具体欲望与自我矛盾、主要对抗力量自己的目标和策略、失败代价，以及本作独有的冲突机制如何迫使主角在两种都要付代价的选择间取舍、又如何被对手利用。做“替换性测试”：若删去作品专有名词后剧情仍可原样套进任意同题材作品，说明独特设定尚未进入因果。不要把世界观名词当成剧情。',
      '再设计 3–6 段因果弧（不套固定三幕公式）：每段写清起始局势、压力如何改变、主角作出的关键选择及代价、弧末不可逆的新状态、留下什么下一步问题。升级要改变冲突机制、关系或代价，不能只换更强敌人；伏笔先有可回指的铺垫，再改变人物判断或行动。',
      expectation?.count > 0 && expectation.count <= 36
        ? `本次交付范围是第 ${expectation.start}–${expectation.end} 章，共 ${expectation.count} 章。为每章给出一句独特的叙事职责与状态变化，确保前因后果、人物选择、信息递进和章间接力；不允许用重复冲突填满章数。${expectation.kind === 'continue' ? '这是续写大纲，只规划新增范围；尊重已有章节的事实和结果，不重写旧章。' : ''}`
        : expectation?.count > 36
          ? `本次交付范围是第 ${expectation.start}–${expectation.end} 章，共 ${expectation.count} 章。先按可执行的故事弧为章节分配阶段目标与转折点，标出本批次开端、中点、关键代价和收束交接；避免对如此长的篇幅逐章写重复的空泛梗概。${expectation.kind === 'continue' ? '只规划新增范围，并从既有大纲当前状态自然接续。' : ''}`
          : '若作者明确了章数或分段范围，架构必须服从该范围；若未给范围，设计可扩展但有明确阶段目标的主线。',
      '保护作者的设定、资料库确认内容、已写正文和已选画布分支；未确认 AI 记忆只作为待核对线索。不要强加巧合解围、无代价胜利、套路反转或强行悬崖钩子。',
      '遵守作者明确的人称、POV 角色和切换规则；资料卡缺失不是阻止构思的前置条件，资料不完整时用清楚的叙事功能或待确认槽位，不把推测伪装成设定。',
      `严格只输出故事结构蓝图，不生成最终大纲：\n${OUTLINE_ARCHITECTURE_MARKER}\n核心戏剧问题：……\n人物与对抗力量：……\n故事因果弧：……\n章节职责（如适用）：……`,
    ].join('\n');

  const addOutlineArchitecturePlanningProtocol = (messages, expectation) => {
    let lastUserIndex = -1;
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    messages.forEach((message, index) => {
      if (message.role === 'user') lastUserIndex = index;
    });
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
      if (index === systemIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n当前处于故事架构阶段，只输出结构蓝图，不生成 JSON 大纲。`,
        };
      if (index === lastUserIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n${outlineArchitecturePlanningProtocol(expectation)}`,
        };
      return message;
    });
  };

  const addPlannedOutlineDraftProtocol = (messages, architecture, expectation) => {
    const scope =
      expectation?.kind === 'continue' ? '只生成本次新增章节，不复写已有大纲。' : '生成完整的章节大纲。';
    const protocol = [
      '【按故事结构蓝图生成章节大纲】',
      `【故事结构蓝图｜结构参照】\n${architecture}`,
      `依据蓝图把宏观因果落实为具体、可写的章节事件。${scope}蓝图是规划参照，不是新增正史；若与作者确认资料、已写正文或明确要求冲突，以权威事实为准。`,
      '逐章区分叙事职责：让前章结果迫使下一章选择，选择改变信息、关系、资源或处境并留下代价。避免重复发现—受阻—解围；每个关键点都应能在正文中演出，而非抽象总结。',
      '严格遵守本任务已有的 JSON 字段、章节编号、章节数、概要篇幅和关键点数量契约；不得输出结构蓝图、Markdown、代码围栏或说明。',
    ].join('\n');
    let lastUserIndex = -1;
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    messages.forEach((message, index) => {
      if (message.role === 'user') lastUserIndex = index;
    });
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
      if (index === systemIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n当前处于结构化大纲写作阶段。把已规划的故事因果弧落实为任务要求的章节 JSON；只输出 JSON，不重复蓝图。`,
        };
      if (index === lastUserIndex) return { ...message, content: `${message.content || ''}\n\n${protocol}` };
      return message;
    });
  };

  const parseOutlineArchitecture = (text) => {
    const source = String(text || '').trim();
    const markerIndex = source.indexOf(OUTLINE_ARCHITECTURE_MARKER);
    let architecture =
      markerIndex < 0
        ? source
            .replace(/^```(?:text|markdown)?\s*/i, '')
            .replace(/```\s*$/u, '')
            .trim()
        : source.slice(markerIndex + OUTLINE_ARCHITECTURE_MARKER.length).trim();
    architecture = architecture.replace(/^[:：\s]+/u, '').trim();
    if (architecture.length < 80) throw new Error('故事结构蓝图内容不足');
    if (architecture.length > 16000) {
      const head = architecture.slice(0, 11200).trimEnd();
      const tail = architecture.slice(-3600).trimStart();
      architecture = `${head}\n\n【蓝图已压缩以继续生成】\n${tail}`;
    }
    return architecture;
  };

  const sceneBlueprintPlanningProtocol = (mode) =>
    [
      '【场景蓝图规划任务】',
      '你现在只做章节结构策划，不写小说正文，不回答或解释作者。先结合已有正史、人物动机、视角规则、本章大纲与用户要求，设计一组能直接指导写作的场景卡。',
      '先找出本章最有辨识度的戏剧问题：作品独有的规则、关系或限制怎样逼人物作出困难选择，选择又怎样留下代价。若只是把通用桥段换上专有名词，重新设计因果。对关键选择先在内部比较不同的、都符合人物动机的做法，再选更具体、较少套路且后果自然的一条；不要输出备选推理。',
      '蓝图通常 2–6 场；短章或单一连续事件允许 1 场，复杂章可按实际因果增加，但最多 8 场。按时间、空间、行动目标和局势转变划分，不按剧情关键点数量机械切场，也不要把不同冲突硬塞进同一场。',
      '每场压成一行，每卡约 100–220 字，整份蓝图不超过 2400 字；按实际需要写清：场景编号｜本场戏的功能或未决问题｜视角人物与时地｜人物此刻想要什么｜具体阻力或对手的主动策略｜人物尝试的办法与关键选择｜场末可观察到的局势位移及代价｜情绪/关系怎样通过行为或潜台词微变｜作品特有的规则、关系、物件或环境细节如何参与因果（只写自然有效的）｜承载的 PP 编号（如有）｜建议字数。场与场之间必须有因果、信息或状态交接；整章合计覆盖全部作者要求与剧情关键点，保持顺序，不增加正史。',
      '分配建议字数时服从作者的章节篇幅要求，把篇幅留给关键选择、冲突和后果，不平均填充、不用环境描写凑数。避免通用套路和固定幕式；不是每场都要反转、钩子或同样的情绪节拍。',
      '场景卡是创作意图，不是逐项填空表。整章应有节奏和关系变化的起伏；让细节来自本作具体情境，而非每场硬塞一个感官描写、伏笔或金句。',
      mode === 'continue'
        ? '续写只规划现有正文最后真实状态之后的新增场景：不得重排、复述或改写已完成内容；优先推进尚未发生的剧情点，若其已完成则写其后果或自然收束，不抢写后续章节。'
        : '整章规划必须覆盖本章完整交付范围。',
      '不得把推测写成设定事实。若输入资料冲突，遵循已确认资料和正文事实，并在场景卡中采用不依赖冲突信息的稳妥行动。',
      `严格只输出场景卡，不加前言、诊断或结语，格式如下：\n${CHAPTER_SCENE_BLUEPRINT_MARKER}\n场景1｜……`,
    ].join('\n');

  const addSceneBlueprintPlanningProtocol = (messages, mode = 'chapter') => {
    const scopeNote =
      mode === 'continue'
        ? '当前是续写前的规划阶段，只返回新增内容的场景蓝图；不要生成正文。'
        : '当前是章节正文生成前的规划阶段，只返回场景蓝图；不要生成正文。';
    let lastUserIndex = -1;
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    messages.forEach((message, index) => {
      if (message.role === 'user') lastUserIndex = index;
    });
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
      if (index === systemIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n${scopeNote}`,
        };
      if (index === lastUserIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n${sceneBlueprintPlanningProtocol(mode)}`,
        };
      return message;
    });
  };

  const addPlannedChapterDraftProtocol = (messages, mode, blueprint) => {
    const continuation = mode === 'continue';
    const protocol = [
      continuation ? '【按场景蓝图续写｜正文阶段】' : '【按场景蓝图写作｜正文阶段】',
      `【本轮场景蓝图｜结构参照】\n${blueprint}`,
      continuation
        ? '只续写已有正文之后的内容，不重写、复述或换词重复已有段落；按蓝图推进尚未发生的关键事件，若其已发生则只写真实后果或自然收束。人物的目标、策略和声线要从具体行动与应对中显现。'
        : '按蓝图的因果与场景交接写成本章完整正文，落实每个关键选择及其后果，并覆盖全部作者要求与剧情关键点。用人物自己的判断、策略和关系写出场景，不要把蓝图逐栏扩写成清单。',
      '蓝图是临时组织提案，不是新增正史。若蓝图与正文、已确认资料或作者要求冲突，以这些权威信息为准；允许为因果、人物真实性和节奏做必要调整，但须保留关键事件与顺序。',
      '将建议字数用于控制各场景篇幅，总体遵守用户的篇幅要求；写出可读的完整场景，不把蓝图扩写成摘要，也不重复说明已知背景。',
      '让各场景的句子节奏、信息密度和张力随情境变化；不用连续的“目标—受阻—反转”模板。作品特有的设定必须影响行动或代价，不能只作装饰。',
      '严格只输出可直接采用的小说正文，不输出蓝图、场景编号、前言或创作说明。保留任务要求的剧情点标记，并且只在对应事件真正发生后标注。',
    ].join('\n');
    let lastUserIndex = -1;
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    messages.forEach((message, index) => {
      if (message.role === 'user') lastUserIndex = index;
    });
    if (lastUserIndex < 0) return messages;
    return messages.map((message, index) => {
      if (index === systemIndex)
        return {
          ...message,
          content: `${message.content || ''}\n\n当前处于正文写作阶段。依据用户消息末尾的临时场景蓝图完成正文；不要重新输出蓝图，也不要将蓝图视为已确认的新设定。`,
        };
      if (index === lastUserIndex) return { ...message, content: `${message.content || ''}\n\n${protocol}` };
      return message;
    });
  };

  const parseSceneBlueprintPlan = (text) => {
    const source = String(text || '').trim();
    const markerIndex = source.indexOf(CHAPTER_SCENE_BLUEPRINT_MARKER);
    if (markerIndex < 0) throw new Error('场景规划没有按要求返回蓝图；原章节已保留，请重试。');
    const blueprint = source.slice(markerIndex + CHAPTER_SCENE_BLUEPRINT_MARKER.length).trim();
    const lines = blueprint
      .split(/\r\n|\n|\r/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const cards = lines.filter((line) => CHAPTER_SCENE_CARD_LINE.test(line));
    if (!cards.length || cards.length !== lines.length)
      throw new Error('场景规划结果不完整或混入正文；原章节已保留，请重试。');
    if (cards.length > 8 || blueprint.length > 3200)
      throw new Error('场景蓝图超过安全长度；原章节已保留，请重试。');
    return cards.join('\n').slice(0, 3200);
  };

  const parseChapterSceneBlueprintDraft = (text) => {
    const source = String(text || '').trim();
    const blueprintStart = source.indexOf(CHAPTER_SCENE_BLUEPRINT_MARKER);
    const bodyHeading = CHAPTER_SCENE_BODY_HEADING.exec(source);
    const blueprintBodyStart =
      blueprintStart >= 0 ? blueprintStart + CHAPTER_SCENE_BLUEPRINT_MARKER.length : -1;
    if (bodyHeading) {
      const headingPrefixLength = bodyHeading[0].match(/^\r?\n/u)?.[0].length || 0;
      const bodyHeadingStart = bodyHeading.index + headingPrefixLength;
      if (blueprintStart >= 0 && blueprintStart > bodyHeadingStart)
        return {
          blueprint: '',
          draft: '',
          error: '场景蓝图与正文分隔顺序错误；原章节已保留，请重试。',
        };
      const blueprint =
        blueprintStart >= 0 ? source.slice(blueprintBodyStart, bodyHeadingStart).trim().slice(0, 2400) : '';
      const draft = source.slice(bodyHeading.index + bodyHeading[0].length).trim();
      return draft
        ? { blueprint, draft }
        : {
            blueprint,
            draft: '',
            error:
              blueprintStart >= 0
                ? '模型只返回了场景蓝图，没有返回章节正文；原章节已保留，请重试。'
                : '模型没有返回章节正文；原章节已保留，请重试。',
          };
    }

    if (!source) return { blueprint: '', draft: '', error: '模型没有返回章节正文；原章节已保留，请重试。' };

    const lineRecords = [];
    let cursor = 0;
    for (const line of source.split(/\r\n|\n|\r/u)) {
      lineRecords.push({ line, start: cursor });
      cursor += line.length;
      if (source.startsWith('\r\n', cursor)) cursor += 2;
      else if (source[cursor] === '\n' || source[cursor] === '\r') cursor += 1;
    }
    const firstNonEmptyLine = lineRecords.find(({ line }) => line.trim());
    const unmarkedSceneStart =
      blueprintStart < 0 && firstNonEmptyLine && CHAPTER_SCENE_CARD_LINE.test(firstNonEmptyLine.line)
        ? firstNonEmptyLine.start
        : -1;
    const hasBlueprint = blueprintStart >= 0 || unmarkedSceneStart >= 0;
    if (!hasBlueprint) return { blueprint: '', draft: source };

    const planStart = blueprintStart >= 0 ? blueprintStart : unmarkedSceneStart;
    const scanStart = blueprintStart >= 0 ? blueprintBodyStart : unmarkedSceneStart;
    let foundSceneCard = false;
    let draftStart = -1;
    for (const { line, start } of lineRecords) {
      const lineEnd = start + line.length;
      if (lineEnd <= scanStart) continue;
      const candidate = line.slice(Math.max(0, scanStart - start)).trim();
      if (!candidate || /^```(?:[\w+-]+)?$/u.test(candidate) || /^---+$/u.test(candidate)) continue;
      if (CHAPTER_SCENE_CARD_LINE.test(candidate)) {
        foundSceneCard = true;
        continue;
      }
      if (foundSceneCard) {
        draftStart = start;
        break;
      }
      return {
        blueprint: '',
        draft: '',
        error: '无法识别场景蓝图与正文的边界；原章节已保留，请重试。',
      };
    }

    const draft = draftStart >= 0 ? source.slice(draftStart).trim() : '';
    if (!foundSceneCard || !draft)
      return {
        blueprint: source
          .slice(planStart, source.length)
          .replace(CHAPTER_SCENE_BLUEPRINT_MARKER, '')
          .trim()
          .slice(0, 2400),
        draft: '',
        error: '模型只返回了场景蓝图，没有返回章节正文；原章节已保留，请重试。',
      };
    const blueprint = source
      .slice(planStart, draftStart)
      .replace(CHAPTER_SCENE_BLUEPRINT_MARKER, '')
      .trim()
      .slice(0, 2400);
    return { blueprint, draft };
  };

  const EDITORIAL_REVIEW_SYSTEM = [
    '【本轮角色：独立内容编辑】',
    '将上一条 assistant 回复视为候选初稿，不为它辩护；以作者要求、已确认事实与作品规则作最终判断。',
    '先看作品辨识度与读者承诺，再看人物选择是否驱动因果并留下代价、章节或场景是否实质重复、铺垫是否兑现、情绪与节奏是否可信，最后才修辞。只指出有文本证据且影响阅读的问题；不把格式正确当作内容优秀，也不为证明评审有用而强改有效内容。',
    '优先处理最影响阅读的 1–2 个具体问题，再交付完整修订稿。不得添加设定或抹平作者声音；必须保留事实、视角、人称、体裁、格式与成立的关键事件。',
    '只输出本轮任务指定的交付格式，不展示逐步推理。',
  ].join('\n');
  const EDITORIAL_OUTPUT_CONTRACT = [
    '【精修交付格式】',
    `先用“${EDITORIAL_DIAGNOSIS_MARKER}”写 0–2 条简短、可执行的发现，总计不超过 120 字。每条须指向具体章、事件、段落或句子，并给出改法；不要泛评、打分或展开推理。若无实质缺陷，明确写“无需实质改动”。`,
    `随后单独输出“${EDITORIAL_ARTIFACT_MARKER}”，其后只能是完整、可直接采用的修订成果，并严格遵守本任务要求的 JSON、路线或正文格式；诊断不得混进成果。`,
  ].join('\n');

  const appendEditorialOutputContract = (prompt) => `${prompt}\n\n${EDITORIAL_OUTPUT_CONTRACT}`;

  const withEditorialReviewSystem = (messages) => {
    const systemIndex = messages.findIndex((message) => message.role === 'system');
    if (systemIndex < 0) return messages;
    return messages.map((message, index) =>
      index === systemIndex
        ? { ...message, content: `${message.content || ''}\n\n${EDITORIAL_REVIEW_SYSTEM}` }
        : message,
    );
  };

  const parseEditorialRefinement = (text) => {
    const source = String(text || '').trim();
    const diagnosisIndex = source.indexOf(EDITORIAL_DIAGNOSIS_MARKER);
    const artifactIndex = source.indexOf(EDITORIAL_ARTIFACT_MARKER);
    const invalidFormat = (message) => {
      const error = new Error(message);
      error.code = 'EDITORIAL_FORMAT';
      return error;
    };

    if (diagnosisIndex < 0 && artifactIndex < 0)
      throw invalidFormat('缺少精修诊断与修订稿标记，不能确认本轮审校已完成');
    if (diagnosisIndex < 0) throw invalidFormat('修订稿前缺少精修诊断标记');
    if (artifactIndex < 0) throw invalidFormat('返回了诊断，但缺少最终修订稿标记');
    if (diagnosisIndex >= artifactIndex && diagnosisIndex >= 0) throw invalidFormat('诊断与修订稿的顺序错误');
    if (
      source.indexOf(EDITORIAL_DIAGNOSIS_MARKER, diagnosisIndex + EDITORIAL_DIAGNOSIS_MARKER.length) >= 0 ||
      source.indexOf(EDITORIAL_ARTIFACT_MARKER, artifactIndex + EDITORIAL_ARTIFACT_MARKER.length) >= 0
    )
      throw invalidFormat('重复输出了诊断或修订稿标记');

    const feedback = source
      .slice(diagnosisIndex + EDITORIAL_DIAGNOSIS_MARKER.length, artifactIndex)
      .trim()
      .slice(0, 600);
    if (!feedback) throw invalidFormat('精修诊断内容为空');
    const artifact = source.slice(artifactIndex + EDITORIAL_ARTIFACT_MARKER.length).trim();
    if (!artifact) throw invalidFormat('修订稿内容为空');
    return { feedback, artifact };
  };

  const parseQualityRepairArtifact = (text) => {
    const source = String(text || '').trim();
    const artifactIndex = source.indexOf(EDITORIAL_ARTIFACT_MARKER);
    if (artifactIndex >= 0) {
      const artifact = source.slice(artifactIndex + EDITORIAL_ARTIFACT_MARKER.length).trim();
      if (!artifact) throw new Error('针对性修复稿为空');
      return artifact;
    }
    if (source.includes(EDITORIAL_DIAGNOSIS_MARKER))
      throw new Error('针对性修复只返回了诊断，没有修复后的成果');
    if (!source) throw new Error('针对性修复没有返回成果');
    return source;
  };

  const buildCanvasRefinementPrompt = (
    mode,
    outlineExpectation = null,
    chapterExpectation = null,
    draftTruncated = false,
    outlineOutputContract = null,
    sceneBlueprint = '',
    outlineArchitecture = '',
  ) => {
    if (mode === 'outline')
      return appendEditorialOutputContract(
        [
          '【结构精修任务】',
          '你是长篇小说的结构编辑。不要只做同义改写；先检查整条故事因果链，再直接修订初稿，交付更能驱动读者往下读的大纲。',
          ...(outlineArchitecture
            ? [
                `【故事结构蓝图｜质量参照】\n${outlineArchitecture}\n逐章检查大纲是否兑现核心戏剧问题、对抗力量的主动策略和各段因果弧。蓝图帮助核对结构，不是新增正史；若蓝图与作者要求、已确认资料或正文冲突，以权威事实为准。`,
              ]
            : []),
          '逐章核对：本章由什么前因触发、人物想达成什么、遇到什么具体阻力、做了什么主动选择、付出什么代价、局势因此如何改变。关键事件要靠人物选择和既有事实推进，不能靠巧合代替因果；后续章节要承接前章造成的变化。',
          '比较各章的叙事功能与章末状态：主角获得或失去什么信息、关系、资源、信任或退路，下一章因此不得不怎样行动。共享意象和母题可以回环，但事件、人物选择与结果应有实质推进；不能只用换词制造“新剧情”。',
          '保护这部作品最有辨识度的戏剧承诺，让世界规则、人物欲望与主要冲突彼此咬合；关键揭示应回收可追溯的铺垫并改变判断或行动。不要用生硬反转、单纯加大威胁或通用桥段冒充升级。',
          '把“发现秘密、陷入危机、关系变化”等抽象结论改成可写、可见、可验证的事件；每章必须推进新的信息、选择、关系或处境，不能靠重复转述凑进度。',
          '每章概要内部不得重复同一句或换词重述同一因果来凑篇幅；需要扩展时补充新的行动、阻力、选择、证据或后果。',
          '让本作独有的规则、关系或社会矛盾真正影响人物能做什么、要付出什么；不能只把专有名词贴在通用剧情模板上。做“替换性测试”：暂时遮掉人名和专有名词，若剧情因果仍可原样套进任意同题材作品，就让规则、关系或人物缺陷真正改变行动与代价，而不是堆设定词或加反转。检查对抗力量是否有自己的目标与行动，人物选择是否留下持续后果；避免连续章节重复相同的“发现线索—受阻—他人解围”。',
          '伏笔与揭示要能回指具体铺垫，并令人物重新判断局势；升级要改变冲突机制或代价，不只是换一个更强的对手。故事节奏应服从题材和人物弧光，不套固定幕数，不强迫每章都反转或用悬崖钩子收尾。',
          '保留原稿的章节数量、编号与每个已经成立的核心事件，不得丢失或替换为无关事件；可以重写表达、补足因果和具体行动。不得推翻作者设定、画布选定分支、人物已确认资料或既有故事事实，也不要为了“更戏剧”强加巧合、反转或无代价胜利。',
          ...(outlineOutputContract?.summaryRange
            ? [
                `【概要篇幅契约】每章概要 ${outlineOutputContract.summaryRange.minimum}-${outlineOutputContract.summaryRange.maximum} 字；用具体行动和因果充实，不能重复句子凑长度。`,
              ]
            : []),
          ...(outlineOutputContract?.plotPointRange
            ? [
                `【每章关键点数量契约】每章 ${outlineOutputContract.plotPointRange.minimum}-${outlineOutputContract.plotPointRange.maximum} 个。保留初稿中成立的独立事件；若初稿少于下限，只补足缺少的关键行动，不得用同义句凑数；若初稿超过上限，合并同一因果链中的子动作或重复节点，不能删掉独立核心事件。`,
              ]
            : []),
          ...(outlineExpectation?.count > 0
            ? [
                `【章节数交付契约】本次必须交付第 ${outlineExpectation.start} 至第 ${outlineExpectation.end} 章，共 ${outlineExpectation.count} 章，编号连续且不能重号。${outlineExpectation.kind === 'continue' ? '只输出本次新增章节，不得复写已经存在的大纲章节。' : '输出完整大纲，不能只输出部分章节。'}`,
                `初稿当前包含 ${outlineExpectation.draftCount ?? '无法完整解析'} 章。若不足目标章数，在保留已有章节关键点的前提下补齐缺章；若多于目标，精简到指定范围。新增章节必须承接前因、推动人物选择并造成后续影响，不得用重复剧情凑数。`,
              ]
            : []),
          ...(draftTruncated
            ? [
                '初稿的模型终止原因是输出长度上限，尾部可能被截断；必须重新核对 JSON 闭合和最后章节，按交付范围补完，不能把截断当作结尾。',
              ]
            : []),
          '【修订稿】部分只输出修订后的合法 JSON 数组，字段结构与初稿一致，不要 Markdown 或代码围栏。',
        ].join('\n'),
      );
    if (mode === 'chapter')
      return appendEditorialOutputContract(
        [
          '【章节正文精修任务】',
          '你是尊重作者文风的资深小说编辑。不要另起炉灶或只润色句子：先找出初稿最影响阅读的因果、场景、人物或语言问题，再直接完成整章第二稿；最终只交付正文。',
          '严格对照大纲、剧情关键点、人物资料、前文、记忆、视角和作者规则。每个关键场景都要让读者看见人物当下目标、阻力、策略或选择以及随之发生的局势变化；关键事件要演出来而不是用摘要带过。人物的情绪、关系和认知变化应落在具体言行与后果上。',
          ...(sceneBlueprint
            ? [
                `【首稿场景蓝图｜结构参照】\n${sceneBlueprint}\n逐场对照蓝图与正文：关键点必须在对应场景中真正发生，人物选择须带来可见后果；蓝图只是组织提案，不是新增正史。若正文表现出更好的因果与节奏，可调整场景边界，但不得漏掉或调换必需事件。场景卡不得出现在最终正文中。`,
              ]
            : []),
          '把作品独有的规则、关系和物件落实到人物此刻能做什么、误判什么、愿意付出什么；不要只点名设定。做“替换性测试”：把人名和专有名词遮掉后，若冲突仍能原封不动放进任意同题材故事，就把最弱的场景改成由本作的规则、人物关系或角色缺陷真正驱动；不要靠堆设定词、加反转或加形容词伪造独特性。复现的信息要增加新含义或迫使新选择，不要用另一段对白或心理描写重复同一结论。',
          '逐个核验每个【PPn】标记前的文本确实演出了对应事件，并以完整句落点；不能只放置标记、复述关键点描述或用一个结果词代替情节。若事件尚未成立，补足人物行动、阻力和结果后再放标记。',
          '让作品独有的设定和人物关系参与冲突解决，而不是只作背景名词；对白要有各自的目的、语感和潜台词，环境细节要具体且影响人物行动或判断。人物卡中的「说话方式」是稳定倾向，检查重要角色的句长、称呼、信息显隐与应对策略能否区分；不要把差异写成反复口头禅、刻意方言拼写或刻板音译，也不要让角色为证明人设而每句都刻意变调。删掉重复解释、空泛心理总结、无效过渡、模板化反转、装饰性细节和套话。',
          '按场景需要变化节奏和叙述距离，不强行套用固定场景公式，不要把每一幕写成同一种“钩子—阻碍—反转”结构；不要求每段末尾都落金句，也不强制每章以悬念收尾。避免把情绪直接解释多遍，让选择、对白和后果承载变化。',
          '避免机械套用词语黑名单：作者明确提出的禁用项必须遵守，其余词语、句式和标点按语境自然使用；不能为了躲避单个词或句式而损害准确性、人物声音与节奏。',
          '不得增加与设定冲突的新事实，不得删掉或调换关键情节。保留作者提示词指定的文风、篇幅、正文格式和有生命力的原句；优先做实质提升，避免为了显得改过而改写已经有效的内容。',
          ...(chapterExpectation?.target > 0
            ? [
                chapterExpectation.minimum > 0
                  ? `【篇幅交付】当前模式目标约 ${chapterExpectation.target} 字（按去空白字符数统计），最终至少达到 ${chapterExpectation.minimum} 字；不要靠删剧情或压缩成摘要来满足篇幅。`
                  : `【篇幅交付】当前模式目标约 ${chapterExpectation.target} 字（按去空白字符数统计）。本轮先保住完整场景、因果和有效细节；若开启了自动补写，后续会单独续写篇幅缺口，不要为赶长度压缩剧情。`,
              ]
            : []),
          ...(draftTruncated
            ? [
                '初稿的模型终止原因是输出长度上限，结尾可能缺失；请结合本章交付目标完整重建尾部并交付整章，不能把截断句当作章末。',
              ]
            : []),
          '修订稿必须准确保留所有作者要求的【PP数字】剧情标记；只输出完整本章正文，不要标题或前言。',
        ].join('\n'),
      );
    if (mode === 'ending')
      return appendEditorialOutputContract(
        [
          '【章节收束精修任务】',
          '这是要追加在当前章节末尾的结尾初稿，不是重写本章，也不是另起一段无关的新剧情。先核对它与已有正文、当前人物状态和作者要求是否自然衔接，再交付一版更准确、更有余韵的结尾。',
          '让本章最后的行动、选择或信息产生可感知的落点；情绪从人物言行、环境变化和处境中显现，不靠旁白总结。可以留下具体余压，也可以安静收束，不强行反转或制造悬崖式悬念。',
          '若上下文提供下一章方向，只用来选择自然的交接状态或保留未解压力；不得把下一章独有事件、揭示或人物变化提前写进当前结尾。',
          '保持已有视角、人物声音、时态与文风；避免重复最后一段已表达的信息、套话、空泛金句和无缘由的新设定。不得改变前文事实，也不得擅自解决作者要求继续保留的主线冲突。',
          '保留初稿中成立的独特细节和有效表达，只做实质提升；严格遵守作者明确的禁用项，其他词语和标点按语境自然使用。按作者原定篇幅与格式要求输出可直接接在当前章节后的完整结尾，不要说明或自评。',
          ...(draftTruncated
            ? [
                '结尾初稿触及模型输出长度上限，末尾可能被截断；请修复句意与场景落点，不要把截断处当作有意收束。',
              ]
            : []),
        ].join('\n'),
      );
    if (mode === 'continue')
      return appendEditorialOutputContract(
        [
          '【续写精修任务】',
          '你是尊重作者文风的小说编辑。只精修新增续写，不重写已有正文，也不要把已有内容换词复述。',
          ...(sceneBlueprint
            ? [
                `【续写场景蓝图｜仅新增部分参照】\n${sceneBlueprint}\n逐场核对新增内容是否从已有正文末尾的真实状态自然承接，并落实目标、阻力、行动和局势变化。蓝图不代表新增正史；不能重写、复述既有正文，也不能提前写完后续章节。若蓝图与原文事实冲突，以原文为准。场景卡不得进入最终续写。`,
              ]
            : []),
          '核对承接是否自然、人物认知与前文是否一致、视角是否越界；让新增场景围绕人物目标与阻力推进，并以真实选择、信息变化或代价带来后果。删掉重复句、空泛心理、无效转折和套路悬念。',
          '保留有辨识度的作者文风与有效原句；细节必须服务于行动、人物或氛围，不靠堆砌形容词制造质感。根据场景变化节奏，不机械复用相同句式或悬念结构。明确的作者禁用项严格遵守，其余词语与标点自然使用。不要改变既有事实，不要把未发生的后续情节提前写完。',
          ...(chapterExpectation?.minimum > 0
            ? [
                `【补写篇幅】本次新增内容至少 ${chapterExpectation.minimum} 字，理想补足约 ${chapterExpectation.target || chapterExpectation.minimum} 字；只有在事件、人物关系或处境确实推进时才扩展，不得复演已发生的关键点或用空泛描写凑数。`,
              ]
            : []),
          ...(draftTruncated
            ? ['续写初稿触及模型输出长度上限，结尾可能缺失；请修复新增部分的收束，但不得重写或复述既有正文。']
            : []),
          '修订稿只输出新增续写正文，不要补写已有内容、标题或前言。',
        ].join('\n'),
      );
    if (mode === 'step')
      return appendEditorialOutputContract(
        [
          '【创作结果精修任务】',
          '你是严谨的小说编辑。逐项对照作者要求和作品上下文，检查这份成果是否真正完成了指定交付，而非只给建议；检查事实一致性、人物主动性、因果、具体细节、可执行性和表达冗余。',
          '剧情与人物方案要核对“选择—阻力—代价—新局面”是否真实改变关系、资源或处境；场景要能直接演出；人物和世界设定要说明其规则如何改变角色的行动与代价。若遮掉人名和专有名词后能原样套进任意同题材作品，就让本作独有的规则、关系或缺陷真正驱动结果。',
          '修复泛化表达、无因果跳跃、动机薄弱、设定冲突和重复内容；不靠加长、加反转或堆形容词伪造提升。保留有创意且成立的部分，不擅自扩大任务范围；作者未要求多个方案时，不拆成多个浅方案。',
          '修订稿按作者原要求的体裁与结构输出完整成果。',
        ].join('\n'),
      );
    return appendEditorialOutputContract(
      [
        '【剧情路线精修任务】',
        '你是资深故事编辑。检查三条路线是否各有清晰且不同的冲突机制，人物是否主动选择，行动是否遭遇可信阻力，代价是否真实发生并改变局面，后续悬念是否由前因自然产生。',
        '删改同质路线、套话、巧合和只换名词的伪差异；保留有力的独创细节。不得违反作者设定、确认资料、既有故事事实或视角规则。',
        '修订稿保留恰好三条路线及原有格式，不要混入诊断说明。',
      ].join('\n'),
    );
  };

  const buildQualityRepairPrompt = (mode, chapterExpectation = null, issues = [], qualityContract = '') => {
    const uniqueIssues = [...new Set(issues.map((issue) => String(issue || '').trim()).filter(Boolean))];
    const requirements =
      mode === 'outline'
        ? '逐章满足作者指定的概要篇幅、关键点数量、章节范围与编号；概要内部不得重复句子或换词重述同一因果来凑篇幅，在不丢失独立核心事件的前提下合并重复子动作，并保证前后章因果衔接。'
        : mode === 'chapter'
          ? `严格达到本章最低篇幅${chapterExpectation?.minimum ? `（至少 ${chapterExpectation.minimum} 字）` : ''}；剧情标记数量、编号和顺序必须与原要求完全一致，每个标记前要有具体、完整且真正发生的事件。`
          : mode === 'ending'
            ? '只修订追加结尾，保证与当前正文自然衔接并保留初稿有效细节；按原要求形成有落点的收束，不压缩成摘要、不强塞悬念或新增主线事实。'
            : mode === 'continue'
              ? `只修复新增续写，不能重写或复述已有正文；完整保留新增事件、承接关系和作者指定格式。${chapterExpectation?.minimum ? `本次新增内容至少达到 ${chapterExpectation.minimum} 字。` : ''}`
              : mode === 'brainstorm'
                ? `保留恰好三条路线，每条不少于 ${BRAINSTORM_ROUTE_MIN_CHARS} 字；路线必须在冲突来源、人物选择和代价机制上实质不同。`
                : mode === 'step' && qualityContract === STORY_ENGINE_QUALITY_CONTRACT
                  ? `完整保留故事事实并逐一满足六个精确分节：${STORY_ENGINE_SECTIONS.map((section) => `【${section.label}】`).join('、')}。每节给出有实质内容的答案；「三段升级链」严格按 1、2、3 编号，每段都体现前因、主动选择、对抗反制、真实代价和新局面。不得用标题占位或空话通过检查。`
                  : '完整满足作者原始交付要求，修复遗漏、重复、因果断裂和格式偏差。';
    const targetLabel =
      mode === 'step' && qualityContract === STORY_ENGINE_QUALITY_CONTRACT
        ? '故事引擎'
        : mode === 'outline'
          ? '大纲'
          : mode === 'chapter'
            ? '正文'
            : mode === 'ending'
              ? '章节结尾'
              : mode === 'continue'
                ? '续写'
                : mode === 'brainstorm'
                  ? '剧情路线'
                  : '创作';
    return [
      `【${targetLabel}质量校验修复】`,
      '上一版修订触发了自动质检提示。请以最初的作者要求和完整初稿为基准，先定位遗漏、违反的硬性要求或可能的重复，再直接给出一次完整、可交付的修正版；不要只解释问题，也不要折中保留已确认的缺陷。',
      requirements,
      ...(uniqueIssues.length
        ? [
            '【自动校验发现的具体问题】',
            ...uniqueIssues.slice(0, 10).map((issue, index) => `${index + 1}. ${issue}`),
            ...(uniqueIssues.length > 10
              ? [`以上列出前 10 项，共检测到 ${uniqueIssues.length} 项；还需逐章复核全部章节并修复其余问题。`]
              : []),
            '逐项处理以上问题：硬性要求必须修复，词面近似项需结合事件含义核实；如果提示与作者原始要求冲突，以作者原始要求为准。',
          ]
        : []),
      '词面相近只代表需要核对：共享母题、线索，或同一行动带来不同选择与后果，可以保留；确属重复时，必须改变人物选择、事件结果或叙事功能，不能只换同义词。',
      '保护已成立的故事事实、人物动机和独立核心事件；不要为满足格式而捏造冲突事实，也不要输出审稿意见、自评或修复说明。',
      '只输出修复后的完整成果。',
    ].join('\n');
  };

  const buildMainQualityReviewContext = (messages, mode) => {
    const systemMessages = messages.filter((message) => message.role === 'system');
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (!lastUser) return systemMessages;
    const priorContext = messages.filter((message) => message.role !== 'system' && message !== lastUser);
    const dynamicContext = priorContext.filter(
      (message) => message.role === 'user' && String(message.content || '').startsWith('【动态写作上下文】'),
    );
    const chapterContext = priorContext.filter((message) => !dynamicContext.includes(message));
    const retainedChapterContext =
      mode === 'chapter' && state.contextFull !== true ? chapterContext.slice(-8) : chapterContext;

    // Reuse the exact context selected for the first draft. Rebuilding it here used to silently
    // replace a user's full-text mode with recent summaries, weakening continuity during editing.
    return [...systemMessages, ...retainedChapterContext, ...dynamicContext, lastUser];
  };

  const analyzePreservedOutlineChapter = (draftChapter, revisedChapter, outlineOutputContract = null) => {
    const issues = [];
    if (!revisedChapter) return ['缺少与初稿对应的章节，不能安全精修。'];
    const draftPointCount = (draftChapter.plotPoints || []).length;
    const revisedPointCount = (revisedChapter.plotPoints || []).length;
    if (!outlineOutputContract?.plotPointRange && draftPointCount !== revisedPointCount) {
      issues.push(
        `剧情关键点数量从 ${draftPointCount} 项变为 ${revisedPointCount} 项；没有数量范围时应保留原数量。`,
      );
    }
    const draftDetail =
      String(draftChapter.summary || '').length +
      (draftChapter.plotPoints || []).reduce((sum, point) => sum + String(point.desc || '').length, 0);
    const revisedDetail =
      String(revisedChapter.summary || '').length +
      (revisedChapter.plotPoints || []).reduce((sum, point) => sum + String(point.desc || '').length, 0);
    const retainsDetail = !draftDetail || revisedDetail >= Math.ceil(draftDetail * 0.55);
    if (!retainsDetail) issues.push('精修稿大幅压缩了本章已成立的概要与剧情细节。');
    if (!preservesOutlinePointCoverage(draftChapter, revisedChapter))
      issues.push('未充分保留初稿中每一条独立关键剧情事件，或以无关剧情替换了原事件。');
    return issues;
  };

  const countWritingCharacters = (text) => {
    const clean =
      typeof globalThis.sanitizeGeneratedText === 'function'
        ? globalThis.sanitizeGeneratedText(text)
        : String(text || '');
    return Array.from(String(clean || '').replace(/\s|【PP\s*\d+】/g, '')).length;
  };

  const outlinePointNgramSets = (chapter) => {
    const points = Array.isArray(chapter?.plotPoints) ? chapter.plotPoints : [];
    return points.map((point) => {
      const text = String(typeof point === 'string' ? point : point?.desc || point?.text || '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[\s，。！？!?；;、：:,.“”‘’「」『』【】（）()《》<>—…·]/gu, '');
      const characters = Array.from(text);
      const ngrams = new Set();
      for (let index = 0; index < characters.length - 1; index += 1)
        ngrams.add(characters[index] + characters[index + 1]);
      return ngrams;
    });
  };

  const preservesOutlinePointCoverage = (draftChapter, revisedChapter) => {
    const originalPoints = outlinePointNgramSets(draftChapter);
    const original = new Set(originalPoints.flatMap((ngrams) => [...ngrams]));
    if (original.size < 8) return true;
    const revised = new Set(outlinePointNgramSets(revisedChapter).flatMap((ngrams) => [...ngrams]));
    const retained = [...original].filter((ngram) => revised.has(ngram)).length;
    const preservesEachEvent = originalPoints.every((ngrams) => {
      if (ngrams.size < 8) return true;
      const eventRetained = [...ngrams].filter((ngram) => revised.has(ngram)).length;
      return eventRetained / ngrams.size >= 0.1;
    });
    // The low per-event floor permits paraphrase/merging; total coverage still rejects wholesale replacement.
    return preservesEachEvent && retained / original.size >= 0.25;
  };

  const normalizeOutlineTextKey = (text) =>
    String(text || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]/gu, '');

  const findRepeatedOutlineSummarySentence = (summary) => {
    const sentences = String(summary || '').match(/[^。！？!?]+[。！？!?]?/gu) || [];
    const firstByKey = new Map();
    for (const [index, sentence] of sentences.entries()) {
      const key = normalizeOutlineTextKey(sentence);
      if (Array.from(key).length < 18) continue;
      const firstIndex = firstByKey.get(key);
      if (firstIndex !== undefined) return { firstIndex, repeatedIndex: index };
      firstByKey.set(key, index);
    }
    return null;
  };

  // Deliberately high: this catches light rewording of the same sentence, not shared motifs.
  const OUTLINE_NEAR_DUPLICATE_THRESHOLD = 0.94;
  const outlineTextSimilarity = (leftText, rightText) => {
    const left = Array.from(normalizeOutlineTextKey(leftText));
    const right = Array.from(normalizeOutlineTextKey(rightText));
    const longest = Math.max(left.length, right.length);
    if (!longest || Math.min(left.length, right.length) < 18 || longest > 1200) return 0;
    if (left.join('') === right.join('')) return 1;
    const editLimit = Math.floor(longest * (1 - OUTLINE_NEAR_DUPLICATE_THRESHOLD));
    if (Math.abs(left.length - right.length) > editLimit) return 0;

    let previous = new Uint32Array(right.length + 1);
    previous.fill(editLimit + 1);
    for (let column = 0; column <= Math.min(right.length, editLimit); column += 1) previous[column] = column;
    for (let row = 1; row <= left.length; row += 1) {
      const current = new Uint32Array(right.length + 1);
      current.fill(editLimit + 1);
      if (row <= editLimit) current[0] = row;
      for (
        let column = Math.max(1, row - editLimit);
        column <= Math.min(right.length, row + editLimit);
        column += 1
      ) {
        current[column] = Math.min(
          current[column - 1] + 1,
          previous[column] + 1,
          previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
        );
      }
      previous = current;
    }
    return previous[right.length] <= editLimit ? 1 - previous[right.length] / longest : 0;
  };

  const isNearDuplicateOutlineText = (leftText, rightText, minimumLength = 18) => {
    const left = normalizeOutlineTextKey(leftText);
    const right = normalizeOutlineTextKey(rightText);
    return (
      left !== right &&
      Math.min(Array.from(left).length, Array.from(right).length) >= minimumLength &&
      outlineTextSimilarity(left, right) >= OUTLINE_NEAR_DUPLICATE_THRESHOLD
    );
  };

  const validatePlotPointMarkerAttachment = (text) => {
    const source = String(text || '');
    const markers = [...source.matchAll(/【PP\s*(\d+)】/g)];
    return markers.every((marker, index) => {
      const start = index ? markers[index - 1].index + markers[index - 1][0].length : 0;
      const beat = source.slice(start, marker.index).trim();
      const sentenceTail = beat.replace(/["'”’」』）)\]】]+$/u, '').trim();
      const meaningfulLength = Array.from(
        sentenceTail.replace(/[\s"'“”‘’「」『』（）()【】\u005B\u005D，,、。！？!?…；;：:—-]/gu, ''),
      ).length;
      return meaningfulLength >= 8 && /[。！？!?…]$/u.test(sentenceTail);
    });
  };

  const analyzeOutlineRefinement = (
    firstDraft,
    revised,
    expectation = null,
    outlineOutputContract = null,
  ) => {
    let draft;
    let candidate;
    try {
      draft = globalThis.parseOutlineJSON?.(firstDraft);
      candidate = globalThis.parseOutlineJSON?.(revised);
    } catch {
      return ['精修结果无法解析为合法大纲 JSON。'];
    }
    if (!Array.isArray(candidate) || !candidate.length) return ['精修结果必须是至少包含一章的 JSON 数组。'];

    const issues = [];
    const summaryChapterByText = new Map();
    candidate.forEach((chapter, index) => {
      const number = Number(chapter?.chapter) || index + 1;
      const summary = String(chapter?.summary || '');
      const summaryLength = Array.from(summary.replace(/\s/g, '')).length;
      if (!String(chapter?.title || '').trim()) issues.push(`第 ${number} 章缺少标题。`);
      if (!summary.trim()) issues.push(`第 ${number} 章缺少内容概要。`);
      const repeatedSentence = findRepeatedOutlineSummarySentence(summary);
      if (repeatedSentence)
        issues.push(
          `第 ${number} 章概要内部第 ${repeatedSentence.repeatedIndex + 1} 句与第 ${repeatedSentence.firstIndex + 1} 句重复；请用新的行动、信息、选择或后果替代，不能以复述凑篇幅。`,
        );
      const summaryKey = normalizeOutlineTextKey(summary);
      if (summaryKey) {
        const previousChapter = summaryChapterByText.get(summaryKey);
        if (previousChapter) {
          issues.push(`第 ${number} 章概要与第 ${previousChapter} 章完全重复。`);
        } else {
          for (const [previousSummary, previousSummaryChapter] of summaryChapterByText.entries()) {
            if (isNearDuplicateOutlineText(summaryKey, previousSummary, 80))
              issues.push(
                `第 ${number} 章概要与第 ${previousSummaryChapter} 章词面高度相近（相似度约 ${Math.round(outlineTextSimilarity(summaryKey, previousSummary) * 100)}%），可能是轻微换词后的重复推进；请核对人物选择、事件结果和叙事功能。`,
              );
          }
          summaryChapterByText.set(summaryKey, number);
        }
      }
      if (!Array.isArray(chapter?.plotPoints)) {
        issues.push(`第 ${number} 章的剧情关键点格式无效。`);
        return;
      }
      const pointIndexByText = new Map();
      const pointTexts = [];
      chapter.plotPoints.forEach((point, pointIndex) => {
        const pointText = String(
          typeof point === 'string' ? point : (point?.desc ?? point?.text ?? ''),
        ).trim();
        if (!pointText) {
          issues.push(`第 ${number} 章第 ${pointIndex + 1} 个剧情关键点为空。`);
          return;
        }
        const pointKey = normalizeOutlineTextKey(pointText);
        if (!pointKey) return;
        const previousPointIndex = pointIndexByText.get(pointKey);
        if (previousPointIndex !== undefined) {
          issues.push(
            `第 ${number} 章第 ${pointIndex + 1} 个剧情关键点与第 ${previousPointIndex + 1} 个完全重复。`,
          );
        } else {
          for (const [previousPointIndex, previousPoint] of pointTexts.entries()) {
            if (isNearDuplicateOutlineText(pointKey, previousPoint))
              issues.push(
                `第 ${number} 章第 ${pointIndex + 1} 个剧情关键点与第 ${previousPointIndex + 1} 个词面高度相近（相似度约 ${Math.round(outlineTextSimilarity(pointKey, previousPoint) * 100)}%），可能是轻微换词后的同一事件；请检查是否有新增行动、选择或后果。`,
              );
          }
          pointIndexByText.set(pointKey, pointIndex);
          pointTexts.push(pointKey);
        }
      });
      if (outlineOutputContract?.summaryRange) {
        const { minimum, maximum } = outlineOutputContract.summaryRange;
        if (summaryLength < minimum || summaryLength > maximum)
          issues.push(`第 ${number} 章概要为 ${summaryLength} 字，要求 ${minimum}-${maximum} 字。`);
      }
      if (outlineOutputContract?.plotPointRange) {
        const { minimum, maximum } = outlineOutputContract.plotPointRange;
        if (chapter.plotPoints.length < minimum || chapter.plotPoints.length > maximum)
          issues.push(
            `第 ${number} 章剧情关键点为 ${chapter.plotPoints.length} 项，要求 ${minimum}-${maximum} 项。`,
          );
      }
    });

    const hasDraft = Array.isArray(draft) && draft.length > 0;
    if (expectation?.count > 0) {
      if (candidate.length !== expectation.count)
        issues.push(`章节数量为 ${candidate.length} 章，要求交付 ${expectation.count} 章。`);
      const hasAbsoluteSequence = candidate.every(
        (chapter, index) => Number(chapter.chapter) === expectation.start + index,
      );
      const hasRelativeSequence =
        expectation.kind === 'continue' &&
        candidate.every((chapter, index) => Number(chapter.chapter) === index + 1);
      if (!hasAbsoluteSequence && !hasRelativeSequence)
        issues.push(
          `章节编号必须从第 ${expectation.start} 章连续到第 ${expectation.end} 章，不能缺号或重号。`,
        );
      const normalizedCandidate = hasRelativeSequence
        ? candidate.map((chapter, index) => ({ ...chapter, chapter: expectation.start + index }))
        : candidate;
      if (!hasDraft) return issues;
      const draftUsesRelativeNumbers =
        expectation.start > 1 && draft.every((chapter, index) => Number(chapter.chapter) === index + 1);
      draft.forEach((chapter, index) => {
        const chapterNumber = draftUsesRelativeNumbers ? expectation.start + index : Number(chapter.chapter);
        if (chapterNumber < expectation.start || chapterNumber > expectation.end) return;
        const revisedChapter = normalizedCandidate.find(
          (candidateChapter) => Number(candidateChapter.chapter) === chapterNumber,
        );
        if (!revisedChapter) {
          issues.push(`第 ${chapterNumber} 章缺失，无法保留该章的原有剧情事件。`);
          return;
        }
        issues.push(
          ...analyzePreservedOutlineChapter(chapter, revisedChapter, outlineOutputContract).map(
            (issue) => `第 ${chapterNumber} 章${issue}`,
          ),
        );
      });
      return issues;
    }
    if (!hasDraft) return issues;
    if (draft.length !== candidate.length)
      issues.push(`章节数量从初稿的 ${draft.length} 章变为 ${candidate.length} 章；作者未要求时应保持一致。`);
    draft.forEach((chapter, index) => {
      const revisedChapter = candidate[index];
      const number = Number(chapter.chapter) || index + 1;
      if (!revisedChapter) {
        issues.push(`第 ${number} 章在精修结果中缺失。`);
        return;
      }
      if (Number(chapter.chapter) !== Number(revisedChapter.chapter))
        issues.push(`第 ${number} 章编号被改为第 ${revisedChapter.chapter} 章。`);
      issues.push(
        ...analyzePreservedOutlineChapter(chapter, revisedChapter, outlineOutputContract).map(
          (issue) => `第 ${number} 章${issue}`,
        ),
      );
    });
    return issues;
  };

  const normalizeAppendOnlyQualityText = (text) => {
    const sanitized =
      typeof globalThis.sanitizeGeneratedText === 'function'
        ? globalThis.sanitizeGeneratedText(text)
        : String(text || '').trim();
    return sanitized.replace(/\s+/gu, '');
  };

  const repeatsExistingChapter = (candidate, request = null) => {
    if (!['continue', 'ending'].includes(request?.mode)) return false;
    const existing = normalizeAppendOnlyQualityText(request?.chapterBaseContent);
    const output = normalizeAppendOnlyQualityText(candidate);
    return !!existing && !!output && output.includes(existing);
  };

  const analyzeEditorialChange = (firstDraft, revised, feedback = '') => {
    const first = normalizeAppendOnlyQualityText(firstDraft);
    const final = normalizeAppendOnlyQualityText(revised);
    const explicitlyUnchanged = /无需实质改动|无需实质修改|无实质缺陷/u.test(String(feedback || ''));
    return first && first === final && !explicitlyUnchanged
      ? ['精修指出了具体问题，但修订稿与初稿内容相同；请落实改进，或明确说明无需实质改动。']
      : [];
  };

  const analyzeRefinedDraft = (mode, firstDraft, revised, lastUser, request = null) => {
    if (!String(revised || '').trim()) return ['精修结果为空。'];
    if (mode === 'outline')
      return analyzeOutlineRefinement(
        firstDraft,
        revised,
        request?.outlineExpectation || null,
        request?.outlineOutputContract || null,
      );
    if (mode === 'brainstorm') {
      return analyzeBrainstormBranches(revised);
    }
    if (mode === 'step')
      return request?.qualityContract === STORY_ENGINE_QUALITY_CONTRACT
        ? analyzeStoryEngineArtifact(revised)
        : [];
    if (mode === 'chapter') {
      const requiredMarkers = [
        ...new Set([...String(lastUser?.content || '').matchAll(/【PP\s*(\d+)】/g)].map((match) => match[1])),
      ];
      const revisedMarkers = [...String(revised).matchAll(/【PP\s*(\d+)】/g)].map((match) => match[1]);
      const issues = [];
      if (requiredMarkers.length !== revisedMarkers.length)
        issues.push(`剧情标记数量为 ${revisedMarkers.length} 个，要求 ${requiredMarkers.length} 个。`);
      if (!requiredMarkers.every((number, index) => revisedMarkers[index] === number))
        issues.push('剧情标记缺失、重复或顺序错误；必须与作者原要求完全一致。');
      if (requiredMarkers.length && !validatePlotPointMarkerAttachment(revised))
        issues.push('至少一个剧情标记前没有完整演出对应事件，或标记前文本不是完整句。');
      const draftLength = countWritingCharacters(firstDraft);
      const revisedLength = countWritingCharacters(revised);
      const preservationMinimum = Math.ceil(draftLength * 0.72);
      if (draftLength && revisedLength < preservationMinimum)
        issues.push(
          `正文从初稿的 ${draftLength} 字压缩到 ${revisedLength} 字，低于保留完整情节所需的 ${preservationMinimum} 字。`,
        );
      const minimum = Number(request?.chapterExpectation?.minimum || 0);
      if (revisedLength < minimum)
        issues.push(`正文为 ${revisedLength} 字，低于本章最低篇幅 ${minimum} 字。`);
      return issues;
    }
    if (mode === 'continue' || mode === 'ending') {
      const issues = [];
      if (repeatsExistingChapter(revised, request))
        issues.push(
          `${mode === 'ending' ? '结尾' : '续写'}精修稿重复包含了已有完整正文；只能交付新增内容，不得复述整章。`,
        );
      const draftLength = countWritingCharacters(firstDraft);
      const revisedLength = countWritingCharacters(revised);
      if (draftLength && revisedLength < Math.ceil(draftLength * 0.72))
        issues.push(
          `${mode === 'ending' ? '章节结尾' : '续写'}从初稿的 ${draftLength} 字压缩到 ${revisedLength} 字，低于保留有效场景与细节所需的 ${Math.ceil(draftLength * 0.72)} 字。`,
        );
      const minimum = Number(request?.chapterExpectation?.minimum || 0);
      if (mode === 'continue' && revisedLength < minimum)
        issues.push(
          `本次补写为 ${revisedLength} 字，仍缺 ${minimum - revisedLength} 字才能达到本章最低篇幅。`,
        );
      return issues;
    }
    return [];
  };

  const isAdvisoryNearDuplicateIssue = (issue) => String(issue || '').includes('词面高度相近');
  const validateRefinedDraft = (...args) =>
    // Similar wording is only advisory; exact repeats and structural/continuity errors remain blocking.
    analyzeRefinedDraft(...args).every(isAdvisoryNearDuplicateIssue);

  const describeFallbackDraftQuality = (mode, firstDraft, lastUser, request) => {
    const issues = analyzeRefinedDraft(mode, firstDraft, firstDraft, lastUser, request);
    request.fallbackQualityIssues = issues;
    if (!issues.length) return '初稿通过结构检查，但没有完成语义精修。';
    return `初稿仍未通过自动检查：${issues.slice(0, 3).join('；')}${issues.length > 3 ? `；另有 ${issues.length - 3} 项` : ''}`;
  };

  const createOutlineExpectation = (functionName) => {
    if (!['generateOutline', 'continueOutline'].includes(functionName)) return null;
    const chapterCountInput = document.getElementById('chapterCount');
    const end = Math.floor(Number(chapterCountInput?.value || state.project?.chapterCount || 0));
    if (!Number.isInteger(end) || end <= 0) return null;
    const isContinuation = functionName === 'continueOutline';
    const existingMax = isContinuation ? Number(globalThis.getOutlineMaxChapter?.() || 0) : 0;
    const start = isContinuation ? existingMax + 1 : 1;
    const count = Math.max(0, end - start + 1);
    return count ? { kind: isContinuation ? 'continue' : 'complete', start, end, count } : null;
  };

  const createChapterExpectation = (functionName) => {
    if (functionName !== 'generateChapter') return null;
    const mode = String(state.selectedLength || 'medium');
    const multiplier = { brief: 0.55, medium: 1, detailed: 1.5 }[mode] || 1;
    const baseLength = Number(state.project?.wordsPerChapter || 0);
    const target = Math.max(0, Math.round(baseLength * multiplier));
    if (!target) return null;
    const completionMinimum = Math.ceil(target * 0.7);
    const autoSupplementExpected = state.autoContinue !== false;
    return {
      mode,
      target,
      minimum: autoSupplementExpected ? 0 : completionMinimum,
      completionMinimum,
      autoSupplementExpected,
    };
  };

  const findMissingOutlineChapters = (expectation) => {
    if (!expectation?.count) return { found: 0, missing: [] };
    const chapterNumber = (chapter) =>
      Number(globalThis.outlineChapterNumber?.(chapter?.chapter, 0) || chapter?.chapter || 0);
    const existing = new Set((state.outline || []).map(chapterNumber).filter((number) => number > 0));
    const missing = [];
    for (let chapter = expectation.start; chapter <= expectation.end; chapter++) {
      if (!existing.has(chapter)) missing.push(chapter);
    }
    return { found: expectation.count - missing.length, missing };
  };

  const warnAboutIncompleteOutline = (expectation, outputTruncated = false, qualityNotice = '') => {
    const { found, missing } = findMissingOutlineChapters(expectation);
    if (!missing.length || typeof toast !== 'function') return false;
    const sample = missing
      .slice(0, 5)
      .map((chapter) => `第 ${chapter} 章`)
      .join('、');
    const suffix = missing.length > 5 ? '等' : '';
    const truncatedSuffix = outputTruncated ? '；精修也触及模型长度上限，建议再次续写或降低单次章节数。' : '';
    const qualitySuffix = qualityNotice ? `；${qualityNotice}` : '';
    toast(
      expectation.kind === 'continue'
        ? `大纲仍缺 ${missing.length} 章（${sample}${suffix}），已保存当前进度；可再次续写。${truncatedSuffix}${qualitySuffix}`
        : `大纲仅覆盖 ${found}/${expectation.count} 章（缺 ${sample}${suffix}），已保存为部分稿；可用“续写大纲”补齐。${truncatedSuffix}${qualitySuffix}`,
    );
    return true;
  };

  const warnAboutGenerationQuality = (request) => {
    if (request?.qualityAbortHandled || typeof toast !== 'function') return;
    if (
      request.outlineExpectation &&
      warnAboutIncompleteOutline(
        request.outlineExpectation,
        request.outputTruncated,
        request.qualityRejectionReason,
      )
    )
      return;

    if (request.qualityRejectionReason) {
      toast(request.qualityRejectionReason);
      return;
    }

    if (request.chapterExpectation && request.firstDraft) {
      const chapter = Number(request.chapterNumber || 0);
      const content =
        globalThis.getChapterContent?.(chapter) ||
        state.chapters?.find((item) => Number(item.chapter) === chapter)?.content ||
        '';
      const actual = countWritingCharacters(content);
      const minimum = Number(
        request.chapterExpectation.completionMinimum || request.chapterExpectation.minimum || 0,
      );
      if (actual < minimum) {
        toast(
          `本章正文 ${actual}/${request.chapterExpectation.target} 字，低于篇幅底线；${request.autoContinuationQualityIssue ? '自动补写未通过审校，已舍弃不合格补写并保留已审校正文。' : '请继续补写，或调整目标篇幅。'}${request.outputTruncated ? '本次输出也触及模型长度上限。' : ''}`,
        );
        return;
      }
    }

    if (request.autoContinuationQualityIssue) {
      toast(
        `自动补写未通过审校，已保留此前的审校正文：${compactCanvasQualityText(request.autoContinuationQualityIssue, 180)}`,
      );
      return;
    }

    if (request.outputTruncated)
      toast('精修输出触及模型长度上限，已保留可用初稿；请检查结尾，必要时续写或降低单次篇幅。');
  };

  const preservePreRefinementChapterDraft = (request, firstDraft, revised) => {
    if (!request?.main || !['chapter', 'continue', 'ending'].includes(request.mode)) return;
    const chapter = Number(state.currentChapter || 0);
    if (!Number.isInteger(chapter) || chapter <= 0) return;

    const editor = document.getElementById('chapterEditor');
    const existing =
      request.mode === 'continue'
        ? String(
            globalThis.getChapterContent?.(chapter) ||
              (Number(state.currentChapter) === chapter ? editor?.value : '') ||
              '',
          )
        : request.mode === 'ending'
          ? String(request.chapterBaseContent || '')
          : '';
    const merge = globalThis.mergeContinuationText;
    const isAppend = ['continue', 'ending'].includes(request.mode);
    const sanitize = (text) =>
      typeof globalThis.sanitizeGeneratedText === 'function'
        ? globalThis.sanitizeGeneratedText(text)
        : String(text || '').trim();
    const beforeRefinement = sanitize(
      isAppend && typeof merge === 'function'
        ? merge(existing, firstDraft)
        : isAppend
          ? `${existing}${firstDraft}`
          : firstDraft,
    );
    const afterRefinement = sanitize(
      isAppend && typeof merge === 'function'
        ? merge(existing, revised)
        : isAppend
          ? `${existing}${revised}`
          : revised,
    );
    if (!beforeRefinement || beforeRefinement === afterRefinement) return;

    const snapshot = globalThis.createChapterSnapshot?.(
      chapter,
      request.mode === 'ending' ? 'AI 结尾初稿（精修前）' : 'AI 初稿（精修前）',
      { content: beforeRefinement },
    );
    if (snapshot) request.qualityDraftSnapshotId = snapshot.id;
  };

  const markQualityPassStarted = (mode, request) => {
    if (request) request.qualityPassStarted = true;
    if (mode === 'outline') {
      const title = document.getElementById('outlineStreamTitle');
      const content = document.getElementById('outlineStreamContent');
      if (title) title.textContent = '✦ 正在校验章间因果、人物选择与伏笔';
      if (content && request?.main) content.textContent = '初稿已完成，正在检查章节递进与设定一致性…';
      return;
    }
    if (request?.main) {
      if (typeof globalThis.updateGeneratingChapterUI === 'function')
        globalThis.updateGeneratingChapterUI(
          Number(state.currentChapter || 0),
          mode === 'continue' ? '续写精修' : mode === 'ending' ? '结尾精修' : '正文精修',
        );
      if (!state.autoGenerating && typeof toast === 'function')
        toast(
          mode === 'ending'
            ? '结尾初稿已完成，正在校对与正文的衔接、人物声音与收束落点…'
            : mode === 'continue'
              ? '篇幅补写已完成，正在检查是否重复、是否推动剧情并补足篇幅…'
              : '初稿已完成，正在校对人物、视角与情节连贯性…',
        );
      return;
    }
    showCanvasGenerationStatus('◇ 初稿完成，正在校验设定、因果与人物选择…');
    if (typeof toast === 'function') toast('初稿完成，AI 正在校验设定与因果并精修…');
  };

  const markOutlineArchitecturePlanningStarted = () => {
    const title = document.getElementById('outlineStreamTitle');
    const content = document.getElementById('outlineStreamContent');
    if (title) title.textContent = '✦ 正在搭建故事主线与因果弧';
    if (content) content.textContent = '先确定故事承诺、人物目标、对抗策略和章节递进，再转成可编辑大纲…';
  };

  const markOutlineDraftStarted = () => {
    const title = document.getElementById('outlineStreamTitle');
    const content = document.getElementById('outlineStreamContent');
    if (title) title.textContent = '✦ 正在把故事结构落成章节大纲';
    if (content) content.textContent = '架构已完成，正在生成章节事件、人物选择与章间接力…';
  };

  const markScenePlanningStarted = (mode, request) => {
    if (request?.main && typeof globalThis.updateGeneratingChapterUI === 'function')
      globalThis.updateGeneratingChapterUI(
        Number(request.chapterNumber || state.currentChapter || 0),
        mode === 'continue' ? '续写场景规划' : '场景规划',
      );
    if (!state.autoGenerating && typeof toast === 'function')
      toast(
        mode === 'continue' ? '正在先梳理已有正文之后的场景，再开始续写…' : '正在先规划本章场景，再开始写作…',
      );
  };

  const markSceneDraftStarted = (mode, request) => {
    if (request?.main && typeof globalThis.updateGeneratingChapterUI === 'function')
      globalThis.updateGeneratingChapterUI(
        Number(request.chapterNumber || state.currentChapter || 0),
        mode === 'continue' ? '按场景蓝图续写' : '按场景蓝图写作',
      );
    if (!state.autoGenerating && typeof toast === 'function')
      toast('场景蓝图已完成，正在按人物选择与因果关系写正文…');
  };

  let generationStreamDock = null;
  let generationStreamTimer = null;
  let generationProgressSequence = 0;
  let displayedProgress = null;
  const createGenerationProgress = (options, request) => ({
    operationId: `generation-${++generationProgressSequence}`,
    ownerId: request?.progressOwnerId || options?.progressOwnerId || null,
    scope:
      request?.main || request?.functionName || options?.progressOwnerId
        ? 'main'
        : request
          ? 'canvas'
          : 'auxiliary',
    route: request?.route || options?.route || 'default',
    mode: request?.mode || null,
    status: 'running',
    phase: '',
    preview: '',
    label: '',
  });
  const emitGenerationProgress = (progress, detail) =>
    window.dispatchEvent(
      new CustomEvent('novel-generation-progress', {
        detail: {
          ...detail,
          operationId: progress.operationId,
          ownerId: progress.ownerId,
          scope: progress.scope,
          route: progress.route,
          mode: progress.mode,
        },
      }),
    );
  const canDisplayProgress = (progress, dock) =>
    !displayedProgress ||
    displayedProgress.operationId === progress.operationId ||
    dock.hidden ||
    progress.scope !== 'auxiliary' ||
    displayedProgress.scope === 'auxiliary';
  const paintGenerationProgress = (progress) => {
    const dock = ensureGenerationStreamDock();
    if (!canDisplayProgress(progress, dock)) return null;
    const changed = displayedProgress?.operationId !== progress.operationId;
    displayedProgress = progress;
    dock.hidden = false;
    dock.dataset.status = progress.status;
    dock.dataset.operation = progress.operationId;
    dock.querySelector('[data-stream-dock-title]').textContent = progress.label;
    dock.querySelector('[data-stream-dock-phase]').textContent = progress.phase;
    dock.querySelector('[data-stream-dock-preview]').textContent = progress.preview;
    if (changed) {
      window.clearTimeout(generationStreamTimer);
      dock.open = progress.status === 'running';
    }
    return dock;
  };
  const ensureGenerationStreamDock = () => {
    if (generationStreamDock?.isConnected) return generationStreamDock;
    generationStreamDock = document.createElement('details');
    generationStreamDock.id = 'generationStreamDock';
    generationStreamDock.className = 'generation-stream-dock';
    generationStreamDock.open = true;
    generationStreamDock.innerHTML =
      '<summary><span data-stream-dock-title>AI 正在工作</span><small data-stream-dock-status>流式接收中</small></summary><div class="generation-stream-dock-body"><div data-stream-dock-phase></div><pre data-stream-dock-preview></pre></div>';
    document.body.append(generationStreamDock);
    return generationStreamDock;
  };
  const streamDockStart = (label, progress) => {
    progress.label = label || 'AI 正在工作';
    progress.status = 'running';
    emitGenerationProgress(progress, { type: 'start', label: progress.label });
    const dock = paintGenerationProgress(progress);
    if (!dock) return;
    window.clearTimeout(generationStreamTimer);
    dock.hidden = false;
    dock.open = true;
    dock.dataset.status = 'running';
    dock.querySelector('[data-stream-dock-title]').textContent = progress.label;
    dock.querySelector('[data-stream-dock-status]').textContent = '流式接收中 · 可继续浏览';
    dock.querySelector('[data-stream-dock-phase]').textContent = '';
    dock.querySelector('[data-stream-dock-preview]').textContent = '';
  };
  const streamDockChunk = (chunk, phase, progress, kind = 'content') => {
    const text = String(chunk || '');
    const label = kind === 'reasoning' ? `${phase} · 思考` : phase;
    if (progress.phase !== label) progress.preview = '';
    progress.phase = label;
    progress.preview = `${progress.preview}${text}`.slice(-4200);
    paintGenerationProgress(progress);
    emitGenerationProgress(progress, { type: 'chunk', text, phase, kind });
  };
  const streamDockFinish = (status, progress) => {
    progress.status = status;
    emitGenerationProgress(progress, { type: 'finish', status });
    const dock = paintGenerationProgress(progress);
    if (!dock) return;
    dock.querySelector('[data-stream-dock-status]').textContent =
      status === 'error' ? '遇到问题 · 原内容已保留' : '本轮输出已接收 · 可展开预览';
    if (status === 'done') {
      dock.open = false;
      generationStreamTimer = window.setTimeout(() => {
        if (dock.dataset.operation === progress.operationId && progress.status === 'done') dock.hidden = true;
      }, 12_000);
    }
  };
  const monitoredNativeStream = (nativeApiStreamChat, context, messages, options, phase) => {
    const progress = options._generationProgress;
    return nativeApiStreamChat.call(context, messages, (chunk) => streamDockChunk(chunk, phase, progress), {
      ...options,
      onReasoning: (chunk) => {
        streamDockChunk(chunk, phase, progress, 'reasoning');
        if (typeof options.onReasoning === 'function') options.onReasoning(chunk);
      },
    });
  };

  const streamCanvasResult = async (text, onChunk) => {
    if (typeof onChunk !== 'function') return;
    const chunkSize = 160;
    for (let offset = 0; offset < text.length; offset += chunkSize) {
      onChunk(text.slice(offset, offset + chunkSize));
      if (offset + chunkSize < text.length) await new Promise((resolve) => setTimeout(resolve, 12));
    }
  };

  const showCanvasGenerationStatus = (message) => {
    const assistant = document.getElementById('chatMessages')?.lastElementChild;
    const content = assistant?.classList.contains('assistant')
      ? assistant.querySelector('.msg-content')
      : null;
    if (content && !content.textContent?.trim()) content.textContent = message;
  };

  const decorateBrainstormReplies = () => {
    const container = document.getElementById('chatMessages');
    const win = (state.chatWindows || []).find((item) => item.id === state.activeChatId);
    if (!container || !win?.messages) return;
    const elements = [...container.querySelectorAll(':scope > .chat-msg')];
    win.messages.forEach((message, messageIndex) => {
      if (!message.creativeCanvasBranchFrom || message._streaming) return;
      const response = String(message.content || '').trim();
      if (!response || response.startsWith('❌')) return;
      const source = canvasModel().nodes.find(
        (node) =>
          node.id === message.creativeCanvasBranchFrom && ['note', 'step', 'experiment'].includes(node.kind),
      );
      const element = elements[messageIndex];
      const content = element?.querySelector('.msg-content');
      if (!source || !content) return;

      const quality = message.creativeCanvasQuality;
      if (quality?.status) {
        let report = element.querySelector('.creative-canvas-quality-report');
        if (!report) {
          const labels = {
            reviewed: '✓ 审校通过',
            repaired: '↺ 修复后通过',
            unverified: '! 未完成审校 · 保留初稿',
          };
          report = document.createElement('details');
          report.className = `creative-canvas-quality-report is-${quality.status}`;
          const summary = document.createElement('summary');
          summary.textContent = labels[quality.status] || '审校状态';
          const detail = document.createElement('div');
          detail.className = 'creative-canvas-quality-detail';
          detail.textContent =
            quality.status === 'unverified'
              ? quality.reason || '精修未完成，当前展示的是未经审校的初稿。'
              : quality.status === 'repaired'
                ? [quality.feedback && `审校发现：${quality.feedback}`, '针对性修复已通过结构检查。']
                    .filter(Boolean)
                    .join(' ')
                : quality.feedback || '独立内容审校已完成，修订结果通过结构检查。';
          report.append(summary, detail);
          content.insertAdjacentElement('afterend', report);
        }
      }

      if (element.querySelector('.creative-canvas-branch-actions')) return;
      const options = parseBrainstormBranches(response);
      if (!options.length) return;
      const added = new Set(
        Array.isArray(message.creativeCanvasBranchesAdded) ? message.creativeCanvasBranchesAdded : [],
      );
      const actions = document.createElement('div');
      actions.className = 'creative-canvas-branch-actions';
      options.forEach((option, optionIndex) => {
        const actionKey = canvasBranchActionKey(win.id, messageIndex, option.text);
        const pending = pendingCanvasBranches.get(actionKey);
        const isAdded = added.has(option.text) && !pending;
        const button = document.createElement('button');
        button.type = 'button';
        button.dataset.creativeCanvasBranch = 'true';
        button.dataset.chatId = win.id;
        button.dataset.messageIndex = String(messageIndex);
        button.dataset.optionIndex = String(optionIndex);
        button.disabled = isAdded || pending?.status === 'saving';
        button.setAttribute(
          'aria-label',
          isAdded
            ? `已落地：${option.title}`
            : pending
              ? `重试保存：${option.title}`
              : `落到画布：${option.title}`,
        );
        button.textContent = isAdded
          ? `✓ ${option.title}`
          : pending
            ? `↻ ${option.title}`
            : `＋ ${option.title}`;
        if (pending) button.classList.add('is-pending-save');
        actions.append(button);
      });
      const qualityReport = element.querySelector('.creative-canvas-quality-report');
      (qualityReport || content).insertAdjacentElement('afterend', actions);
    });
  };

  const addBrainstormBranchToCanvas = async (button) => {
    const win = (state.chatWindows || []).find((item) => item.id === button.dataset.chatId);
    const message = win?.messages?.[Number(button.dataset.messageIndex)];
    const option = parseBrainstormBranches(message?.content || '')[Number(button.dataset.optionIndex)];
    const model = canvasModel();
    const source = model.nodes.find(
      (node) =>
        node.id === message?.creativeCanvasBranchFrom && ['note', 'step', 'experiment'].includes(node.kind),
    );
    if (!source || !option) {
      if (typeof toast === 'function') toast('原灵感便笺已不存在，无法建立分支');
      return;
    }
    message.creativeCanvasBranchesAdded = Array.isArray(message.creativeCanvasBranchesAdded)
      ? message.creativeCanvasBranchesAdded
      : [];
    const actionKey = canvasBranchActionKey(win.id, Number(button.dataset.messageIndex), option.text);
    let pending = pendingCanvasBranches.get(actionKey);
    if (pending?.status === 'saving') return;
    if (message.creativeCanvasBranchesAdded.includes(option.text) && !pending) return;

    let branch = pending && model.nodes.find((node) => node.id === pending.branchId);
    if (!branch) {
      pendingCanvasBranches.delete(actionKey);
      const sourceSize = canvasNodeSize(source);
      const position = findOpenNotePosition(source.x + sourceSize.width + 48, source.y);
      branch = {
        id: `note:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        kind: 'note',
        aiBranch: true,
        text: `【${option.title}】\n${option.text}`,
        createdAt: Date.now(),
        x: position.x,
        y: position.y,
      };
      const edge = {
        id: `edge:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
        from: source.id,
        to: branch.id,
        kind: 'custom',
      };
      model.nodes.push(branch);
      model.edges.push(edge);
      if (!message.creativeCanvasBranchesAdded.includes(option.text))
        message.creativeCanvasBranchesAdded.push(option.text);
      pending = { branchId: branch.id, edgeId: edge.id, status: 'saving' };
      pendingCanvasBranches.set(actionKey, pending);
    } else {
      pending.status = 'saving';
    }
    button.disabled = true;
    button.classList.add('is-pending-save');
    button.setAttribute('aria-label', `正在保存：${option.title}`);
    button.textContent = '保存中…';
    renderCanvasNodes();
    let saveResult;
    try {
      saveResult = await saveCanvasModel();
    } catch (error) {
      saveResult = { projectSaved: false, error: { message: error.message || '未知错误' } };
    }
    if (!saveResult.projectSaved) {
      pending.status = 'pending';
      button.disabled = false;
      button.setAttribute('aria-label', `重试保存：${option.title}`);
      button.textContent = `↻ ${option.title}`;
      if (announce) announce.textContent = '分支未保存，当前页面仍保留草稿；可重试保存。';
      if (saveResult.error && typeof toast === 'function' && !saveResult.error.status)
        toast(`分支未保存：${saveResult.error.message}`);
      return;
    }
    pendingCanvasBranches.delete(actionKey);
    button.disabled = true;
    button.classList.remove('is-pending-save');
    button.setAttribute('aria-label', `已落地：${option.title}`);
    button.textContent = `✓ ${option.title}`;
    globalThis.switchTab('creative-flow');
    requestAnimationFrame(() => centerCanvasOnNode(branch.id));
    if (announce) announce.textContent = `已将“${option.title}”连回原灵感。`;
  };

  const readStreamFinishReason = async (response) => {
    const reader = response?.body?.getReader?.();
    if (!reader) return null;
    const decoder = new TextDecoder();
    let buffer = '';
    let finishReason = null;
    const inspectLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) return;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') return;
      try {
        const payload = JSON.parse(data);
        const reason = payload.choices?.find?.((choice) => choice?.finish_reason || choice?.finishReason);
        finishReason = reason?.finish_reason || reason?.finishReason || finishReason;
      } catch {
        // Ignore non-JSON stream events; the main workbench parser handles provider errors.
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(inspectLine);
    }
    buffer += decoder.decode();
    if (buffer.trim()) inspectLine(buffer);
    return finishReason;
  };

  const captureChatFinishReason = async (call) => {
    const nativeFetch = globalThis.fetch;
    let captured = false;
    let observation = null;
    const observingFetch = async function (...args) {
      const response = await Reflect.apply(nativeFetch, this, args);
      const input = args[0];
      const url =
        typeof input === 'string' || input instanceof URL ? String(input) : String(input?.url || '');
      if (!captured && response.ok && /\/chat\/completions(?:[?#]|$)/i.test(url) && response.body) {
        captured = true;
        try {
          observation = readStreamFinishReason(response.clone()).catch(() => null);
        } catch {
          observation = Promise.resolve(null);
        }
      }
      return response;
    };

    globalThis.fetch = observingFetch;
    try {
      const text = await call();
      return { text, finishReason: observation ? await observation : null };
    } catch (error) {
      if (observation) await observation;
      throw error;
    } finally {
      if (globalThis.fetch === observingFetch) globalThis.fetch = nativeFetch;
    }
  };

  const isLengthLimitedFinish = (finishReason) =>
    ['length', 'max_tokens', 'max_output_tokens', 'max_tokens_reached', 'token_limit'].includes(
      String(finishReason || '').toLowerCase(),
    );

  const hasDedicatedRoute = (route) => String(state.modelRoutes?.[route] || '').trim().length > 0;
  const resolveCanvasDraftRoute = (mode, draftRoute, preferredRoute) => {
    if (mode === 'brainstorm' && hasDedicatedRoute('outline')) return 'outline';
    return preferredRoute && hasDedicatedRoute(preferredRoute) ? preferredRoute : draftRoute;
  };
  const resolveEditorialRoute = (mode, draftRoute, preferredRoute) => {
    if (hasDedicatedRoute('editing')) return 'editing';
    if (mode === 'brainstorm' && hasDedicatedRoute('outline')) return 'outline';
    if (preferredRoute && hasDedicatedRoute(preferredRoute)) return preferredRoute;
    return draftRoute;
  };

  const installChatCanvasBranchLoop = () => {
    const nativeApiStreamChat = globalThis.apiStreamChat;
    if (typeof nativeApiStreamChat === 'function' && !nativeApiStreamChat.canvasQualityWrapped) {
      const wrappedApiStreamChat = function (messages, onChunk, options = {}) {
        const outlineRequest = options?.route === 'outline' ? canvasOutlineRequest : null;
        const chatRequest =
          activeCanvasGenerationRequest?.chatId === state.activeChatId ? activeCanvasGenerationRequest : null;
        const mainRequest =
          activeMainQualityRequest &&
          !activeMainQualityRequest.consumed &&
          activeMainQualityRequest.route === options?.route
            ? activeMainQualityRequest
            : null;
        const autoContinuationParent =
          options?.qualityStage === 'auto-continue' &&
          activeMainQualityRequest?.mode === 'chapter' &&
          activeMainQualityRequest.consumed &&
          activeMainQualityRequest.route === options?.route
            ? activeMainQualityRequest
            : null;
        const autoContinuationRequest = autoContinuationParent
          ? (() => {
              const chapterNumber = Number(state.currentChapter || 0);
              const chapterBaseContent = String(
                document.getElementById('chapterEditor')?.value ||
                  globalThis.getChapterContent?.(chapterNumber) ||
                  '',
              );
              const chapterExpectation = autoContinuationParent.chapterExpectation;
              const baseLength = countWritingCharacters(chapterBaseContent);
              const completionMinimum = Number(
                chapterExpectation?.completionMinimum || Math.ceil((chapterExpectation?.target || 0) * 0.7),
              );
              return {
                mode: 'continue',
                progressOwnerId: autoContinuationParent.progressOwnerId,
                route: 'chapter',
                main: true,
                autoSupplement: true,
                parentRequest: autoContinuationParent,
                consumed: true,
                chapterNumber,
                chapterBaseContent,
                chapterExpectation: chapterExpectation?.target
                  ? {
                      mode: chapterExpectation.mode,
                      target: Math.max(0, chapterExpectation.target - baseLength),
                      minimum: Math.max(0, completionMinimum - baseLength),
                    }
                  : null,
              };
            })()
          : null;
        const request = outlineRequest || chatRequest || mainRequest || autoContinuationRequest;
        const progress = createGenerationProgress(options, request);
        if (!request) {
          streamDockStart(
            options?.route === 'outline'
              ? '正在生成大纲'
              : options?.route === 'memory'
                ? '记忆与资料更新'
                : 'AI 正在生成内容',
            progress,
          );
          const direct = nativeApiStreamChat.call(
            this,
            messages,
            (chunk) => {
              streamDockChunk(chunk, '模型输出', progress);
              if (typeof onChunk === 'function') onChunk(chunk);
            },
            {
              ...options,
              onReasoning: (chunk) => {
                streamDockChunk(chunk, '模型输出', progress, 'reasoning');
                if (typeof options?.onReasoning === 'function') options.onReasoning(chunk);
              },
            },
          );
          return Promise.resolve(direct).then(
            (value) => {
              streamDockFinish('done', progress);
              return value;
            },
            (error) => {
              streamDockFinish('error', progress);
              throw error;
            },
          );
        }
        if (request.qualityPassRunning) return nativeApiStreamChat.apply(this, arguments);
        request.qualityPassRunning = true;
        if (mainRequest) {
          mainRequest.consumed = true;
          mainRequest.main = true;
        }
        const mode = outlineRequest
          ? 'outline'
          : chatRequest?.mode || mainRequest?.mode || autoContinuationRequest?.mode;
        request.mode ||= mode;
        const editorialOptions = {
          ...options,
          route: resolveEditorialRoute(mode, options?.route, chatRequest?.route),
          _generationProgress: progress,
        };
        const draftOptions = {
          ...options,
          route: resolveCanvasDraftRoute(mode, options?.route, chatRequest?.route),
          _generationProgress: progress,
        };
        request.qualityPassRoute = editorialOptions.route || 'default';
        const systemMessages = messages.filter((message) => message.role === 'system');
        const lastUser = [...messages].reverse().find((message) => message.role === 'user');
        if (!lastUser) {
          request.qualityPassRunning = false;
          return nativeApiStreamChat.apply(this, arguments);
        }
        const isolatedMessages = mainRequest
          ? buildMainQualityReviewContext(messages, mode)
          : [...systemMessages, { role: 'user', content: lastUser.content }];
        const usesOutlineArchitecture = mode === 'outline';
        const usesSceneBlueprint = !!request.main && ['chapter', 'continue'].includes(mode);
        const refine = async () => {
          streamDockStart(
            usesOutlineArchitecture
              ? '正在生成大纲 · 先搭结构再落章节'
              : usesSceneBlueprint
                ? '正在生成正文 · 先规划场景再写作'
                : mode === 'outline'
                  ? '正在生成大纲'
                  : 'AI 正在生成内容',
            progress,
          );
          let firstResult;
          let firstDraft;
          if (usesOutlineArchitecture) {
            if (request.providedArchitecture) {
              request.outlineArchitecture = parseOutlineArchitecture(request.providedArchitecture);
              streamDockChunk('', '沿用全篇故事蓝图', progress);
            } else {
              markOutlineArchitecturePlanningStarted();
              const planningMessages = addOutlineArchitecturePlanningProtocol(
                isolatedMessages,
                request.architectureScope || request.outlineExpectation,
              );
              try {
                const planningResult = await captureChatFinishReason(() =>
                  monitoredNativeStream(
                    nativeApiStreamChat,
                    this,
                    planningMessages,
                    { ...draftOptions, temperature: 0.35 },
                    '故事结构蓝图',
                  ),
                );
                request.outlineArchitectureFinishReason = planningResult.finishReason;
                if (isLengthLimitedFinish(planningResult.finishReason))
                  throw new Error('结构蓝图触及长度上限');
                request.outlineArchitecture = parseOutlineArchitecture(planningResult.text);
              } catch (error) {
                if (
                  error?.name === 'AbortError' ||
                  error?.status >= 400 ||
                  /(?:HTTP\s+\d{3}|insufficient\s+balance|invalid\s+request|api\s*key|余额不足)/i.test(
                    String(error?.message || ''),
                  )
                )
                  throw error;
                request.outlineArchitectureWarning = String(error?.message || '结构蓝图格式不完整');
                if (!state.autoGenerating && typeof toast === 'function')
                  toast('结构规划未完整，已切换直接大纲生成；原大纲仍会保留到新稿完成。');
              }
            }

            markOutlineDraftStarted();
            if (request.outlineArchitecture) {
              const draftMessages = addPlannedOutlineDraftProtocol(
                isolatedMessages,
                request.outlineArchitecture,
                request.outlineExpectation,
              );
              firstResult = await captureChatFinishReason(() =>
                monitoredNativeStream(nativeApiStreamChat, this, draftMessages, draftOptions, '章节大纲'),
              );
            } else {
              firstResult = await captureChatFinishReason(() =>
                monitoredNativeStream(
                  nativeApiStreamChat,
                  this,
                  isolatedMessages,
                  draftOptions,
                  '直接章节大纲',
                ),
              );
            }
            firstDraft = String(firstResult?.text || '').trim();
          } else if (usesSceneBlueprint) {
            markScenePlanningStarted(mode, request);
            const planningMessages = addSceneBlueprintPlanningProtocol(isolatedMessages, mode);
            const planningResult = await captureChatFinishReason(() =>
              monitoredNativeStream(
                nativeApiStreamChat,
                this,
                planningMessages,
                { ...draftOptions, temperature: 0.35 },
                '本章场景蓝图',
              ),
            );
            request.scenePlanFinishReason = planningResult.finishReason;
            if (isLengthLimitedFinish(planningResult.finishReason))
              throw new Error('场景蓝图规划触及模型长度上限；原章节已保留，请重试。');
            request.sceneBlueprint = parseSceneBlueprintPlan(planningResult.text);

            markSceneDraftStarted(mode, request);
            const draftMessages = addPlannedChapterDraftProtocol(
              isolatedMessages,
              mode,
              request.sceneBlueprint,
            );
            firstResult = await captureChatFinishReason(() =>
              monitoredNativeStream(nativeApiStreamChat, this, draftMessages, draftOptions, '章节正文'),
            );
            firstDraft = String(firstResult.text || '').trim();
            // Accept older providers that still follow a combined plan/body format, but
            // keep the separately planned blueprint as the authoritative structure.
            if (
              firstDraft.includes(CHAPTER_SCENE_BODY_MARKER) ||
              firstDraft.includes(CHAPTER_SCENE_BLUEPRINT_MARKER)
            ) {
              const legacyDraft = parseChapterSceneBlueprintDraft(firstDraft);
              if (legacyDraft.error) throw new Error(legacyDraft.error);
              firstDraft = legacyDraft.draft;
            }
          } else {
            firstResult = await captureChatFinishReason(() =>
              monitoredNativeStream(nativeApiStreamChat, this, isolatedMessages, draftOptions, 'AI 初稿'),
            );
            firstDraft = firstResult.text;
          }
          request.firstFinishReason = firstResult.finishReason;
          request.firstDraft = firstDraft;
          if (!String(firstDraft || '').trim()) {
            if (mode === 'chapter') throw new Error('模型没有返回章节正文；原章节已保留，请重试。');
            if (request.autoSupplement)
              request.qualityRejectionReason = '自动补写没有返回正文，已保留此前的审校正文。';
            if (mode === 'ending') throw new Error('模型未返回结尾内容');
            return firstDraft;
          }

          markQualityPassStarted(mode, request);
          const parsedOutlineDraft = mode === 'outline' ? globalThis.parseOutlineJSON?.(firstDraft) : null;
          const outlineExpectation = request.outlineExpectation?.count
            ? {
                ...request.outlineExpectation,
                draftCount: Array.isArray(parsedOutlineDraft) ? parsedOutlineDraft.length : null,
              }
            : null;
          const outlineOutputContract =
            mode === 'outline' ? parseOutlineOutputContract(lastUser.content) : null;
          request.outlineOutputContract = outlineOutputContract;

          const reviewMessages = [
            ...withEditorialReviewSystem(isolatedMessages),
            ...(request.autoSupplement
              ? [
                  {
                    role: 'user',
                    content: `【此前已审校的本章正文｜只作连续性参考】\n${request.chapterBaseContent}\n\n只审校后续新增部分；不得重写、复述或改写这段正文。`,
                  },
                ]
              : []),
            { role: 'assistant', content: firstDraft },
            {
              role: 'user',
              content: buildCanvasRefinementPrompt(
                mode,
                outlineExpectation,
                request.chapterExpectation,
                isLengthLimitedFinish(firstResult.finishReason),
                outlineOutputContract,
                request.sceneBlueprint,
                request.outlineArchitecture,
              ),
            },
          ];
          let revised = '';
          try {
            const reviewResult = await captureChatFinishReason(() =>
              monitoredNativeStream(
                nativeApiStreamChat,
                this,
                reviewMessages,
                {
                  ...editorialOptions,
                  temperature:
                    mode === 'brainstorm' ? 0.45 : ['chapter', 'continue'].includes(mode) ? 0.55 : 0.2,
                },
                '质量校验与精修',
              ),
            );
            request.reviewFinishReason = reviewResult.finishReason;

            if (isLengthLimitedFinish(reviewResult.finishReason)) {
              request.outputTruncated = true;
              request.qualityRejectionReason = `精修输出触及模型长度上限，已保留初稿。${describeFallbackDraftQuality(mode, firstDraft, lastUser, request)}`;
              if (!request.main && typeof toast === 'function') toast(request.qualityRejectionReason);
              revised = firstDraft;
            } else {
              const editorialResult = parseEditorialRefinement(reviewResult.text);
              revised = editorialResult.artifact;
              request.editorialFeedback = editorialResult.feedback;
              if (!String(revised || '').trim()) throw new Error('精修阶段没有返回修订稿');
              request.qualityReviewIssues = [
                ...analyzeEditorialChange(firstDraft, revised, request.editorialFeedback),
                ...analyzeRefinedDraft(mode, firstDraft, revised, lastUser, request),
              ];
              if (request.qualityReviewIssues.length > 0) {
                request.qualityRepairAttempted = true;
                if (typeof toast === 'function' && !state.autoGenerating)
                  toast('精修稿未通过质量校验，正在进行一次针对性修复…');
                const repairResult = await captureChatFinishReason(() =>
                  monitoredNativeStream(
                    nativeApiStreamChat,
                    this,
                    [
                      ...reviewMessages,
                      { role: 'assistant', content: revised },
                      {
                        role: 'user',
                        content: buildQualityRepairPrompt(
                          mode,
                          request.chapterExpectation,
                          request.qualityReviewIssues,
                          request.qualityContract,
                        ),
                      },
                    ],
                    {
                      ...editorialOptions,
                      temperature:
                        mode === 'outline' ? 0.15 : ['chapter', 'continue'].includes(mode) ? 0.4 : 0.35,
                    },
                    '针对性修复',
                  ),
                );
                request.qualityRepairFinishReason = repairResult.finishReason;
                let repaired = '';
                try {
                  repaired = parseQualityRepairArtifact(repairResult.text).trim();
                } catch (error) {
                  request.qualityRepairFormatInvalid = error?.code === 'EDITORIAL_FORMAT';
                }
                const repairAccepted =
                  !!repaired &&
                  !isLengthLimitedFinish(repairResult.finishReason) &&
                  !analyzeEditorialChange(firstDraft, repaired).length &&
                  validateRefinedDraft(mode, firstDraft, repaired, lastUser, request);
                if (repairAccepted) {
                  revised = repaired;
                  request.qualityRepairAccepted = true;
                  request.qualityReviewCompleted = true;
                } else {
                  request.outputTruncated =
                    isLengthLimitedFinish(firstResult.finishReason) ||
                    isLengthLimitedFinish(repairResult.finishReason);
                  request.qualityRepairAccepted = false;
                  request.qualityRejectionReason =
                    mode === 'outline'
                      ? '精修与一次针对性修复仍未满足大纲数量、篇幅或剧情保留要求，已保留初稿。'
                      : mode === 'chapter' && request.chapterExpectation?.minimum
                        ? '精修与一次针对性修复仍低于本章篇幅底线，已保留完整初稿。'
                        : mode === 'ending'
                          ? '结尾精修与一次针对性修复仍未保住有效场景细节，已保留完整初稿。'
                          : request.outlineExpectation
                            ? '精修与一次针对性修复仍未达到目标章数或保住关键剧情，已保留初稿。'
                            : '精修与一次针对性修复仍未通过结构检查，已安全保留完整初稿。';
                  request.qualityRejectionReason += ` ${describeFallbackDraftQuality(mode, firstDraft, lastUser, request)}`;
                  if (request.qualityRepairFormatInvalid)
                    request.qualityRejectionReason += ' 针对性修复未提供可解析的完整修订稿。';
                  if (typeof toast === 'function' && !request.main && !state.autoGenerating)
                    toast(request.qualityRejectionReason);
                  revised = firstDraft;
                }
              } else request.qualityReviewCompleted = true;
            }
            if (request.autoSupplement && request.qualityRejectionReason) {
              request.parentRequest.autoContinuationQualityIssue = request.qualityRejectionReason;
              return '';
            }
            if ((mainRequest || request.autoSupplement) && repeatsExistingChapter(revised, request)) {
              request.qualityAbortHandled = true;
              request.qualityRejectionReason =
                mode === 'ending'
                  ? '结尾初稿与一次针对性修复仍完整复述已有正文；为避免重复追加，已保留原文。'
                  : '续写初稿与一次针对性修复仍完整复述已有正文；为避免重复追加，已保留原文。';
              if (request.autoSupplement) {
                request.parentRequest.autoContinuationQualityIssue = request.qualityRejectionReason;
                return '';
              }
              const error = new Error(request.qualityRejectionReason);
              error.code = 'DUPLICATE_APPEND_BODY';
              throw error;
            }
            if ((mainRequest || request.autoSupplement) && revised !== firstDraft)
              preservePreRefinementChapterDraft(request, firstDraft, revised);
            if (request.autoSupplement) {
              const parent = request.parentRequest;
              parent.qualityReviewCompleted = parent.qualityReviewCompleted || request.qualityReviewCompleted;
              parent.qualityRepairAccepted = parent.qualityRepairAccepted || request.qualityRepairAccepted;
              if (request.editorialFeedback)
                parent.editorialFeedback = [
                  parent.editorialFeedback,
                  `篇幅补写：${request.editorialFeedback}`,
                ]
                  .filter(Boolean)
                  .join('；');
            }
            if (typeof toast === 'function' && outlineRequest && !request.qualityRejectionReason)
              toast('大纲已完成因果与设定精修，请检查预览后再采用。');
            await streamCanvasResult(revised, onChunk);
            return revised;
          } catch (error) {
            if (error?.code === 'DUPLICATE_APPEND_BODY') throw error;
            request.outputTruncated = isLengthLimitedFinish(firstResult.finishReason);
            if (error?.name === 'AbortError') {
              request.qualityRejectionReason = '精修已中止，已保留初稿。';
              if (request.autoSupplement) {
                request.parentRequest.autoContinuationQualityIssue = request.qualityRejectionReason;
                throw error;
              }
              await streamCanvasResult(firstDraft, onChunk);
              if (mode === 'outline' || mode === 'ending') {
                if (typeof toast === 'function')
                  toast(
                    mode === 'ending' ? '结尾精修已停止，已保留完整初稿。' : '精修已停止，已保留完整初稿。',
                  );
                return firstDraft;
              }
              throw error;
            }
            const issueSummary = describeFallbackDraftQuality(mode, firstDraft, lastUser, request);
            const rejectedReviewSummary = request.qualityReviewIssues?.length
              ? `；被拒绝的修订稿问题：${request.qualityReviewIssues.slice(0, 2).join('；')}`
              : '';
            request.qualityRejectionReason =
              error?.code === 'EDITORIAL_FORMAT'
                ? `精修交付格式不完整（${String(error.message || '缺少修订稿').slice(0, 100)}），已保留初稿。${issueSummary}`
                : `精修服务失败（${String(error.message || '未知错误').slice(0, 140)}），已保留初稿。${issueSummary}${rejectedReviewSummary}`;
            if (request.autoSupplement) {
              request.parentRequest.autoContinuationQualityIssue = request.qualityRejectionReason;
              return '';
            }
            if (!request.main && typeof toast === 'function') toast(request.qualityRejectionReason);
            await streamCanvasResult(firstDraft, onChunk);
            return firstDraft;
          }
        };
        return refine()
          .then(
            (value) => {
              streamDockFinish('done', progress);
              return value;
            },
            (error) => {
              streamDockFinish('error', progress);
              throw error;
            },
          )
          .finally(() => {
            request.qualityPassRunning = false;
            if (request.autoSupplement) {
              const parent = request.parentRequest;
              const issue =
                request.qualityRejectionReason ||
                (!request.qualityReviewCompleted && !request.qualityRepairAccepted
                  ? '自动补写未完成审校。'
                  : '');
              if (issue) {
                parent.autoContinuationQualityIssue = issue;
                const expectation = parent.chapterExpectation;
                const baseLength = countWritingCharacters(request.chapterBaseContent);
                const minimum = Number(
                  expectation?.completionMinimum || Math.ceil((expectation?.target || 0) * 0.7),
                );
                const lengthNotice =
                  expectation?.target && baseLength < minimum
                    ? `当前正文 ${baseLength}/${expectation.target} 字，低于 ${minimum} 字底线。`
                    : '';
                parent.qualityRejectionReason ||= `自动补写未通过审校，已舍弃未确认内容并保留此前正文。${lengthNotice} ${issue}`;
              }
            }
          });
      };
      wrappedApiStreamChat.canvasQualityWrapped = true;
      globalThis.apiStreamChat = wrappedApiStreamChat;
    }

    for (const [functionName, mode] of [
      ['generateOutline', 'outline'],
      ['continueOutline', 'outline'],
      ['generateChapter', 'chapter'],
      ['continueChapter', 'continue'],
      ['generateEnding', 'ending'],
    ]) {
      const nativeGenerate = globalThis[functionName];
      if (typeof nativeGenerate !== 'function' || nativeGenerate.canvasQualityWrapped) continue;
      const wrappedGenerate = function (...args) {
        if (activeMainQualityRequest || canvasOutlineRequest) return nativeGenerate.apply(this, args);
        const request = {
          mode,
          progressOwnerId: args[0]?.progressOwnerId || null,
          route: mode === 'outline' ? 'outline' : 'chapter',
          functionName,
          consumed: false,
          outlineExpectation: createOutlineExpectation(functionName),
          chapterExpectation: createChapterExpectation(functionName),
          chapterNumber: Number(state.currentChapter || 0),
          chapterBaseContent: ['continueChapter', 'generateEnding'].includes(functionName)
            ? String(
                document.getElementById('chapterEditor')?.value ||
                  globalThis.getChapterContent?.(Number(state.currentChapter || 0)) ||
                  '',
              )
            : '',
          outlineBefore: mode === 'outline' ? state.outline : null,
        };
        const previousRequest = activeMainQualityRequest;
        activeMainQualityRequest = request;
        let result;
        try {
          result = nativeGenerate.apply(this, args);
        } catch (error) {
          activeMainQualityRequest = previousRequest;
          throw error;
        }
        return Promise.resolve(result)
          .then(async (value) => {
            // Native generation has finished and re-enabled its UI. Release the
            // AI request owner before the asynchronous report-save queue: a new
            // user action must get its own quality pass, not inherit a consumed one.
            if (activeMainQualityRequest === request) activeMainQualityRequest = previousRequest;
            await recordMainGenerationQuality(request);
            if (
              String(request.firstDraft || '').trim() &&
              (request.mode !== 'outline' || state.outline !== request.outlineBefore)
            )
              warnAboutGenerationQuality(request);
            return value;
          })
          .finally(() => {
            if (activeMainQualityRequest === request) activeMainQualityRequest = previousRequest;
          });
      };
      wrappedGenerate.canvasQualityWrapped = true;
      globalThis[functionName] = wrappedGenerate;
    }

    // Other writing surfaces can reuse the same architecture/draft/editorial pipeline
    // without letting legacy UI helpers commit an intermediate outline to the project.
    globalThis.runOutlineQualityTask = async function (
      messages,
      { start, end, signal, onChunk, progressOwnerId, architecture, architectureScope } = {},
    ) {
      if (activeMainQualityRequest || canvasOutlineRequest || activeCanvasGenerationRequest)
        throw new Error('另一个创作任务正在进行，请等待它完成。');
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start)
        throw new Error('章节范围无效。');
      if (
        architectureScope &&
        (!Number.isInteger(architectureScope.start) ||
          !Number.isInteger(architectureScope.end) ||
          architectureScope.start < 1 ||
          architectureScope.start > start ||
          architectureScope.end < end ||
          architectureScope.count !== architectureScope.end - architectureScope.start + 1)
      )
        throw new Error('全篇蓝图范围无效。');
      const request = {
        mode: 'outline',
        progressOwnerId,
        route: 'outline',
        main: true,
        consumed: false,
        providedArchitecture: architecture ? parseOutlineArchitecture(architecture) : '',
        architectureScope,
        outlineExpectation: {
          kind: start === 1 ? 'generate' : 'continue',
          start,
          end,
          count: end - start + 1,
        },
      };
      activeMainQualityRequest = request;
      try {
        const result = await globalThis.apiStreamChat(messages, onChunk, {
          route: 'outline',
          signal,
          temperature: 0.35,
        });
        return {
          text: result,
          quality: getQualityMetadata(request),
          architecture: request.outlineArchitecture || '',
        };
      } finally {
        if (activeMainQualityRequest === request) activeMainQualityRequest = null;
      }
    };

    const nativeSend = globalThis.sendChatMessage;
    if (typeof nativeSend === 'function' && !nativeSend.creativeCanvasBranchWrapped) {
      const wrappedSend = function (...args) {
        const input = document.getElementById('chatInput');
        const prompt = input?.value.trim() || '';
        const pending = pendingCanvasBrainstorm;
        const generationRequest = pending?.prompt === prompt ? pending : null;
        const sourceNodeId = generationRequest?.sourceNodeId || null;
        if (pending) pendingCanvasBrainstorm = null;
        activeCanvasGenerationRequest = generationRequest
          ? { ...generationRequest, chatId: state.activeChatId, qualityPassRunning: false }
          : null;
        const win = (state.chatWindows || []).find((item) => item.id === state.activeChatId);
        const previousLength = win?.messages?.length || 0;
        const result = nativeSend.apply(this, args);
        const updatedWin = (state.chatWindows || []).find((item) => item.id === win?.id);
        const assistant = updatedWin?.messages?.[previousLength + 1];
        if (sourceNodeId && assistant?.role === 'assistant' && assistant._streaming) {
          if (generationRequest?.mode === 'step') startCanvasStepExecution(activeCanvasGenerationRequest);
          assistant.creativeCanvasBranchFrom = sourceNodeId;
          activeCanvasBrainstorm = {
            chatId: updatedWin.id,
            message: assistant,
            qualityRequest: activeCanvasGenerationRequest,
          };
          persistChatMetadata();
        } else if (generationRequest && input?.value.trim() === prompt) {
          pendingCanvasBrainstorm = generationRequest;
          activeCanvasGenerationRequest = null;
        } else if (generationRequest) {
          activeCanvasGenerationRequest = null;
        }
        return result;
      };
      wrappedSend.creativeCanvasBranchWrapped = true;
      globalThis.sendChatMessage = wrappedSend;
    }

    const nativeFinish = globalThis.finishStreamingChatMessage;
    if (typeof nativeFinish === 'function' && !nativeFinish.creativeCanvasBranchWrapped) {
      const wrappedFinish = function (win, content, thinking, ...args) {
        const generationRequest =
          activeCanvasGenerationRequest?.chatId === win?.id ? activeCanvasGenerationRequest : null;
        const generationMessage =
          activeCanvasBrainstorm?.chatId === win?.id ? activeCanvasBrainstorm.message : null;
        const result = nativeFinish.call(this, win, content, thinking, ...args);
        if (activeCanvasBrainstorm?.chatId === win?.id) {
          const response = String(activeCanvasBrainstorm.message?.content || content || '').trim();
          if (!response || response.startsWith('❌')) {
            delete activeCanvasBrainstorm.message.creativeCanvasBranchFrom;
            persistChatMetadata();
          } else {
            const request =
              activeCanvasBrainstorm.qualityRequest ||
              (activeCanvasGenerationRequest?.chatId === win?.id ? activeCanvasGenerationRequest : null);
            const quality = getQualityMetadata(request);
            if (quality) {
              activeCanvasBrainstorm.message.creativeCanvasQuality = quality;
              persistChatMetadata();
            }
          }
          activeCanvasBrainstorm = null;
        }
        if (generationRequest?.mode === 'step') {
          persistCanvasStepResult(
            generationRequest,
            String(generationMessage?.content || content || '').trim(),
          );
          // A canvas step temporarily uses the chat tab as its execution surface.
          // Once the final (reviewed/repaired) artifact is stored, return to the
          // canvas only when the author is still on that execution chat. This
          // keeps the next action visible without interrupting a deliberate tab
          // change made while the model was running.
          if (
            generationRequest.qualityContract === STORY_ENGINE_QUALITY_CONTRACT &&
            state.currentTab === 'chat'
          )
            requestAnimationFrame(() => {
              if (state.currentTab === 'chat') globalThis.switchTab('creative-flow');
            });
        }
        if (activeCanvasGenerationRequest?.chatId === win?.id) activeCanvasGenerationRequest = null;
        requestAnimationFrame(decorateBrainstormReplies);
        return result;
      };
      wrappedFinish.creativeCanvasBranchWrapped = true;
      globalThis.finishStreamingChatMessage = wrappedFinish;
    }

    const nativeRender = globalThis.renderChatMessages;
    if (typeof nativeRender === 'function' && !nativeRender.creativeCanvasBranchWrapped) {
      const wrappedRender = function (...args) {
        const result = nativeRender.apply(this, args);
        requestAnimationFrame(decorateBrainstormReplies);
        return result;
      };
      wrappedRender.creativeCanvasBranchWrapped = true;
      globalThis.renderChatMessages = wrappedRender;
    }

    const installSnapshotCompareAction = () => {
      const actions = document.querySelector('#snapshotModal .snapshot-panel .modal-actions');
      if (!actions) return null;
      let button = actions.querySelector('[data-quality-snapshot-compare]');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.dataset.qualitySnapshotCompare = 'true';
        button.textContent = '与正文对比';
        button.title = '将所选历史版本与当前正文并排比较';
        actions.prepend(button);
      }
      button.disabled = !document.querySelector('#snapshotList .snapshot-item.active');
      return button;
    };

    const compareSelectedSnapshotToCurrent = () => {
      const activeItem = document.querySelector('#snapshotList .snapshot-item.active');
      const selectHandler = activeItem?.getAttribute('onclick') || '';
      const snapshotId = selectHandler.match(/selectSnapshot\(['"]([^'"]+)['"]\)/)?.[1];
      const snapshot = (state.chapterSnapshots || []).find((item) => item.id === snapshotId);
      if (!snapshot) {
        if (typeof toast === 'function') toast('请先选择一份历史版本');
        return;
      }
      const chapter = Number(snapshot.chapter);
      const sanitize = (text) =>
        typeof globalThis.sanitizeGeneratedText === 'function'
          ? globalThis.sanitizeGeneratedText(text)
          : String(text || '').trim();
      const oldText = sanitize(snapshot.content || '');
      const newText = sanitize(globalThis.getChapterContent?.(chapter) || '');
      if (oldText === newText) {
        if (typeof toast === 'function') toast('所选版本与当前正文相同');
        return;
      }
      pendingSnapshotComparison = {
        chapter,
        snapshotId,
        snapshotSource: snapshot.source || '历史版本',
        oldText,
        newText,
        recoverySnapshotId: null,
      };
      globalThis.closeSnapshotModal?.();
      globalThis.showRewriteCompare?.({
        title: `第 ${chapter} 章版本对比`,
        chapter,
        oldText,
        newText,
        oldLabel: `所选版本 · ${snapshot.source || '历史版本'}`,
        newLabel: '当前正文',
        keepOldLabel: '恢复所选版本',
        applyNewLabel: '保留当前正文',
        operationType: 'snapshot-history-compare',
        route: 'chapter',
      });
    };

    const nativeOpenSnapshotModal = globalThis.openSnapshotModal;
    if (typeof nativeOpenSnapshotModal === 'function' && !nativeOpenSnapshotModal.qualityCompareWrapped) {
      const wrappedOpenSnapshotModal = function (...args) {
        const result = nativeOpenSnapshotModal.apply(this, args);
        installSnapshotCompareAction();
        return result;
      };
      wrappedOpenSnapshotModal.qualityCompareWrapped = true;
      globalThis.openSnapshotModal = wrappedOpenSnapshotModal;
    }

    const nativeCloseRewriteCompare = globalThis.closeRewriteCompare;
    if (typeof nativeCloseRewriteCompare === 'function' && !nativeCloseRewriteCompare.qualityCompareWrapped) {
      const wrappedCloseRewriteCompare = function (...args) {
        const result = nativeCloseRewriteCompare.apply(this, args);
        pendingSnapshotComparison = null;
        return result;
      };
      wrappedCloseRewriteCompare.qualityCompareWrapped = true;
      globalThis.closeRewriteCompare = wrappedCloseRewriteCompare;
    }

    const ensureSnapshotCompareRecovery = async (comparison) => {
      let snapshot = (state.chapterSnapshots || []).find((item) => item.id === comparison.recoverySnapshotId);
      if (!snapshot) {
        snapshot = globalThis.createChapterSnapshot?.(comparison.chapter, '对比前当前正文', {
          content: comparison.newText,
          allowEmpty: true,
        });
        if (!snapshot) throw new Error('无法建立恢复快照');
        comparison.recoverySnapshotId = snapshot.id;
      }
      const save =
        typeof globalThis.saveState === 'function'
          ? globalThis.saveState()
          : typeof Store?.save === 'function'
            ? Store.save()
            : null;
      if (!save) throw new Error('保存服务不可用');
      const result = await Promise.resolve(save);
      if (result?.projectSaved === false) throw new Error(result.error?.message || '恢复快照尚未保存');
    };

    const nativeRejectRewriteCompare = globalThis.rejectRewriteCompare;
    if (
      typeof nativeRejectRewriteCompare === 'function' &&
      !nativeRejectRewriteCompare.qualityCompareWrapped
    ) {
      const wrappedRejectRewriteCompare = async function (...args) {
        const comparison = pendingSnapshotComparison;
        if (!comparison) return nativeRejectRewriteCompare.apply(this, args);
        const buttons = [
          document.getElementById('btnRewriteKeepOld'),
          document.getElementById('btnRewriteApplyNew'),
        ].filter(Boolean);
        buttons.forEach((button) => (button.disabled = true));
        try {
          await ensureSnapshotCompareRecovery(comparison);
          if (pendingSnapshotComparison !== comparison) return;
          pendingSnapshotComparison = null;
          const result = nativeRejectRewriteCompare.apply(this, args);
          if (typeof toast === 'function') toast('已恢复所选版本；恢复前正文已保存在章节历史。');
          return result;
        } catch (error) {
          if (typeof toast === 'function') toast(`未恢复版本：${error.message || '恢复快照保存失败'}`);
        } finally {
          buttons.forEach((button) => (button.disabled = false));
        }
      };
      wrappedRejectRewriteCompare.qualityCompareWrapped = true;
      globalThis.rejectRewriteCompare = wrappedRejectRewriteCompare;
    }

    const nativeApplyRewriteCompare = globalThis.applyRewriteCompare;
    if (typeof nativeApplyRewriteCompare === 'function' && !nativeApplyRewriteCompare.qualityCompareWrapped) {
      const wrappedApplyRewriteCompare = async function (...args) {
        const comparison = pendingSnapshotComparison;
        if (!comparison) return nativeApplyRewriteCompare.apply(this, args);
        const buttons = [
          document.getElementById('btnRewriteKeepOld'),
          document.getElementById('btnRewriteApplyNew'),
        ].filter(Boolean);
        buttons.forEach((button) => (button.disabled = true));
        try {
          await ensureSnapshotCompareRecovery(comparison);
          if (pendingSnapshotComparison !== comparison) return;
          pendingSnapshotComparison = null;
          globalThis.closeRewriteCompare?.();
          if (typeof toast === 'function') toast('已保留当前正文；当前版本也已记入章节历史。');
        } catch (error) {
          if (typeof toast === 'function')
            toast(`当前正文未变；历史快照保存失败：${error.message || '未知错误'}`);
        } finally {
          buttons.forEach((button) => (button.disabled = false));
        }
      };
      wrappedApplyRewriteCompare.qualityCompareWrapped = true;
      globalThis.applyRewriteCompare = wrappedApplyRewriteCompare;
    }

    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-creative-canvas-branch]');
      if (button && !button.disabled) void addBrainstormBranchToCanvas(button);
      if (event.target.closest?.('[data-quality-snapshot-compare]')) compareSelectedSnapshotToCurrent();
    });
  };

  const buildBranchOutlineContext = (branch) => {
    const branchGraph = collectIncomingCanvasGraph(branch.id, { limit: 6, visitLimit: 64 });
    const ancestors = branchGraph.notes;
    const chapterText = (state.outline || [])
      .slice(-6)
      .map(
        (chapter) =>
          `第${chapter.chapter}章 ${chapter.title}：${String(chapter.summary || '').slice(0, 160)}`,
      )
      .join('\n');
    const selected = String(branch.text || '').slice(0, 1200);
    const prior = ancestors.map((node) => `- ${canvasNodeContent(node).slice(0, 500)}`).join('\n');
    const graphEdges = serializeCanvasGraphEdges(branchGraph);
    const existing = (state.outline || []).length > 0;
    return {
      text: [
        '【画布选定分支】',
        selected,
        prior ? `【沿连线回溯的前置灵感】（按箭头从上游到下游读取）\n${prior}` : '',
        graphEdges,
        existing ? `【现有大纲末尾，用于衔接】\n${chapterText}` : '',
        existing
          ? '【最高优先级输出约束】本次只围绕选定分支生成 3—5 个连续新章节。忽略前文“按项目目标章数生成完整大纲”等要求；不得重写已有章节，不得输出整本大纲。章节号从 1 开始，确认追加时系统会自动接续编号。'
          : '【本次任务】以选定分支为核心，发展成完整章节大纲；保留其关键因果与代价，不要偏离作品设定。',
      ]
        .filter(Boolean)
        .join('\n\n'),
      nodeIds: [branch.id, ...ancestors.map((node) => node.id)],
    };
  };

  const showCanvasOutlineProposal = (proposal) => {
    const previous = document.getElementById('canvasOutlineProposalModal');
    previous?.remove();
    const chapters = proposal.candidate
      .map((chapter) => {
        const points = (chapter.plotPoints || [])
          .map((point) => `<li>${escapeHtml(point.desc || point.description || point || '')}</li>`)
          .join('');
        return `<article class="canvas-outline-preview-chapter"><h3>第 ${escapeHtml(String(chapter.chapter))} 章 · ${escapeHtml(chapter.title || '未命名章节')}</h3><p>${escapeHtml(chapter.summary || '')}</p>${points ? `<ol>${points}</ol>` : ''}</article>`;
      })
      .join('');
    const hasExisting = proposal.baseline.length > 0;
    const firstNumber = hasExisting
      ? Math.max(
          ...proposal.baseline.map((chapter, index) => {
            const parsed = Number(chapter.chapter);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : index + 1;
          }),
        ) + 1
      : 1;
    const overlay = document.createElement('div');
    overlay.id = 'canvasOutlineProposalModal';
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `<section class="modal canvas-outline-proposal" role="dialog" aria-modal="true" aria-labelledby="canvasOutlineProposalTitle"><header><div><span>画布分支</span><h2 id="canvasOutlineProposalTitle">${escapeHtml(proposal.branchTitle)} · 大纲预览</h2></div><button type="button" data-canvas-outline-cancel aria-label="关闭预览">×</button></header><div class="canvas-outline-proposal-meta">${proposal.candidate.length} 章${hasExisting ? ` · 将从第 ${firstNumber} 章接续` : ''}</div><div class="canvas-outline-preview-list">${chapters}</div><footer>${hasExisting ? '<button type="button" class="btn btn-primary" data-canvas-outline-accept="append">追加为新剧情段</button>' : '<button type="button" class="btn btn-primary" data-canvas-outline-accept="replace">采用这版大纲</button>'}<button type="button" class="btn" data-canvas-outline-cancel>取消</button></footer></section>`;
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cancelCanvasOutlineProposal();
    });
    overlay.querySelector('[data-canvas-outline-cancel]')?.focus();
  };

  const showCanvasOutlineLengthWarning = (request, count) => {
    const overlay = document.createElement('div');
    overlay.id = 'canvasOutlineProposalModal';
    overlay.className = 'modal-overlay show';
    overlay.innerHTML = `<section class="modal canvas-outline-proposal" role="dialog" aria-modal="true" aria-labelledby="canvasOutlineProposalTitle"><header><div><span>画布分支</span><h2 id="canvasOutlineProposalTitle">${escapeHtml(request.branchTitle)} · 需要重试</h2></div><button type="button" data-canvas-outline-cancel aria-label="关闭提示">×</button></header><div class="canvas-outline-length-warning">模型返回 ${count} 章；已有大纲时只接受 3–5 章。原大纲未改变。</div><footer><button type="button" class="btn btn-primary" data-canvas-outline-cancel>关闭并重试</button></footer></section>`;
    document.body.append(overlay);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) cancelCanvasOutlineProposal();
    });
    overlay.querySelector('[data-canvas-outline-cancel]')?.focus();
  };

  const cancelCanvasOutlineProposal = () => {
    canvasOutlineProposal = null;
    document.getElementById('canvasOutlineProposalModal')?.remove();
    globalThis.renderOutline?.();
  };

  const acceptCanvasOutlineProposal = async (mode) => {
    const proposal = canvasOutlineProposal;
    if (!proposal) return;
    if (JSON.stringify(state.outline || []) !== JSON.stringify(proposal.baseline)) {
      const overlay = document.getElementById('canvasOutlineProposalModal');
      const meta = overlay?.querySelector('.canvas-outline-proposal-meta');
      if (meta) meta.textContent = '大纲已变化，本次结果未采用。关闭后重新发展此分支。';
      const accept = overlay?.querySelector('[data-canvas-outline-accept]');
      if (accept) accept.disabled = true;
      const cancel = overlay?.querySelector('footer [data-canvas-outline-cancel]');
      if (cancel) cancel.textContent = '关闭';
      if (typeof toast === 'function') toast('大纲已变化，已阻止覆盖');
      return;
    }
    const chapters = structuredClone(proposal.candidate);
    let adopted;
    if (mode === 'append' && (state.outline || []).length) {
      const start =
        Math.max(
          ...proposal.baseline.map((chapter, index) => {
            const parsed = Number(chapter.chapter);
            return Number.isFinite(parsed) && parsed > 0 ? parsed : index + 1;
          }),
        ) + 1;
      adopted = chapters.map((chapter, index) => ({
        ...chapter,
        chapter: start + index,
        sourceCanvasBranchId: proposal.branchId,
        plotPoints: (chapter.plotPoints || []).map((point, pointIndex) => ({
          ...point,
          id: `pp-${start + index}-${pointIndex + 1}`,
          done: false,
        })),
      }));
      state.outline = [...state.outline, ...adopted];
    } else {
      adopted = chapters.map((chapter) => ({ ...chapter, sourceCanvasBranchId: proposal.branchId }));
      state.outline = adopted;
    }
    const maxAdoptedChapter = Math.max(
      0,
      ...adopted.map((chapter, index) => {
        const number = Number(chapter.chapter);
        return Number.isInteger(number) && number > 0 ? number : index + 1;
      }),
    );
    if (maxAdoptedChapter > Number(state.project?.chapterCount || 0)) {
      state.project.chapterCount = maxAdoptedChapter;
      const chapterCountInput = document.getElementById('chapterCount');
      if (chapterCountInput) chapterCountInput.value = String(maxAdoptedChapter);
    }
    canvasOutlineProposal = null;
    document.getElementById('canvasOutlineProposalModal')?.remove();
    globalThis.renderOutline?.();
    globalThis.updateOutlineActionButton?.();
    globalThis.renderMobileApp?.();
    renderCanvasNodes();
    renderWorkflowCards();
    if (typeof globalThis.saveState === 'function') await globalThis.saveState();
    if (typeof toast === 'function') toast(`已将画布分支写入大纲：${adopted.length} 章`);
  };

  const startCanvasBranchOutline = (branchId) => {
    if (!state.baseURL || !state.model) {
      if (typeof toast === 'function') toast('先配置 AI，再发展这条分支');
      globalThis.openSettings?.();
      return;
    }
    if (state.generating || canvasOutlineRequest) {
      if (typeof toast === 'function') toast('当前已有生成任务，请稍后再试');
      return;
    }
    const branch = canvasModel().nodes.find((node) => node.id === branchId && node.kind === 'note');
    if (!branch) return;
    if (!Array.isArray(state.outline)) state.outline = [];
    const title = String(branch.text || '').match(/^【([^】]+)】/)?.[1] || '选定分支';
    const branchContext = buildBranchOutlineContext(branch);
    canvasOutlineRequest = {
      branchId,
      branchTitle: title,
      context: branchContext.text,
      contextNodeIds: branchContext.nodeIds,
      baseline: structuredClone(state.outline || []),
      baselineRef: state.outline,
      contextAdded: false,
      rawRepairShown: false,
    };
    globalThis.switchTab('outline');
    requestAnimationFrame(() => globalThis.generateOutline?.());
  };

  const installOutlineBranchBridge = () => {
    const nativeCreativeRulesContext = globalThis.buildCreativeRulesContext;
    if (
      typeof nativeCreativeRulesContext === 'function' &&
      !nativeCreativeRulesContext.canvasStageContextWrapped
    ) {
      const wrappedCreativeRulesContext = function (target, ...args) {
        const context = nativeCreativeRulesContext.call(this, target, ...args);
        const request = target === 'outline' ? canvasOutlineRequest : null;
        const canvasTarget = canvasContextTargetOverride || target;
        const canvasContext = buildCanvasStageContext(canvasTarget, request?.contextNodeIds || []);
        const qualityContext =
          target === 'outline'
            ? [
                '【剧情架构质量标准】',
                '把作者设定、人工确认资料、已写正文和已有大纲视为正史；画布提案与未确认 AI 记忆不是既定事实。遵守作者指定的视角角色和切换规则。',
                '先确立故事的核心戏剧问题、主角的具体欲望、持续施压的对手/阻力与失败代价，再按计划篇幅安排递进、转折、高潮与余波；不要机械套固定三幕公式。',
                '章节之间必须有因果：上一章的结果迫使下一章作出选择；选择改变关系、目标或处境，并留下后续代价。安排伏笔时要有铺垫与回收，避免重复冲突、无效过场、巧合解围和未经铺垫的反转。',
                '每章概要写清具体事件、人物行动与结果，不用主题口号代替剧情；保留现有提示词要求的篇幅和字段。剧情关键点按发生顺序递进，每点都能在正文中演出来。',
                '输出前检查人物动机是否成立、章节功能是否重复、因果是否闭合、结尾是否兑现本段承诺并提出自然的新问题；只修复问题，不改变作者确立的事实。',
              ].join('\n')
            : ['chapter', 'continue'].includes(target)
              ? [
                  '【小说正文质量标准】',
                  '服从本章大纲、关键点、已定稿正文、人物状态和作者视角规则。人物必须基于当下目标与认知作出选择；让行动、阻力、反应和后果推动场景，不用旁白概述替代关键戏剧。',
                  '将剧情节点写成可感知的场景：目标清楚、阻力具体、局势发生变化；对白有角色差异和潜台词，细节服务人物、氛围或因果。让情绪通过选择、动作和关系变化显现，避免同义复述、空泛感悟与无效过渡。',
                  '不增加与正史冲突的新设定，不替角色知道其未知信息；严格满足原提示词的篇幅和输出格式。落笔前检查关键点覆盖、场景因果、人物连续性与视角边界。',
                ].join('\n')
              : '';
        return [context, qualityContext, canvasContext].filter(Boolean).join('\n\n');
      };
      wrappedCreativeRulesContext.canvasStageContextWrapped = true;
      globalThis.buildCreativeRulesContext = wrappedCreativeRulesContext;
    }

    for (const functionName of [
      'runExpertReview',
      'rewriteChapterByReviewInstruction',
      'rewriteChapterForReviewIssues',
      'rewriteChapterForReviewIssue',
    ]) {
      const nativeReviewFunction = globalThis[functionName];
      if (typeof nativeReviewFunction !== 'function' || nativeReviewFunction.canvasContextWrapped) continue;
      const wrappedReviewFunction = function (...args) {
        const previousTarget = canvasContextTargetOverride;
        canvasContextTargetOverride = 'review';
        try {
          return nativeReviewFunction.apply(this, args);
        } finally {
          canvasContextTargetOverride = previousTarget;
        }
      };
      wrappedReviewFunction.canvasContextWrapped = true;
      globalThis[functionName] = wrappedReviewFunction;
    }

    const nativeExtraContext = globalThis.buildExtraWritingContext;
    if (typeof nativeExtraContext === 'function' && !nativeExtraContext.canvasBranchWrapped) {
      const wrappedExtraContext = function (target, ...args) {
        const context = nativeExtraContext.call(this, target, ...args);
        const request = canvasOutlineRequest;
        if (target !== 'outline' || !request || request.contextAdded) return context;
        request.contextAdded = true;
        return `${context || ''}\n\n${request.context}`;
      };
      wrappedExtraContext.canvasBranchWrapped = true;
      globalThis.buildExtraWritingContext = wrappedExtraContext;
    }

    const nativeRender = globalThis.renderOutline;
    if (typeof nativeRender === 'function' && !nativeRender.canvasBranchWrapped) {
      const wrappedRender = function (...args) {
        const request = canvasOutlineRequest;
        if (request?.contextAdded && state.outline !== request.baselineRef) {
          const candidate = structuredClone(state.outline || []);
          state.outline = request.baselineRef;
          const result = nativeRender.apply(this, args);
          canvasOutlineRequest = null;
          if (candidate.length) {
            if (request.baseline.length && (candidate.length < 3 || candidate.length > 5)) {
              showCanvasOutlineLengthWarning(request, candidate.length);
              return result;
            }
            canvasOutlineProposal = {
              ...request,
              candidate,
            };
            showCanvasOutlineProposal(canvasOutlineProposal);
          }
          return result;
        }
        if (request?.rawRepairShown && state.outline === request.baselineRef) {
          canvasOutlineRequest = null;
        }
        return nativeRender.apply(this, args);
      };
      wrappedRender.canvasBranchWrapped = true;
      globalThis.renderOutline = wrappedRender;
    }

    const nativeGenerate = globalThis.generateOutline;
    if (typeof nativeGenerate === 'function' && !nativeGenerate.canvasBranchWrapped) {
      const wrappedGenerate = function (...args) {
        const request = canvasOutlineRequest;
        const result = nativeGenerate.apply(this, args);
        if (!request) return result;
        return Promise.resolve(result).finally(() => {
          if (canvasOutlineRequest !== request || request.rawRepairShown) return;
          canvasOutlineRequest = null;
          // A provider failure must not leave a stale branch preview overlay over the
          // workbench. Successful proposals clear the request inside renderOutline first.
          document.getElementById('canvasOutlineProposalModal')?.remove();
          globalThis.renderOutline?.();
        });
      };
      wrappedGenerate.canvasBranchWrapped = true;
      globalThis.generateOutline = wrappedGenerate;
    }

    const nativeRawRepair = globalThis.showOutlineRawRepair;
    if (typeof nativeRawRepair === 'function' && !nativeRawRepair.canvasBranchWrapped) {
      const wrappedRawRepair = function (...args) {
        const result = nativeRawRepair.apply(this, args);
        const request = canvasOutlineRequest;
        if (request?.contextAdded) {
          request.rawRepairShown = true;
          const actions = document.querySelector('#outlineContainer > div > div');
          if (actions && !actions.querySelector('[data-canvas-outline-cancel]')) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'btn btn-sm';
            cancel.dataset.canvasOutlineCancel = 'true';
            cancel.textContent = '取消并保留原大纲';
            actions.append(cancel);
          }
        }
        return result;
      };
      wrappedRawRepair.canvasBranchWrapped = true;
      globalThis.showOutlineRawRepair = wrappedRawRepair;
    }

    const nativeToast = globalThis.toast;
    if (typeof nativeToast === 'function' && !nativeToast.canvasBranchWrapped) {
      const wrappedToast = function (message, ...args) {
        if (
          canvasOutlineProposal &&
          (/^✅ 已生成 .*大纲/.test(String(message)) || /^修复成功，已解析/.test(String(message)))
        )
          return;
        return nativeToast.call(this, message, ...args);
      };
      wrappedToast.canvasBranchWrapped = true;
      globalThis.toast = wrappedToast;
    }

    document.addEventListener('click', (event) => {
      const branchAction = event.target.closest?.('[data-note-outline]');
      if (branchAction) {
        event.preventDefault();
        event.stopPropagation();
        startCanvasBranchOutline(branchAction.dataset.noteOutline);
        return;
      }
      if (event.target.closest?.('[data-canvas-outline-cancel]')) {
        const wasProposal = Boolean(canvasOutlineProposal);
        if (wasProposal) cancelCanvasOutlineProposal();
        else {
          canvasOutlineRequest = null;
          globalThis.renderOutline?.();
        }
        return;
      }
      const accept = event.target.closest?.('[data-canvas-outline-accept]');
      if (accept) void acceptCanvasOutlineProposal(accept.dataset.canvasOutlineAccept);
    });
  };

  const setConnectMode = (enabled) => {
    connectMode = enabled;
    connectSourceId = null;
    canvasViewport?.classList.toggle('is-connect-mode', connectMode);
    const hint = flowPage?.querySelector('#creativeCanvasHint');
    if (hint) hint.textContent = connectMode ? '已选连线起点，请选择目标；按 Esc 取消。' : '';
    canvasWorld
      ?.querySelectorAll('[data-canvas-node]')
      .forEach((node) => node.classList.remove('is-connect-source'));
  };

  const addCanvasConnection = async (fromId, toId) => {
    if (fromId === toId) {
      if (announce) announce.textContent = '选择另一个节点作为连线目标。';
      return false;
    }
    const model = canvasModel();
    const canConnect = (id) => model.nodes.some((node) => node.id === id);
    if (!canConnect(fromId) || !canConnect(toId)) {
      if (announce) announce.textContent = '剧情段连线由大纲自动生成。';
      return false;
    }
    const exists = model.edges.some((edge) => edge.from === fromId && edge.to === toId);
    if (exists) {
      if (announce) announce.textContent = '这两个节点之间已经有连线。';
      return false;
    }
    model.edges.push({
      id: `edge:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`,
      from: fromId,
      to: toId,
      kind: 'custom',
    });
    selectedEdgeId = null;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, '连线已保存。', '连线尚未保存，当前页面仍保留草稿。');
    return Boolean(saveResult.projectSaved);
  };

  const connectCanvasNode = async (nodeId) => {
    if (!connectSourceId) {
      connectSourceId = nodeId;
      canvasWorld
        ?.querySelector(`[data-canvas-node-id="${CSS.escape(nodeId)}"]`)
        ?.classList.add('is-connect-source');
      if (announce) announce.textContent = '已选连线起点，请再选择一个目标节点。';
      return;
    }
    if (connectSourceId === nodeId) {
      setConnectMode(false);
      return;
    }
    const sourceId = connectSourceId;
    setConnectMode(false);
    await addCanvasConnection(sourceId, nodeId);
  };

  const deleteSelectedEdge = async () => {
    if (!selectedEdgeId) return;
    const model = canvasModel();
    model.edges = model.edges.filter((edge) => edge.id !== selectedEdgeId);
    selectedEdgeId = null;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, '已删除选中的连线。', '连线删除尚未保存，当前页面仍保留草稿。');
  };

  const deleteCanvasNote = async (nodeId) => {
    const model = canvasModel();
    const node = model.nodes.find((item) => item.id === nodeId);
    if (!node || !['note', 'step', 'experiment'].includes(node.kind)) return;
    const label =
      node.kind === 'step' ? '这个工作步骤' : node.kind === 'experiment' ? '这个玩法实验' : '这张画布便笺';
    if (!window.confirm(`删除${label}？${node.kind === 'note' ? '原收件箱灵感不会受影响。' : ''}`)) return;
    model.nodes = model.nodes.filter((item) => item.id !== nodeId);
    model.edges = model.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, '节点已删除。', '节点删除尚未保存，当前页面仍保留草稿。');
  };

  const hideCanvasStage = async (stageId) => {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) return;
    const model = canvasModel();
    model.legacyStarterReviewed = true;
    if (!model.hiddenStageIds.includes(stageId)) model.hiddenStageIds.push(stageId);
    selectedEdgeId = null;
    renderCanvasNodes();
    const saveResult = await saveCanvasModel();
    announceCanvasSave(
      saveResult,
      `已隐藏「${stage.title}」，项目内容与连线保留；可从＋恢复。`,
      '节点隐藏尚未保存，当前页面仍保留草稿。',
    );
  };

  const restoreCanvasStage = async (stageId) => {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) return;
    const model = canvasModel();
    model.legacyStarterReviewed = true;
    model.hiddenStageIds = model.hiddenStageIds.filter((hiddenId) => hiddenId !== stageId);
    let node = model.nodes.find((item) => item.id === `stage:${stageId}`);
    if (!node) {
      node = {
        id: `stage:${stageId}`,
        kind: 'stage',
        stageId,
        ...defaultStagePositions[stageId],
      };
      model.nodes.push(node);
    }
    renderCanvasNodes();
    centerCanvasOnNode(node.id);
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, `已恢复「${stage.title}」。`, '节点恢复尚未保存，当前页面仍保留草稿。');
  };

  const addCanvasStage = async (stageId) => {
    const stage = stages.find((item) => item.id === stageId);
    if (!stage) return;
    const model = canvasModel();
    model.legacyStarterReviewed = true;
    let node = model.nodes.find((item) => item.id === `stage:${stageId}`);
    if (node) {
      await restoreCanvasStage(stageId);
      return;
    }
    const position = findOpenPosition(
      worldSize.width / 2 - 132,
      worldSize.height / 2 - 69,
      { width: 264, height: 138 },
      canvasNodes(),
    );
    node = {
      id: `stage:${stageId}`,
      kind: 'stage',
      stageId,
      ...position,
    };
    model.nodes.push(node);
    renderCanvasNodes();
    centerCanvasOnNode(node.id);
    const saveResult = await saveCanvasModel();
    announceCanvasSave(saveResult, `已添加「${stage.title}」入口。`, '节点尚未保存，当前页面仍保留草稿。');
  };

  const setCanvasAddMenuOpen = (open, focusFirst = false) => {
    const menu = flowPage?.querySelector('#creativeCanvasAddMenu');
    const toggle = flowPage?.querySelector('[data-canvas-action="toggle-add-menu"]');
    if (!menu || !toggle) return;
    menu.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && focusFirst) menu.querySelector('[role="menuitem"]')?.focus();
    else if (!open && focusFirst) toggle.focus();
  };

  const installCanvasController = () => {
    canvasViewport = flowPage.querySelector('#creativeCanvasViewport');
    canvasWorld = flowPage.querySelector('#creativeCanvasWorld');
    canvasSvg = flowPage.querySelector('#creativeCanvasEdges');
    const hasSavedCamera = loadCamera();
    applyCanvasCamera();
    canvasNeedsFit = !hasSavedCamera || legacyStarterWasHidden;
    let lastViewportSize = null;
    const adaptCanvasViewport = () => {
      const size = { width: canvasViewport.clientWidth, height: canvasViewport.clientHeight };
      if (!size.width || !size.height) return;
      if (canvasNeedsFit) {
        if (!focusStarterPathStart()) fitCanvas();
        canvasNeedsFit = false;
      } else if (
        lastViewportSize &&
        (lastViewportSize.width !== size.width || lastViewportSize.height !== size.height)
      ) {
        const worldCenter = {
          x: (lastViewportSize.width / 2 - canvasCamera.x) / canvasCamera.scale,
          y: (lastViewportSize.height / 2 - canvasCamera.y) / canvasCamera.scale,
        };
        canvasCamera.x = size.width / 2 - worldCenter.x * canvasCamera.scale;
        canvasCamera.y = size.height / 2 - worldCenter.y * canvasCamera.scale;
        applyCanvasCamera();
        saveCamera();
      }
      lastViewportSize = size;
    };
    const canvasResizeObserver = new ResizeObserver(adaptCanvasViewport);
    canvasResizeObserver.observe(canvasViewport);

    document.addEventListener('pointerdown', (event) => {
      const menu = flowPage?.querySelector('#creativeCanvasAddMenu');
      const target = event.target instanceof Element ? event.target : null;
      if (
        menu &&
        !menu.hidden &&
        !target?.closest('#creativeCanvasAddMenu, [data-canvas-action="toggle-add-menu"]')
      )
        setCanvasAddMenuOpen(false);
    });

    canvasViewport.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'touch') {
        activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const blockedPinchTarget = event.target.closest?.(
          '.creative-canvas-toolbar, textarea, input, button:not([data-node-drag])',
        );
        if (activeTouches.size >= 2 && canvasGesture?.type === 'pan' && !blockedPinchTarget) {
          const pointerIds = [...activeTouches.keys()].slice(-2);
          const first = activeTouches.get(pointerIds[0]);
          const second = activeTouches.get(pointerIds[1]);
          const rect = canvasViewport.getBoundingClientRect();
          const centerX = (first.x + second.x) / 2;
          const centerY = (first.y + second.y) / 2;
          const localX = centerX - rect.left;
          const localY = centerY - rect.top;
          canvasGesture = {
            type: 'pinch',
            pointerIds,
            startDistance: Math.max(Math.hypot(second.x - first.x, second.y - first.y), 1),
            startScale: canvasCamera.scale,
            worldX: (localX - canvasCamera.x) / canvasCamera.scale,
            worldY: (localY - canvasCamera.y) / canvasCamera.scale,
            moved: false,
          };
          canvasViewport.classList.remove('is-panning');
          event.preventDefault();
          return;
        }
        if (activeTouches.size > 1) return;
      }
      const connectPort = event.target.closest?.('[data-node-connect]');
      if (connectPort) {
        const sourceId = connectPort.dataset.nodeConnect;
        if (!canvasModel().nodes.some((node) => node.id === sourceId)) return;
        event.preventDefault();
        canvasGesture = {
          type: 'connect',
          pointerId: event.pointerId,
          sourceId,
          startX: event.clientX,
          startY: event.clientY,
          moved: false,
        };
        try {
          connectPort.setPointerCapture(event.pointerId);
        } catch {
          // Window-level pointer listeners remain the fallback.
        }
        return;
      }
      const element = event.target.closest?.('[data-canvas-node]');
      const interactiveNodeControl = event.target.closest?.('button:not([data-node-drag]), textarea, input');
      if (element && !interactiveNodeControl) {
        const handle = element.querySelector('[data-node-drag]');
        const nodeId = element?.dataset.canvasNodeId;
        const node = canvasNodes().find((item) => item.id === nodeId);
        if (!node) return;
        event.preventDefault();
        handle?.focus({ preventScroll: true });
        const rect = canvasViewport.getBoundingClientRect();
        canvasGesture = {
          type: 'node',
          pointerId: event.pointerId,
          nodeId,
          startX: event.clientX,
          startY: event.clientY,
          offsetX: (event.clientX - rect.left - canvasCamera.x) / canvasCamera.scale - node.x,
          offsetY: (event.clientY - rect.top - canvasCamera.y) / canvasCamera.scale - node.y,
          original: { x: node.x, y: node.y },
          moved: false,
        };
        element.classList.add('is-dragging');
        try {
          handle.setPointerCapture(event.pointerId);
        } catch {
          // Window-level pointer listeners remain the fallback.
        }
        return;
      }
      if (interactiveNodeControl || event.target.closest?.('.creative-canvas-toolbar, [data-canvas-edge]'))
        return;
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      canvasGesture = {
        type: 'pan',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        original: { x: canvasCamera.x, y: canvasCamera.y },
        moved: false,
      };
      canvasViewport.classList.add('is-panning');
      try {
        canvasViewport.setPointerCapture(event.pointerId);
      } catch {
        // Window-level pointer listeners remain the fallback.
      }
    });

    const moveCanvasPointer = (event) => {
      if (event.pointerType === 'touch' && activeTouches.has(event.pointerId)) {
        activeTouches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      }
      if (canvasGesture?.type === 'pinch') {
        if (!canvasGesture.pointerIds.includes(event.pointerId)) return;
        const [first, second] = canvasGesture.pointerIds.map((id) => activeTouches.get(id));
        if (!first || !second) return;
        const gesture = canvasGesture;
        const rect = canvasViewport.getBoundingClientRect();
        const centerX = (first.x + second.x) / 2 - rect.left;
        const centerY = (first.y + second.y) / 2 - rect.top;
        const distance = Math.max(Math.hypot(second.x - first.x, second.y - first.y), 1);
        const minScale = 0.03;
        const scale = Math.max(
          minScale,
          Math.min(1.8, (gesture.startScale * distance) / gesture.startDistance),
        );
        canvasCamera = {
          scale,
          x: centerX - gesture.worldX * scale,
          y: centerY - gesture.worldY * scale,
        };
        gesture.moved = true;
        applyCanvasCamera();
        return;
      }
      if (!canvasGesture || canvasGesture.pointerId !== event.pointerId) return;
      const gesture = canvasGesture;
      if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) > 3)
        gesture.moved = true;
      if (!gesture.moved) return;
      event.preventDefault();
      if (gesture.type === 'node') {
        const rect = canvasViewport.getBoundingClientRect();
        setNodePosition(
          gesture.nodeId,
          (event.clientX - rect.left - canvasCamera.x) / canvasCamera.scale - gesture.offsetX,
          (event.clientY - rect.top - canvasCamera.y) / canvasCamera.scale - gesture.offsetY,
        );
      } else {
        if (gesture.type === 'connect') {
          const rect = canvasViewport.getBoundingClientRect();
          gesture.currentX = (event.clientX - rect.left - canvasCamera.x) / canvasCamera.scale;
          gesture.currentY = (event.clientY - rect.top - canvasCamera.y) / canvasCamera.scale;
          canvasConnectPreview = {
            sourceId: gesture.sourceId,
            x: gesture.currentX,
            y: gesture.currentY,
          };
          renderCanvasEdges();
          return;
        }
        canvasCamera.x = gesture.original.x + event.clientX - gesture.startX;
        canvasCamera.y = gesture.original.y + event.clientY - gesture.startY;
        applyCanvasCamera();
      }
    };

    const finishCanvasPointer = async (event, cancelled = false) => {
      if (event?.pointerType === 'touch') activeTouches.delete(event.pointerId);
      if (canvasGesture?.type === 'pinch') {
        if (canvasGesture.pointerIds.includes(event?.pointerId) && activeTouches.size < 2) {
          canvasGesture = null;
          suppressCanvasClickUntil = Date.now() + 180;
          saveCamera();
        }
        return;
      }
      if (!canvasGesture || (event && canvasGesture.pointerId !== event.pointerId)) return;
      const gesture = canvasGesture;
      canvasGesture = null;
      canvasViewport.classList.remove('is-panning');
      if (gesture.type === 'connect') {
        canvasConnectPreview = null;
        renderCanvasEdges();
        if (cancelled || !gesture.moved) return;
        suppressCanvasClickUntil = Date.now() + 250;
        const target = document
          .elementFromPoint(event.clientX, event.clientY)
          ?.closest?.('[data-canvas-node]');
        const targetId = target?.dataset.canvasNodeId;
        setConnectMode(false);
        if (targetId) await addCanvasConnection(gesture.sourceId, targetId);
        else if (announce) announce.textContent = '把连线拖到另一个节点上。';
        return;
      }
      if (gesture.type === 'node') {
        const element = canvasWorld.querySelector(`[data-canvas-node-id="${CSS.escape(gesture.nodeId)}"]`);
        element?.classList.remove('is-dragging');
        if (cancelled) setNodePosition(gesture.nodeId, gesture.original.x, gesture.original.y);
        else if (gesture.moved) {
          suppressCanvasClickUntil = Date.now() + 250;
          const saveResult = await saveCanvasModel();
          announceCanvasSave(saveResult, '节点位置已保存。', '节点位置尚未保存，当前页面仍保留草稿。');
        }
      } else if (gesture.moved) {
        suppressCanvasClickUntil = Date.now() + 180;
        saveCamera();
      }
    };

    window.addEventListener('pointermove', moveCanvasPointer, { passive: false });
    window.addEventListener('pointerup', (event) => void finishCanvasPointer(event, false));
    window.addEventListener('pointercancel', (event) => void finishCanvasPointer(event, true));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (connectMode) setConnectMode(false);
        if (!flowPage?.querySelector('#creativeCanvasAddMenu')?.hidden) setCanvasAddMenuOpen(false, true);
      }
      const edge = event.target instanceof Element && event.target.closest('[data-canvas-edge]');
      if (edge && ['Enter', ' '].includes(event.key)) {
        event.preventDefault();
        selectedEdgeId = edge.dataset.canvasEdge;
        renderCanvasEdges();
        return;
      }
      const editing =
        event.target instanceof Element && event.target.closest('textarea, input, [contenteditable="true"]');
      if (event.key === 'Delete' && selectedEdgeId && !editing) void deleteSelectedEdge();
    });

    canvasViewport.addEventListener(
      'wheel',
      (event) => {
        if (event.target.closest?.('textarea, input, [contenteditable="true"]')) return;
        event.preventDefault();
        zoomCanvasAt(canvasCamera.scale * (event.deltaY < 0 ? 1.1 : 0.9), event.clientX, event.clientY);
      },
      { passive: false },
    );
    canvasViewport.addEventListener('keydown', (event) => {
      const handle = event.target.closest?.('[data-node-drag]');
      if (!handle || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      const element = handle.closest('[data-canvas-node]');
      const nodeId = element?.dataset.canvasNodeId;
      const node = canvasNodes().find((item) => item.id === nodeId);
      if (!node) return;
      const amount = event.shiftKey ? 64 : 24;
      const delta = {
        ArrowUp: [0, -amount],
        ArrowDown: [0, amount],
        ArrowLeft: [-amount, 0],
        ArrowRight: [amount, 0],
      }[event.key];
      setNodePosition(nodeId, node.x + delta[0], node.y + delta[1]);
      void saveCanvasModel().then((result) =>
        announceCanvasSave(result, '节点位置已保存。', '节点位置尚未保存，当前页面仍保留草稿。'),
      );
    });

    canvasViewport.addEventListener('input', (event) => {
      const textarea = event.target.closest?.('[data-canvas-note]');
      const stepTitle = event.target.closest?.('[data-canvas-step-title]');
      const stepInstruction = event.target.closest?.('[data-canvas-step-instruction]');
      const experimentTitle = event.target.closest?.('[data-canvas-experiment-title]');
      const experimentPrompt = event.target.closest?.('[data-canvas-experiment-prompt]');
      const experimentOption = event.target.closest?.('[data-experiment-option-text]');
      if (
        !textarea &&
        !stepTitle &&
        !stepInstruction &&
        !experimentTitle &&
        !experimentPrompt &&
        !experimentOption
      )
        return;
      const nodeId =
        textarea?.dataset.canvasNote ||
        stepTitle?.dataset.canvasStepTitle ||
        stepInstruction?.dataset.canvasStepInstruction ||
        experimentTitle?.dataset.canvasExperimentTitle ||
        experimentPrompt?.dataset.canvasExperimentPrompt ||
        experimentOption?.dataset.experimentOptionText;
      const node = canvasModel().nodes.find((item) => item.id === nodeId);
      if (!node) return;
      if (textarea) node.text = textarea.value;
      else if (stepTitle) node.title = stepTitle.value;
      else if (stepInstruction) {
        node.instruction = stepInstruction.value;
        if (node.qualityContract === STORY_ENGINE_QUALITY_CONTRACT) delete node.qualityContract;
      } else if (experimentTitle) node.title = experimentTitle.value;
      else if (experimentPrompt) node.prompt = experimentPrompt.value;
      else if (experimentOption) {
        const option = (node.options || []).find(
          (item) => item.id === experimentOption.dataset.experimentOptionId,
        );
        if (option) option.text = experimentOption.value;
      }
      clearTimeout(noteSaveTimer);
      noteSaveTimer = setTimeout(() => {
        noteSaveTimer = null;
        void saveCanvasModel().then((result) => {
          refreshCanvasStepStatuses();
          announceCanvasSave(result, '节点修改已保存。', '节点修改尚未保存，当前页面仍保留草稿。');
        });
      }, 600);
    });

    canvasViewport.addEventListener('focusout', (event) => {
      if (
        event.target.closest?.('[data-canvas-note], [data-canvas-step-title], [data-canvas-step-instruction]')
      )
        flushCanvasNoteSave();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) flushCanvasNoteSave();
    });
    window.addEventListener('pagehide', flushCanvasNoteSave);

    canvasViewport.addEventListener('click', (event) => {
      if (Date.now() < suppressCanvasClickUntil && !event.target.closest?.('[data-canvas-action]')) return;
      const addMenu = flowPage.querySelector('#creativeCanvasAddMenu');
      if (
        addMenu &&
        !addMenu.hidden &&
        !event.target.closest?.('#creativeCanvasAddMenu, [data-canvas-action="toggle-add-menu"]')
      )
        setCanvasAddMenuOpen(false);
      const edge = event.target.closest?.('[data-canvas-edge]');
      if (edge) {
        event.stopPropagation();
        selectedEdgeId = edge.dataset.canvasEdge;
        renderCanvasEdges();
        return;
      }
      const action = event.target.closest?.('[data-canvas-action]');
      if (action) {
        const rect = canvasViewport.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        if (action.dataset.canvasAction === 'zoom-in')
          zoomCanvasAt(canvasCamera.scale * 1.2, centerX, centerY);
        else if (action.dataset.canvasAction === 'zoom-out')
          zoomCanvasAt(canvasCamera.scale / 1.2, centerX, centerY);
        else if (action.dataset.canvasAction === 'fit') fitCanvas();
        else if (action.dataset.canvasAction === 'toggle-add-menu') {
          setCanvasAddMenuOpen(addMenu.hidden, addMenu.hidden);
        } else if (action.dataset.canvasAction === 'add-note') {
          setCanvasAddMenuOpen(false);
          void createCanvasNote();
        } else if (action.dataset.canvasAction === 'add-experiment') {
          setCanvasAddMenuOpen(false);
          void createCanvasExperiment();
        } else if (action.dataset.canvasAction === 'starter-path') {
          setCanvasAddMenuOpen(false);
          void createStarterPath();
        } else if (action.dataset.canvasAction === 'add-step') {
          setCanvasAddMenuOpen(false);
          void createCanvasStep();
        } else if (action.dataset.canvasAction === 'prompt') {
          setCanvasAddMenuOpen(false);
          void rollStorySpark();
        } else if (action.dataset.canvasAction === 'delete-edge') void deleteSelectedEdge();
        return;
      }
      const addStage = event.target.closest?.('[data-canvas-add-stage]');
      if (addStage) {
        event.stopPropagation();
        setCanvasAddMenuOpen(false);
        void addCanvasStage(addStage.dataset.canvasAddStage);
        return;
      }
      const restoreStage = event.target.closest?.('[data-canvas-restore-stage]');
      if (restoreStage) {
        event.stopPropagation();
        setCanvasAddMenuOpen(false);
        void restoreCanvasStage(restoreStage.dataset.canvasRestoreStage);
        return;
      }
      const hideStage = event.target.closest?.('[data-canvas-hide-stage]');
      if (hideStage) {
        event.stopPropagation();
        void hideCanvasStage(hideStage.dataset.canvasHideStage);
        return;
      }
      const noteOutline = event.target.closest?.('[data-note-outline]');
      if (noteOutline) {
        event.stopPropagation();
        startCanvasBranchOutline(noteOutline.dataset.noteOutline);
        return;
      }
      const experimentBranch = event.target.closest?.('[data-experiment-branch]');
      if (experimentBranch) {
        event.stopPropagation();
        void rollExperimentRoutes(experimentBranch.dataset.experimentBranch);
        return;
      }
      const experimentTwist = event.target.closest?.('[data-experiment-twist]');
      if (experimentTwist) {
        event.stopPropagation();
        void rollExperimentTwist(experimentTwist.dataset.experimentTwist);
        return;
      }
      const experimentAi = event.target.closest?.('[data-experiment-ai]');
      if (experimentAi) {
        event.stopPropagation();
        const node = canvasModel().nodes.find(
          (item) => item.id === experimentAi.dataset.experimentAi && item.kind === 'experiment',
        );
        if (node) sendIdeaToChat(canvasNodeSourceContent(node), node.id);
        return;
      }
      const experimentPick = event.target.closest?.('[data-experiment-pick]');
      if (experimentPick) {
        event.stopPropagation();
        void pickExperimentRoute(
          experimentPick.dataset.experimentPick,
          experimentPick.dataset.experimentOption,
        );
        return;
      }
      const experimentCommit = event.target.closest?.('[data-experiment-commit]');
      if (experimentCommit) {
        event.stopPropagation();
        void commitExperimentRoute(experimentCommit.dataset.experimentCommit, false);
        return;
      }
      const experimentHandoff = event.target.closest?.('[data-experiment-handoff]');
      if (experimentHandoff) {
        event.stopPropagation();
        void commitExperimentRoute(experimentHandoff.dataset.experimentHandoff, true);
        return;
      }
      const arcOpen = event.target.closest?.('[data-arc-open]');
      if (arcOpen) {
        event.stopPropagation();
        openChapterFromCanvas(arcOpen.dataset.arcOpen);
        return;
      }
      const noteAi = event.target.closest?.('[data-note-ai]');
      if (noteAi) {
        event.stopPropagation();
        const note = canvasModel().nodes.find((node) => node.id === noteAi.dataset.noteAi);
        if (note?.text?.trim()) sendIdeaToChat(note.text.trim(), note.id);
        else {
          const editor = canvasWorld?.querySelector(
            `[data-canvas-note="${CSS.escape(noteAi.dataset.noteAi)}"]`,
          );
          editor?.focus();
          if (announce) announce.textContent = '先在便笺里写下一条灵感。';
        }
        return;
      }
      const stepAi = event.target.closest?.('[data-step-ai]');
      if (stepAi) {
        event.stopPropagation();
        const step = canvasModel().nodes.find(
          (node) => node.id === stepAi.dataset.stepAi && node.kind === 'step',
        );
        if (step) sendCanvasStepToChat(step);
        return;
      }
      const stepHandoff = event.target.closest?.('[data-step-handoff]');
      if (stepHandoff) {
        event.stopPropagation();
        runCanvasStepHandoff(stepHandoff.dataset.stepHandoff);
        return;
      }
      const removeNode = event.target.closest?.('[data-node-delete]');
      if (removeNode) {
        event.stopPropagation();
        void deleteCanvasNote(removeNode.dataset.nodeDelete);
        return;
      }
      const connectHandle = event.target.closest?.('[data-node-connect]');
      if (connectHandle) {
        event.stopPropagation();
        if (!connectMode) setConnectMode(true);
        void connectCanvasNode(connectHandle.dataset.nodeConnect);
        return;
      }
      const node = event.target.closest?.('[data-canvas-node]');
      if (connectMode && node) {
        event.stopPropagation();
        if (node.dataset.canvasNodeKind === 'arc') {
          if (announce) announce.textContent = '剧情段连线由大纲自动生成。';
          return;
        }
        void connectCanvasNode(node.dataset.canvasNodeId);
        return;
      }
    });

    canvasViewport.addEventListener('dblclick', (event) => {
      if (event.target.closest?.('[data-canvas-node], .creative-canvas-toolbar')) return;
      const rect = canvasViewport.getBoundingClientRect();
      const worldX = (event.clientX - rect.left - canvasCamera.x) / canvasCamera.scale;
      const worldY = (event.clientY - rect.top - canvasCamera.y) / canvasCamera.scale;
      void createCanvasNoteAt(worldX, worldY);
    });
  };

  const renderWorkflowCards = () => {
    if (!flowPage) return;
    flowPage.querySelector('#creativeHeroTitle').textContent = state.project?.title
      ? state.project.title
      : '新故事';
    renderCanvasNodes();
  };

  function refreshWorkflow() {
    renderWorkflowCards();
    renderInbox();
  }

  const installWorkflowEvents = () => {
    flowPage.addEventListener('click', (event) => {
      const open = event.target.closest('[data-workflow-open]');
      if (open) {
        openStage(open.dataset.workflowOpen);
        return;
      }
      const idea = event.target.closest('[data-idea-id]');
      if (!idea) return;
      const record = inbox().find((item) => item.id === idea.dataset.ideaId);
      if (!record) return;
      if (event.target.closest('.creative-idea-chat')) {
        const source = canvasModel().nodes.find((node) => node.sourceIdeaId === record.id);
        if (source) {
          sendIdeaToChat(record.text, source.id);
        } else {
          void createCanvasNote(record.text, record.id)
            .then((node) => {
              if (node) sendIdeaToChat(record.text, node.id);
            })
            .catch((error) => {
              console.error('Unable to prepare canvas source for idea', error);
              if (typeof toast === 'function') toast('灵感未能放上画布，请重试。');
            });
        }
      } else if (event.target.closest('.creative-idea-archive')) {
        state.uiDrafts.creativeInbox = inbox().filter((item) => item.id !== record.id);
        persistCreativeInbox();
      }
    });
    flowPage.querySelector('#creativeInboxForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const input = flowPage.querySelector('#creativeInboxInput');
      if (!input.value.trim()) return;
      const text = input.value.trim();
      input.value = '';
      await addIdea(text);
      input.focus();
    });
  };

  const addIdea = async (text) => {
    const record = {
      id: `idea_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text,
      createdAt: Date.now(),
    };
    inbox().unshift(record);
    await persistCreativeInbox();
    if (typeof toast === 'function') toast('已收进灵感箱');
  };

  const decorateMethodologyCards = () => {
    const list = document.getElementById('methodologyCardList');
    if (!list) return;
    list.querySelectorAll('.methodology-item').forEach((item, index) => {
      const card = state.methodologyCards?.[index];
      if (!card) return;
      item.dataset.sortItem = '';
      item.dataset.cardId = card.id;
      item.draggable = false;
      const head = item.querySelector('.methodology-card-head');
      if (!head || head.querySelector('.creative-card-reorder')) return;
      const controls = document.createElement('div');
      controls.className = 'creative-card-reorder';
      controls.innerHTML =
        '<button class="creative-drag-handle" type="button" aria-label="拖动写作卡片排序" title="按住拖动卡片">⠿</button><span class="creative-sort-buttons"><button type="button" data-method-move="-1" aria-label="卡片上移">↑</button><button type="button" data-method-move="1" aria-label="卡片下移">↓</button></span>';
      head.append(controls);
    });
  };

  const decorateOutlinePoints = () => {
    const chapters = [...document.querySelectorAll('#outlineContainer .outline-list > .outline-item')];
    chapters.forEach((chapterElement, chapterIndex) => {
      const chapter = state.outline?.[chapterIndex];
      if (!chapter?.plotPoints?.length) return;
      const pointGroup =
        chapterElement.querySelector('.outline-full-points ol') ||
        [...chapterElement.children].find((child) => child.tagName === 'DIV' && child.style.borderTop);
      if (!pointGroup) return;
      pointGroup.classList.add('creative-plotpoint-list');
      pointGroup.dataset.chapterIndex = String(chapterIndex);
      [...pointGroup.children].forEach((row, pointIndex) => {
        const point = chapter.plotPoints[pointIndex];
        if (!point || row.dataset.pointReady) return;
        row.dataset.pointReady = 'true';
        row.dataset.sortItem = '';
        row.dataset.pointIndex = String(pointIndex);
        row.classList.add('creative-plotpoint-row');
        const controls = document.createElement('span');
        controls.className = 'creative-point-reorder';
        controls.innerHTML =
          '<button class="creative-drag-handle" type="button" aria-label="拖动剧情关键点排序" title="按住拖动关键点">⠿</button><button type="button" data-point-move="-1" aria-label="关键点上移">↑</button><button type="button" data-point-move="1" aria-label="关键点下移">↓</button>';
        const text = row.querySelector(':scope > span:first-child');
        if (text) text.prepend(controls);
        else row.prepend(controls);
      });
      attachPointerSort(pointGroup, {
        itemSelector: '.creative-plotpoint-row',
        handleSelector: '.creative-drag-handle',
        onCommit: () => reorderPlotPointsFromDOM(pointGroup, chapterIndex),
      });
    });
  };

  const installContentSorting = () => {
    const originalCards = globalThis.renderMethodologyCards;
    if (typeof originalCards === 'function' && !originalCards.creativeSortWrapped) {
      const wrappedCards = function (...args) {
        const result = originalCards.apply(this, args);
        decorateMethodologyCards();
        return result;
      };
      wrappedCards.creativeSortWrapped = true;
      globalThis.renderMethodologyCards = wrappedCards;
    }
    const originalOutline = globalThis.renderOutline;
    if (typeof originalOutline === 'function' && !originalOutline.creativeSortWrapped) {
      const wrappedOutline = function (...args) {
        const result = originalOutline.apply(this, args);
        decorateOutlinePoints();
        return result;
      };
      wrappedOutline.creativeSortWrapped = true;
      globalThis.renderOutline = wrappedOutline;
    }

    const methods = document.getElementById('methodologyCardList');
    attachPointerSort(methods, {
      itemSelector: '.methodology-item',
      handleSelector: '.creative-drag-handle',
      onCommit: () => {
        const records = new Map((state.methodologyCards || []).map((card) => [card.id, card]));
        state.methodologyCards = [...methods.querySelectorAll('.methodology-item')]
          .map((item) => records.get(item.dataset.cardId))
          .filter(Boolean);
        Store.save();
        globalThis.renderMethodologyCards();
        if (announce) announce.textContent = '写作卡片顺序已保存。';
      },
    });
    methods?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-method-move]');
      if (!button) return;
      const item = button.closest('.methodology-item');
      if (!moveNode(methods, item, Number(button.dataset.methodMove))) return;
      const records = new Map((state.methodologyCards || []).map((card) => [card.id, card]));
      state.methodologyCards = [...methods.querySelectorAll('.methodology-item')]
        .map((node) => records.get(node.dataset.cardId))
        .filter(Boolean);
      Store.save();
      globalThis.renderMethodologyCards();
      if (announce) announce.textContent = '写作卡片顺序已保存。';
    });

    const outline = document.getElementById('outlineContainer');
    outline?.addEventListener('click', (event) => {
      const button = event.target.closest('[data-point-move]');
      if (!button) return;
      const row = button.closest('.creative-plotpoint-row');
      const group = row.closest('.creative-plotpoint-list');
      if (!moveNode(group, row, Number(button.dataset.pointMove))) return;
      reorderPlotPointsFromDOM(group, Number(group.dataset.chapterIndex));
    });
  };

  const reorderPlotPointsFromDOM = (group, chapterIndex) => {
    const chapter = state.outline?.[chapterIndex];
    if (!chapter || !group) return;
    const source = chapter.plotPoints || [];
    const byIndex = new Map(source.map((point, index) => [String(index), point]));
    const sorted = [...group.querySelectorAll('.creative-plotpoint-row')]
      .map((row) => byIndex.get(row.dataset.pointIndex))
      .filter(Boolean);
    if (sorted.length !== source.length) return;
    chapter.plotPoints = sorted;
    Store.save();
    globalThis.renderOutline();
    if (announce) announce.textContent = `第 ${chapter.chapter} 章的剧情关键点顺序已保存。`;
  };

  const installNavigationDefault = () => {
    const switchTab = globalThis.switchTab;
    if (typeof switchTab !== 'function' || switchTab.creativeRouteWrapped) return;
    let initial = true;
    const wrapped = function (tab, ...args) {
      const target = initial && tab === 'project' ? 'creative-flow' : tab;
      initial = false;
      const result = switchTab.call(this, target, ...args);
      if (target === 'creative-flow') {
        refreshWorkflow();
        requestAnimationFrame(() => {
          if (canvasNeedsFit && canvasViewport?.clientWidth > 0) {
            if (!focusStarterPathStart()) fitCanvas();
            canvasNeedsFit = false;
          }
          applyCanvasCamera();
        });
      }
      return result;
    };
    wrapped.creativeRouteWrapped = true;
    globalThis.switchTab = wrapped;
  };

  installNavigationDefault();
  installContentSorting();
  installGenerationQualityReports();
  const originalLoad = Store.load;
  if (typeof originalLoad === 'function') {
    Store.load = async function (...args) {
      const result = await originalLoad.apply(this, args);
      queueMicrotask(refreshWorkflow);
      queueMicrotask(refreshGenerationQualityReports);
      return result;
    };
  }
  document.addEventListener('DOMContentLoaded', installNavigation);
})();
