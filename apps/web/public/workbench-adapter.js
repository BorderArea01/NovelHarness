/* global Store, state, normalizeMemory, toast, buildExtraWritingContext, EDITOR_AGENT_PROMPTS, escapeHtml */
/* eslint-disable no-global-assign */
/* Service adapter for the frozen V4.4.3 workbench. */
(() => {
  const projectId = new URLSearchParams(location.search).get('project');
  if (!projectId) {
    location.replace('/');
    return;
  }
  let revision = 0;
  let saveTail = Promise.resolve();
  let baseSnapshot = null;
  let baseGlobalSettings = null;
  let globalUi = {};
  let conflictOpen = false;
  let bibleCategory = 'character';
  let refreshBibleUI = () => {};
  let refreshPOVUI = () => {};
  let storyBibleText = '';
  let storyBibleOutlineText = '';
  let storyBibleBundle = {
    characters: [],
    locations: [],
    items: [],
    organizations: [],
    relations: [],
  };
  // The index is intentionally editable in-place. Keep selection outside the
  // rendered cards so a search/category refresh does not lose a batch edit.
  let bibleBatchMode = false;
  const bibleSelection = {
    character: new Set(),
    location: new Set(),
    item: new Set(),
    organization: new Set(),
    relation: new Set(),
  };
  const bibleEntityConfig = {
    character: {
      label: '人物',
      path: 'characters',
      fields: [
        ['name', '姓名', 'input'],
        ['aliases', '别名', 'list'],
        ['role', '角色定位', 'input'],
        ['basicInfo', '基础信息', 'textarea'],
        ['appearance', '外貌', 'textarea'],
        ['personality', '性格', 'textarea'],
        ['speechStyle', '说话方式 / 语言习惯', 'textarea'],
        ['background', '背景', 'textarea'],
        ['motivation', '动机', 'textarea'],
        ['goals', '目标', 'textarea'],
        ['secrets', '秘密', 'textarea'],
        ['currentStatus', '当前状态', 'textarea'],
        ['tags', '标签', 'list'],
        ['notes', '备注', 'textarea'],
      ],
    },
    location: {
      label: '地点',
      path: 'locations',
      fields: [
        ['name', '名称', 'input'],
        ['aliases', '别名', 'list'],
        ['type', '类型', 'input'],
        ['description', '描述', 'textarea'],
        ['geography', '地理', 'textarea'],
        ['culture', '文化', 'textarea'],
        ['rules', '规则', 'textarea'],
        ['currentStatus', '当前状态', 'textarea'],
        ['tags', '标签', 'list'],
        ['notes', '备注', 'textarea'],
      ],
    },
    item: {
      label: '物品',
      path: 'items',
      fields: [
        ['name', '名称', 'input'],
        ['aliases', '别名', 'list'],
        ['type', '类型', 'input'],
        ['description', '描述', 'textarea'],
        ['owner', '持有者', 'input'],
        ['abilities', '能力与作用', 'textarea'],
        ['origin', '来源', 'textarea'],
        ['currentStatus', '当前状态', 'textarea'],
        ['tags', '标签', 'list'],
        ['notes', '备注', 'textarea'],
      ],
    },
    organization: {
      label: '组织',
      path: 'organizations',
      fields: [
        ['name', '名称', 'input'],
        ['aliases', '别名', 'list'],
        ['type', '类型', 'input'],
        ['description', '描述', 'textarea'],
        ['purpose', '目标与立场', 'textarea'],
        ['culture', '文化', 'textarea'],
        ['rules', '规则', 'textarea'],
        ['leaders', '领导者', 'textarea'],
        ['headquarters', '总部', 'textarea'],
        ['currentStatus', '当前状态', 'textarea'],
        ['tags', '标签', 'list'],
        ['notes', '备注', 'textarea'],
      ],
    },
  };
  let bibleEditorMount = null;
  let activeBibleEditor = null;
  const MAX_PROSE_STYLE_REFERENCE_SOURCES = 2;
  const PROSE_STYLE_SAMPLE_WIDTH = { single: 760, multiple: 460 };

  const request = async (path, options = {}) => {
    const response = await fetch(`/api${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    });
    const data = await response.json().catch(() => ({}));
    if (response.status === 401) {
      location.replace('/');
      throw new Error('登录已失效');
    }
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  };

  const chapterMemoryFreshness = (chapterNumber) => {
    const record = globalThis.getChapterMemoryRecord?.(chapterNumber);
    if (!record || !String(record.content ?? '').trim()) return { status: 'missing', record: null };
    let currentSourceHash = null;
    try {
      currentSourceHash = globalThis.getChapterMemorySourceHash?.(chapterNumber) ?? null;
    } catch {
      currentSourceHash = null;
    }
    if (
      typeof record.sourceHash === 'string' &&
      typeof currentSourceHash === 'string' &&
      record.sourceHash === currentSourceHash
    )
      return { status: 'fresh', record, currentSourceHash };
    return {
      status: typeof record.sourceHash === 'string' ? 'stale' : 'unknown',
      record,
      currentSourceHash,
    };
  };

  const cloneSerializable = (value) => {
    try {
      return structuredClone(value);
    } catch {
      try {
        return JSON.parse(JSON.stringify(value ?? {}));
      } catch {
        return {};
      }
    }
  };

  const chapterCardTrustStatus = (chapter) =>
    typeof globalThis.trustStatusOf === 'function'
      ? globalThis.trustStatusOf(`chapterCard:${Number(chapter)}`)
      : 'auto';

  const buildCurrentSourceMemorySnapshot = (sourceMemory) => {
    const normalize = globalThis.normalizeMemory;
    if (typeof normalize !== 'function') return cloneSerializable(sourceMemory || {});
    const memory = normalize(cloneSerializable(sourceMemory || globalThis.getEmptyMemory?.() || {}));
    const cards = [];
    for (const card of memory.chapterCards || []) {
      const chapter = Number(card.chapter);
      const trust = chapterCardTrustStatus(chapter);
      if (['ignored', 'stale', 'conflict'].includes(trust)) continue;
      // An explicit author confirmation is a deliberate override of the derived-source check.
      if (trust === 'confirmed') {
        cards.push(card);
        continue;
      }
      const currentChapter = (state.chapters || []).find((item) => Number(item.chapter) === chapter);
      const currentText = String(currentChapter?.content || '');
      if (!currentText.trim()) continue;
      const currentHash = globalThis.chapterContentHash?.(currentText);
      if (currentHash && card.contentHash === currentHash) {
        cards.push(card);
        continue;
      }

      // AI summary cards are derived data. Rebuild a conservative local card from current text;
      // do not mutate the stored card or reuse its stale summary, events, or keywords.
      const fallback = globalThis.createFallbackChapterCard?.(chapter, currentText);
      if (!fallback) continue;
      const cleanText = globalThis.sanitizeGeneratedText?.(currentText) || currentText.trim();
      const keywordSet = globalThis.memoryKeywords?.(
        `${fallback.title || ''} ${cleanText.slice(0, 500)} ${cleanText.slice(-700)}`,
      );
      cards.push({
        ...fallback,
        chapter,
        summary: cleanText.slice(0, 220),
        keyEvents: [cleanText.slice(-260)].filter(Boolean),
        characterChanges: [],
        foreshadowsAdded: [],
        foreshadowsResolved: [],
        locations: [],
        propsAndRules: [],
        endingState: cleanText.slice(-500),
        keywords: keywordSet ? Array.from(keywordSet).slice(0, 30) : [],
        contentHash: currentHash || fallback.contentHash,
        source: 'local-current-text',
      });
    }
    memory.chapterCards = cards;
    return typeof globalThis.rebuildMemoryIndexes === 'function'
      ? globalThis.rebuildMemoryIndexes(memory)
      : memory;
  };

  const originalRelevantChapterCards = globalThis.getRelevantChapterCards;
  if (
    typeof originalRelevantChapterCards === 'function' &&
    !originalRelevantChapterCards.sourceFreshnessWrapped
  ) {
    const wrappedRelevantChapterCards = function (...args) {
      const storedMemory = state.memory;
      state.memory = buildCurrentSourceMemorySnapshot(storedMemory);
      try {
        return originalRelevantChapterCards.apply(this, args);
      } finally {
        state.memory = storedMemory;
      }
    };
    wrappedRelevantChapterCards.sourceFreshnessWrapped = true;
    globalThis.getRelevantChapterCards = wrappedRelevantChapterCards;
  }

  const SUMMARY_RECENT_CHAPTER_LIMIT = 3;
  const originalSummaryContextMessages = globalThis.buildSummaryContextMessages;
  if (
    typeof originalSummaryContextMessages === 'function' &&
    !originalSummaryContextMessages.retrievalBudgetWrapped
  ) {
    const wrappedSummaryContextMessages = function (...args) {
      const messages = originalSummaryContextMessages.apply(this, args);
      const messageBudget = SUMMARY_RECENT_CHAPTER_LIMIT * 2;
      if (!Array.isArray(messages) || messages.length <= messageBudget) return messages;
      // Keep recent chronological context here; older cards still remain available through
      // buildRelevantChapterCards/buildRelevantMemoryPrompt, which performs goal-based retrieval.
      return messages.slice(-messageBudget);
    };
    wrappedSummaryContextMessages.retrievalBudgetWrapped = true;
    globalThis.buildSummaryContextMessages = wrappedSummaryContextMessages;
  }

  const originalRelevantMemoryPrompt = globalThis.buildRelevantMemoryPrompt;
  if (
    typeof originalRelevantMemoryPrompt === 'function' &&
    !originalRelevantMemoryPrompt.deduplicatedRetrievalWrapped
  ) {
    const wrappedRelevantMemoryPrompt = function (chapterNumber, outlineChapter, plotPoints) {
      if (state.contextFull === true)
        return originalRelevantMemoryPrompt.call(this, chapterNumber, outlineChapter, plotPoints);
      const allRelevantCards = globalThis.getRelevantChapterCards?.(
        chapterNumber,
        outlineChapter,
        plotPoints,
        Math.max(6, Number(state.memory?.chapterCards?.length || 0)),
      );
      if (!Array.isArray(allRelevantCards) || !allRelevantCards.length) return '';
      const recentChapters = new Set(
        (globalThis.getFinishedChaptersBefore?.(chapterNumber) || [])
          .slice(-SUMMARY_RECENT_CHAPTER_LIMIT)
          .map((chapter) => Number(chapter.chapter)),
      );
      const selectedCards = allRelevantCards
        .filter((card) => !recentChapters.has(Number(card.chapter)))
        .slice(0, 6);
      if (!selectedCards.length) return '';
      const cardText = selectedCards
        .map((card) =>
          typeof globalThis.formatChapterCard === 'function'
            ? globalThis.formatChapterCard(card)
            : `第${card.chapter}章：${card.summary || card.title || ''}`,
        )
        .join('\n\n');
      return `\n\n【远距相关章节记忆卡】\n最近章节已由摘要上下文提供；以下仅补充更早且与本章目标相关的信息，不要复述。\n${cardText}`;
    };
    wrappedRelevantMemoryPrompt.deduplicatedRetrievalWrapped = true;
    globalThis.buildRelevantMemoryPrompt = wrappedRelevantMemoryPrompt;
  }

  const originalWriterToggleLabels = globalThis.setWriterToggleLabels;
  if (
    typeof originalWriterToggleLabels === 'function' &&
    !originalWriterToggleLabels.contextRetrievalLabelWrapped
  ) {
    const wrappedWriterToggleLabels = function (...args) {
      const result = originalWriterToggleLabels.apply(this, args);
      const contextLabel = document.getElementById('contextLabel');
      if (contextLabel)
        contextLabel.title = state.contextFull
          ? '全文模式：将此前已定稿章节的完整正文作为上下文。'
          : `摘要模式：包含最近 ${SUMMARY_RECENT_CHAPTER_LIMIT} 章摘要，并从更早章节中检索与本章目标相关的记忆卡。`;
      return result;
    };
    wrappedWriterToggleLabels.contextRetrievalLabelWrapped = true;
    globalThis.setWriterToggleLabels = wrappedWriterToggleLabels;
  }

  const originalOutlineMemoryContext = globalThis.buildOutlineMemoryContext;
  if (
    typeof originalOutlineMemoryContext === 'function' &&
    !originalOutlineMemoryContext.sourceFreshnessWrapped
  ) {
    const wrappedOutlineMemoryContext = function () {
      const memory = buildCurrentSourceMemorySnapshot(state.memory || globalThis.getEmptyMemory?.() || {});
      // Runtime sync times and locally rebuilt card times are not story facts.
      // Keep their provenance and all authored dates/content, but do not make a
      // page reload appear to change the memory supplied to outline planning.
      for (const card of memory.chapterCards || []) {
        delete card.updatedAt;
        delete card.createdAt;
      }
      for (const mirror of [memory.structuredStoryBible, memory.notes?.storyBible]) {
        if (mirror?.source === 'server-authoritative') delete mirror.updatedAt;
      }
      const chapterMemoryRows = Object.entries(state.chapterMemories || {})
        .filter(
          ([key, item]) =>
            item &&
            String(item.content || '').trim() &&
            chapterMemoryFreshness(item.chapter ?? key).status === 'fresh',
        )
        .sort((left, right) => Number(left[1].chapter ?? left[0]) - Number(right[1].chapter ?? right[0]))
        .map(
          ([key, item]) =>
            `第 ${Number(item.chapter ?? key)} 章写作前记忆：${String(item.content || '').trim()}`,
        );
      return JSON.stringify({ longTermMemory: memory, chapterMemories: chapterMemoryRows }, null, 2);
    };
    wrappedOutlineMemoryContext.sourceFreshnessWrapped = true;
    globalThis.buildOutlineMemoryContext = wrappedOutlineMemoryContext;
  }

  const originalChapterMemoryContext = globalThis.buildMemoryPrompt;
  if (
    typeof originalChapterMemoryContext === 'function' &&
    !originalChapterMemoryContext.trustBoundaryWrapped
  ) {
    const wrappedChapterMemoryContext = function (chapterNumber) {
      const memory = state.memory || {};
      const targetChapter = Math.floor(Number(chapterNumber) || 0);
      const chapterScoped = targetChapter > 0;
      const trust = (key) => globalThis.trustStatusOf?.(key) || 'auto';
      const isUnconfirmedCandidate = (key) => trust(key) === 'auto';
      const memoryText = (value) =>
        typeof globalThis.memoryTextOf === 'function' ? globalThis.memoryTextOf(value) : String(value || '');
      const hash = (value) =>
        typeof globalThis.simpleHash === 'function' ? globalThis.simpleHash(memoryText(value)) : '';
      const confirmedSections = [];
      const candidateSections = [];

      const previousChapterText = chapterScoped
        ? (state.chapters || [])
            .filter((item) => Number(item.chapter) < targetChapter && String(item.content || '').trim())
            .map((item) => String(item.content || ''))
            .join('\n')
        : '';
      const confirmedCharacters = Object.entries(memory.characters || {}).filter(([name]) => {
        if (trust(`character:${name}`) !== 'confirmed') return false;
        return !chapterScoped || previousChapterText.includes(name);
      });
      if (confirmedCharacters.length)
        confirmedSections.push(
          `作者确认角色记忆（仅供正史连续性核验；角色在本章知道什么，仍以目标章前正文为准）：\n${confirmedCharacters
            .map(([name, info]) => {
              const details = [
                info?.currentStatus ? `状态：${memoryText(info.currentStatus)}` : '',
                info?.goal ? `目标：${memoryText(info.goal)}` : '',
                info?.relationships?.length
                  ? `关系：${(info.relationships || []).map(memoryText).join('；')}`
                  : '',
                info?.knownSecrets?.length
                  ? `秘密（不得提前揭露）：${(info.knownSecrets || []).map(memoryText).join('；')}`
                  : '',
              ].filter(Boolean);
              return `  · ${name}${details.length ? `：${details.join('；')}` : ''}`;
            })
            .join('\n')}`,
        );

      const confirmedEvents = (memory.importantEvents || []).filter((event) => {
        const chapter = Number(event?.chapter);
        if (chapterScoped && (!Number.isFinite(chapter) || chapter >= targetChapter)) return false;
        const eventHash = hash(event);
        return eventHash && trust(`event:${event.chapter || ''}:${eventHash}`) === 'confirmed';
      });
      if (confirmedEvents.length)
        confirmedSections.push(
          `作者确认事件（只包含目标章之前已发生的事实）：\n${confirmedEvents
            .slice(-8)
            .map((event) => `  · 第${event.chapter}章：${event.event || memoryText(event)}`)
            .join('\n')}`,
        );

      const confirmedForeshadows = ['active', 'resolved'].flatMap((bucket) =>
        (memory.foreshadows?.[bucket] || [])
          .filter((item) => {
            const chapter = Number(item?.chapter ?? item?.sourceChapter ?? item?.introducedChapter);
            const knownBeforeTarget = Number.isFinite(chapter) && chapter > 0 && chapter < targetChapter;
            if (chapterScoped && !knownBeforeTarget && !previousChapterText.includes(memoryText(item)))
              return false;
            const itemHash = hash(item);
            return itemHash && trust(`foreshadow:${bucket}:${itemHash}`) === 'confirmed';
          })
          .map((item) => ({ bucket, item })),
      );
      if (confirmedForeshadows.length)
        confirmedSections.push(
          `作者确认伏笔状态：\n${confirmedForeshadows
            .slice(-8)
            .map(
              ({ bucket, item }) =>
                `  · ${bucket === 'active' ? '尚未回收' : '已回收'}：${memoryText(item?.desc || item)}`,
            )
            .join('\n')}`,
        );

      const characterNames = Object.keys(memory.characters || {}).filter((name) => {
        if (!isUnconfirmedCandidate(`character:${name}`)) return false;
        return !chapterScoped || previousChapterText.includes(name);
      });
      if (characterNames.length)
        candidateSections.push(
          `人物名称候选（不代表本章当前状态）：\n${characterNames.map((name) => `  · ${name}`).join('\n')}`,
        );

      const events = (memory.importantEvents || []).filter((event) => {
        const chapter = Number(event?.chapter);
        if (chapterScoped && (!Number.isFinite(chapter) || chapter >= targetChapter)) return false;
        const eventHash = hash(event);
        return eventHash && isUnconfirmedCandidate(`event:${event.chapter || ''}:${eventHash}`);
      });
      if (events.length)
        candidateSections.push(
          `AI 提取事件候选（仅列出目标章之前的事件，未经确认，不可覆盖正文）：\n${events
            .slice(-8)
            .map((event) => `  · 第${event.chapter}章：${event.event || memoryText(event)}`)
            .join('\n')}`,
        );

      const foreshadows = (memory.foreshadows?.active || []).filter((item) => {
        const chapter = Number(item?.chapter ?? item?.sourceChapter ?? item?.introducedChapter);
        if (chapterScoped && (!Number.isFinite(chapter) || chapter >= targetChapter)) return false;
        const itemHash = hash(item);
        return itemHash && isUnconfirmedCandidate(`foreshadow:active:${itemHash}`);
      });
      if (foreshadows.length)
        candidateSections.push(
          `AI 提取伏笔候选（只作检索线索，不得新增未确认的伏笔事实）：\n${foreshadows
            .slice(-8)
            .map((item) => `  · ${memoryText(item?.desc || item)}`)
            .join('\n')}`,
        );

      const worldBuilding = (memory.worldBuilding || []).filter((item) => {
        const chapterList = Array.isArray(item?.chaptersAppeared)
          ? item.chaptersAppeared.map(Number).filter(Number.isFinite)
          : [];
        return (
          !chapterScoped || !chapterList.length || chapterList.every((chapter) => chapter < targetChapter)
        );
      });
      if (worldBuilding.length)
        candidateSections.push(
          `AI 提取世界设定候选（与作者确认设定冲突时以后者为准）：\n${worldBuilding
            .slice(0, 3)
            .map((item) => `  · ${item.concept || '未命名'}：${item.description || ''}`)
            .join('\n')}`,
        );

      if (!confirmedSections.length && !candidateSections.length) return '';
      const blocks = [];
      if (confirmedSections.length)
        blocks.push(
          '【作者确认长期记忆｜正史参考】\n' +
            '这些条目可用于保持设定与连续性；除明确写明的前情外，不代表视角人物已经知道，也不得提前揭露秘密。\n' +
            confirmedSections.join('\n\n'),
        );
      if (candidateSections.length)
        blocks.push(
          '【AI 长期记忆候选｜非正史】\n' +
            '以下是模型从正文提取的检索线索，不是作者确认资料。正文、作者确认资料、本章之前已成立的故事事实与当前写作指令优先；遇到冲突时忽略候选，不得将未知时间的角色状态或未来事件写成本章已发生事实。\n' +
            candidateSections.join('\n\n'),
        );
      return '\n\n' + blocks.join('\n\n');
    };
    wrappedChapterMemoryContext.trustBoundaryWrapped = true;
    globalThis.buildMemoryPrompt = wrappedChapterMemoryContext;
  }

  const originalChapterMemoryPrompt = globalThis.buildChapterMemoryPrompt;
  if (
    typeof originalChapterMemoryPrompt === 'function' &&
    !originalChapterMemoryPrompt.memoryFreshnessWrapped
  ) {
    const wrappedChapterMemoryPrompt = function (chapterNumber, ...args) {
      const freshness = chapterMemoryFreshness(chapterNumber);
      if (freshness.status === 'missing' || freshness.status === 'fresh')
        return originalChapterMemoryPrompt.call(this, chapterNumber, ...args);

      // A cached AI summary is derived data. If its source chapters changed, never
      // send it as current canon; rebuild a small context from the current chapter text.
      let fallback = '';
      try {
        fallback = globalThis.buildFallbackChapterMemory?.(chapterNumber) || '';
      } catch {
        return '';
      }
      return String(fallback || '').trim()
        ? `\n\n【本章写作前记忆 · 按当前已定稿前文重建】\n${fallback}`
        : '';
    };
    wrappedChapterMemoryPrompt.memoryFreshnessWrapped = true;
    globalThis.buildChapterMemoryPrompt = wrappedChapterMemoryPrompt;
  }

  const refreshChapterMemoryFreshnessNote = () => {
    const viewer = document.getElementById('memoryViewer');
    if (!viewer) return;
    viewer.querySelector('[data-chapter-memory-freshness]')?.remove();
    const freshness = chapterMemoryFreshness(state.currentChapter);
    if (freshness.status === 'missing' || freshness.status === 'fresh') return;
    const note = document.createElement('div');
    note.className = 'chapter-memory-freshness-note';
    note.dataset.chapterMemoryFreshness = freshness.status;
    note.textContent =
      freshness.status === 'stale'
        ? 'AI 记忆已过期 · 生成时采用最新已定稿前文'
        : 'AI 记忆来源未核验 · 生成时采用最新已定稿前文';
    viewer.prepend(note);
  };

  const originalRenderMemoryViewer = globalThis.renderMemoryViewer;
  if (typeof originalRenderMemoryViewer === 'function' && !originalRenderMemoryViewer.freshnessWrapped) {
    const wrappedRenderMemoryViewer = function (...args) {
      const result = originalRenderMemoryViewer.apply(this, args);
      refreshChapterMemoryFreshnessNote();
      return result;
    };
    wrappedRenderMemoryViewer.freshnessWrapped = true;
    globalThis.renderMemoryViewer = wrappedRenderMemoryViewer;
  }

  const BIBLE_PROMPT_CHAR_BUDGET = 18000;
  const BIBLE_PROMPT_HEADER = '【小说资料库】';
  const BIBLE_PROMPT_PRIORITY =
    '资料优先级：作者确认资料、已写正文和当前作者指令优先；“AI待确认建议”仅作候选，不可当作既定事实或覆盖确认资料。不得据此改变作者指定的叙事视角。';
  const BIBLE_PROMPT_FILTER_NOTE =
    '【本轮资料检索】按当前写作目标筛选；未列出不代表资料不存在，也没有改动或删除资料库原文。';
  const BIBLE_ENTITY_SCHEMAS = [
    {
      key: 'characters',
      type: 'character',
      kind: '人物',
      fields: [
        ['role', '角色定位'],
        ['basicInfo', '基础信息'],
        ['appearance', '外貌'],
        ['personality', '性格'],
        ['speechStyle', '说话方式'],
        ['background', '背景'],
        ['motivation', '动机'],
        ['goals', '目标'],
        ['secrets', '秘密'],
        ['currentStatus', '当前状态'],
        ['notes', '备注'],
      ],
    },
    {
      key: 'locations',
      type: 'location',
      kind: '地点',
      fields: [
        ['type', '类型'],
        ['description', '描述'],
        ['geography', '地理'],
        ['culture', '文化'],
        ['rules', '规则'],
        ['currentStatus', '当前状态'],
        ['notes', '备注'],
      ],
    },
    {
      key: 'items',
      type: 'item',
      kind: '物品',
      fields: [
        ['type', '类型'],
        ['description', '描述'],
        ['owner', '持有者'],
        ['abilities', '能力'],
        ['origin', '来历'],
        ['currentStatus', '当前状态'],
        ['notes', '备注'],
      ],
    },
    {
      key: 'organizations',
      type: 'organization',
      kind: '组织',
      fields: [
        ['type', '类型'],
        ['description', '描述'],
        ['purpose', '目的'],
        ['culture', '文化'],
        ['rules', '规则'],
        ['leaders', '领导者'],
        ['headquarters', '总部'],
        ['currentStatus', '当前状态'],
        ['notes', '备注'],
      ],
    },
  ];
  const BIBLE_MATCH_STOP_WORDS = new Set(
    '一个 一种 这个 那个 这些 那些 因为 所以 但是 如果 而且 并且 以及 之后 之前 现在 目前 正在 可以 必须 需要 通过 其中 相关 信息 内容 背景 设定 资料 小说 故事 角色 人物 地点 物品 组织 章节 关键 主要 状态 目标 描述 备注 当前 作者 确认 建议'.split(
      ' ',
    ),
  );
  const normalizeBibleMatchText = (value) => String(value ?? '').toLocaleLowerCase();
  const textValue = (value) =>
    Array.isArray(value)
      ? value
          .map((part) => String(part || '').trim())
          .filter(Boolean)
          .join('、')
      : value && typeof value === 'object'
        ? JSON.stringify(value)
        : String(value ?? '').trim();
  const bibleMatchTokens = (value) => {
    const tokens = new Set();
    const runs = normalizeBibleMatchText(value).match(/[\p{Script=Han}]+|[a-z0-9]+/gu) || [];
    for (const run of runs) {
      if (/^[a-z0-9]+$/.test(run)) {
        if (run.length > 1 && !BIBLE_MATCH_STOP_WORDS.has(run)) tokens.add(run);
        continue;
      }
      if (run.length > 1 && run.length <= 8 && !BIBLE_MATCH_STOP_WORDS.has(run)) tokens.add(run);
      for (let index = 0; index < run.length - 1; index += 1) {
        const pair = run.slice(index, index + 2);
        if (!BIBLE_MATCH_STOP_WORDS.has(pair)) tokens.add(pair);
        if (index < run.length - 2) {
          const triple = run.slice(index, index + 3);
          if (!BIBLE_MATCH_STOP_WORDS.has(triple)) tokens.add(triple);
        }
      }
    }
    return tokens;
  };
  const bibleMatchScore = (text, queryTokens) => {
    const tokens = bibleMatchTokens(text);
    if (!tokens.size || !queryTokens.size) return 0;
    let overlap = 0;
    let sharedTokenCount = 0;
    let hasLongAnchor = false;
    for (const token of tokens) {
      if (!queryTokens.has(token)) continue;
      overlap += token.length >= 4 ? 1.5 : 1;
      sharedTokenCount += 1;
      if (token.length >= 3) hasLongAnchor = true;
    }
    if (sharedTokenCount < 2 || !hasLongAnchor) return 0;
    return overlap / Math.sqrt(tokens.size);
  };
  const bibleAliases = (item) => {
    const aliases = Array.isArray(item.aliases)
      ? item.aliases
      : String(item.aliases || '').split(/[,，、;；|\n]/);
    return [item.name, ...aliases]
      .map((value) => String(value || '').trim())
      .filter((value) => value.length >= 2);
  };
  const bibleEntityBlock = (kind, item, fieldSpecs) => {
    const aliases = textValue(item.aliases);
    const tags = textValue(item.tags);
    const customFields = Object.entries(item.customFields || {})
      .map(([key, value]) => `${key}：${textValue(value)}`)
      .filter((value) => !value.endsWith('：'));
    const values = fieldSpecs.flatMap(([key, label]) => {
      const value = textValue(item[key]);
      return value ? [`${label}：${value}`] : [];
    });
    return [
      `${item.trust === 'auto' ? 'AI待确认建议' : '作者确认资料'} · ${kind}：${item.name}${aliases ? `（别名：${aliases}）` : ''}`,
      ...values,
      tags ? `标签：${tags}` : '',
      ...customFields.map((value) => `自定义字段 · ${value}`),
    ]
      .filter(Boolean)
      .join('\n');
  };
  const createBibleRecords = (bundle) => {
    const entities = BIBLE_ENTITY_SCHEMAS.flatMap(({ key, type, kind, fields }) =>
      (bundle[key] || []).map((item, index) => ({
        id: item.id,
        type,
        item,
        index,
        text: bibleEntityBlock(kind, item, fields),
        searchText: [
          item.name,
          textValue(item.aliases),
          textValue(item.tags),
          ...fields.map(([field]) => textValue(item[field])),
          ...Object.entries(item.customFields || {}).map(([name, value]) => `${name} ${textValue(value)}`),
        ]
          .join('\n')
          .slice(0, 16000),
      })),
    );
    const names = new Map(entities.map((entry) => [entry.id, entry.item.name]));
    const typeLabels = { character: '人物', location: '地点', item: '物品', organization: '组织' };
    const relations = (bundle.relations || []).map((item, index) => {
      const sourceName = names.get(item.sourceId) || '?';
      const targetName = names.get(item.targetId) || '?';
      const tags = textValue(item.tags);
      const customFields = Object.entries(item.customFields || {}).map(
        ([key, value]) => `${key}=${textValue(value)}`,
      );
      const source = `${typeLabels[item.sourceType] || '资料'}「${sourceName}」`;
      const target = `${typeLabels[item.targetType] || '资料'}「${targetName}」`;
      const text = `${item.trust === 'auto' ? 'AI待确认建议' : '作者确认资料'}：${source} —${item.label}→ ${target}${item.description ? `：${item.description}` : ''}${tags ? ` [${tags}]` : ''}${customFields.length ? ` ${customFields.join('；')}` : ''}`;
      return {
        id: item.id,
        item,
        index,
        sourceName,
        targetName,
        text,
        searchText: [sourceName, targetName, item.label, item.description, tags, ...customFields]
          .map(textValue)
          .join('\n')
          .slice(0, 8000),
      };
    });
    return { entities, relations };
  };
  const serializeBible = (entityTexts, relationTexts, filterNote = '') => {
    const records = [BIBLE_PROMPT_HEADER, BIBLE_PROMPT_PRIORITY];
    if (filterNote) records.push(filterNote);
    records.push(...entityTexts.filter(Boolean));
    if (relationTexts.length) records.push(`关系：\n${relationTexts.join('\n')}`);
    return records.length > (filterNote ? 3 : 2) ? records.join('\n\n') : '';
  };
  const formatBible = (characters, locations, items, organizations, relations) => {
    const records = createBibleRecords({ characters, locations, items, organizations, relations });
    return serializeBible(
      records.entities.map((entry) => entry.text),
      records.relations.map((entry) => entry.text),
    );
  };

  const formatCompactBibleEntry = (text, maxChars, queryTokens) => {
    if (text.length <= maxChars) return text;
    const lines = text.split('\n');
    const heading = lines.shift() || '';
    const tail = lines
      .map((line, index) => ({ line, index, score: bibleMatchScore(line, queryTokens) }))
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const marker = '…（本轮节选；完整内容仍保存在原资料卡）';
    let result = heading.slice(0, maxChars - marker.length - 1);
    let omitted = tail.length === 0;
    for (const { line } of tail) {
      const maxLineChars = 640;
      const clippedLine = line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line;
      const addition = `\n${clippedLine}`;
      if (result.length + addition.length + marker.length > maxChars) {
        omitted = true;
        continue;
      }
      result += addition;
      if (clippedLine !== line) omitted = true;
    }
    return omitted ? `${result}\n${marker}` : result;
  };

  const buildBibleSearchQuery = (target, originalContext) => {
    const chapterNumber = Number(state.currentChapter || 1);
    const outline = Array.isArray(state.outline) ? state.outline : [];
    const currentOutline = outline.find((chapter) => Number(chapter.chapter) === chapterNumber);
    const outlineText =
      target === 'outline'
        ? outline
            .slice(0, 40)
            .map(
              (chapter) =>
                `${chapter.title || ''} ${chapter.summary || ''} ${(chapter.plotPoints || []).join(' ')}`,
            )
            .join('\n')
        : currentOutline
          ? `${currentOutline.title || ''} ${currentOutline.summary || ''} ${(currentOutline.plotPoints || []).join(' ')}`
          : '';
    const chapterText = (state.chapters || []).find(
      (chapter) => Number(chapter.chapter) === chapterNumber,
    )?.content;
    const project = state.project || {};
    return [
      project.title,
      project.genre,
      project.setting,
      project.characters,
      state.creativeRules?.narrativePOV,
      state.creativeRules?.narrativePerspective,
      outlineText,
      String(chapterText || '').slice(-5000),
      String(originalContext || ''),
    ]
      .filter(Boolean)
      .join('\n')
      .slice(0, 32000);
  };

  const buildRelevantBibleText = (bundle, target, originalContext) => {
    const records = createBibleRecords(bundle);
    if (!records.entities.length && !records.relations.length) return '';
    const query = buildBibleSearchQuery(target, originalContext);
    const normalizedQuery = normalizeBibleMatchText(query);
    const queryTokens = bibleMatchTokens(query);
    const rankedEntities = records.entities.map((entry) => {
      const aliases = bibleAliases(entry.item);
      const mentionPositions = aliases
        .map((alias) => normalizedQuery.indexOf(normalizeBibleMatchText(alias)))
        .filter((position) => position >= 0);
      const score = bibleMatchScore(entry.searchText, queryTokens);
      return {
        ...entry,
        direct: mentionPositions.length > 0,
        mentionPosition: mentionPositions.length ? Math.min(...mentionPositions) : Number.MAX_SAFE_INTEGER,
        score,
        rank: mentionPositions.length ? 100 + score : score,
      };
    });
    const selected = new Map(
      rankedEntities.filter((entry) => entry.direct || entry.score >= 0.22).map((entry) => [entry.id, entry]),
    );
    if (!selected.size) {
      for (const entry of rankedEntities
        .filter((item) => item.score >= 0.14)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, 4)) {
        selected.set(entry.id, entry);
      }
    }

    const entityById = new Map(rankedEntities.map((entry) => [entry.id, entry]));
    const rankedRelations = records.relations.map((entry) => ({
      ...entry,
      score: bibleMatchScore(entry.searchText, queryTokens),
    }));
    const connectedRelations = rankedRelations
      .filter((entry) => selected.has(entry.item.sourceId) !== selected.has(entry.item.targetId))
      .filter((entry) => {
        const source = selected.get(entry.item.sourceId);
        const target = selected.get(entry.item.targetId);
        return source?.direct || target?.direct || entry.score >= 0.14;
      })
      .sort((left, right) => right.score - left.score || left.index - right.index);
    for (const relation of connectedRelations.slice(0, 8)) {
      const otherId = selected.has(relation.item.sourceId) ? relation.item.targetId : relation.item.sourceId;
      const other = entityById.get(otherId);
      if (other && !selected.has(otherId)) selected.set(otherId, { ...other, rank: relation.score + 0.1 });
    }

    const selectedEntities = [...selected.values()].sort(
      (left, right) =>
        right.rank - left.rank || left.mentionPosition - right.mentionPosition || left.index - right.index,
    );
    const filterNote = BIBLE_PROMPT_FILTER_NOTE;
    const prefixLength = [BIBLE_PROMPT_HEADER, BIBLE_PROMPT_PRIORITY, filterNote].join('\n\n').length;
    const bodyBudget = Math.max(0, BIBLE_PROMPT_CHAR_BUDGET - prefixLength);
    const entityBudget = Math.floor(bodyBudget * 0.72);
    const relationBudget = bodyBudget - entityBudget;
    const entityTexts = [];
    const includedEntityIds = new Set();
    let entityChars = 0;
    for (const entry of selectedEntities) {
      const text = formatCompactBibleEntry(entry.text, 2400, queryTokens);
      const cost = text.length + 2;
      if (entityChars + cost > entityBudget) continue;
      entityTexts.push(text);
      includedEntityIds.add(entry.id);
      entityChars += cost;
    }

    const relationCandidates = rankedRelations
      .filter(
        (entry) => includedEntityIds.has(entry.item.sourceId) && includedEntityIds.has(entry.item.targetId),
      )
      .sort((left, right) => right.score - left.score || left.index - right.index);
    const relationTexts = [];
    let relationChars = 0;
    for (const entry of relationCandidates) {
      const text = formatCompactBibleEntry(entry.text, 850, queryTokens);
      const cost = text.length + (relationTexts.length ? 1 : 2 + '关系：\n'.length);
      if (relationChars + cost > relationBudget) continue;
      relationTexts.push(text);
      relationChars += cost;
    }
    return serializeBible(entityTexts, relationTexts, filterNote);
  };

  const getBiblePromptText = (target, originalContext) => {
    const bundle =
      target === 'outline'
        ? (() => {
            const characters = (storyBibleBundle.characters || []).filter((item) => item.trust !== 'auto');
            const locations = (storyBibleBundle.locations || []).filter((item) => item.trust !== 'auto');
            const items = (storyBibleBundle.items || []).filter((item) => item.trust !== 'auto');
            const organizations = (storyBibleBundle.organizations || []).filter(
              (item) => item.trust !== 'auto',
            );
            const ids = new Set(
              [...characters, ...locations, ...items, ...organizations].map((item) => item.id),
            );
            return {
              characters,
              locations,
              items,
              organizations,
              relations: (storyBibleBundle.relations || []).filter(
                (item) => item.trust !== 'auto' && ids.has(item.sourceId) && ids.has(item.targetId),
              ),
            };
          })()
        : storyBibleBundle;
    const fullText = target === 'outline' ? storyBibleOutlineText : storyBibleText;
    return fullText.length <= BIBLE_PROMPT_CHAR_BUDGET
      ? fullText
      : buildRelevantBibleText(bundle, target, originalContext);
  };

  const formatOutlineBible = (bundle) => {
    const characters = (bundle.characters || []).filter((item) => item.trust !== 'auto');
    const locations = (bundle.locations || []).filter((item) => item.trust !== 'auto');
    const items = (bundle.items || []).filter((item) => item.trust !== 'auto');
    const organizations = (bundle.organizations || []).filter((item) => item.trust !== 'auto');
    const ids = new Set([...characters, ...locations, ...items, ...organizations].map((item) => item.id));
    const relations = (bundle.relations || []).filter(
      (item) => item.trust !== 'auto' && ids.has(item.sourceId) && ids.has(item.targetId),
    );
    return formatBible(characters, locations, items, organizations, relations);
  };

  const syncStoryBibleState = (result = {}, changes) => {
    if (Number.isFinite(Number(result.revision))) revision = Number(result.revision);
    storyBibleBundle = {
      characters: Array.isArray(result.characters) ? result.characters : storyBibleBundle.characters || [],
      locations: Array.isArray(result.locations) ? result.locations : storyBibleBundle.locations || [],
      items: Array.isArray(result.items) ? result.items : storyBibleBundle.items || [],
      organizations: Array.isArray(result.organizations)
        ? result.organizations
        : storyBibleBundle.organizations || [],
      relations: Array.isArray(result.relations) ? result.relations : storyBibleBundle.relations || [],
    };
    storyBibleText = formatBible(
      storyBibleBundle.characters,
      storyBibleBundle.locations,
      storyBibleBundle.items,
      storyBibleBundle.organizations,
      storyBibleBundle.relations,
    );
    storyBibleOutlineText = formatOutlineBible(storyBibleBundle);
    state.memory = normalizeMemory(state.memory);
    state.memory.structuredStoryBible = {
      source: 'server-authoritative',
      content: storyBibleText,
      updatedAt: new Date().toISOString(),
    };
    document
      .getElementById('serverSaveIndicator')
      ?.replaceChildren(document.createTextNode(`资料库已同步 · v${revision}`));
    renderBiblePanel(changes);
    refreshPOVUI();
  };

  const parseBibleList = (value) => {
    const source = Array.isArray(value) ? value : String(value || '').split(/[\n,，、;；]+/);
    return [...new Set(source.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 100);
  };

  const normalizeBibleCustomFields = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .map(([key, item]) => [String(key).trim(), String(item ?? '').trim()])
        .filter(([key, item]) => key && item)
        .slice(0, 100),
    );
  };

  const customFieldRowHtml = (key = '', value = '') =>
    `<div class="workbench-bible-custom-row" data-bible-custom-field-row>
      <input type="text" data-bible-custom-key value="${escapeHtml(key)}" placeholder="字段名，例如：信条">
      <input type="text" data-bible-custom-value value="${escapeHtml(value)}" placeholder="字段内容">
      <button type="button" class="btn btn-sm btn-ghost" data-bible-custom-remove aria-label="删除这个自定义字段">×</button>
    </div>`;

  const renderBibleCustomFields = (fields = {}) => {
    const entries = Object.entries(normalizeBibleCustomFields(fields));
    return (entries.length ? entries : [['', '']])
      .map(([key, value]) => customFieldRowHtml(key, value))
      .join('');
  };

  const collectBibleCustomFields = (form) => {
    const fields = {};
    form?.querySelectorAll('[data-bible-custom-field-row]').forEach((row) => {
      const key = row.querySelector('[data-bible-custom-key]')?.value.trim();
      const value = row.querySelector('[data-bible-custom-value]')?.value.trim();
      if (key && value) fields[key] = value;
    });
    return normalizeBibleCustomFields(fields);
  };

  const appendBibleCustomFieldRow = (form) => {
    const mount = form?.querySelector('[data-bible-custom-fields]');
    if (!mount) return;
    mount.insertAdjacentHTML('beforeend', customFieldRowHtml());
    mount.lastElementChild?.querySelector('[data-bible-custom-key]')?.focus();
  };

  const bibleEntityList = () =>
    Object.entries(bibleEntityConfig).flatMap(([type, config]) =>
      (storyBibleBundle[config.path] || []).map((entity) => ({ ...entity, type })),
    );

  const bibleTrustLabel = (entity) =>
    entity?.trust === 'auto' ? 'AI 待确认' : entity?.trust === 'confirmed' ? '已确认' : '人工资料';

  const closeBibleEditor = () => {
    activeBibleEditor = null;
    if (bibleEditorMount) {
      bibleEditorMount.hidden = true;
      bibleEditorMount.replaceChildren();
    }
  };

  const renderBibleEditor = (type, entity = null) => {
    const config = bibleEntityConfig[type];
    if (!config || !bibleEditorMount) return;
    activeBibleEditor = { type, id: entity?.id || null };
    bibleEditorMount.hidden = false;
    const expandedFields = config.fields.filter(([, , kind]) => kind !== 'input');
    const fieldControl = ([key, label, kind]) => {
      const value = entity?.[key] ?? '';
      const isList = kind === 'list';
      const control = isList
        ? `<input data-bible-field="${key}" value="${escapeHtml(Array.isArray(value) ? value.join('、') : String(value))}" placeholder="用逗号或换行分隔">`
        : kind === 'textarea'
          ? `<textarea data-bible-field="${key}" rows="3" placeholder="${escapeHtml(label)}">${escapeHtml(String(value))}</textarea>`
          : `<input data-bible-field="${key}" value="${escapeHtml(String(value))}" placeholder="${escapeHtml(label)}">`;
      return `<label class="workbench-bible-field"><span>${label}</span>${control}</label>`;
    };
    const primary = config.fields.filter(([, , kind]) => kind === 'input');
    const full = expandedFields.filter(([key]) => !['notes', 'tags'].includes(key));
    bibleEditorMount.innerHTML = `<form class="workbench-bible-editor" data-bible-editor data-bible-type="${type}">
      <div class="workbench-bible-editor-head"><div><span class="eyebrow">${entity ? 'EDIT CARD' : 'NEW CARD'}</span><h4>${entity ? `编辑${config.label}` : `新增${config.label}`}</h4><p>作者手动保存后会被视为权威资料，AI 更新只会补充未确认卡片。</p></div><button type="button" class="btn btn-sm btn-ghost" data-bible-editor-cancel>取消</button></div>
      <div class="workbench-bible-editor-grid">${primary.map(fieldControl).join('')}</div>
      <details class="workbench-bible-editor-more" ${entity ? '' : 'open'}><summary>展开完整字段</summary><div class="workbench-bible-editor-grid workbench-bible-editor-grid-wide">${full.map(fieldControl).join('')}</div></details>
      <div class="workbench-bible-editor-grid workbench-bible-editor-grid-wide">${config.fields
        .filter(([key]) => ['tags', 'notes'].includes(key))
        .map(fieldControl)
        .join(
          '',
        )}<div class="workbench-bible-field workbench-bible-custom-field"><span>自定义字段 <small>可直接增删，不用记 JSON 格式</small></span><div class="workbench-bible-custom-fields" data-bible-custom-fields>${renderBibleCustomFields(entity?.customFields || {})}</div><button type="button" class="btn btn-sm btn-ghost workbench-bible-custom-add" data-bible-custom-add>＋ 添加字段</button></div></div>
      <div class="workbench-bible-editor-actions"><button type="submit" class="btn btn-primary">保存资料</button>${entity ? `<button type="button" class="btn btn-danger" data-bible-delete-editor>删除${config.label}</button>` : ''}</div>
    </form>`;
    bibleEditorMount.querySelector('[data-bible-editor]')?.querySelector('input')?.focus();
  };

  const saveBibleEditor = async (form) => {
    const type = form.dataset.bibleType;
    const config = bibleEntityConfig[type];
    if (!config) return;
    const data = {};
    config.fields.forEach(([key, , kind]) => {
      const control = form.querySelector(`[data-bible-field="${key}"]`);
      if (!control) return;
      data[key] = kind === 'list' ? parseBibleList(control.value) : control.value.trim();
    });
    if (!data.name) {
      toast?.('请先填写名称');
      return;
    }
    data.customFields = collectBibleCustomFields(form);
    const currentEntity = activeBibleEditor?.id
      ? (storyBibleBundle[config.path] || []).find((item) => item.id === activeBibleEditor.id)
      : null;
    if (currentEntity?.evidence) data.evidence = currentEntity.evidence;
    if (currentEntity?.confidence) data.confidence = currentEntity.confidence;
    data.trust = activeBibleEditor?.id ? 'confirmed' : 'manual';
    data.expectedRevision = revision;
    const path = `/projects/${projectId}/${config.path}${activeBibleEditor?.id ? `/${activeBibleEditor.id}` : ''}`;
    const method = activeBibleEditor?.id ? 'PATCH' : 'POST';
    const result = await request(path, { method, body: JSON.stringify(data) });
    syncStoryBibleState({
      revision: result.revision,
      [config.path]: [
        ...(storyBibleBundle[config.path] || []).filter((item) => item.id !== result.entity?.id),
        result.entity,
      ],
    });
    closeBibleEditor();
    toast?.(`${config.label}已保存`);
  };

  const deleteBibleEntity = async (type, id) => {
    const config = bibleEntityConfig[type];
    if (!config || !id || !window.confirm(`确定删除这张${config.label}卡吗？相关关系也会删除。`)) return;
    const result = await request(`/projects/${projectId}/${config.path}/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: revision }),
    });
    syncStoryBibleState({
      revision: result.revision,
      [config.path]: (storyBibleBundle[config.path] || []).filter((item) => item.id !== id),
      relations: (storyBibleBundle.relations || []).filter(
        (item) => item.sourceId !== id && item.targetId !== id,
      ),
    });
    closeBibleEditor();
    toast?.(`${config.label}已删除`);
  };

  const confirmBibleEntity = async (type, id) => {
    const config = bibleEntityConfig[type];
    const entity = (storyBibleBundle[config?.path] || []).find((item) => item.id === id);
    if (!config || !entity) return;
    const result = await request(`/projects/${projectId}/${config.path}/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...entity, trust: 'confirmed', expectedRevision: revision }),
    });
    syncStoryBibleState({
      revision: result.revision,
      [config.path]: (storyBibleBundle[config.path] || []).map((item) =>
        item.id === id ? result.entity : item,
      ),
    });
    toast?.(`${config.label}已确认，后续 AI 更新不会覆盖它`);
  };

  const renderBibleRelationEditor = (relation = null) => {
    if (!bibleEditorMount) return;
    activeBibleEditor = { type: 'relation', id: relation?.id || null };
    const entities = bibleEntityList();
    const optionGroups = Object.entries(bibleEntityConfig)
      .map(([type, config]) => {
        const options = entities
          .filter((entity) => entity.type === type)
          .map(
            (entity) =>
              `<option value="${entity.id}" data-entity-type="${type}">${escapeHtml(entity.name)}</option>`,
          )
          .join('');
        return options ? `<optgroup label="${config.label}">${options}</optgroup>` : '';
      })
      .join('');
    const source = entities.find((entity) => entity.id === relation?.sourceId);
    const target = entities.find((entity) => entity.id === relation?.targetId);
    bibleEditorMount.hidden = false;
    bibleEditorMount.innerHTML = `<form class="workbench-bible-editor" data-bible-relation-editor><div class="workbench-bible-editor-head"><div><span class="eyebrow">${relation ? 'EDIT LINK' : 'NEW LINK'}</span><h4>${relation ? '编辑关系' : '新增关系'}</h4><p>只连接已有资料卡；关系也可以由作者手动确认。</p></div><button type="button" class="btn btn-sm btn-ghost" data-bible-editor-cancel>取消</button></div><div class="workbench-bible-editor-grid workbench-bible-editor-grid-wide"><label class="workbench-bible-field"><span>起点</span><select name="sourceId" data-relation-id>${optionGroups}</select></label><label class="workbench-bible-field"><span>关系标签</span><input name="label" value="${escapeHtml(relation?.label || '')}" placeholder="例如：信任、隶属、位于"></label><label class="workbench-bible-field"><span>终点</span><select name="targetId" data-relation-id>${optionGroups}</select></label><label class="workbench-bible-field"><span>描述</span><textarea name="description" rows="3" placeholder="关系为何成立、何时发生">${escapeHtml(relation?.description || '')}</textarea></label><label class="workbench-bible-field"><span>标签</span><input name="tags" value="${escapeHtml((relation?.tags || []).join('、'))}" placeholder="用逗号或换行分隔"></label><div class="workbench-bible-field workbench-bible-custom-field"><span>自定义字段 <small>可直接增删</small></span><div class="workbench-bible-custom-fields" data-bible-custom-fields>${renderBibleCustomFields(relation?.customFields || {})}</div><button type="button" class="btn btn-sm btn-ghost workbench-bible-custom-add" data-bible-custom-add>＋ 添加字段</button></div></div><div class="workbench-bible-editor-actions"><button type="submit" class="btn btn-primary">保存关系</button>${relation ? '<button type="button" class="btn btn-danger" data-bible-delete-editor>删除关系</button>' : ''}</div></form>`;
    const sourceSelect = bibleEditorMount.querySelector('[name="sourceId"]');
    const targetSelect = bibleEditorMount.querySelector('[name="targetId"]');
    if (source) sourceSelect.value = source.id;
    if (target) targetSelect.value = target.id;
  };

  const saveBibleRelation = async (form) => {
    const sourceId = form.querySelector('[name="sourceId"]')?.value;
    const targetId = form.querySelector('[name="targetId"]')?.value;
    const source = bibleEntityList().find((entity) => entity.id === sourceId);
    const target = bibleEntityList().find((entity) => entity.id === targetId);
    const label = form.querySelector('[name="label"]')?.value.trim();
    if (!source || !target || !label || source.id === target.id) {
      toast?.('请选择两个不同资料卡，并填写关系标签');
      return;
    }
    const data = {
      sourceType: source.type,
      sourceId,
      targetType: target.type,
      targetId,
      label,
      description: form.querySelector('[name="description"]')?.value.trim() || '',
      tags: parseBibleList(form.querySelector('[name="tags"]')?.value),
      customFields: collectBibleCustomFields(form),
      trust: activeBibleEditor?.id ? 'confirmed' : 'manual',
      expectedRevision: revision,
    };
    const currentRelation = activeBibleEditor?.id
      ? (storyBibleBundle.relations || []).find((item) => item.id === activeBibleEditor.id)
      : null;
    if (currentRelation?.evidence) data.evidence = currentRelation.evidence;
    if (currentRelation?.confidence) data.confidence = currentRelation.confidence;
    const path = `/projects/${projectId}/relations${activeBibleEditor?.id ? `/${activeBibleEditor.id}` : ''}`;
    const result = await request(path, {
      method: activeBibleEditor?.id ? 'PATCH' : 'POST',
      body: JSON.stringify(data),
    });
    syncStoryBibleState({
      revision: result.revision,
      relations: [
        ...(storyBibleBundle.relations || []).filter((item) => item.id !== result.relation?.id),
        result.relation,
      ],
    });
    closeBibleEditor();
    toast?.('关系已保存');
  };

  const deleteBibleRelation = async (id) => {
    if (!id || !window.confirm('确定删除这条关系吗？')) return;
    const result = await request(`/projects/${projectId}/relations/${id}`, {
      method: 'DELETE',
      body: JSON.stringify({ expectedRevision: revision }),
    });
    syncStoryBibleState({
      revision: result.revision,
      relations: (storyBibleBundle.relations || []).filter((item) => item.id !== id),
    });
    closeBibleEditor();
    toast?.('关系已删除');
  };

  const clearBibleSelection = () => {
    Object.values(bibleSelection).forEach((selection) => selection.clear());
  };

  const bibleSelectionCount = () =>
    Object.values(bibleSelection).reduce((total, selection) => total + selection.size, 0);

  const selectedBibleRecords = () => {
    const records = [];
    Object.entries(bibleEntityConfig).forEach(([type, config]) => {
      const entities = storyBibleBundle[config.path] || [];
      for (const id of bibleSelection[type] || []) {
        const entity = entities.find((item) => item.id === id);
        if (entity) records.push({ type, config, entity });
      }
    });
    for (const id of bibleSelection.relation || []) {
      const relation = (storyBibleBundle.relations || []).find((item) => item.id === id);
      if (relation) records.push({ type: 'relation', entity: relation });
    }
    return records;
  };

  const updateBibleBatchBar = () => {
    const bar = document.getElementById('workbenchBibleBatchBar');
    if (!bar) return;
    const toggle = document.getElementById('workbenchBibleBatchToggle');
    if (toggle) toggle.textContent = bibleBatchMode ? '完成批量编辑' : '批量编辑';
    bar.hidden = !bibleBatchMode;
    const count = bibleSelectionCount();
    const label = bar.querySelector('[data-bible-batch-count]');
    if (label) label.textContent = `已选 ${count} 条`;
    bar.querySelectorAll('[data-bible-batch-requires-selection]').forEach((button) => {
      button.disabled = count === 0;
    });
    const editor = bar.querySelector('[data-bible-batch-editor]');
    if (editor && count === 0) editor.hidden = true;
  };

  const ensureBibleBatchSelection = () => {
    for (const [type, config] of Object.entries(bibleEntityConfig)) {
      const ids = new Set((storyBibleBundle[config.path] || []).map((item) => item.id));
      for (const id of bibleSelection[type]) if (!ids.has(id)) bibleSelection[type].delete(id);
    }
    const relationIds = new Set((storyBibleBundle.relations || []).map((item) => item.id));
    for (const id of bibleSelection.relation) if (!relationIds.has(id)) bibleSelection.relation.delete(id);
  };

  const selectedBatchValue = (form, selector) => form.querySelector(selector)?.value.trim() || '';

  const buildBibleBatchPayload = (record, form, operation = 'edit') => {
    const entity = record.entity;
    const payload = { ...entity, trust: 'confirmed', expectedRevision: revision };
    if (operation === 'confirm') return payload;
    const field = selectedBatchValue(form, '[data-bible-batch-field]');
    const mode = form.querySelector('[data-bible-batch-mode]')?.value || 'replace';
    const value = selectedBatchValue(form, '[data-bible-batch-value]');
    if (!value) return null;
    if (field === 'currentStatus') {
      payload.currentStatus =
        mode === 'append' && entity.currentStatus ? `${entity.currentStatus}\n${value}` : value;
    } else if (field === 'notes') {
      payload.notes = mode === 'append' && entity.notes ? `${entity.notes}\n${value}` : value;
    } else if (field === 'tags') {
      const tags = parseBibleList(value);
      payload.tags = mode === 'append' ? [...new Set([...(entity.tags || []), ...tags])] : tags;
    } else if (field === 'customField') {
      const key = selectedBatchValue(form, '[data-bible-batch-key]');
      if (!key || !value) return null;
      payload.customFields = {
        ...normalizeBibleCustomFields(entity.customFields || {}),
        [key]:
          mode === 'append' && entity.customFields?.[key] ? `${entity.customFields[key]}\n${value}` : value,
      };
    }
    return payload;
  };

  const applyBibleBatch = async (operation, form = null) => {
    const records = selectedBibleRecords();
    if (!records.length) {
      toast?.('先勾选要处理的资料卡');
      return;
    }
    if (
      operation === 'delete' &&
      !window.confirm(`确定永久删除选中的 ${records.length} 条资料吗？相关关系也会删除。`)
    )
      return;
    if (operation === 'edit') {
      const field = selectedBatchValue(form, '[data-bible-batch-field]');
      const value = selectedBatchValue(form, '[data-bible-batch-value]');
      const key = selectedBatchValue(form, '[data-bible-batch-key]');
      if (!value || (field === 'customField' && !key)) {
        toast?.(field === 'customField' ? '请填写自定义字段名和内容' : '请填写要批量写入的内容');
        return;
      }
    }
    const working = {
      characters: [...(storyBibleBundle.characters || [])],
      locations: [...(storyBibleBundle.locations || [])],
      items: [...(storyBibleBundle.items || [])],
      organizations: [...(storyBibleBundle.organizations || [])],
      relations: [...(storyBibleBundle.relations || [])],
    };
    try {
      for (const record of records) {
        const config = record.config;
        const path =
          record.type === 'relation'
            ? `/projects/${projectId}/relations/${record.entity.id}`
            : `/projects/${projectId}/${config.path}/${record.entity.id}`;
        let result;
        if (operation === 'delete') {
          result = await request(path, {
            method: 'DELETE',
            body: JSON.stringify({ expectedRevision: revision }),
          });
          revision = Number(result.revision ?? revision);
          if (record.type === 'relation') {
            working.relations = working.relations.filter((item) => item.id !== record.entity.id);
          } else {
            working[config.path] = working[config.path].filter((item) => item.id !== record.entity.id);
            working.relations = working.relations.filter(
              (item) => item.sourceId !== record.entity.id && item.targetId !== record.entity.id,
            );
          }
          continue;
        }
        const payload = buildBibleBatchPayload(record, form, operation);
        if (!payload) continue;
        result = await request(path, { method: 'PATCH', body: JSON.stringify(payload) });
        revision = Number(result.revision ?? revision);
        if (record.type === 'relation') {
          const updated = result.relation || record.entity;
          working.relations = working.relations.map((item) =>
            item.id === record.entity.id ? updated : item,
          );
        } else {
          const updated = result.entity || record.entity;
          working[config.path] = working[config.path].map((item) =>
            item.id === record.entity.id ? updated : item,
          );
        }
      }
    } catch (error) {
      // Earlier requests in a batch may already have committed. Reflect those
      // commits locally before surfacing the conflict instead of hiding them.
      syncStoryBibleState({ revision, ...working });
      throw error;
    }
    syncStoryBibleState({ revision, ...working });
    clearBibleSelection();
    const editor = document.querySelector('[data-bible-batch-editor]');
    if (editor) editor.hidden = true;
    toast?.(
      operation === 'delete'
        ? `已删除 ${records.length} 条资料`
        : operation === 'confirm'
          ? `已确认 ${records.length} 条资料`
          : `已批量更新 ${records.length} 条资料`,
    );
  };

  Store.load = async function () {
    const [bundle, globalSettings, health] = await Promise.all([
      request(`/projects/${projectId}/state`),
      request('/settings/runtime'),
      request('/health').catch(() => null),
    ]);
    revision = bundle.revision;
    statePatchEnabled = health?.features?.statePatch === 1;
    baseStateDocument = globalThis.novelStatePatch?.normalize(bundle.state) || null;
    storyBibleBundle = {
      characters: bundle.characters || [],
      locations: bundle.locations || [],
      items: bundle.items || [],
      organizations: bundle.organizations || [],
      relations: bundle.relations || [],
    };
    storyBibleText = formatBible(
      bundle.characters || [],
      bundle.locations || [],
      bundle.items || [],
      bundle.organizations || [],
      bundle.relations || [],
    );
    storyBibleOutlineText = formatOutlineBible(storyBibleBundle);
    const incoming = {
      ...bundle.state,
      baseURL:
        globalSettings.apiConfigs?.find((item) => item.id === globalSettings.activeConfigId)?.baseURL ||
        bundle.state.baseURL ||
        '',
      apiKey:
        globalSettings.apiConfigs?.find((item) => item.id === globalSettings.activeConfigId)?.apiKey ||
        bundle.state.apiKey ||
        '',
      model:
        globalSettings.apiConfigs?.find((item) => item.id === globalSettings.activeConfigId)?.model ||
        bundle.state.model ||
        '',
      apiConfigs: globalSettings.apiConfigs || [],
      activeConfigId: globalSettings.activeConfigId || null,
      models: globalSettings.models || [],
      modelRoutes: globalSettings.modelRoutes || {},
      modelRouteThinking: globalSettings.modelRouteThinking || {},
      modelRouteThinkingEffort: globalSettings.modelRouteThinkingEffort || {},
    };
    state = this.normalize(incoming);
    state.memory = normalizeMemory(state.memory);
    state.memory.structuredStoryBible = {
      source: 'server-authoritative',
      content: storyBibleText,
      updatedAt: new Date().toISOString(),
    };
    this.legacyAppStateExtras = {};
    baseSnapshot = structuredClone(persistedState());
    globalUi = structuredClone(globalSettings.ui || {});
    baseGlobalSettings = collectGlobalSettings();
    queueMicrotask(() => {
      refreshBibleUI();
      refreshPOVUI();
    });
  };

  const persistedState = () => ({
    ...Store.snapshot(),
    chapters: state.chapters || [],
    chatWindows: state.chatWindows || [],
    referenceText: state.referenceText || '',
    storyBibleFreeText: state.storyBibleFreeText || '',
    methodologyCards: state.methodologyCards || [],
    chapterSnapshots: state.chapterSnapshots || [],
    operationLogs: state.operationLogs || [],
    agentEditHistory: state.agentEditHistory || [],
  });
  let statePatchEnabled = false,
    baseStateDocument = null;

  const sameValue = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const cloneValue = (value) => (value === undefined ? undefined : structuredClone(value));
  const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const arrayItemKey = (item) => {
    if (!isPlainObject(item)) return null;
    if (item.id !== undefined) return `id:${item.id}`;
    if (item.chapter !== undefined) return `chapter:${item.chapter}`;
    return null;
  };

  const threeWayMerge = (base, local, remote, path = [], conflicts = []) => {
    if (sameValue(local, remote)) return { value: cloneValue(local), conflicts };
    if (sameValue(local, base)) return { value: cloneValue(remote), conflicts };
    if (sameValue(remote, base)) return { value: cloneValue(local), conflicts };
    if (isPlainObject(base) || isPlainObject(local) || isPlainObject(remote)) {
      const result = {};
      const keys = new Set([
        ...Object.keys(base || {}),
        ...Object.keys(local || {}),
        ...Object.keys(remote || {}),
      ]);
      for (const key of keys) {
        const merged = threeWayMerge(base?.[key], local?.[key], remote?.[key], [...path, key], conflicts);
        if (merged.value !== undefined) result[key] = merged.value;
      }
      return { value: result, conflicts };
    }
    if (Array.isArray(base) && Array.isArray(local) && Array.isArray(remote)) {
      const all = [...base, ...local, ...remote];
      if (all.length && all.every((item) => arrayItemKey(item))) {
        const baseMap = new Map(base.map((item) => [arrayItemKey(item), item]));
        const localMap = new Map(local.map((item) => [arrayItemKey(item), item]));
        const remoteMap = new Map(remote.map((item) => [arrayItemKey(item), item]));
        const keys = [...new Set([...remoteMap.keys(), ...localMap.keys(), ...baseMap.keys()])];
        const result = [];
        for (const key of keys) {
          const merged = threeWayMerge(
            baseMap.get(key),
            localMap.get(key),
            remoteMap.get(key),
            [...path, result.length],
            conflicts,
          );
          if (merged.value !== undefined) result.push(merged.value);
        }
        return { value: result, conflicts };
      }
    }
    conflicts.push({ path, base: cloneValue(base), local: cloneValue(local), remote: cloneValue(remote) });
    return { value: cloneValue(local), conflicts };
  };

  const conflictPathLabel = (path) => {
    const joined = path.join('.');
    const exact = {
      'project.title': '小说标题',
      'project.genre': '小说类型',
      'project.setting': '背景设定',
      'project.characters': '人物与关键设定',
      storyBibleFreeText: '资料库自由文本',
      outline: '章节大纲',
      chapters: '章节正文',
      memory: 'AI 长期记忆',
    };
    if (exact[joined]) return exact[joined];
    if (path[0] === 'chapters' && Number.isInteger(path[1]))
      return `章节正文 · 列表第 ${Number(path[1]) + 1} 项 · ${path.slice(2).join('.') || '整章'}`;
    if (path[0] === 'outline' && Number.isInteger(path[1]))
      return `章节大纲 · 列表第 ${Number(path[1]) + 1} 项 · ${path.slice(2).join('.') || '整章'}`;
    return joined || '整个项目';
  };

  const conflictText = (value) => {
    if (value === undefined) return '［已删除］';
    if (typeof value === 'string') return value || '［空文本］';
    return JSON.stringify(value, null, 2);
  };

  const setAtPath = (root, path, value) => {
    if (!path.length) return cloneValue(value);
    let target = root;
    for (let index = 0; index < path.length - 1; index += 1) target = target[path[index]];
    const key = path.at(-1);
    if (value === undefined) {
      if (Array.isArray(target)) target.splice(Number(key), 1);
      else delete target[key];
    } else target[key] = cloneValue(value);
    return root;
  };

  const closeConflictResolver = () => {
    document.getElementById('serverConflictModal')?.remove();
    conflictOpen = false;
  };

  const projectContent = (snapshot) => {
    const memory = structuredClone(snapshot?.memory || {});
    delete memory.structuredStoryBible;
    const uiDrafts = structuredClone(snapshot?.uiDrafts || {});
    // Reader navigation is a tab preference, not a change to the novel.
    if (uiDrafts.inspirationWriter) delete uiDrafts.inspirationWriter.view;
    return {
      project: snapshot?.project || {},
      storyBibleFreeText: snapshot?.storyBibleFreeText || '',
      outline: snapshot?.outline || [],
      chapters: snapshot?.chapters || [],
      memory,
      chapterMemories: snapshot?.chapterMemories || {},
      chatWindows: snapshot?.chatWindows || [],
      referenceText: snapshot?.referenceText || '',
      methodologyCards: snapshot?.methodologyCards || [],
      savedPrompts: snapshot?.savedPrompts || {},
      creativeRules: snapshot?.creativeRules || {},
      editorAgent: snapshot?.editorAgent || {},
      uiDrafts,
      reviewReports: snapshot?.reviewReports || {},
      memoryTrust: snapshot?.memoryTrust || {},
      chapterSnapshots: snapshot?.chapterSnapshots || [],
      operationLogs: snapshot?.operationLogs || [],
      agentEditHistory: snapshot?.agentEditHistory || [],
    };
  };

  const openConflictResolver = async (localSnapshot) => {
    if (document.getElementById('serverConflictModal')) return;
    conflictOpen = true;
    const remoteBundle = await request(`/projects/${projectId}/state`);
    const remoteSnapshot = remoteBundle.state;
    const comparison = threeWayMerge(baseSnapshot || remoteSnapshot, localSnapshot, remoteSnapshot);
    let mergedState = comparison.value;
    const modal = document.createElement('div');
    modal.id = 'serverConflictModal';
    modal.className = 'modal-overlay show';
    const conflictCards = comparison.conflicts.length
      ? comparison.conflicts
          .map(
            (conflict, index) =>
              `<article class="server-conflict-card" data-conflict="${index}"><h3>${escapeHtml(conflictPathLabel(conflict.path))}</h3><div class="server-conflict-columns"><label><span>本地修改</span><textarea readonly>${escapeHtml(conflictText(conflict.local))}</textarea></label><label><span>服务器版本</span><textarea readonly>${escapeHtml(conflictText(conflict.remote))}</textarea></label></div><div class="server-conflict-choice"><label><input type="radio" name="conflict-${index}" value="local" checked>保留本地</label><label><input type="radio" name="conflict-${index}" value="remote">采用服务器</label></div></article>`,
          )
          .join('')
      : '<p class="server-conflict-clean">修改没有重叠，可以直接自动合并。</p>';
    modal.innerHTML = `<div class="modal server-conflict-modal"><div class="server-conflict-head"><div><h2>版本冲突解决</h2><p>基于你上次加载的版本，对比本地与服务器修改。未重叠内容已经自动合并；重叠字段请逐项选择。</p></div><span>本地基线 v${revision} · 服务器 v${remoteBundle.revision}</span></div><div class="server-conflict-list">${conflictCards}</div><div class="server-conflict-actions"><button class="btn" type="button" data-conflict-cancel>继续编辑</button><button class="btn" type="button" data-conflict-copy>另存为冲突副本</button><button class="btn" type="button" data-conflict-server>全部采用服务器</button><button class="btn btn-primary" type="button" data-conflict-apply>合并并保存</button></div></div>`;
    modal.querySelector('[data-conflict-cancel]').onclick = closeConflictResolver;
    modal.querySelector('[data-conflict-server]').onclick = () => location.reload();
    modal.querySelector('[data-conflict-copy]').onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '正在创建副本…';
      try {
        const copy = await request(`/projects/${projectId}/conflict-copy`, {
          method: 'POST',
          body: JSON.stringify({ state: localSnapshot }),
        });
        location.href = `/workbench.html?project=${encodeURIComponent(copy.id)}`;
      } catch (error) {
        button.disabled = false;
        button.textContent = '另存为冲突副本';
        if (typeof toast === 'function') toast(error.message || '创建副本失败');
      }
    };
    modal.querySelector('[data-conflict-apply]').onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      button.textContent = '正在合并…';
      comparison.conflicts.forEach((conflict, index) => {
        const choice = modal.querySelector(`input[name="conflict-${index}"]:checked`)?.value;
        mergedState = setAtPath(
          mergedState,
          conflict.path,
          choice === 'remote' ? conflict.remote : conflict.local,
        );
      });
      try {
        await request(`/projects/${projectId}/state`, {
          method: 'PUT',
          body: JSON.stringify({ revision: remoteBundle.revision, state: mergedState }),
        });
        location.reload();
      } catch (error) {
        closeConflictResolver();
        if (error.status === 409) await openConflictResolver(localSnapshot);
        else if (typeof toast === 'function') toast(error.message || '冲突合并失败');
      }
    };
    document.body.append(modal);
  };

  function collectGlobalSettings() {
    return {
      apiConfigs: structuredClone(state.apiConfigs || []),
      activeConfigId: state.activeConfigId || null,
      models: structuredClone(state.models || []),
      modelRoutes: structuredClone(state.modelRoutes || {}),
      modelRouteThinking: structuredClone(state.modelRouteThinking || {}),
      modelRouteThinkingEffort: structuredClone(state.modelRouteThinkingEffort || {}),
      ui: structuredClone(globalUi),
    };
  }
  Store.save = function (options = {}) {
    if (conflictOpen)
      return Promise.resolve({
        ok: false,
        projectSaved: false,
        settingsSaved: false,
        error: { message: '请先解决版本冲突', status: 409 },
      });
    const snapshot = structuredClone(persistedState());
    // A streamed checkpoint must verify the revision even if another local save
    // already persisted identical content. Keep the same transactional writer.
    const globalSettings = collectGlobalSettings();
    let projectSaved = false;
    let settingsSaved = false;
    saveTail = saveTail.then(async () => {
      if (conflictOpen)
        return {
          ok: false,
          projectSaved: false,
          settingsSaved: false,
          error: { message: '请先解决版本冲突', status: 409 },
        };
      try {
        // Recheck against the last acknowledged snapshot when this queued save
        // actually runs. Identical queued saves must not create extra revisions.
        const contentChanged =
          options?.forceProject === true ||
          !baseSnapshot ||
          !sameValue(projectContent(snapshot), projectContent(baseSnapshot));
        if (contentChanged) {
          const patchEngine = globalThis.novelStatePatch;
          const usePatch = statePatchEnabled && baseStateDocument && patchEngine;
          const targetDocument = usePatch
            ? { ...baseStateDocument, ...patchEngine.normalize(snapshot) }
            : null;
          const result = await request(`/projects/${projectId}/state`, {
            method: usePatch ? 'PATCH' : 'PUT',
            body: JSON.stringify(
              usePatch
                ? { revision, patch: patchEngine.create(baseStateDocument, targetDocument) }
                : { revision, state: snapshot },
            ),
          });
          revision = result.revision;
          baseSnapshot = structuredClone(snapshot);
          if (usePatch) baseStateDocument = targetDocument;
          else if (patchEngine) baseStateDocument = patchEngine.normalize(snapshot);
        }
        projectSaved = true;
        if (!baseGlobalSettings || !sameValue(globalSettings, baseGlobalSettings)) {
          await request('/settings', { method: 'PUT', body: JSON.stringify(globalSettings) });
          baseGlobalSettings = structuredClone(globalSettings);
        }
        settingsSaved = true;
        document
          .getElementById('serverSaveIndicator')
          ?.replaceChildren(document.createTextNode(`已保存 · v${revision}`));
        return { ok: true, projectSaved, settingsSaved };
      } catch (error) {
        const message =
          error.status === 409
            ? '保存冲突：项目已在其他设备修改。请返回书库重新打开，当前页面内容尚未覆盖服务器。'
            : `服务保存失败：${error.message}`;
        document.getElementById('serverSaveIndicator')?.replaceChildren(document.createTextNode(message));
        if (typeof toast === 'function') toast(message);
        if (error.status === 409) await openConflictResolver(structuredClone(persistedState()));
        return {
          ok: false,
          projectSaved,
          settingsSaved,
          error: { message: error.message || message, status: error.status || 0 },
        };
      }
    });
    this.saving = saveTail;
    return saveTail;
  };

  const buildCharacterVoiceContext = (targetChapter) => {
    const rules = state.creativeRules || {};
    if (rules.detailedPOVEnabled !== true) return '';
    const override = rules.chapterPOVOverrides?.[String(targetChapter)];
    const hasOverride = Array.isArray(override)
      ? override.length > 0
      : typeof override === 'string' && override.trim().length > 0;
    const selected = hasOverride ? override : rules.povCharacters;
    const selectedNames = Array.isArray(selected)
      ? selected
      : typeof selected === 'string'
        ? selected.split(/[,，、]/u)
        : [];
    const names = [...new Set(selectedNames.map((name) => String(name).trim()))]
      .filter((name) => name && name.length <= 32)
      .slice(0, 3);
    if (!names.length) return '';

    const previousChapters = getPreviousProseSources(targetChapter);
    const quotePattern = /[“「『]([^”」』\r\n]{2,160})[”」』]|"([^"\r\n]{2,160})"/gu;
    const speechTagEnding =
      /(?:说|道|问|答|喊|叫|应|回|追问|反问|提醒|解释|嘱咐|回应|补充)(?:了|着|过)?[，,:：、。！？!?…\s]*$/u;
    const hasLocalSpeakerTag = (text, name, beforeQuote) => {
      const clauses = text.split(/[。！？!?…\n]/u);
      const clause = beforeQuote ? clauses.at(-1) || '' : clauses[0] || '';
      const nameIndex = beforeQuote ? clause.lastIndexOf(name) : clause.indexOf(name);
      if (nameIndex < 0) return false;
      const afterName = clause.slice(nameIndex + name.length).trim();
      return afterName.length <= 32 && speechTagEnding.test(afterName);
    };
    const examples = [];

    for (const name of names) {
      let found = null;
      for (const chapter of previousChapters) {
        const text =
          globalThis.sanitizeGeneratedText?.(chapter.content) || String(chapter.content || '').trim();
        const quotes = [...text.matchAll(quotePattern)];
        for (const quote of quotes.reverse()) {
          const start = Number(quote.index || 0);
          const end = start + quote[0].length;
          const before = text.slice(Math.max(0, start - 56), start);
          const after = text.slice(end, end + 48);
          if (!hasLocalSpeakerTag(before, name, true) && !hasLocalSpeakerTag(after, name, false)) continue;
          const line = String(quote[1] || quote[2] || '').trim();
          if (!line) continue;
          found = {
            chapter: Number(chapter.chapter),
            text: line.length > 120 ? line.slice(0, 120).trimEnd() + '…' : line,
          };
          break;
        }
        if (found) break;
      }
      if (found) examples.push('- ' + name + '（第' + found.chapter + '章）：“' + found.text + '”');
    }

    if (!examples.length) return '';
    return [
      '【角色声线参照｜仅限本章指定视角人物】',
      '以下只用于辨认各角色稳定的表达节奏与措辞倾向，不是当前情绪的模板；不得复制原句，也不得把某人的口吻移植给其他人。无可靠历史台词的角色，以人物资料和当前情境为准，不臆造口头禅。',
      ...examples,
    ].join('\n');
  };

  const proseQualityFingerprint = (value) => {
    const content = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < content.length; index += 1) {
      hash ^= content.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return `${content.length.toString(36)}-${(hash >>> 0).toString(16).padStart(8, '0')}`;
  };

  const isCurrentReviewedChapter = (chapter) => {
    const number = Number(chapter?.chapter);
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[String(number)];
    if (!['reviewed', 'repaired'].includes(report?.status)) return false;
    const cleanText =
      globalThis.sanitizeGeneratedText?.(chapter?.content) || String(chapter?.content || '').trim();
    return !!cleanText && report.fingerprint === proseQualityFingerprint(cleanText);
  };

  const authorProseFeedbackForChapter = (chapterNumber) => {
    const key = String(Number(chapterNumber));
    const saved = state.uiDrafts?.authorProseFeedback?.[key];
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[key];
    return [saved, report?.authorRevision].find(
      (marker) => marker && typeof marker === 'object' && typeof marker.fingerprint === 'string',
    );
  };

  const authorRevisionTime = (chapter) => {
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[String(chapter.chapter)];
    const value = authorProseFeedbackForChapter(chapter.chapter)?.updatedAt ?? report?.updatedAt;
    const time = typeof value === 'number' ? value : Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : 0;
  };

  const orderedAuthorRevisionSources = (chapters) =>
    chapters
      .filter(isAuthorRevisedChapter)
      .sort(
        (left, right) =>
          authorRevisionTime(right) - authorRevisionTime(left) ||
          Number(right.chapter) - Number(left.chapter),
      );

  const currentReviewedProseSources = (chapters) => chapters.filter(isCurrentReviewedChapter);

  const authorRevisionLabel = (chapter) => {
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[String(chapter.chapter)];
    return ['reviewed', 'repaired'].includes(report?.status) ? '（审校后有修订）' : '（作者修订）';
  };

  const isAuthorRevisedChapter = (chapter) => {
    const number = Number(chapter?.chapter);
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[String(number)];
    const cleanText =
      globalThis.sanitizeGeneratedText?.(chapter?.content) || String(chapter?.content || '').trim();
    if (!cleanText) return false;
    const currentFingerprint = proseQualityFingerprint(cleanText);
    const savedFeedback = state.uiDrafts?.authorProseFeedback?.[String(number)];
    const reportFeedback = report?.authorRevision;
    const markers = [savedFeedback, reportFeedback].filter(
      (marker) => marker && typeof marker === 'object' && typeof marker.fingerprint === 'string',
    );
    if (markers.length) return markers.some((marker) => marker.fingerprint === currentFingerprint);
    if (!['reviewed', 'repaired'].includes(report?.status) || isCurrentReviewedChapter(chapter)) return false;
    const reportTime = Number.isFinite(Number(report.updatedAt))
      ? Number(report.updatedAt)
      : Date.parse(String(report.updatedAt || ''));
    if (!Number.isFinite(reportTime) || reportTime <= 0) return false;
    return !(state.operationLogs || []).some((entry) => {
      if (Number(entry?.chapter) !== number) return false;
      const operationTime =
        typeof entry?.createdAt === 'number' ? entry.createdAt : Date.parse(String(entry?.createdAt || ''));
      // Unknown timestamps are treated conservatively: do not infer an author edit
      // when a later AI rewrite cannot be ruled out.
      return !Number.isFinite(operationTime) || operationTime > reportTime;
    });
  };

  const getPreviousProseSources = (targetChapter) => {
    const previous = (state.chapters || [])
      .filter((chapter) => Number(chapter.chapter) < targetChapter && String(chapter.content || '').trim())
      .sort((left, right) => Number(right.chapter) - Number(left.chapter));
    const authorRevised = previous.filter(isAuthorRevisedChapter);
    const authorRevisedNumbers = new Set(authorRevised.map((chapter) => Number(chapter.chapter)));
    const reviewed = previous.filter(
      (chapter) => !authorRevisedNumbers.has(Number(chapter.chapter)) && isCurrentReviewedChapter(chapter),
    );
    const preferredNumbers = new Set([
      ...authorRevisedNumbers,
      ...reviewed.map((chapter) => Number(chapter.chapter)),
    ]);
    return [
      ...authorRevised,
      ...reviewed,
      ...previous.filter((chapter) => !preferredNumbers.has(Number(chapter.chapter))),
    ];
  };

  const buildRecentProseStyleContext = (target) => {
    if (!['chapter', 'continue'].includes(target)) return '';
    const targetChapter = Math.floor(Number(state.currentChapter || 0));
    if (targetChapter <= 1) return '';
    const characterVoiceContext = buildCharacterVoiceContext(targetChapter);
    const availablePrevious = getPreviousProseSources(targetChapter);
    const authorRevisedSources = orderedAuthorRevisionSources(availablePrevious);
    const reviewedSources = currentReviewedProseSources(availablePrevious);
    if (state.contextFull === true) {
      const authorLabels = authorRevisedSources
        .slice(0, MAX_PROSE_STYLE_REFERENCE_SOURCES)
        .map((source) => `第${source.chapter}章${authorRevisionLabel(source)}`);
      const latestReviewed = reviewedSources.find(
        (source) => !authorRevisedSources.some((edited) => Number(edited.chapter) === Number(source.chapter)),
      );
      const fullVoiceGuidance =
        '【全文人物声线参照】以人物资料卡为稳定依据，并对照全文中同一人物在不同情境下的表达；不要把单句样本写成口头禅，也不要移植其他人物的口吻。';
      if (!authorLabels.length && !latestReviewed) return fullVoiceGuidance;
      return [
        fullVoiceGuidance,
        `【全文上下文里的${authorLabels.length ? '作者风格锚点' : '正文风格锚点'}】`,
        authorLabels.length
          ? `全文中已包含${authorLabels.join('、')}的完整正文；这些作者亲自修改过的章节是风格优先依据。提炼其中稳定的叙述距离、节奏和细节取舍，不复制原句、剧情或事实。`
          : `全文中已包含第${latestReviewed.chapter}章（审校通过）的完整正文，可作为近期节奏参照；不要复述章节内容。`,
        latestReviewed
          ? authorLabels.length
            ? `第${latestReviewed.chapter}章（审校通过）只补充近期表达节奏，不能覆盖作者修订体现的取舍。`
            : ''
          : '',
        '正文已经在全文上下文中，不重复附加摘录。人物个体口吻以资料卡与其全文对白为准。',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const styleSources = authorRevisedSources.slice(0, MAX_PROSE_STYLE_REFERENCE_SOURCES);
    for (const source of reviewedSources) {
      if (styleSources.length >= MAX_PROSE_STYLE_REFERENCE_SOURCES) break;
      if (!styleSources.some((item) => Number(item.chapter) === Number(source.chapter)))
        styleSources.push(source);
    }
    if (!styleSources.length && availablePrevious[0]) styleSources.push(availablePrevious[0]);
    if (!styleSources.length) return characterVoiceContext;

    const sampleWidth =
      styleSources.length > 1 ? PROSE_STYLE_SAMPLE_WIDTH.multiple : PROSE_STYLE_SAMPLE_WIDTH.single;
    const styleSamples = styleSources
      .map((source) => {
        const cleanText =
          globalThis.sanitizeGeneratedText?.(source.content) || String(source.content || '').trim();
        if (!cleanText) return '';
        const dialogueMatches = Array.from(
          cleanText.matchAll(/[“「『][^”」』]{1,500}[”」』]|"[^"\r\n]{1,500}"/gu),
        );
        const latestDialogue = dialogueMatches.at(-1);
        const sampleCenter = latestDialogue
          ? Number(latestDialogue.index || 0) + Math.floor(latestDialogue[0].length / 2)
          : Math.floor(cleanText.length / 2);
        let sampleStart = Math.max(
          0,
          Math.min(cleanText.length - sampleWidth, Math.floor(sampleCenter - sampleWidth / 2)),
        );
        if (sampleStart > 0) {
          const leadingBoundary = cleanText
            .slice(sampleStart, Math.min(cleanText.length, sampleStart + 180))
            .search(/[。！？!?…\n]/u);
          if (leadingBoundary >= 0) sampleStart += leadingBoundary + 1;
        }
        let sampleEnd = Math.min(cleanText.length, sampleStart + sampleWidth);
        if (sampleEnd < cleanText.length) {
          const sampleTail = cleanText.slice(sampleStart, sampleEnd);
          const endingBoundary = Math.max(
            sampleTail.lastIndexOf('。'),
            sampleTail.lastIndexOf('！'),
            sampleTail.lastIndexOf('？'),
            sampleTail.lastIndexOf('!'),
            sampleTail.lastIndexOf('?'),
            sampleTail.lastIndexOf('…'),
            sampleTail.lastIndexOf('\n'),
          );
          if (endingBoundary >= sampleWidth * 0.62) sampleEnd = sampleStart + endingBoundary + 1;
        }
        const sample = cleanText.slice(sampleStart, sampleEnd).trim();
        if (!sample) return '';
        const authorRevised = isAuthorRevisedChapter(source);
        return [
          `【正文风格参照 · 第${source.chapter}章${authorRevised ? authorRevisionLabel(source) : '（审校通过）'}】`,
          authorRevised
            ? '作者亲自修订的样本优先级最高，优先把这份修订视作作者反馈：提炼其叙述距离、句式节奏、潜台词和细节取舍；只迁移稳定写法，不复制措辞、情节或事实。'
            : '这份审校通过的近期正文用于补充节奏参照；若与作者修订样本冲突，以作者修订为准。只参考表达方式，不照搬其措辞、情节或事实。',
          `${sampleStart > 0 ? '……' : ''}${sample}${sampleEnd < cleanText.length ? '……' : ''}`,
        ].join('\n');
      })
      .filter(Boolean);
    if (!styleSamples.length) return characterVoiceContext;
    return [
      ...(characterVoiceContext ? [characterVoiceContext] : []),
      '【参照优先级】作者亲自修订的样本体现明确取舍；多份样本只迁移共同的稳定风格，审校稿只补充近期流畅度。若没有可用的作者修订或审校样本，则回退到最近的已写章节。人物个体口吻以资料卡和当前情境为准，不把样本人物的口吻套给其他角色。',
      ...styleSamples,
    ].join('\n');
  };
  globalThis.buildRecentProseStyleContext = buildRecentProseStyleContext;

  const buildSceneQualityContext = (target) => {
    if (!['chapter', 'continue'].includes(target)) return '';
    return [
      '【场景组织｜把大纲写成戏】',
      '关键点按原有因果顺序发生，但不要求“一点一幕”：按时空连续性、焦点人物和当下行动任务把相关事件编成完整场景；只在真实的时地、行动焦点或戏剧任务变化时切场。不要逐点复述成清单，也不要为合并场景而把重要事件概述跳过。',
      '每个场景都要让读者看见人物此刻要什么、阻力怎样具体作用、人物采取什么行动或选择，以及场面结束时信息、关系、资源、风险或处境发生了什么变化。场景节奏可以不同，不套统一节拍，也不要求每场都反转。',
      '让本作独有的规则、地点、物件和关系改变人物能做什么、会误判什么或要付出什么；细节必须参与行动、判断或情绪。对白有各自目的与语感，情绪落在言行和后果上；严格守住指定视角与作者明确禁用项。',
      '人物卡提供「说话方式」时，把它当作稳定倾向而不是口头禅清单：通过句长、称呼、信息显隐和应对策略自然体现。不得把差异简化成重复口头禅、刻意方言拼写或刻板音译；人物在压力、撒谎或亲密关系中的表达可以变化，但要有情境依据。',
      '场景间保持时间、空间和因果连续；结尾落在本章真实造成的变化上，不强加金句或悬崖钩子。',
    ].join('\n');
  };

  let writingContextPurpose = '';

  const buildNextChapterHandoffContext = (target) => {
    if (target !== 'chapter') return '';
    const chapterNumber = Math.floor(Number(state.currentChapter || 0));
    if (!Number.isInteger(chapterNumber) || chapterNumber < 1) return '';
    const nextChapter = (state.outline || []).find(
      (chapter) => Number(chapter.chapter) === chapterNumber + 1,
    );
    const summary = String(nextChapter?.summary || '')
      .trim()
      .slice(0, 700);
    if (!nextChapter || !summary) return '';
    const nextTitle = String(nextChapter.title || `第${chapterNumber + 1}章`).trim();
    return [
      '【下一章接力方向｜仅供当前章收束参考】',
      `下一章《${nextTitle}》的既有大纲方向：${summary}`,
      '当前章仍须完整兑现自己的大纲与剧情关键点。只借此选择自然的收束状态、未解压力或可承接的动作；不得提前演出下一章专属事件、揭示或人物变化，不强行制造悬念。若与已写正文、人工确认设定或本章大纲冲突，以既有正史和本章大纲为准。',
    ].join('\n');
  };

  const cloneMemoryValue = (value) => cloneSerializable(value);
  const canonicalMemoryValue = (value) => {
    if (Array.isArray(value)) return value.map(canonicalMemoryValue);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => !['updatedAt', 'createdAt', 'contentHash', 'source', 'indexes'].includes(key))
        .sort()
        .map((key) => [key, canonicalMemoryValue(value[key])]),
    );
  };
  const memoryValueSignature = (value) => JSON.stringify(canonicalMemoryValue(value) ?? null);
  const hashMemoryValue = (value) => {
    const text = String(value || '');
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  };
  const memoryProposalList = () => {
    state.uiDrafts = state.uiDrafts && typeof state.uiDrafts === 'object' ? state.uiDrafts : {};
    state.uiDrafts.memoryProposals = Array.isArray(state.uiDrafts.memoryProposals)
      ? state.uiDrafts.memoryProposals
      : [];
    return state.uiDrafts.memoryProposals;
  };
  const addMemoryProposal = ({ kind, key, title, chapter, current, suggested }) => {
    const signature = memoryValueSignature(suggested);
    const id = 'memory-proposal-' + hashMemoryValue(kind + ':' + key + ':' + signature);
    const proposals = memoryProposalList();
    if (proposals.some((proposal) => proposal.id === id)) return false;
    proposals.unshift({
      id,
      kind,
      key,
      title,
      chapter: Number(chapter) || null,
      current: cloneMemoryValue(current),
      suggested: cloneMemoryValue(suggested),
      status: 'pending',
      createdAt: Date.now(),
    });
    return true;
  };
  const memoryEntryText = (value) =>
    typeof globalThis.memoryTextOf === 'function'
      ? globalThis.memoryTextOf(value)
      : typeof value === 'string'
        ? value
        : JSON.stringify(value ?? null);
  const foreshadowIdentity = (value) =>
    String(value && typeof value === 'object' ? value.desc || value.description || '' : value || '')
      .trim()
      .toLocaleLowerCase();
  const memoryTrustStatus = (key) => globalThis.trustStatusOf?.(key) || 'auto';

  const mergeAiMemoryWithCanon = (candidateValue, sourceChapter) => {
    if (typeof globalThis.normalizeMemory !== 'function') return candidateValue;
    const current = globalThis.normalizeMemory(cloneMemoryValue(state.memory || {}));
    const next = globalThis.normalizeMemory(cloneMemoryValue(candidateValue || {}));
    const chapter = Number(sourceChapter) || 0;
    if (current.structuredStoryBible)
      next.structuredStoryBible = cloneMemoryValue(current.structuredStoryBible);

    for (const [name, existing] of Object.entries(current.characters || {})) {
      const proposed = next.characters[name];
      const key = 'character:' + name;
      if (memoryTrustStatus(key) === 'confirmed') {
        if (proposed && memoryValueSignature(existing) !== memoryValueSignature(proposed))
          addMemoryProposal({
            kind: 'character',
            key,
            title: '人物记忆：' + name,
            chapter,
            current: existing,
            suggested: proposed,
          });
        next.characters[name] = cloneMemoryValue(existing);
      } else if (proposed && existing && typeof existing === 'object' && typeof proposed === 'object') {
        next.characters[name] = { ...cloneMemoryValue(existing), ...cloneMemoryValue(proposed) };
      } else if (!proposed) next.characters[name] = cloneMemoryValue(existing);
    }

    const mergeNamedRecords = (existingItems, proposedItems, keyOf) => {
      const merged = (Array.isArray(existingItems) ? existingItems : []).map(cloneMemoryValue);
      for (const proposed of Array.isArray(proposedItems) ? proposedItems : []) {
        const key = String(keyOf(proposed) || '')
          .trim()
          .toLocaleLowerCase();
        const index = key
          ? merged.findIndex(
              (item) =>
                String(keyOf(item) || '')
                  .trim()
                  .toLocaleLowerCase() === key,
            )
          : -1;
        if (index < 0) merged.push(cloneMemoryValue(proposed));
        else if (
          proposed &&
          typeof proposed === 'object' &&
          merged[index] &&
          typeof merged[index] === 'object'
        )
          merged[index] = { ...merged[index], ...cloneMemoryValue(proposed) };
        else merged[index] = cloneMemoryValue(proposed);
      }
      return merged;
    };
    next.locations = mergeNamedRecords(current.locations, next.locations, (item) => item?.name);
    next.factions = mergeNamedRecords(current.factions, next.factions, (item) => item?.name);
    next.worldBuilding = mergeNamedRecords(
      current.worldBuilding,
      next.worldBuilding,
      (item) => item?.concept,
    );

    const proposedEvents = Array.isArray(next.importantEvents) ? next.importantEvents : [];
    const preservedEvents = (current.importantEvents || []).filter((existing) => {
      const eventChapter = Number(existing?.chapter) || 0;
      if (!chapter || eventChapter !== chapter) return true;
      const key = 'event:' + (existing?.chapter || '') + ':' + hashMemoryValue(memoryEntryText(existing));
      return memoryTrustStatus(key) === 'confirmed';
    });
    next.importantEvents = [...preservedEvents];
    for (const proposed of proposedEvents) {
      if (!next.importantEvents.some((item) => memoryValueSignature(item) === memoryValueSignature(proposed)))
        next.importantEvents.push(cloneMemoryValue(proposed));
    }

    for (const existing of current.importantEvents || []) {
      const key = 'event:' + (existing?.chapter || '') + ':' + hashMemoryValue(memoryEntryText(existing));
      if (memoryTrustStatus(key) !== 'confirmed') continue;
      const index = next.importantEvents.findIndex(
        (item) => memoryValueSignature(item) === memoryValueSignature(existing),
      );
      if (index >= 0) next.importantEvents[index] = cloneMemoryValue(existing);
      else next.importantEvents.push(cloneMemoryValue(existing));
    }

    const foreshadowKey = (bucket, item) =>
      'foreshadow:' + bucket + ':' + hashMemoryValue(memoryEntryText(item));
    for (const bucket of ['active', 'resolved']) {
      const otherBucket = bucket === 'active' ? 'resolved' : 'active';
      for (const existing of current.foreshadows?.[bucket] || []) {
        const trusted = memoryTrustStatus(foreshadowKey(bucket, existing)) === 'confirmed';
        const identity = foreshadowIdentity(existing);
        const sameInCurrent = (next.foreshadows[bucket] || []).findIndex((item) =>
          identity
            ? foreshadowIdentity(item) === identity
            : memoryValueSignature(item) === memoryValueSignature(existing),
        );
        const movedIndex = (next.foreshadows[otherBucket] || []).findIndex((item) =>
          identity
            ? foreshadowIdentity(item) === identity
            : memoryValueSignature(item) === memoryValueSignature(existing),
        );
        if (trusted && movedIndex >= 0) {
          const moved = next.foreshadows[otherBucket][movedIndex];
          addMemoryProposal({
            kind: 'foreshadow-state',
            key: foreshadowKey(bucket, existing),
            title: '伏笔状态：' + memoryEntryText(existing).slice(0, 32),
            chapter,
            current: { bucket, item: existing },
            suggested: { bucket: otherBucket, item: moved },
          });
          next.foreshadows[otherBucket].splice(movedIndex, 1);
        }
        if (trusted) {
          if (sameInCurrent >= 0) next.foreshadows[bucket][sameInCurrent] = cloneMemoryValue(existing);
          else if (movedIndex < 0) next.foreshadows[bucket].push(cloneMemoryValue(existing));
        } else if (sameInCurrent < 0 && movedIndex < 0) {
          // An omitted AI memory entry is not evidence that an older story fact disappeared.
          next.foreshadows[bucket].push(cloneMemoryValue(existing));
        }
      }
    }

    const cardsByChapter = new Map(
      (current.chapterCards || []).map((card) => [Number(card.chapter), cloneMemoryValue(card)]),
    );
    for (const proposed of next.chapterCards || []) {
      const number = Number(proposed.chapter);
      const existing = cardsByChapter.get(number);
      if (!existing) {
        cardsByChapter.set(number, cloneMemoryValue(proposed));
        continue;
      }
      const key = 'chapterCard:' + number;
      if (memoryTrustStatus(key) === 'confirmed') {
        if (memoryValueSignature(existing) !== memoryValueSignature(proposed))
          addMemoryProposal({
            kind: 'chapter-card',
            key,
            title: '第 ' + number + ' 章记忆卡',
            chapter,
            current: existing,
            suggested: proposed,
          });
        cardsByChapter.set(number, existing);
      } else {
        cardsByChapter.set(number, { ...existing, ...cloneMemoryValue(proposed) });
      }
    }
    next.chapterCards = [...cardsByChapter.values()].sort(
      (left, right) => Number(left.chapter) - Number(right.chapter),
    );

    return typeof globalThis.rebuildMemoryIndexes === 'function'
      ? globalThis.rebuildMemoryIndexes(next)
      : next;
  };

  const mergeChapterMemoryPackageWithCanon = (packageValue, sourceChapter) => {
    if (typeof globalThis.normalizeMemory !== 'function') return packageValue;
    const current = globalThis.normalizeMemory(cloneMemoryValue(state.memory || {}));
    const delta =
      packageValue?.memoryDelta && typeof packageValue.memoryDelta === 'object'
        ? packageValue.memoryDelta
        : {};
    const chapter = Number(sourceChapter) || Number(packageValue?.chapterCard?.chapter) || 0;
    const foreshadows = {
      active: (current.foreshadows?.active || []).map(cloneMemoryValue),
      resolved: (current.foreshadows?.resolved || []).map(cloneMemoryValue),
    };
    const addForeshadow = (bucket, value) => {
      const identity = foreshadowIdentity(value);
      if (!identity) return;
      if (!foreshadows[bucket].some((item) => foreshadowIdentity(item) === identity))
        foreshadows[bucket].push(cloneMemoryValue(value));
    };
    for (const value of Array.isArray(delta.foreshadows?.added) ? delta.foreshadows.added : []) {
      const identity = foreshadowIdentity(value);
      if (!identity) continue;
      const resolvedIndex = foreshadows.resolved.findIndex((item) => foreshadowIdentity(item) === identity);
      if (resolvedIndex >= 0) foreshadows.resolved.splice(resolvedIndex, 1);
      addForeshadow('active', value);
    }
    for (const value of Array.isArray(delta.foreshadows?.resolved) ? delta.foreshadows.resolved : []) {
      const identity = foreshadowIdentity(value);
      if (!identity) continue;
      const activeIndex = foreshadows.active.findIndex((item) => foreshadowIdentity(item) === identity);
      const existing = activeIndex >= 0 ? foreshadows.active.splice(activeIndex, 1)[0] : null;
      const resolved =
        existing && value && typeof value === 'object'
          ? { ...cloneMemoryValue(existing), ...cloneMemoryValue(value) }
          : existing || value;
      addForeshadow('resolved', resolved);
    }
    const events = (Array.isArray(delta.importantEvents) ? delta.importantEvents : []).map((event) =>
      typeof event === 'string'
        ? { chapter, event }
        : { ...cloneMemoryValue(event || {}), chapter: Number(event?.chapter) || chapter },
    );
    const card =
      packageValue?.chapterCard && typeof packageValue.chapterCard === 'object'
        ? { ...cloneMemoryValue(packageValue.chapterCard), chapter, source: 'ai-summary-card' }
        : null;
    const candidate = {
      ...current,
      characters:
        delta.characters && typeof delta.characters === 'object' && !Array.isArray(delta.characters)
          ? cloneMemoryValue(delta.characters)
          : {},
      locations: Array.isArray(delta.locations) ? cloneMemoryValue(delta.locations) : [],
      factions: Array.isArray(delta.factions) ? cloneMemoryValue(delta.factions) : [],
      importantEvents: events,
      foreshadows,
      worldBuilding: Array.isArray(delta.worldBuilding) ? cloneMemoryValue(delta.worldBuilding) : [],
      chapterCards: card ? [card] : [],
    };
    return mergeAiMemoryWithCanon(candidate, chapter);
  };
  globalThis.mergeChapterMemoryPackageWithCanon = mergeChapterMemoryPackageWithCanon;

  const installMemoryCanonGuard = () => {
    const nativeMemoryApi = globalThis.apiStreamChatForAutoGen;
    if (typeof nativeMemoryApi === 'function' && !nativeMemoryApi.canonGuardWrapped) {
      const wrappedMemoryApi = async function (messages) {
        const result = await nativeMemoryApi.apply(this, arguments);
        const prompt = (messages || []).map((message) => String(message.content || '')).join('\n');
        if (!prompt.includes('生成章节记忆包') || !prompt.includes('本章正文全文')) return result;
        const match = prompt.match(/根据刚完成的第\s*(\d+)\s*章正文生成章节记忆包/);
        const text = String(result || '');
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start < 0 || end <= start) return result;
        try {
          const json = text.slice(start, end + 1);
          let parsed;
          try {
            parsed = JSON.parse(json);
          } catch {
            parsed = JSON.parse(json.replace(/,\s*([\]}])/g, '$1').replace(/'/g, '"'));
          }
          if (
            !parsed ||
            typeof parsed !== 'object' ||
            Array.isArray(parsed) ||
            !parsed.chapterCard ||
            !parsed.memoryDelta
          )
            return result;
          return JSON.stringify(mergeChapterMemoryPackageWithCanon(parsed, match?.[1]));
        } catch {
          return result;
        }
      };
      wrappedMemoryApi.canonGuardWrapped = true;
      globalThis.apiStreamChatForAutoGen = wrappedMemoryApi;
    }

    const nativeSaveChapterCard = globalThis.saveChapterSummaryCard;
    if (typeof nativeSaveChapterCard === 'function' && !nativeSaveChapterCard.canonGuardWrapped) {
      const wrappedSaveChapterCard = function (card) {
        const chapter = Number(card?.chapter);
        const key = 'chapterCard:' + chapter;
        const existing = (globalThis.normalizeMemory?.(state.memory || {}).chapterCards || []).find(
          (item) => Number(item.chapter) === chapter,
        );
        if (existing && memoryTrustStatus(key) === 'confirmed') {
          if (
            card?.source === 'ai-summary-card' &&
            memoryValueSignature(existing) !== memoryValueSignature(card)
          ) {
            addMemoryProposal({
              kind: 'chapter-card',
              key,
              title: '第 ' + chapter + ' 章记忆卡',
              chapter,
              current: existing,
              suggested: card,
            });
            Promise.resolve(globalThis.saveState?.()).catch((error) =>
              console.error('Unable to save confirmed memory proposal', error),
            );
            globalThis.renderMemoryViewer?.();
          }
          return existing;
        }
        return nativeSaveChapterCard.apply(this, arguments);
      };
      wrappedSaveChapterCard.canonGuardWrapped = true;
      globalThis.saveChapterSummaryCard = wrappedSaveChapterCard;
    }

    const nativeRenderMemory = globalThis.renderMemoryViewer;
    if (typeof nativeRenderMemory === 'function' && !nativeRenderMemory.proposalPanelWrapped) {
      const wrappedRenderMemory = function () {
        const result = nativeRenderMemory.apply(this, arguments);
        const root = document.getElementById('memoryViewer');
        if (!root) return result;
        const pending = memoryProposalList().filter((proposal) => proposal.status === 'pending');
        if (!pending.length) return result;
        const panel = document.createElement('section');
        panel.className = 'memory-proposal-panel';
        panel.setAttribute('aria-label', '待确认的 AI 记忆建议');
        const heading = document.createElement('header');
        const title = document.createElement('strong');
        title.textContent = 'AI 建议修改已确认资料';
        const count = document.createElement('span');
        count.textContent = pending.length + ' 条待确认';
        heading.append(title, count);
        panel.append(heading);

        for (const proposal of pending) {
          const card = document.createElement('article');
          card.className = 'memory-proposal-card';
          const cardTitle = document.createElement('strong');
          cardTitle.textContent = proposal.title || '记忆建议';
          card.append(cardTitle);
          const comparison = document.createElement('div');
          comparison.className = 'memory-proposal-comparison';
          for (const [label, value] of [
            ['当前确认', proposal.current],
            ['AI 建议', proposal.suggested],
          ]) {
            const column = document.createElement('div');
            const caption = document.createElement('span');
            caption.textContent = label;
            const content = document.createElement('pre');
            content.textContent = typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2);
            column.append(caption, content);
            comparison.append(column);
          }
          card.append(comparison);
          const actions = document.createElement('div');
          actions.className = 'memory-proposal-actions';
          for (const [action, label] of [
            ['accept', '对比后采用'],
            ['ignore', '忽略'],
          ]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = action === 'accept' ? 'btn btn-sm btn-primary' : 'btn btn-sm btn-ghost';
            button.dataset.memoryProposalAction = action;
            button.dataset.memoryProposalId = proposal.id;
            button.textContent = label;
            actions.append(button);
          }
          card.append(actions);
          panel.append(card);
        }
        root.prepend(panel);
        return result;
      };
      wrappedRenderMemory.proposalPanelWrapped = true;
      globalThis.renderMemoryViewer = wrappedRenderMemory;
    }

    document.addEventListener('click', async (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const button = target?.closest('[data-memory-proposal-action]');
      if (!button) return;
      const proposals = memoryProposalList();
      const proposal = proposals.find(
        (item) => item.id === button.dataset.memoryProposalId && item.status === 'pending',
      );
      if (!proposal) return;
      button.disabled = true;
      try {
        if (button.dataset.memoryProposalAction === 'accept') {
          const memory = globalThis.normalizeMemory?.(state.memory || {}) || state.memory;
          if (proposal.kind === 'character') {
            const name = proposal.key.slice('character:'.length);
            memory.characters[name] = cloneMemoryValue(proposal.suggested);
          } else if (proposal.kind === 'chapter-card') {
            globalThis.upsertChapterCard?.(memory, cloneMemoryValue(proposal.suggested));
          } else if (proposal.kind === 'foreshadow-state') {
            const current = proposal.current || {};
            const suggested = proposal.suggested || {};
            state.memoryTrust = state.memoryTrust || {};
            const sameItem = (item) => memoryValueSignature(item) === memoryValueSignature(current.item);
            memory.foreshadows[current.bucket] = (memory.foreshadows[current.bucket] || []).filter(
              (item) => !sameItem(item),
            );
            memory.foreshadows[suggested.bucket] = memory.foreshadows[suggested.bucket] || [];
            if (!memory.foreshadows[suggested.bucket].some((item) => sameItem(item)))
              memory.foreshadows[suggested.bucket].push(cloneMemoryValue(suggested.item));
            delete state.memoryTrust[proposal.key];
            const nextKey =
              'foreshadow:' + suggested.bucket + ':' + hashMemoryValue(memoryEntryText(suggested.item));
            state.memoryTrust[nextKey] = { status: 'confirmed', updatedAt: new Date().toISOString() };
          }
          state.memory = globalThis.rebuildMemoryIndexes?.(memory) || memory;
          state.memoryTrust = state.memoryTrust || {};
          if (proposal.kind !== 'foreshadow-state')
            state.memoryTrust[proposal.key] = { status: 'confirmed', updatedAt: new Date().toISOString() };
          proposal.status = 'accepted';
        } else proposal.status = 'ignored';
        proposal.decidedAt = Date.now();
        const saved = await Store.save();
        if (saved?.ok === false) throw new Error(saved.error?.message || '保存失败');
        globalThis.renderMemoryViewer?.();
        if (typeof toast === 'function')
          toast(proposal.status === 'accepted' ? 'AI 建议已采用，资料保持作者确认' : '已忽略这条 AI 建议');
      } catch (error) {
        button.disabled = false;
        if (typeof toast === 'function') toast('记忆建议处理失败：' + error.message);
      }
    });
  };
  installMemoryCanonGuard();

  const buildInspirationWritingContext = (target) => {
    if (!['outline', 'chapter', 'continue', 'review'].includes(target)) return '';
    const writer = state.uiDrafts?.inspirationWriter;
    if (!writer) return '';
    const seed = target === 'outline' ? writer.seed : (writer.builtSeed ?? writer.seed);
    const additions = Array.isArray(writer.additions)
      ? writer.additions.filter((item) => item && typeof item.text === 'string' && item.text.trim())
      : [];
    const adopted = additions.filter((item) => item.planned);
    const pending = target === 'outline' ? additions.filter((item) => !item.planned) : [];
    const sections = [
      typeof seed === 'string' && seed.trim() ? `作者原始灵感：\n${seed.trim()}` : '',
      adopted.length ? `已采用的作者追加灵感：\n${adopted.map((item) => item.text).join('\n')}` : '',
      pending.length ? `本次待融入的作者灵感：\n${pending.map((item) => item.text).join('\n')}` : '',
    ].filter(Boolean);
    return sections.length
      ? `【作者灵感与创作意图】\n${sections.join('\n\n')}\n这些是作者意图与未发生的计划，不是已发生的正史。按目标章节推进，不提前兑现未来情节，不让视角人物预知未来。已写正文与作者确认设定优先；有矛盾时保留既有事实并指出冲突，不回改正文。`
      : '';
  };
  const originalExtraContext = buildExtraWritingContext;
  buildExtraWritingContext = function (target) {
    const original = originalExtraContext(target);
    const bible = getBiblePromptText(target, original);
    const styleSample = buildRecentProseStyleContext(target);
    const sceneQuality = buildSceneQualityContext(target);
    const inspiration = buildInspirationWritingContext(target);
    const nextChapterHandoff = buildNextChapterHandoffContext(
      writingContextPurpose === 'ending' ? 'chapter' : target,
    );
    return [original, bible, styleSample, sceneQuality, nextChapterHandoff, inspiration]
      .filter(Boolean)
      .join('\n\n');
  };

  const nativeGenerateEnding = globalThis.generateEnding;
  if (typeof nativeGenerateEnding === 'function' && !nativeGenerateEnding.endingHandoffWrapped) {
    const wrappedGenerateEnding = function (...args) {
      const previousPurpose = writingContextPurpose;
      writingContextPurpose = 'ending';
      try {
        return nativeGenerateEnding.apply(this, args);
      } finally {
        writingContextPurpose = previousPurpose;
      }
    };
    wrappedGenerateEnding.endingHandoffWrapped = true;
    globalThis.generateEnding = wrappedGenerateEnding;
  }

  if (typeof EDITOR_AGENT_PROMPTS === 'object') {
    EDITOR_AGENT_PROMPTS.normal +=
      '\n执行分析与修改时，必须优先遵守长期记忆中的 structuredStoryBible 人物与地点资料。';
    EDITOR_AGENT_PROMPTS.long +=
      '\n执行分析与修改时，必须优先遵守长期记忆中的 structuredStoryBible 人物与地点资料。';
  }

  // The original list truncated summaries twice (200 characters and a two-line clamp).
  // Keep scanning fast, but expose the complete generated outline in an expandable card.
  globalThis.renderOutline = function () {
    const container = document.getElementById('outlineContainer');
    if (!container) return;
    if (!state.outline?.length) {
      container.innerHTML =
        '<div class="outline-empty"><div>◇</div><p>尚未生成大纲</p><span>先完善项目设定，再点击“生成大纲”</span></div>';
      return;
    }
    container.innerHTML = `<div class="outline-reading-toolbar"><span>共 ${state.outline.length} 章 · 点击章节展开完整内容</span><div><button class="btn btn-sm btn-ghost" type="button" data-outline-expand="all">全部展开</button><button class="btn btn-sm btn-ghost" type="button" data-outline-expand="none">全部收起</button></div></div><div class="outline-list">${state.outline
      .map((chapter, index) => {
        const points = Array.isArray(chapter.plotPoints) ? chapter.plotPoints : [];
        const summary = String(chapter.summary || '暂无内容概要');
        return `<details class="outline-item">
          <summary class="outline-chapter-head">
            <span class="ch-num">#${escapeHtml(String(chapter.chapter))}</span>
            <span class="ch-title">${escapeHtml(chapter.title || `第${chapter.chapter}章`)}</span>
            <span class="outline-point-count">${points.length} 个剧情点</span>
            <span class="outline-chevron">›</span>
          </summary>
          <div class="outline-chapter-body">
            <section class="outline-full-summary"><strong>章节概要</strong><p>${escapeHtml(summary)}</p></section>
            <section class="outline-full-points"><strong>剧情关键点</strong>
              ${
                points.length
                  ? `<ol>${points
                      .map(
                        (point, pointIndex) =>
                          `<li><span>${escapeHtml(String(point?.desc ?? point ?? ''))}</span><span class="outline-point-actions"><button class="btn btn-sm btn-ghost" type="button" onclick="event.stopPropagation();editPlotPoint(${index},${pointIndex})">编辑</button><button class="btn btn-sm btn-ghost" type="button" onclick="event.stopPropagation();deletePlotPoint(${index},${pointIndex})">删除</button></span></li>`,
                      )
                      .join('')}</ol>`
                  : '<p class="outline-muted">暂无剧情关键点</p>'
              }
            </section>
            <div class="outline-card-actions"><button class="btn btn-sm" type="button" onclick="event.stopPropagation();editOutlineChapter(${index})">编辑标题与概要</button><button class="btn btn-sm" type="button" onclick="event.stopPropagation();addPlotPoint(${index})">添加关键点</button><button class="btn btn-sm btn-ghost outline-delete" type="button" onclick="event.stopPropagation();deleteOutlineChapter(${index})">删除本章</button></div>
          </div>
        </details>`;
      })
      .join('')}</div>`;
    container.querySelector('[data-outline-expand="all"]')?.addEventListener('click', () => {
      container.querySelectorAll('details.outline-item').forEach((item) => (item.open = true));
    });
    container.querySelector('[data-outline-expand="none"]')?.addEventListener('click', () => {
      container.querySelectorAll('details.outline-item').forEach((item) => (item.open = false));
    });
  };

  const compactWorkbenchActions = () => {
    const headerActions = document.querySelector('.header-actions');
    if (headerActions && !headerActions.querySelector('.workbench-more')) {
      const details = document.createElement('details');
      details.className = 'workbench-more';
      details.innerHTML = '<summary>工具</summary><div class="workbench-more-menu"></div>';
      const menu = details.querySelector('.workbench-more-menu');
      [...headerActions.querySelectorAll('button')].forEach((control) => menu.append(control));
      headerActions.append(details);
    }
    const outlineHeader = document.querySelector('#tab-outline .card > .flex');
    const outlineActions = outlineHeader?.querySelector('.flex');
    if (outlineActions && !outlineActions.querySelector('.outline-more')) {
      const lowFrequency = [...outlineActions.querySelectorAll('button')].filter((control) =>
        /导入大纲|导出大纲|清空/.test(control.textContent || ''),
      );
      const details = document.createElement('details');
      details.className = 'outline-more';
      details.innerHTML = '<summary>更多</summary><div class="outline-more-menu"></div>';
      const menu = details.querySelector('.outline-more-menu');
      lowFrequency.forEach((control) => menu.append(control));
      outlineActions.append(details);
    }
  };

  const renderBiblePanel = (changes) => {
    ensureBibleBatchSelection();
    const groups = [
      ['character', '人物', storyBibleBundle.characters || [], 'characters'],
      ['location', '地点', storyBibleBundle.locations || [], 'locations'],
      ['item', '物品', storyBibleBundle.items || [], 'items'],
      ['organization', '组织', storyBibleBundle.organizations || [], 'organizations'],
    ];
    const totalEntities = groups.reduce((sum, group) => sum + group[2].length, 0);
    const count = document.getElementById('workbenchBibleCount');
    if (count)
      count.textContent = `${totalEntities} 条资料 · ${storyBibleBundle.relations?.length || 0} 条关系`;
    const changeSummary = document.getElementById('workbenchBibleChanges');
    if (changeSummary && changes) {
      const total = (kind) =>
        `${kind.created || 0} 新增 / ${kind.updated || 0} 更新 / ${kind.protected || 0} 人工保护`;
      changeSummary.textContent = groups
        .map(([, label, , key]) => `${label}：${total(changes[key] || {})}`)
        .join('；');
      changeSummary.hidden = false;
    }
    const query = String(document.getElementById('workbenchBibleSearch')?.value || '')
      .trim()
      .toLowerCase();
    const renderCards = (items, type) => {
      const filtered = items.filter((item) => !query || JSON.stringify(item).toLowerCase().includes(query));
      return filtered.length
        ? filtered
            .map((item) => {
              const detailFields = {
                character: [item.role, item.personality, item.goals, item.currentStatus],
                location: [item.type, item.description, item.currentStatus],
                item: [item.type, item.description, item.owner, item.abilities, item.currentStatus],
                organization: [item.type, item.description, item.purpose, item.leaders, item.currentStatus],
              };
              const detail = detailFields[type].filter(Boolean).join(' · ');
              const tags = (item.tags || [])
                .map((tag) => `<span class="bible-tag">#${escapeHtml(tag)}</span>`)
                .join('');
              const custom = Object.entries(item.customFields || {})
                .map(
                  ([key, value]) =>
                    `<span class="bible-custom"><b>${escapeHtml(key)}</b> ${escapeHtml(String(value))}</span>`,
                )
                .join('');
              const evidence = item.evidence
                ? `<small class="bible-evidence">依据：${escapeHtml(String(item.evidence))}</small>`
                : '';
              const selected = bibleSelection[type]?.has(item.id);
              const selector = bibleBatchMode
                ? `<label class="workbench-bible-select"><input type="checkbox" data-bible-select data-select-type="${type}" data-select-id="${escapeHtml(item.id)}" ${selected ? 'checked' : ''}><span aria-hidden="true"></span></label>`
                : '';
              return `<article class="workbench-bible-card ${selected ? 'is-selected' : ''}" data-entity-type="${type}"><div class="workbench-bible-card-head"><div>${selector}<strong>${escapeHtml(item.name || '未命名')}</strong><span class="bible-trust ${item.trust === 'auto' ? 'auto' : 'manual'}">${bibleTrustLabel(item)}</span></div><div class="workbench-bible-card-actions"><button class="btn btn-sm btn-ghost" type="button" data-bible-edit="${type}" data-bible-id="${item.id}">编辑</button>${item.trust === 'auto' ? `<button class="btn btn-sm btn-ghost" type="button" data-bible-confirm="${type}" data-bible-id="${item.id}">确认</button>` : ''}<button class="btn btn-sm btn-ghost danger-text" type="button" data-bible-delete="${type}" data-bible-id="${item.id}">删除</button></div></div><p>${escapeHtml(detail || item.notes || '暂无详细资料')}</p>${evidence}${tags || custom ? `<footer>${tags}${custom}</footer>` : ''}</article>`;
            })
            .join('')
        : `<div class="workbench-bible-empty"><p>当前分类没有匹配的资料</p><button class="btn btn-sm" type="button" data-bible-add="${type}">＋ 新增${bibleEntityConfig[type].label}</button></div>`;
    };
    document.querySelectorAll('.bible-category-button').forEach((button) => {
      const type = button.dataset.category;
      const group = groups.find(([groupType]) => groupType === type);
      const amount = type === 'relation' ? storyBibleBundle.relations?.length || 0 : group?.[2].length || 0;
      button.classList.toggle('active', type === bibleCategory);
      button.querySelector('span')?.replaceChildren(document.createTextNode(String(amount)));
    });
    const names = new Map(
      groups.flatMap(([, label, items]) => items.map((item) => [item.id, `${label} · ${item.name}`])),
    );
    const activeGroup = groups.find(([type]) => type === bibleCategory);
    const content = document.getElementById('workbenchBibleContent');
    const title = document.getElementById('workbenchBibleCategoryTitle');
    const add = document.getElementById('workbenchBibleAdd');
    if (!content || !title) return;
    if (bibleCategory === 'relation') {
      title.textContent = '关系';
      if (add) add.textContent = '＋ 新增关系';
      content.classList.add('relation-view');
      const relations = (storyBibleBundle.relations || []).filter(
        (relation) =>
          !query ||
          `${names.get(relation.sourceId)} ${relation.label} ${names.get(relation.targetId)} ${relation.description}`
            .toLowerCase()
            .includes(query),
      );
      content.innerHTML = relations.length
        ? relations
            .map(
              (relation) =>
                `<article class="workbench-relation ${bibleSelection.relation.has(relation.id) ? 'is-selected' : ''}"><div class="workbench-relation-main">${bibleBatchMode ? `<label class="workbench-bible-select"><input type="checkbox" data-bible-select data-select-type="relation" data-select-id="${escapeHtml(relation.id)}" ${bibleSelection.relation.has(relation.id) ? 'checked' : ''}><span aria-hidden="true"></span></label>` : ''}<span>${escapeHtml(names.get(relation.sourceId) || '未知')}</span><strong>${escapeHtml(relation.label)}</strong><span>${escapeHtml(names.get(relation.targetId) || '未知')}</span></div>${relation.description || relation.tags?.length ? `<small>${escapeHtml(relation.description || '')}${relation.tags?.length ? ` · #${relation.tags.map(escapeHtml).join(' #')}` : ''}</small>` : ''}<footer class="workbench-bible-card-actions"><span class="bible-trust ${relation.trust === 'auto' ? 'auto' : 'manual'}">${bibleTrustLabel(relation)}</span><button class="btn btn-sm btn-ghost" type="button" data-bible-edit-relation="${relation.id}">编辑</button>${relation.trust === 'auto' ? `<button class="btn btn-sm btn-ghost" type="button" data-bible-confirm-relation="${relation.id}">确认</button>` : ''}<button class="btn btn-sm btn-ghost danger-text" type="button" data-bible-delete-relation="${relation.id}">删除</button></footer></article>`,
            )
            .join('')
        : '<div class="workbench-bible-empty"><p>尚无结构化关系</p><button class="btn btn-sm" type="button" data-bible-add="relation">＋ 新增关系</button></div>';
    } else if (activeGroup) {
      title.textContent = activeGroup[1];
      if (add) add.textContent = `＋ 新增${activeGroup[1]}`;
      content.classList.remove('relation-view');
      content.innerHTML = renderCards(activeGroup[2], activeGroup[0]);
    }
    updateBibleBatchBar();
  };

  const updateBibleProgress = (event, startedAt) => {
    const progress = document.getElementById('workbenchBibleProgress');
    const message = document.getElementById('workbenchBibleProgressMessage');
    const meta = document.getElementById('workbenchBibleProgressMeta');
    const fill = document.getElementById('workbenchBibleProgressFill');
    if (!progress || !message || !meta || !fill) return;
    progress.hidden = false;
    message.textContent = event.message || '正在整理';
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    if (event.stage === 'preparing') {
      fill.style.width = '18%';
      meta.textContent = `已读取 ${Number(event.sourceChars || 0).toLocaleString()} 字 · ${event.chapters || 0} 章 · 已等待 ${elapsed} 秒`;
    } else if (event.stage === 'extracting') {
      fill.style.width = `${Math.min(78, 30 + Number(event.receivedChars || 0) / 100)}%`;
      meta.textContent = `模型已返回 ${Number(event.receivedChars || 0).toLocaleString()} 字 · 已等待 ${elapsed} 秒`;
      const preview = document.getElementById('workbenchBibleStreamPreview');
      if (preview && event.preview) {
        preview.hidden = false;
        preview.textContent = String(event.preview).slice(-1400);
      }
    } else if (event.stage === 'merging') {
      fill.style.width = '90%';
      meta.textContent = `识别到 人物 ${event.detectedCharacters || 0} · 地点 ${event.detectedLocations || 0} · 物品 ${event.detectedItems || 0} · 组织 ${event.detectedOrganizations || 0} · 关系 ${event.detectedRelations || 0} · 已等待 ${elapsed} 秒`;
    } else if (event.stage === 'retrying') {
      fill.style.width = '82%';
      meta.textContent = `首轮只返回了 ${event.reasoningChars || 0} 字推理${event.finishReason ? ` · 结束原因 ${event.finishReason}` : ''} · 已等待 ${elapsed} 秒`;
    } else if (event.stage === 'rebasing') {
      fill.style.width = '94%';
      meta.textContent = `检测到 v${event.fromRevision} → v${event.ontoRevision} 的新保存，正在安全重放索引 · 已等待 ${elapsed} 秒`;
    } else if (event.stage === 'done') {
      fill.style.width = '100%';
      meta.textContent = `整理完成 · 用时 ${elapsed} 秒`;
      const preview = document.getElementById('workbenchBibleStreamPreview');
      if (preview) preview.hidden = true;
    } else if (event.stage === 'error') {
      progress.classList.add('error');
      meta.textContent = `失败 · 已等待 ${elapsed} 秒`;
    }
  };

  const generateBible = async (button) => {
    button.disabled = true;
    button.textContent = '正在整理…';
    const startedAt = Date.now();
    const progress = document.getElementById('workbenchBibleProgress');
    progress?.classList.remove('error');
    let latestProgress = { stage: 'preparing', message: '正在保存当前项目并准备资料…' };
    const showProgress = (event) => {
      latestProgress = event;
      updateBibleProgress(event, startedAt);
    };
    showProgress(latestProgress);
    const timer = window.setInterval(() => updateBibleProgress(latestProgress, startedAt), 1000);
    try {
      await Store.save();
      const response = await fetch(`/api/projects/${projectId}/story-bible/generate-stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedRevision: revision }),
      });
      if (!response.ok || !response.body) throw new Error(`无法启动整理（HTTP ${response.status}）`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let result = null;
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const lines = buffer.split(/\r?\n/);
        buffer = done ? '' : lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          showProgress(event);
          if (event.stage === 'error') throw new Error(event.message || 'AI 资料整理失败');
          if (event.stage === 'done') result = event.result;
        }
        if (done) break;
      }
      if (!result) throw new Error('整理连接已结束，但没有收到最终结果');
      syncStoryBibleState(result, result.changes);
      if (typeof toast === 'function')
        toast(
          `资料库已更新：${result.characters.length} 人物、${result.locations.length} 地点、${result.items.length} 物品、${result.organizations.length} 组织`,
        );
    } catch (error) {
      showProgress({ stage: 'error', message: error.message || 'AI 资料整理失败' });
      if (typeof toast === 'function') toast(error.message || 'AI 资料整理失败');
    } finally {
      window.clearInterval(timer);
      button.disabled = false;
      button.textContent = '用 AI 更新结构化索引';
    }
  };

  const ensureDetailedPOVRules = () => {
    const rules = (state.creativeRules ||= {});
    const legacy = rules.narrativePOV || '';
    if (typeof rules.detailedPOVEnabled !== 'boolean') rules.detailedPOVEnabled = !!legacy;
    if (!['first', 'third'].includes(rules.narrativePerson))
      rules.narrativePerson = legacy === 'first-person' ? 'first' : 'third';
    if (!['single', 'multi', 'omniscient'].includes(rules.povMode))
      rules.povMode =
        legacy === 'third-omniscient' ? 'omniscient' : legacy === 'multi-pov' ? 'multi' : 'single';
    if (!Array.isArray(rules.povCharacters)) rules.povCharacters = [];
    if (!['chapter', 'scene', 'manual'].includes(rules.povSwitchRule)) rules.povSwitchRule = 'chapter';
    if (!rules.chapterPOVOverrides || typeof rules.chapterPOVOverrides !== 'object')
      rules.chapterPOVOverrides = {};
    if (typeof rules.povCustomRule !== 'string') rules.povCustomRule = '';
    return rules;
  };

  const syncLegacyPOV = (rules) => {
    rules.narrativePOV =
      rules.povMode === 'omniscient'
        ? 'third-omniscient'
        : rules.povMode === 'multi'
          ? 'multi-pov'
          : rules.narrativePerson === 'first'
            ? 'first-person'
            : 'third-limited';
    rules.narrativePOVUserSet = true;
    rules.narrativePerspective = '';
  };

  const povLibraryCandidates = () => {
    return [
      ...new Set([
        ...(storyBibleBundle.characters || []).map((item) => String(item.name || '').trim()),
        ...Object.keys(state.memory?.characters || {}),
      ]),
    ].filter(Boolean);
  };

  const saveDetailedPOV = () => {
    const rules = ensureDetailedPOVRules();
    rules.detailedPOVEnabled = true;
    syncLegacyPOV(rules);
    refreshPOVUI();
    Store.save();
  };

  const installDetailedPOV = () => {
    const oldSection = document.getElementById('povGrid')?.closest('.rules-section');
    if (!oldSection) return;
    const panel = document.createElement('section');
    panel.className = 'rules-section detailed-pov-panel';
    panel.innerHTML = `<div class="detailed-pov-head"><div><div class="rules-section-title">叙事人称与角色视角</div><p>视角规则由作者直接指定，是大纲和资料库的上游约束；资料库只提供候选人物，不会反向修改规则。</p></div><div class="detailed-pov-status"><span id="detailedPOVSummary"></span><button id="povDisableRules" class="btn btn-sm btn-ghost" type="button">清除规则</button></div></div><div class="pov-authority-flow"><strong>作者视角规则</strong><i>→</i><span>章节大纲</span><i>→</i><span>AI 资料索引</span><em>单向生效</em></div>
      <div class="detailed-pov-grid"><section><label>叙事人称</label><div class="pov-segmented"><button type="button" data-person="first">第一人称</button><button type="button" data-person="third">第三人称</button></div><p>控制代词与叙述方式，不决定具体跟随谁。</p></section><section><label>视角模式</label><div class="pov-mode-grid"><button type="button" data-pov-mode="single"><strong>单角色有限</strong><span>只呈现一个角色可感知的信息</span></button><button type="button" data-pov-mode="multi"><strong>多角色轮换</strong><span>在指定角色之间按规则切换</span></button><button type="button" data-pov-mode="omniscient"><strong>全知视角</strong><span>叙述者可以超越单一角色认知</span></button></div></section></div>
      <section id="povCharacterSection" class="pov-character-section"><div><label>作者指定的视角角色</label><span id="povCharacterHint"></span></div><div id="povCharacterChoices" class="pov-character-choices"></div><div class="pov-add-character"><input id="povManualCharacter" placeholder="直接输入角色名，不依赖资料库"><button class="btn btn-sm" id="povAddCharacter" type="button">添加角色</button></div><div class="pov-library-suggestions"><strong>资料库候选</strong><span>仅供快捷添加，不会自动进入视角规则</span><div id="povLibrarySuggestions"></div></div></section>
      <section id="povSwitchSection" class="pov-switch-section"><label>多视角切换规则</label><div class="pov-switch-row"><select id="povSwitchRule"><option value="chapter">按章切换：一章只跟随一个角色</option><option value="scene">按场景切换：只在明确场景边界切换</option><option value="manual">自定义切换规则</option></select><input id="povCustomRule" placeholder="例如：奇数章林尘，偶数章苏璃；同场景不切换"></div></section>
      <details class="pov-chapter-overrides"><summary>章节视角覆盖 <span id="povOverrideCount">0</span></summary><p>可为特定章节覆盖全书默认视角。正文生成、续写和审稿都会优先采用这里的角色。</p><div class="pov-override-add"><input id="povOverrideChapter" type="number" min="1" placeholder="章节号"><input id="povOverrideCharacters" placeholder="角色名；多人用逗号分隔"><button class="btn btn-sm" id="povAddOverride" type="button">添加覆盖</button></div><div id="povOverrideList"></div></details>`;
    oldSection.replaceWith(panel);

    const render = () => {
      const rules = ensureDetailedPOVRules();
      panel
        .querySelectorAll('[data-person]')
        .forEach((button) =>
          button.classList.toggle(
            'active',
            rules.detailedPOVEnabled && button.dataset.person === rules.narrativePerson,
          ),
        );
      panel
        .querySelectorAll('[data-pov-mode]')
        .forEach((button) =>
          button.classList.toggle(
            'active',
            rules.detailedPOVEnabled && button.dataset.povMode === rules.povMode,
          ),
        );
      const characterSection = panel.querySelector('#povCharacterSection');
      characterSection.hidden = rules.povMode === 'omniscient';
      panel.querySelector('#povCharacterHint').textContent =
        rules.povMode === 'single' ? '只能选择一个角色' : '可以选择多个角色';
      const choices = panel.querySelector('#povCharacterChoices');
      choices.innerHTML = rules.povCharacters.length
        ? rules.povCharacters
            .map(
              (name) =>
                `<span class="pov-selected-character">${escapeHtml(name)}<button type="button" data-remove-pov-character="${escapeHtml(name)}" aria-label="移除 ${escapeHtml(name)}">×</button></span>`,
            )
            .join('')
        : '<p class="pov-empty">尚未指定。可以直接输入角色名，不需要先生成大纲或整理资料库。</p>';
      const candidates = povLibraryCandidates().filter((name) => !rules.povCharacters.includes(name));
      const suggestions = panel.querySelector('#povLibrarySuggestions');
      suggestions.innerHTML = candidates.length
        ? candidates
            .map(
              (name) =>
                `<button class="btn btn-sm btn-ghost" type="button" data-add-pov-candidate="${escapeHtml(name)}">＋ ${escapeHtml(name)}</button>`,
            )
            .join('')
        : '<small>暂无新的候选人物</small>';
      panel.querySelector('#povSwitchSection').hidden = rules.povMode !== 'multi';
      panel.querySelector('#povSwitchRule').value = rules.povSwitchRule;
      panel.querySelector('#povCustomRule').value = rules.povCustomRule;
      panel.querySelector('#povCustomRule').hidden = rules.povSwitchRule !== 'manual';
      const overrides = Object.entries(rules.chapterPOVOverrides).sort(
        ([left], [right]) => Number(left) - Number(right),
      );
      panel.querySelector('#povOverrideCount').textContent = String(overrides.length);
      panel.querySelector('#povOverrideList').innerHTML = overrides.length
        ? overrides
            .map(
              ([chapter, characters]) =>
                `<div class="pov-override-row"><strong>第 ${escapeHtml(chapter)} 章</strong><span>${escapeHtml((Array.isArray(characters) ? characters : [characters]).join('、'))}</span><button class="btn btn-sm btn-ghost" type="button" data-delete-pov-override="${escapeHtml(chapter)}">删除</button></div>`,
            )
            .join('')
        : '<p class="pov-empty">未设置章节覆盖，全部章节遵循上方规则。</p>';
      const person = rules.narrativePerson === 'first' ? '第一人称' : '第三人称';
      const mode =
        rules.povMode === 'single' ? '单角色有限' : rules.povMode === 'multi' ? '多角色轮换' : '全知';
      panel.querySelector('#detailedPOVSummary').textContent = !rules.detailedPOVEnabled
        ? '未配置 · 点击选项启用'
        : rules.povMode === 'omniscient'
          ? `${person} · ${mode}`
          : `${person} · ${mode}${rules.povCharacters.length ? ` · ${rules.povCharacters.join(' / ')}` : ' · 未指定角色'}`;
      choices.querySelectorAll('[data-remove-pov-character]').forEach((button) => {
        button.addEventListener('click', () => {
          rules.povCharacters = rules.povCharacters.filter(
            (name) => name !== button.dataset.removePovCharacter,
          );
          saveDetailedPOV();
        });
      });
      suggestions.querySelectorAll('[data-add-pov-candidate]').forEach((button) => {
        button.addEventListener('click', () => {
          const name = button.dataset.addPovCandidate;
          rules.povCharacters =
            rules.povMode === 'single' ? [name] : [...new Set([...rules.povCharacters, name])];
          saveDetailedPOV();
        });
      });
      panel.querySelectorAll('[data-delete-pov-override]').forEach((button) => {
        button.addEventListener('click', () => {
          delete rules.chapterPOVOverrides[button.dataset.deletePovOverride];
          saveDetailedPOV();
        });
      });
    };

    panel.querySelectorAll('[data-person]').forEach((button) => {
      button.addEventListener('click', () => {
        ensureDetailedPOVRules().narrativePerson = button.dataset.person;
        saveDetailedPOV();
      });
    });
    panel.querySelector('#povDisableRules').addEventListener('click', () => {
      const rules = ensureDetailedPOVRules();
      rules.detailedPOVEnabled = false;
      rules.povCharacters = [];
      rules.chapterPOVOverrides = {};
      rules.narrativePOV = '';
      rules.narrativePOVUserSet = false;
      refreshPOVUI();
      Store.save();
    });
    panel.querySelectorAll('[data-pov-mode]').forEach((button) => {
      button.addEventListener('click', () => {
        const rules = ensureDetailedPOVRules();
        rules.povMode = button.dataset.povMode;
        if (rules.povMode === 'single' && rules.povCharacters.length > 1)
          rules.povCharacters = rules.povCharacters.slice(0, 1);
        saveDetailedPOV();
      });
    });
    panel.querySelector('#povAddCharacter').addEventListener('click', () => {
      const input = panel.querySelector('#povManualCharacter');
      const name = input.value.trim();
      if (!name) return;
      const rules = ensureDetailedPOVRules();
      rules.povCharacters =
        rules.povMode === 'single' ? [name] : [...new Set([...rules.povCharacters, name])];
      input.value = '';
      saveDetailedPOV();
    });
    panel.querySelector('#povSwitchRule').addEventListener('change', (event) => {
      ensureDetailedPOVRules().povSwitchRule = event.target.value;
      saveDetailedPOV();
    });
    panel.querySelector('#povCustomRule').addEventListener('change', (event) => {
      ensureDetailedPOVRules().povCustomRule = event.target.value.trim();
      saveDetailedPOV();
    });
    panel.querySelector('#povAddOverride').addEventListener('click', () => {
      const chapter = Number(panel.querySelector('#povOverrideChapter').value);
      const names = panel
        .querySelector('#povOverrideCharacters')
        .value.split(/[,，、]/)
        .map((name) => name.trim())
        .filter(Boolean);
      if (!Number.isInteger(chapter) || chapter < 1 || !names.length) {
        if (typeof toast === 'function') toast('请填写章节号和至少一个视角角色');
        return;
      }
      ensureDetailedPOVRules().chapterPOVOverrides[String(chapter)] = names;
      panel.querySelector('#povOverrideChapter').value = '';
      panel.querySelector('#povOverrideCharacters').value = '';
      saveDetailedPOV();
    });
    refreshPOVUI = render;
    render();
  };

  const originalCreativeRulesContext = globalThis.buildCreativeRulesContext;
  globalThis.buildCreativeRulesContext = function (target) {
    const original = originalCreativeRulesContext(target);
    const rules = ensureDetailedPOVRules();
    if (!rules.detailedPOVEnabled) return original;
    const person = rules.narrativePerson === 'first' ? '第一人称' : '第三人称';
    const selected = rules.povCharacters.join('、');
    const chapterOverride = rules.chapterPOVOverrides?.[String(state.currentChapter || '')];
    const activeCharacters = chapterOverride?.length ? chapterOverride.join('、') : selected;
    const lines = [
      '【精确叙事视角约束｜作者权威规则】',
      '本规则是大纲与资料库的上游约束。不得因为大纲内容、AI 记忆或资料库出现其他人物而自行更换视角角色。',
      `叙事人称：${person}`,
    ];
    if (rules.povMode === 'omniscient') {
      lines.push('视角模式：全知视角。叙述者可以提供超出单一角色认知的信息，但仍应保持场景焦点稳定。');
    } else if (rules.povMode === 'single') {
      lines.push(`视角模式：单角色有限；视角角色：${activeCharacters || '尚未指定'}`);
      lines.push('只能描写该视角角色能够观察、回忆、推断或感受到的信息；不得直接进入其他角色内心。');
    } else {
      lines.push(`视角模式：多角色轮换；允许的视角角色：${activeCharacters || '尚未指定'}`);
      if (rules.povSwitchRule === 'chapter')
        lines.push('切换规则：按章切换；同一章节只允许一个视角角色，章节内部不得跳头。');
      else if (rules.povSwitchRule === 'scene')
        lines.push('切换规则：只允许在明确的场景边界切换，单个场景内不得跳头。');
      else lines.push(`切换规则：${rules.povCustomRule || '遵循作者的手动安排，未明确时不得自行切换。'}`);
    }
    if (chapterOverride?.length)
      lines.push(`第 ${state.currentChapter} 章覆盖规则：本章使用 ${chapterOverride.join('、')} 的视角。`);
    const overrides = Object.entries(rules.chapterPOVOverrides || {});
    if (target === 'outline' && overrides.length)
      lines.push(
        `章节视角安排：${overrides.map(([chapter, names]) => `第${chapter}章=${names.join('、')}`).join('；')}`,
      );
    lines.push('生成后检查人称代词、认知边界和视角切换，发现越界时必须修正。');
    return `${original || ''}\n\n${lines.join('\n')}`;
  };

  const installBiblePanel = () => {
    const tabBar = document.getElementById('tabBar');
    const entry = document.createElement('button');
    entry.type = 'button';
    entry.className = 'tab-btn';
    entry.id = 'workbenchBibleTab';
    entry.dataset.tab = 'service-bible';
    entry.textContent = '🗂️ 资料库';
    entry.onclick = () => {
      globalThis.switchTab('service-bible');
      renderBiblePanel();
    };
    const writeTab = tabBar?.querySelector('[data-tab="write"]');
    tabBar?.insertBefore(entry, writeTab || null);

    const page = document.createElement('div');
    page.id = 'tab-service-bible';
    page.className = 'tab-content workbench-bible-page';
    page.style.display = 'none';
    page.innerHTML = `<div class="workbench-bible-page-head"><div><span class="eyebrow">STORY BIBLE</span><h2>小说资料库</h2><p>先写自然的设定原文，再让 AI 把它和长期记忆整理成可检索的知识索引。</p></div><a class="btn" href="/?project=${encodeURIComponent(projectId)}&tab=bible">详细编辑</a></div>
      <section class="workbench-bible-freeform"><div><strong>人物与设定原文</strong><span>这里是主要输入区。可以像写笔记一样记录人物、世界规则、势力、物品和临时想法。</span></div><textarea id="workbenchBibleFreeText" rows="10" placeholder="人物、世界观、势力、关键物品、规则……可以直接自由书写，不需要先填表。"></textarea><button id="workbenchBibleSaveText" class="btn btn-primary" type="button">保存原文</button></section>
      <section class="workbench-bible-ai"><div class="workbench-bible-ai-head"><div><strong>AI 结构化索引</strong><span>AI 只提取已有事实，优先少而准；你可以逐张编辑、确认或删除。</span></div><button id="workbenchBibleGenerate" class="btn" type="button">用 AI 更新索引</button></div><div id="workbenchBibleProgress" class="workbench-bible-progress" hidden><div class="bible-progress-track"><i id="workbenchBibleProgressFill"></i></div><strong id="workbenchBibleProgressMessage">准备中</strong><span id="workbenchBibleProgressMeta"></span><pre id="workbenchBibleStreamPreview" class="workbench-bible-stream-preview" hidden></pre></div></section>
      <section class="workbench-bible-index"><div class="workbench-bible-toolbar"><div class="workbench-bible-status"><strong id="workbenchBibleCount">0 条资料</strong><span id="workbenchBibleChanges" hidden></span></div><input id="workbenchBibleSearch" type="search" placeholder="搜索名称、标签或字段…"><button id="workbenchBibleBatchToggle" class="btn btn-sm btn-ghost" type="button" data-bible-batch-toggle>批量编辑</button></div><div id="workbenchBibleBatchBar" class="workbench-bible-batchbar" hidden><div class="workbench-bible-batch-head"><strong data-bible-batch-count>已选 0 条</strong><span>勾选卡片后一次确认、改状态、加标签或设置自定义字段。</span></div><div class="workbench-bible-batch-actions"><button class="btn btn-sm btn-ghost" type="button" data-bible-select-visible>全选当前列表</button><button class="btn btn-sm btn-ghost" type="button" data-bible-batch-confirm data-bible-batch-requires-selection>批量确认</button><button class="btn btn-sm btn-ghost" type="button" data-bible-batch-edit data-bible-batch-requires-selection>批量改字段</button><button class="btn btn-sm btn-danger" type="button" data-bible-batch-delete data-bible-batch-requires-selection>删除选中</button><button class="btn btn-sm btn-ghost" type="button" data-bible-batch-clear>清空</button></div><div class="workbench-bible-batch-editor" data-bible-batch-editor hidden><label>修改字段<select data-bible-batch-field><option value="currentStatus">当前状态</option><option value="tags">标签</option><option value="notes">备注</option><option value="customField">自定义字段</option></select></label><label data-bible-batch-key-wrap hidden>字段名<input type="text" data-bible-batch-key placeholder="例如：阵营"></label><label>写入方式<select data-bible-batch-mode><option value="replace">替换</option><option value="append">追加</option></select></label><label class="workbench-bible-batch-value">内容<textarea data-bible-batch-value rows="2" placeholder="输入要写入所有选中卡片的内容"></textarea></label><button class="btn btn-sm btn-primary" type="button" data-bible-batch-apply>应用到选中卡片</button></div></div><nav class="workbench-bible-categories"><button class="bible-category-button active" data-category="character">人物 <span>0</span></button><button class="bible-category-button" data-category="location">地点 <span>0</span></button><button class="bible-category-button" data-category="item">物品 <span>0</span></button><button class="bible-category-button" data-category="organization">组织 <span>0</span></button><button class="bible-category-button" data-category="relation">关系 <span>0</span></button></nav><div class="workbench-bible-content-head"><div><h3 id="workbenchBibleCategoryTitle">人物</h3><p>AI 维护的信息会随项目更新；保存过的手工卡片是权威信息。</p></div><button id="workbenchBibleAdd" class="btn btn-sm" type="button">＋ 新增人物</button></div><div id="workbenchBibleEditor" class="workbench-bible-editor-mount" hidden></div><div id="workbenchBibleContent" class="workbench-bible-content"></div></section>`;
    const generate = page.querySelector('#workbenchBibleGenerate');
    generate.onclick = () => generateBible(generate);
    const freeText = page.querySelector('#workbenchBibleFreeText');
    freeText.value = state.storyBibleFreeText || state.project?.characters || '';
    page.querySelector('#workbenchBibleSaveText').onclick = async () => {
      state.storyBibleFreeText = freeText.value;
      state.project.characters = freeText.value;
      await Store.save();
      if (typeof toast === 'function') toast('资料库原文已保存，并会进入 AI 写作上下文');
    };
    page.querySelector('#workbenchBibleSearch').addEventListener('input', () => renderBiblePanel());
    page.querySelectorAll('.bible-category-button').forEach((button) => {
      button.addEventListener('click', () => {
        bibleCategory = button.dataset.category;
        renderBiblePanel();
      });
    });
    bibleEditorMount = page.querySelector('#workbenchBibleEditor');
    page.addEventListener('click', async (event) => {
      const target = event.target.closest('button');
      if (!target) return;
      try {
        if (target.hasAttribute('data-bible-custom-add')) {
          appendBibleCustomFieldRow(target.closest('form'));
        } else if (target.hasAttribute('data-bible-custom-remove')) {
          const row = target.closest('[data-bible-custom-field-row]');
          const rows = row?.parentElement;
          row?.remove();
          if (rows && !rows.children.length) rows.insertAdjacentHTML('beforeend', customFieldRowHtml());
        } else if (target.hasAttribute('data-bible-batch-toggle')) {
          bibleBatchMode = !bibleBatchMode;
          if (!bibleBatchMode) clearBibleSelection();
          renderBiblePanel();
        } else if (target.hasAttribute('data-bible-select-visible')) {
          const query = String(page.querySelector('#workbenchBibleSearch')?.value || '')
            .trim()
            .toLowerCase();
          const visible =
            bibleCategory === 'relation'
              ? (storyBibleBundle.relations || []).filter((relation) => {
                  const names = new Map(bibleEntityList().map((item) => [item.id, item.name]));
                  return (
                    !query ||
                    `${names.get(relation.sourceId)} ${relation.label} ${names.get(relation.targetId)} ${relation.description}`
                      .toLowerCase()
                      .includes(query)
                  );
                })
              : (() => {
                  const config = bibleEntityConfig[bibleCategory];
                  return (storyBibleBundle[config?.path] || []).filter(
                    (item) => !query || JSON.stringify(item).toLowerCase().includes(query),
                  );
                })();
          const selection = bibleSelection[bibleCategory];
          visible.forEach((item) => selection.add(item.id));
          renderBiblePanel();
        } else if (target.hasAttribute('data-bible-batch-clear')) {
          clearBibleSelection();
          renderBiblePanel();
        } else if (target.hasAttribute('data-bible-batch-confirm')) {
          await applyBibleBatch('confirm');
        } else if (target.hasAttribute('data-bible-batch-delete')) {
          await applyBibleBatch('delete');
        } else if (target.hasAttribute('data-bible-batch-edit')) {
          const editor = page.querySelector('[data-bible-batch-editor]');
          if (editor) editor.hidden = false;
          page.querySelector('[data-bible-batch-value]')?.focus();
        } else if (target.hasAttribute('data-bible-batch-apply')) {
          await applyBibleBatch('edit', page.querySelector('[data-bible-batch-editor]'));
        } else if (target.id === 'workbenchBibleAdd' || target.dataset.bibleAdd) {
          const type = target.dataset.bibleAdd || bibleCategory;
          if (type === 'relation') renderBibleRelationEditor();
          else renderBibleEditor(type);
        } else if (target.dataset.bibleEdit) {
          const config = bibleEntityConfig[target.dataset.bibleEdit];
          const entity = (storyBibleBundle[config.path] || []).find(
            (item) => item.id === target.dataset.bibleId,
          );
          renderBibleEditor(target.dataset.bibleEdit, entity);
        } else if (target.dataset.bibleDelete) {
          await deleteBibleEntity(target.dataset.bibleDelete, target.dataset.bibleId);
        } else if (target.dataset.bibleConfirm) {
          await confirmBibleEntity(target.dataset.bibleConfirm, target.dataset.bibleId);
        } else if (target.dataset.bibleEditRelation) {
          const relation = (storyBibleBundle.relations || []).find(
            (item) => item.id === target.dataset.bibleEditRelation,
          );
          renderBibleRelationEditor(relation);
        } else if (target.dataset.bibleDeleteRelation) {
          await deleteBibleRelation(target.dataset.bibleDeleteRelation);
        } else if (target.dataset.bibleConfirmRelation) {
          const relation = (storyBibleBundle.relations || []).find(
            (item) => item.id === target.dataset.bibleConfirmRelation,
          );
          if (!relation) return;
          const result = await request(`/projects/${projectId}/relations/${relation.id}`, {
            method: 'PATCH',
            body: JSON.stringify({ ...relation, trust: 'confirmed', expectedRevision: revision }),
          });
          syncStoryBibleState({
            revision: result.revision,
            relations: (storyBibleBundle.relations || []).map((item) =>
              item.id === relation.id ? result.relation : item,
            ),
          });
          toast?.('关系已确认');
        } else if (target.hasAttribute('data-bible-editor-cancel')) {
          closeBibleEditor();
        } else if (target.hasAttribute('data-bible-delete-editor')) {
          if (activeBibleEditor?.type === 'relation') await deleteBibleRelation(activeBibleEditor.id);
          else if (activeBibleEditor) await deleteBibleEntity(activeBibleEditor.type, activeBibleEditor.id);
        }
      } catch (error) {
        if (error.status === 409) {
          toast?.('资料库已在其他设备更新，请刷新后再编辑，当前表单未覆盖服务器内容');
          return;
        }
        toast?.(error.message || '资料保存失败');
      }
    });
    page.addEventListener('submit', async (event) => {
      const form = event.target.closest('form');
      if (!form) return;
      event.preventDefault();
      try {
        if (form.matches('[data-bible-editor]')) await saveBibleEditor(form);
        else if (form.matches('[data-bible-relation-editor]')) await saveBibleRelation(form);
      } catch (error) {
        if (error.status === 409) toast?.('资料已被其他设备修改，请刷新后再保存');
        else toast?.(error.message || '资料保存失败');
      }
    });
    page.addEventListener('change', (event) => {
      const checkbox = event.target.closest?.('[data-bible-select]');
      if (!checkbox) {
        const field = event.target.closest?.('[data-bible-batch-field]');
        if (field) {
          const keyWrap = page.querySelector('[data-bible-batch-key-wrap]');
          if (keyWrap) keyWrap.hidden = field.value !== 'customField';
        }
        return;
      }
      const type = checkbox.dataset.selectType;
      const id = checkbox.dataset.selectId;
      if (!type || !id || !bibleSelection[type]) return;
      if (checkbox.checked) bibleSelection[type].add(id);
      else bibleSelection[type].delete(id);
      renderBiblePanel();
    });
    refreshBibleUI = () => {
      if (document.activeElement !== freeText)
        freeText.value = state.storyBibleFreeText || state.project?.characters || '';
      renderBiblePanel();
    };
    tabBar.insertAdjacentElement('afterend', page);
    renderBiblePanel();
  };

  const installProjectPresets = () => {
    const genreInput = document.getElementById('novelGenre');
    const toneInput = document.getElementById('toneAtmosphere');
    const styleInput = document.getElementById('styleConstraints');
    const forbiddenInput = document.getElementById('forbiddenItems');
    const cardNameInput = document.getElementById('methodologyCardName');
    if (!genreInput || !toneInput || !styleInput || !forbiddenInput || !cardNameInput) return;

    const makePresetButton = (label, description, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-preset-chip';
      button.textContent = label;
      if (description) button.title = description;
      button.addEventListener('click', onClick);
      return button;
    };
    const makePresetBlock = (title, hint, className) => {
      const block = document.createElement('div');
      block.className = `project-preset-block ${className}`;
      block.innerHTML = `<div class="project-preset-heading"><strong>${title}</strong><span>${hint}</span></div><div class="project-preset-strip"></div>`;
      return block;
    };

    const genres = ['玄幻', '仙侠', '都市', '悬疑', '科幻', '历史', '言情', '奇幻', '末世', '轻小说'];
    const genreList = document.createElement('datalist');
    genreList.id = 'novelGenrePresets';
    genres.forEach((genre) => genreList.append(new Option(genre, genre)));
    genreInput.setAttribute('list', genreList.id);
    genreInput.after(genreList);
    const genreBlock = makePresetBlock('常用类型', '点击填入，也可以继续自由输入', 'genre-preset-block');
    genres.forEach((genre) =>
      genreBlock.querySelector('.project-preset-strip').append(
        makePresetButton(genre, `将小说类型设为${genre}`, async () => {
          genreInput.value = genre;
          state.project = { ...(state.project || {}), genre };
          await Store.save();
          if (typeof toast === 'function') toast(`已选择类型：${genre}`);
        }),
      ),
    );
    genreInput.closest('div').append(genreBlock);

    const stylePresets = [
      {
        name: '热血升级',
        tone: '热血、昂扬、紧张',
        style: '节奏明快；冲突密集；行动推动剧情；升级反馈清晰',
        forbidden: '不要长篇说教\n不要连续总结人物感受\n不要用旁白替代冲突',
      },
      {
        name: '悬疑克制',
        tone: '冷峻、压抑、疑云重重',
        style: '限制信息；重视细节伏笔；对话留有潜台词；结论延后',
        forbidden: '不要提前解释谜底\n不要用巧合强行推进\n不要频繁切换视角',
      },
      {
        name: '轻松群像',
        tone: '轻松、温暖、诙谐',
        style: '角色互动密集；对白自然；群像关系推动剧情',
        forbidden: '不要让所有角色说话口吻一致\n不要用网络梗破坏时代背景',
      },
      {
        name: '黑暗史诗',
        tone: '沉重、宏大、悲壮',
        style: '强调时代与个人命运冲突；场景有历史重量；克制煽情',
        forbidden: '不要无代价解决冲突\n不要滥用空泛宏大词',
      },
      {
        name: '细腻情感',
        tone: '细腻、含蓄、温柔',
        style: '用动作、停顿和细节表达情绪；减少直接心理总结',
        forbidden: '不要反复解释感情\n不要使用套路化告白',
      },
      {
        name: '快节奏爽文',
        tone: '爽快、直接、紧凑',
        style: '开章快速进入事件；每章有明确目标与反馈；减少无效过渡',
        forbidden: '不要连续铺垫多章不兑现\n不要重复解释已知信息',
      },
    ];
    const styleSection = toneInput.closest('.rules-section');
    const styleBlock = makePresetBlock(
      '风格预设',
      '一次填入整组规则，应用前会保护已有内容',
      'style-preset-block',
    );
    stylePresets.forEach((preset) =>
      styleBlock.querySelector('.project-preset-strip').append(
        makePresetButton(preset.name, `${preset.tone}；${preset.style}`, async () => {
          const hasRules = [toneInput.value, styleInput.value, forbiddenInput.value].some((value) =>
            value.trim(),
          );
          if (hasRules && !confirm(`应用“${preset.name}”会替换当前三项风格规则，是否继续？`)) return;
          toneInput.value = preset.tone;
          styleInput.value = preset.style;
          forbiddenInput.value = preset.forbidden;
          if (typeof globalThis.syncCreativeRulesFromUI === 'function') globalThis.syncCreativeRulesFromUI();
          await Store.save();
          if (typeof toast === 'function') toast(`已应用风格预设：${preset.name}`);
        }),
      ),
    );
    styleSection.querySelector('.rules-section-title').after(styleBlock);

    const cardPresets = [
      [
        '强钩子开章',
        '开头 300 字内出现异常、目标、冲突或未完成动作。\n不先解释背景，先让角色进入具体场景。\n钩子必须与本章主要事件相关，不能是虚假悬念。',
      ],
      [
        '自然对白',
        '每句对白都体现角色立场、关系或当下目的。\n少用完整书面句，允许停顿、打断、答非所问。\n不用对白重复读者已经知道的信息。\n用动作和环境反应减少“他说道、她回答”的堆叠。',
      ],
      [
        '悬疑伏笔',
        '伏笔先以普通细节出现，避免作者刻意强调。\n同一线索至少提供两种合理解释。\n回收时必须能追溯到前文，不依赖临时新增设定。',
      ],
      [
        '动作场景',
        '始终明确人物位置、目标、障碍和代价。\n动作与环境互动，避免招式清单。\n每轮交锋都改变局势，不重复同一种攻防。',
      ],
      [
        '人物弧光',
        '每个关键选择都来自人物欲望、恐惧或错误信念。\n变化通过行为与代价表现，不由旁白宣布。\n保留反复和退步，避免突然彻底转变。',
      ],
      [
        '章节节奏',
        '每章包含目标建立、阻力升级、局势变化和章末余波。\n场景之间必须有因果或明确时间推进。\n删除不改变人物、信息或局势的段落。',
      ],
    ];
    const cardSection = cardNameInput.closest('.rules-section');
    const cardBlock = makePresetBlock(
      '内置模板',
      '点击会新增一张可编辑卡片，不覆盖当前卡片',
      'methodology-preset-block',
    );
    cardPresets.forEach(([name, cardText]) =>
      cardBlock.querySelector('.project-preset-strip').append(
        makePresetButton(name, `新增“${name}”写作卡片`, async () => {
          state.methodologyCards = Array.isArray(state.methodologyCards) ? state.methodologyCards : [];
          const card = {
            id: `preset_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
            name,
            cardText,
            enabledForOutline: true,
            enabledForChapter: true,
            createdAt: Date.now(),
          };
          state.methodologyCards.push(card);
          state.activeMethodologyCardId = card.id;
          if (typeof globalThis.renderMethodologyCards === 'function') globalThis.renderMethodologyCards();
          await Store.save();
          if (typeof toast === 'function') toast(`已新增写作卡片：${name}`);
        }),
      ),
    );
    cardSection.querySelector('.rules-section-title').after(cardBlock);
  };

  const installAdaptivePanels = () => {
    const folds = [];
    const makeFold = (section, label, status, hasContent) => {
      if (!section || section.matches('details')) return null;
      const titleNode = section.querySelector('.rules-section-title');
      const details = document.createElement('details');
      details.className = `${section.className} workbench-collapsible-section`;
      details.dataset.adaptivePanel = label;
      const summary = document.createElement('summary');
      summary.innerHTML = `<span class="workbench-fold-label">${escapeHtml(label)}</span><span class="workbench-fold-status"></span>`;
      const body = document.createElement('div');
      body.className = 'workbench-collapsible-body';
      [...section.childNodes].forEach((node) => {
        if (node === titleNode) return;
        body.append(node);
      });
      details.append(summary, body);
      section.replaceWith(details);
      const record = {
        details,
        summary: summary.querySelector('.workbench-fold-status'),
        status,
        hasContent,
        userToggled: false,
        applying: false,
      };
      folds.push(record);
      details.open = Boolean(hasContent());
      details.addEventListener('toggle', () => {
        if (record.applying) {
          record.applying = false;
          return;
        }
        record.userToggled = true;
      });
      return details;
    };

    makeFold(
      document.getElementById('toneAtmosphere')?.closest('.rules-section'),
      '风格规则',
      () => {
        const values = ['toneAtmosphere', 'styleConstraints', 'forbiddenItems'].map(
          (id) => document.getElementById(id)?.value.trim() || '',
        );
        return values.filter(Boolean).length ? `${values.filter(Boolean).length}/3 项已填写` : '未填写';
      },
      () =>
        ['toneAtmosphere', 'styleConstraints', 'forbiddenItems'].some((id) =>
          document.getElementById(id)?.value.trim(),
        ),
    );
    makeFold(
      document.getElementById('referenceText')?.closest('.rules-section'),
      '参考文本',
      () => {
        const length = (document.getElementById('referenceText')?.value || '').trim().length;
        return length ? `${length.toLocaleString()} 字` : '未填写';
      },
      () => Boolean(document.getElementById('referenceText')?.value.trim()),
    );
    makeFold(
      document.getElementById('methodologyCardName')?.closest('.rules-section'),
      '写作卡片',
      () => {
        const cards = Array.isArray(state.methodologyCards) ? state.methodologyCards : [];
        const usable = cards.filter((card) => String(card.cardText || '').trim()).length;
        return usable ? `${usable} 张可用` : '未添加';
      },
      () =>
        Array.isArray(state.methodologyCards) &&
        (state.methodologyCards.some((card) => String(card.cardText || '').trim()) ||
          Boolean(document.querySelector('.methodology-preset-block'))),
    );
    makeFold(
      document.getElementById('citationTechniques')?.closest('.rules-section'),
      '引用手法与大师洞察',
      () => {
        const citation = Boolean(document.getElementById('citationTechniques')?.value.trim());
        const master = Boolean(document.getElementById('masterInsights')?.value.trim());
        return citation || master
          ? `${citation ? '引用手法' : ''}${citation && master ? ' · ' : ''}${master ? '大师洞察' : ''}`
          : '未填写';
      },
      () =>
        Boolean(
          document.getElementById('citationTechniques')?.value.trim() ||
          document.getElementById('masterInsights')?.value.trim(),
        ),
    );
    makeFold(
      document.getElementById('rulesInjectOutline')?.closest('.rules-section'),
      '注入开关',
      () => {
        const active = ['rulesInjectOutline', 'rulesInjectChapter', 'rulesInjectContinue'].filter(
          (id) => document.getElementById(id)?.checked,
        ).length;
        return `${active}/3 项启用`;
      },
      () => false,
    );

    const promptCard = document.getElementById('promptOutline')?.closest('.card');
    if (promptCard && !promptCard.querySelector('.workbench-prompt-fold')) {
      const heading = promptCard.querySelector('h3');
      const details = document.createElement('details');
      details.className = 'workbench-prompt-fold';
      const summary = document.createElement('summary');
      summary.innerHTML = '<span>写作提示词</span><small>按需修改 · 默认生成质量不受影响</small>';
      const body = document.createElement('div');
      body.className = 'workbench-prompt-body';
      [...promptCard.childNodes].forEach((node) => {
        if (node === heading) return;
        body.append(node);
      });
      details.append(summary, body);
      promptCard.replaceChildren(details);
      details.open = false;
    }

    const refresh = () => {
      folds.forEach((fold) => {
        if (fold.summary) fold.summary.textContent = fold.status();
        if (!fold.userToggled && fold.hasContent() && !fold.details.open) {
          fold.applying = true;
          fold.details.open = true;
        }
      });
    };
    document.addEventListener('input', refresh);
    document.addEventListener('change', refresh);
    const nativeSwitchTab = globalThis.switchTab;
    if (typeof nativeSwitchTab === 'function' && !nativeSwitchTab.adaptivePanelsWrapped) {
      const wrappedSwitchTab = function (...args) {
        const result = nativeSwitchTab.apply(this, args);
        window.setTimeout(refresh, 0);
        return result;
      };
      wrappedSwitchTab.adaptivePanelsWrapped = true;
      globalThis.switchTab = wrappedSwitchTab;
    }
    refresh();
  };

  document.addEventListener('DOMContentLoaded', () => {
    compactWorkbenchActions();
    installDetailedPOV();
    installBiblePanel();
    installProjectPresets();
    installAdaptivePanels();
    const bar = document.createElement('div');
    bar.id = 'serverServiceBar';
    const back = document.createElement('a');
    back.href = '/';
    back.textContent = '← 返回书库';
    const status = document.createElement('span');
    status.id = 'serverSaveIndicator';
    status.textContent = `服务项目 · v${revision}`;
    bar.append(back, status);
    const headerActions = document.querySelector('.header-actions');
    if (headerActions) headerActions.insertBefore(bar, headerActions.querySelector('.workbench-more'));
    else document.body.append(bar);
  });
})();
