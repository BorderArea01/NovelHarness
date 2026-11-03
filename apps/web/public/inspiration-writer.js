/* global state, Store */
(() => {
  const params = new URLSearchParams(location.search);
  if (!params.get('project')) return;
  const $ = (id) => document.getElementById(id);
  const clean = (value) => (typeof value === 'string' ? value.trim() : '');
  const id = () =>
    globalThis.crypto?.randomUUID?.() ||
    `idea-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const body = (number) => state.chapters?.find((ch) => Number(ch.chapter) === number)?.content || '';
  const hash = (value) => {
    const source = JSON.stringify(value);
    let result = 2166136261;
    for (let i = 0; i < source.length; i++) result = Math.imul(result ^ source.charCodeAt(i), 16777619);
    return `${source.length}:${result >>> 0}`;
  };
  let ready = false,
    active = null,
    selected = 0,
    viewed = 1,
    timer = null,
    dirty = false;
  let changeVersion = 0,
    checkpointTimer = null;
  let pendingCompletedResult = null,
    completionSavePromise = null;
  const viewKey = `novel-writer:inspiration-view:${params.get('project')}`;
  const interruptedPhase = () =>
    !active && ['paused', 'error', 'writing', 'planning', 'outlining'].includes(lane().phase);
  function rememberView() {
    try {
      sessionStorage.setItem(viewKey, lane().view);
    } catch {
      /* Browsing still works without preference storage. */
    }
  }
  let streamPhase = '',
    streamText = '',
    editingSnapshot = false,
    comparingHistoryId = null;
  const lane = () => {
    state.uiDrafts ||= {};
    const writer = (state.uiDrafts.inspirationWriter ||= { mode: 'inspiration', seed: '', phase: 'idle' });
    writer.additions ||= [];
    writer.outlineHistory ||= [];
    if (writer.version !== 2) {
      writer.version = 2;
      writer.lastTask = ['writing', 'done'].includes(writer.phase) ? 'write' : 'outline';
      writer.view = state.outline?.length ? 'outline' : 'ideas';
      writer.approvedOutline = null;
      if (outline().length && writer.builtSeed == null) writer.builtSeed = writer.seed;
      if (writer.phase === 'done') writer.phase = 'review';
    }
    if (!['ideas', 'outline', 'write'].includes(writer.view))
      writer.view = state.outline?.length ? 'outline' : 'ideas';
    return writer;
  };
  const outline = () =>
    (state.outline || [])
      .filter((ch) => Number.isInteger(Number(ch.chapter)) && Number(ch.chapter) > 0)
      .sort((a, b) => Number(a.chapter) - Number(b.chapter));
  const chapter = (number) => outline().find((item) => Number(item.chapter) === number);
  const endChapter = () =>
    Math.max(
      Number(state.project.chapterCount) || 24,
      ...outline().map((item) => Number(item.chapter)),
      ...state.chapters.map((item) => Number(item.chapter)),
    );
  const firstUnwritten = () => {
    for (let n = 1; n <= endChapter(); n++) if (!clean(body(n))) return n;
    return endChapter() + 1;
  };
  const nextChapter = () =>
    lane().lastTask === 'write' && interruptedPhase() && lane().pendingChapter
      ? lane().pendingChapter
      : firstUnwritten();
  const pending = () => lane().additions.filter((item) => !item.planned);
  // JSON deliveries are bounded; the shared architecture covers the full range.
  const OUTLINE_BATCH_SIZE = 12;
  const outlineKey = () =>
    hash([
      lane().seed,
      outline().map((item) => [
        item.chapter,
        item.title,
        item.summary,
        (item.plotPoints || []).map((point) => point.desc),
        item.note || '',
      ]),
    ]);
  const coverage = () => {
    const missing = [];
    for (let n = 1; n <= endChapter(); n++) {
      const item = chapter(n);
      if (
        !clean(body(n)) &&
        (!item ||
          !clean(item.title) ||
          !clean(item.summary) ||
          !item.plotPoints?.length ||
          item.plotPoints.some((p) => !clean(p.desc)))
      )
        missing.push(n);
    }
    return missing;
  };
  function status(message, error = false) {
    $('inspirationStatus').textContent = message;
    $('inspirationStatus').classList.toggle('error', error);
  }
  function save() {
    if (pendingCompletedResult && completionSavePromise) return completionSavePromise;
    if (!pendingCompletedResult) return saveSnapshot();
    const result = (async () => {
      // Keep save-only retries save-only, including author edits made while the
      // first acknowledgement was in flight. Never credit unsent later edits.
      do {
        await saveSnapshot();
      } while (pendingCompletedResult && dirty);
    })();
    completionSavePromise = result.finally(() => {
      completionSavePromise = null;
      actions();
    });
    actions();
    return completionSavePromise;
  }
  async function saveSnapshot() {
    const savingVersion = changeVersion;
    const completed = pendingCompletedResult;
    const result = await Store.save({ forceProject: !!completed });
    if (!result?.projectSaved) {
      if (completed) dirty = true;
      throw new Error(
        result?.error?.status === 409
          ? '保存冲突：请先对比并解决版本冲突，再继续。'
          : `保存失败：${result?.error?.message || '服务连接中断，请重试'}`,
      );
    }
    if (savingVersion === changeVersion) {
      dirty = false;
      if (completed === pendingCompletedResult) pendingCompletedResult = null;
    }
    $('inspirationSaveState').textContent = dirty ? '保存中' : '已保存';
  }
  function completedSaveFailure(error) {
    dirty = true;
    status(`生成已完成，但${error.message}。仅需重试保存，不会重新调用 AI。`, true);
    $('inspirationSaveState').textContent = '保存失败 · 点击重试';
    $('inspirationProcess').open = false;
    $('inspirationProcessLabel').textContent = '查看生成过程';
    $('toast')?.classList.remove('show');
    actions();
  }
  async function retryCompletedSave() {
    const completed = pendingCompletedResult;
    if (!completed) return;
    clearTimer();
    try {
      await save();
      if (pendingCompletedResult) {
        status('还有新的修改待保存。');
        return;
      }
      status(
        completed.kind === 'outline'
          ? '章节大纲已保存 · 检查后再开始正文'
          : `第 ${completed.chapter} 章已保存 · 可编辑正文或继续下一章`,
      );
      $('inspirationProcess').open = false;
      rememberView();
    } catch (error) {
      completedSaveFailure(error);
    }
  }
  const clearTimer = () => {
    clearTimeout(timer);
    timer = null;
  };
  function scheduleSave() {
    changeVersion++;
    dirty = true;
    $('inspirationSaveState').textContent = '保存中';
    clearTimer();
    timer = setTimeout(async () => {
      timer = null;
      try {
        await save();
      } catch (error) {
        status(error.message, true);
        $('inspirationSaveState').textContent = '保存失败 · 点击重试';
      }
    }, 650);
  }
  function snapshot(source) {
    if (!outline().length) return;
    const writer = lane();
    writer.outlineHistory.unshift({
      id: id(),
      time: Date.now(),
      source,
      chapters: structuredClone(state.outline),
      chapterCount: state.project.chapterCount,
      planning: {
        seed: writer.builtSeed ?? null,
        plannedAdditionIds: writer.additions.filter((item) => item.planned).map((item) => item.id),
      },
      quality: structuredClone(
        state.uiDrafts.generationQualityReports?.outline || writer.outlineQuality || null,
      ),
    });
    lane().outlineHistory = lane().outlineHistory.slice(0, 10);
  }
  function refreshHistoryOptions() {
    const history = $('inspirationHistory'),
      selectedId = comparingHistoryId;
    history.replaceChildren();
    for (const saved of lane().outlineHistory) {
      const option = document.createElement('option');
      option.value = saved.id;
      option.textContent = `${new Date(saved.time).toLocaleString('zh-CN', { hour12: false })} · ${saved.source}`;
      history.append(option);
    }
    if (lane().outlineHistory.some((item) => item.id === selectedId)) history.value = selectedId;
    $('inspirationHistoryTools').hidden = !lane().outlineHistory.length;
    renderHistoryPreview();
  }
  function historyTargetCount(saved) {
    return Math.max(
      Number(saved.chapterCount) || 0,
      ...(saved.chapters || []).map((item) => Number(item.chapter) || 0),
      ...state.chapters.filter((item) => clean(item.content)).map((item) => Number(item.chapter) || 0),
      1,
    );
  }
  function historyRestorable(saved) {
    if (!Array.isArray(saved?.chapters) || !saved.chapters.length) return false;
    const numbers = saved.chapters.map((item) => Number(item?.chapter));
    return (
      numbers.every((n) => Number.isInteger(n) && n > 0) &&
      new Set(numbers).size === numbers.length &&
      saved.chapters.every(
        (item) =>
          item.plotPoints == null ||
          (Array.isArray(item.plotPoints) &&
            item.plotPoints.every(
              (point) => typeof point === 'string' || (point && typeof point === 'object'),
            )),
      )
    );
  }
  function renderHistoryPreview() {
    const saved = lane().outlineHistory.find((item) => item.id === comparingHistoryId),
      host = $('inspirationHistoryPreview');
    if (!host) return;
    host.hidden = !saved;
    if (!saved) return;
    if (!historyRestorable(saved)) {
      $('inspirationHistorySummary').textContent = '此历史版本缺少有效章节数据，不能恢复；当前内容保持不变。';
      $('inspirationHistoryChanges').replaceChildren();
      $('inspirationHistorySource').hidden = true;
      $('inspirationHistoryConfirm').disabled = true;
      return;
    }
    const current = outline(),
      target = saved.chapters || [],
      list = $('inspirationHistoryChanges');
    const signature = (item) =>
      item
        ? JSON.stringify([
            item.title || '',
            item.summary || '',
            (item.plotPoints || []).map((p) => (typeof p === 'string' ? p : p.desc || '')),
            item.note || '',
          ])
        : null;
    const numbers = [...new Set([...current, ...target].map((item) => Number(item.chapter)))].sort(
      (a, b) => a - b,
    );
    const changes = numbers
      .filter((n) => !clean(body(n)))
      .map((n) => ({
        number: n,
        current: current.find((item) => Number(item.chapter) === n),
        target: target.find((item) => Number(item.chapter) === n),
      }))
      .filter((row) => signature(row.current) !== signature(row.target));
    $('inspirationHistorySummary').textContent =
      `${new Date(saved.time).toLocaleString('zh-CN', { hour12: false })} · ${saved.source} · ${changes.length} 章变更 · 规划 ${endChapter()} → ${historyTargetCount(saved)} 章。已写正文及其大纲不变。`;
    $('inspirationHistorySource').textContent =
      saved.planning?.seed == null
        ? '这个旧版本没有记录来源灵感，恢复后请先核对大纲。'
        : saved.planning.seed !== lane().seed
          ? '此版本来自不同灵感，恢复后需要先更新未写章节的大纲。'
          : '';
    $('inspirationHistorySource').hidden = !$('inspirationHistorySource').textContent;
    $('inspirationHistoryConfirm').disabled = !!active;
    list.replaceChildren();
    for (const [index, row] of changes.entries()) {
      const detail = document.createElement('details'),
        title = document.createElement('summary'),
        versions = document.createElement('div');
      detail.className = 'inspiration-history-change';
      detail.open = index === 0;
      title.textContent = `第 ${row.number} 章 · ${!row.current ? '新增' : !row.target ? '移除' : '修改'}`;
      versions.className = 'inspiration-history-versions';
      const fields = (item) => ({
        title: item?.title || '',
        summary: item?.summary || '',
        points: (item?.plotPoints || [])
          .map((p, i) => `${i + 1}. ${typeof p === 'string' ? p : p.desc || ''}`)
          .join('\n'),
        note: item?.note || '',
      });
      const before = fields(row.current),
        after = fields(row.target);
      const changed = [
        ['title', '章节标题'],
        ['summary', '章节概要'],
        ['points', '关键事件'],
        ['note', '写作要求'],
      ].filter(([key]) => before[key] !== after[key]);
      for (const [label, item] of [
        ['当前版本', row.current],
        ['所选版本', row.target],
      ]) {
        const column = document.createElement('section'),
          heading = document.createElement('h3'),
          text = document.createElement('p');
        heading.textContent = label;
        text.textContent = item
          ? [
              item.title,
              item.summary,
              ...(item.plotPoints || []).map(
                (p, i) => `${i + 1}. ${typeof p === 'string' ? p : p.desc || ''}`,
              ),
              item.note ? `写作要求：${item.note}` : '',
            ]
              .filter(Boolean)
              .join('\n\n')
          : '此版本没有本章';
        column.append(heading);
        const values = fields(item);
        for (const [key, name] of changed) {
          const label = document.createElement('h4'),
            value = document.createElement('p');
          label.textContent = name;
          value.textContent = item ? values[key] || '未填写' : '此版本没有本章';
          column.append(label, value);
        }
        if (item && changed.length < 4) {
          const context = document.createElement('details'),
            caption = document.createElement('summary');
          caption.textContent = '完整章节内容';
          context.append(caption, text);
          column.append(context);
        }
        versions.append(column);
      }
      detail.append(title, versions);
      list.append(detail);
    }
    if (!changes.length) {
      const note = document.createElement('p');
      note.textContent = '未写章节内容相同。恢复仍会按所选版本核对灵感来源与已融入的补充灵感。';
      list.append(note);
    }
  }
  function setView(view) {
    lane().view = view;
    render();
    rememberView();
  }
  function sidebar() {
    const list = $('inspirationChapterList');
    list.replaceChildren();
    for (const item of outline()) {
      const n = Number(item.chapter),
        button = document.createElement('button');
      button.type = 'button';
      button.dataset.outlineChapter = n;
      button.className = `inspiration-chapter-link${selected === n ? ' selected' : ''}`;
      const badge = document.createElement('span');
      badge.textContent = String(n).padStart(2, '0');
      const title = document.createElement('span');
      title.textContent = item.title || `第 ${n} 章`;
      const progress = document.createElement('small');
      progress.textContent =
        active?.kind === 'write' && active.chapter === n && !active.resultReady
          ? '生成中'
          : clean(body(n))
            ? '有正文'
            : '待写';
      button.append(badge, title, progress);
      button.onclick = () => {
        selected = n;
        viewed = n;
        editingSnapshot = false;
        setView(lane().view === 'write' ? 'write' : 'outline');
      };
      list.append(button);
    }
    $('inspirationOutlineCount').textContent = `${outline().length} / ${endChapter()} 章`;
  }
  function overview() {
    const list = $('inspirationOutlineOverview');
    list.replaceChildren();
    for (const item of outline()) {
      const card = document.createElement('details');
      card.className = 'inspiration-outline-card';
      card.open = true;
      const heading = document.createElement('summary');
      heading.textContent = `第 ${item.chapter} 章 · ${item.title}`;
      const summary = document.createElement('p');
      summary.textContent = item.summary;
      const points = document.createElement('ol');
      for (const point of item.plotPoints || []) {
        const li = document.createElement('li');
        li.textContent = point.desc;
        points.append(li);
      }
      const edit = document.createElement('button');
      edit.className = 'btn';
      edit.textContent = clean(body(Number(item.chapter))) ? '查看本章' : '编辑本章';
      edit.onclick = () => {
        selected = Number(item.chapter);
        editingSnapshot = false;
        render();
      };
      card.append(heading, summary, points, edit);
      list.append(card);
    }
  }
  function mutate(mutator) {
    if (active || clean(body(selected))) return;
    const item = chapter(selected);
    if (!item) return;
    if (!editingSnapshot) {
      snapshot('手动修改前');
      editingSnapshot = true;
    }
    mutator(item);
    lane().approvedOutline = null;
    globalThis.renderOutline();
    sidebar();
    actions();
    refreshHistoryOptions();
    qualityNotice(
      'inspirationOutlineQuality',
      state.uiDrafts.generationQualityReports?.outline || lane().outlineQuality,
      '已完成结构与因果精修',
      'outline',
      state.outline,
    );
    scheduleSave();
  }
  function renderPoints() {
    const item = chapter(selected),
      list = $('inspirationPlotPoints');
    list.replaceChildren();
    if (!item) return;
    for (const [i, point] of (item.plotPoints || []).entries()) {
      const row = document.createElement('div');
      row.className = 'inspiration-beat';
      const input = document.createElement('textarea');
      input.rows = 2;
      input.value = point.desc || '';
      input.maxLength = 5000;
      input.setAttribute('aria-label', `关键事件 ${i + 1}`);
      input.readOnly = !!active || !!clean(body(selected));
      input.oninput = () =>
        mutate((target) => {
          target.plotPoints[i].desc = input.value;
        });
      const controls = document.createElement('div');
      for (const [label, symbol, action, disabled] of [
        [
          '上移事件',
          '↑',
          () => {
            [item.plotPoints[i - 1], item.plotPoints[i]] = [item.plotPoints[i], item.plotPoints[i - 1]];
          },
          i === 0,
        ],
        [
          '下移事件',
          '↓',
          () => {
            [item.plotPoints[i + 1], item.plotPoints[i]] = [item.plotPoints[i], item.plotPoints[i + 1]];
          },
          i === item.plotPoints.length - 1,
        ],
        [
          '删除事件',
          '×',
          () => {
            item.plotPoints.splice(i, 1);
          },
          false,
        ],
      ]) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'btn';
        button.textContent = symbol;
        button.setAttribute('aria-label', `${label} ${i + 1}`);
        button.disabled = disabled || !!active || !!clean(body(selected));
        button.onclick = () => {
          mutate(action);
          renderPoints();
        };
        controls.append(button);
      }
      row.append(input, controls);
      list.append(row);
    }
  }
  function outlineEditor() {
    const item = chapter(selected);
    $('inspirationOutlineOverview').hidden = !!item;
    $('inspirationOutlineEditor').hidden = !item;
    $('inspirationOutlineHeading').textContent = item ? `第 ${item.chapter} 章 · 大纲` : '章节大纲';
    if (!item) {
      overview();
      return;
    }
    for (const [id, field] of [
      ['inspirationOutlineTitle', 'title'],
      ['inspirationOutlineSummary', 'summary'],
      ['inspirationOutlineNote', 'note'],
    ]) {
      $(id).value = item[field] || '';
      $(id).readOnly = !!active || !!clean(body(selected));
    }
    $('inspirationOutlineLocked').hidden = !clean(body(selected));
    renderPoints();
  }
  function readerPreview() {
    const content = body(viewed);
    if (
      active?.kind === 'write' &&
      active.chapter === viewed &&
      !active.resultReady &&
      content === active.previousContent &&
      clean(active.receivedProse)
    )
      return { content: globalThis.sanitizeGeneratedText(active.receivedProse), draft: true };
    return { content, draft: false };
  }
  function paintReaderContent(force = false) {
    const editor = $('inspirationEditor');
    const changedChapter = Number(editor.dataset.chapter) !== viewed;
    const preview = readerPreview();
    if (changedChapter || force || document.activeElement !== editor) {
      if (editor.value !== preview.content) {
        const top = changedChapter ? 0 : editor.scrollTop;
        const left = changedChapter ? 0 : editor.scrollLeft;
        const start = changedChapter ? 0 : editor.selectionStart;
        const end = changedChapter ? 0 : editor.selectionEnd;
        editor.value = preview.content;
        // Reading position is a UI preference, not a write-back to the chapter.
        // Receiving another chunk must not force a reader to the bottom.
        if (document.activeElement === editor) editor.setSelectionRange(start, end);
        editor.scrollTop = top;
        editor.scrollLeft = left;
      }
    }
    editor.dataset.chapter = viewed;
    editor.dataset.preview = preview.draft ? 'draft' : 'saved';
    editor.readOnly = !!active;
    $('inspirationWords').textContent =
      `${editor.value.replace(/\s/g, '').length.toLocaleString()} 字${preview.draft ? ' · 初稿预览' : ''}`;
    return preview;
  }
  function reader() {
    const item = chapter(viewed);
    const preview = paintReaderContent();
    $('inspirationChapterTitle').textContent = `第 ${viewed} 章${item?.title ? ` · ${item.title}` : ''}`;
    const select = $('inspirationChapterSelect');
    select.replaceChildren();
    for (const n of [
      ...new Set([
        viewed,
        ...outline().map((ch) => Number(ch.chapter)),
        ...state.chapters.map((ch) => Number(ch.chapter)),
      ]),
    ].sort((a, b) => a - b)) {
      const option = document.createElement('option');
      option.value = n;
      option.textContent = `第 ${n} 章${
        active?.kind === 'write' && active.chapter === n && !active.resultReady
          ? ' · 生成中'
          : clean(body(n))
            ? ''
            : ' · 待写'
      }`;
      select.append(option);
    }
    select.value = viewed;
    const report = state.uiDrafts?.generationQualityReports?.chapters?.[String(viewed)];
    qualityNotice(
      'inspirationProseQuality',
      preview.draft ? null : report,
      '已完成精修',
      'chapter',
      preview.content,
    );
  }
  function qualityNotice(target, report, completeLabel, kind, content) {
    const host = $(target);
    const wasOpen = host.querySelector('details')?.open || false;
    host.hidden = !report;
    host.replaceChildren();
    if (!report) return;
    const details = document.createElement('details');
    details.open = wasOpen;
    const summary = document.createElement('summary');
    const freshness = globalThis.generationQuality.freshness(report, kind, content);
    summary.textContent =
      freshness === 'stale'
        ? '内容已改 · 原审校仅供参考'
        : report.status === 'unverified'
          ? '精修待检查 · 查看原因'
          : !['reviewed', 'repaired'].includes(report.status)
            ? '审校信息待核对'
            : freshness === 'unknown'
              ? '旧审校记录 · 版本待核对'
              : completeLabel;
    host.dataset.freshness = freshness;
    const notes = document.createElement('p');
    notes.textContent = [
      freshness === 'stale' ? '这份意见对应生成时的版本，不代表对当前修改稿的评价。' : '',
      report.reason || report.feedback || '已完成原有质量检查。',
    ]
      .filter(Boolean)
      .join('\n');
    details.append(summary, notes);
    host.append(details);
  }
  function actions() {
    const writer = lane(),
      target = nextChapter(),
      missing = coverage();
    const changed =
      pending().length ||
      !!clean(writer.additionDraft) ||
      (writer.builtSeed != null && writer.builtSeed !== writer.seed);
    $('inspirationRun').textContent = active
      ? '正在生成…'
      : writer.lastTask === 'outline' && interruptedPhase()
        ? '重试章节大纲'
        : outline().length
          ? '更新未写章节大纲'
          : '生成章节大纲 →';
    $('inspirationRun').disabled = !!active;
    $('inspirationWrite').textContent =
      writer.lastTask === 'write' && interruptedPhase()
        ? `重试第 ${target} 章`
        : writer.approvedOutline === outlineKey()
          ? `写第 ${target} 章 →`
          : `确认大纲，写第 ${target} 章 →`;
    $('inspirationWrite').disabled = !!active || !!missing.length || !!changed || target > endChapter();
    $('inspirationWrite').hidden = !!active || (writer.view === 'ideas' && !outline().length);
    $('inspirationRun').classList.toggle('btn-primary', !outline().length || !!changed || !!missing.length);
    $('inspirationPlanGate').textContent = changed
      ? '灵感有更新，先融入未写章节的大纲。'
      : !outline().length
        ? `计划 ${endChapter()} 章，生成后可以逐章修改。`
        : missing.length
          ? `第 ${missing.slice(0, 8).join('、')}${missing.length > 8 ? '等' : ''} 章大纲待补齐。`
          : target > endChapter()
            ? '计划中的章节已经全部有正文，可以扩展大纲或继续精修。'
            : writer.approvedOutline === outlineKey()
              ? '按已确认大纲写作，不会重新编造本章计划。'
              : '先看大纲，改好再开始正文。';
    $('inspirationRun').hidden = false;
    if (pendingCompletedResult) {
      const completed = pendingCompletedResult,
        saving = !!completionSavePromise;
      $('inspirationPlanGate').textContent = saving
        ? '正在保存生成结果，不会重新调用 AI。'
        : '内容已生成，尚未确认保存成功；只需重试保存。';
      $('inspirationRun').hidden = completed.kind !== 'outline';
      $('inspirationWrite').hidden = completed.kind !== 'write';
      const button = $(completed.kind === 'outline' ? 'inspirationRun' : 'inspirationWrite');
      button.textContent = saving
        ? '保存中…'
        : completed.kind === 'outline'
          ? '重试保存大纲'
          : `重试保存第 ${completed.chapter} 章`;
      button.disabled = !!active || saving;
      button.classList.add('btn-primary');
    }
    for (const id of [
      'inspirationFull',
      'inspirationSave',
      'inspirationAddButton',
      'inspirationAddBeat',
      'inspirationAddChapter',
      'inspirationExtend',
      'inspirationRestore',
    ])
      $(id).disabled = !!active;
    $('inspirationAddBeat').disabled = !!active || !!clean(body(selected)) || !selected;
    $('inspirationAddBeat').hidden = !selected;
    $('inspirationSeedInput').readOnly = !!active;
    for (const id of ['inspirationLength', 'inspirationChapterCount']) $(id).disabled = !!active;
    const running = !!active && !active.resultReady;
    document.querySelector('#tab-inspiration .inspiration-footer').classList.toggle('is-running', running);
    $('inspirationPlanGate').hidden = running;
    $('inspirationTaskLabel').hidden = !running;
    $('inspirationStop').hidden = !running;
    $('inspirationSave').hidden = !!active;
    if (running) {
      $('inspirationRun').hidden = true;
      $('inspirationWrite').hidden = true;
    }
    updateTaskLabel();
  }
  function updateTaskLabel() {
    if (!active) return;
    const subject =
      active.kind === 'write'
        ? `第 ${active.chapter} 章`
        : active.batchRange
          ? `大纲 ${active.batchRange.start}–${active.batchRange.end} / ${active.batchRange.total} 章`
          : '大纲';
    $('inspirationTaskLabel').textContent = `${subject} · ${streamPhase || '准备中'}`;
  }
  function render() {
    if (!ready || !$('tab-inspiration')) return;
    const writer = lane();
    if (document.body.classList.contains('inspiration-mode')) rememberView();
    $('inspirationBookTitle').textContent = state.project.title;
    if (document.activeElement !== $('inspirationSeedInput'))
      $('inspirationSeedInput').value = writer.seed || '';
    if (document.activeElement !== $('inspirationAdditionInput'))
      $('inspirationAdditionInput').value = writer.additionDraft || '';
    $('inspirationDirection').textContent = writer.direction || '';
    $('inspirationDirection').hidden = !writer.direction;
    $('inspirationLength').value = state.project.wordsPerChapter;
    $('inspirationChapterCount').value = state.project.chapterCount;
    $('inspirationChapterCount').max = Math.max(200, endChapter());
    for (const view of ['ideas', 'outline', 'write']) {
      $(`inspirationView-${view}`).hidden = writer.view !== view;
      const tab = document.querySelector(`[data-inspiration-view="${view}"]`);
      tab.classList.toggle('active', writer.view === view);
      tab.setAttribute('aria-current', writer.view === view ? 'step' : 'false');
    }
    $('inspirationStudio').classList.toggle('is-ideas', writer.view === 'ideas');
    $('inspirationStudio').classList.toggle('is-write', writer.view === 'write');
    $('inspirationSidebar').hidden = writer.view === 'ideas';
    $('inspirationAdditional').hidden = !outline().length;
    $('inspirationBatchSizeHint').textContent =
      `大纲每批最多 ${OUTLINE_BATCH_SIZE} 章，串行生成并精修，会使用多次模型请求；完成批次可在中断后继续。`;
    renderOutlineBatchPreview();
    $('inspirationProcess').hidden = !active && !streamText;
    const additions = $('inspirationAdditions');
    additions.replaceChildren();
    for (const item of writer.additions) {
      const li = document.createElement('li');
      li.textContent = `${item.planned ? '已融入大纲' : '待融入'} · ${item.text}`;
      if (!item.planned) {
        const remove = document.createElement('button');
        remove.className = 'btn';
        remove.textContent = '移除';
        remove.disabled = !!active;
        remove.onclick = () => {
          writer.additions = writer.additions.filter((entry) => entry.id !== item.id);
          render();
          scheduleSave();
        };
        li.append(remove);
      }
      additions.append(li);
    }
    refreshHistoryOptions();
    renderRecoveryControls();
    qualityNotice(
      'inspirationOutlineQuality',
      state.uiDrafts.generationQualityReports?.outline || writer.outlineQuality,
      '已完成结构与因果精修',
      'outline',
      state.outline,
    );
    sidebar();
    outlineEditor();
    reader();
    actions();
  }
  function showStream(phase, chunk = '', reset = false) {
    if (reset || phase !== streamPhase) {
      streamPhase = phase;
      streamText = '';
    }
    streamText += chunk;
    $('inspirationProcessLabel').textContent = phase;
    $('inspirationProcessText').textContent = streamText;
    updateTaskLabel();
    if (active) {
      lane().recoveryDraft = {
        task: active.kind,
        phase,
        text: streamText.slice(-80000),
        chapter: active.chapter,
        prose: active.receivedProse.slice(-80000),
        previousContentHash: hash(active.previousContent),
      };
      active.checkpointVersion++;
      scheduleCheckpoint();
    }
  }
  function scheduleCheckpoint() {
    const task = active;
    if (!task || task.checkpointFailed || checkpointTimer || task.checkpointInFlight) return;
    checkpointTimer = setTimeout(() => {
      checkpointTimer = null;
      void checkpoint(task);
    }, 2000);
  }
  async function checkpoint(task) {
    if (
      active !== task ||
      task.checkpointFailed ||
      task.checkpointInFlight ||
      task.checkpointSaved === task.checkpointVersion
    )
      return;
    const version = task.checkpointVersion;
    task.checkpointInFlight = true;
    try {
      const result = await Store.save({ forceProject: true });
      if (active !== task) return;
      if (!result?.projectSaved) {
        task.checkpointFailed = true;
        $('inspirationSaveState').textContent = '草稿保存失败 · 点击重试';
        if (result?.error?.status === 409) {
          task.checkpointConflict = true;
          task.cancelled = true;
          task.controller.abort();
          state.abortController?.abort();
          status('保存冲突，已停止生成；请先对比并解决冲突。', true);
        }
        return;
      }
      task.checkpointSaved = version;
      if (!dirty) $('inspirationSaveState').textContent = '草稿已保存';
    } catch {
      task.checkpointFailed = true;
      if (active === task) $('inspirationSaveState').textContent = '草稿保存失败 · 点击重试';
    } finally {
      task.checkpointInFlight = false;
      if (active === task && task.checkpointSaved !== task.checkpointVersion) scheduleCheckpoint();
    }
  }
  function renderRecoveryControls() {
    const draft = lane().recoveryDraft;
    const number = Number(draft?.chapter);
    const text =
      draft?.task === 'write' && clean(draft.prose) ? globalThis.sanitizeGeneratedText(draft.prose) : '';
    const available = !active && Number.isInteger(number) && number > 0 && text && text !== body(number);
    $('inspirationRecovery').hidden = !available;
    if (!available) return;
    $('inspirationRecoveryNote').textContent =
      `第 ${number} 章收到 ${text.replace(/\s/g, '').length.toLocaleString()} 字初稿，未完成精修；恢复前会保留现有正文快照。`;
    $('inspirationProcess').hidden = false;
  }
  async function restoreReceivedProse() {
    if (active) return;
    const writer = lane(),
      draft = writer.recoveryDraft,
      number = Number(draft?.chapter);
    if (draft?.task !== 'write' || !Number.isInteger(number) || number <= 0 || !clean(draft.prose)) return;
    const text = globalThis.sanitizeGeneratedText(draft.prose),
      previousContent = body(number);
    if (!clean(text) || text === previousContent) return;
    if (
      clean(previousContent) &&
      !confirm(
        hash(previousContent) === draft.previousContentHash
          ? `恢复第 ${number} 章收到的初稿？会先保留当前正文快照，初稿尚未完成精修。`
          : `第 ${number} 章正文已在检查点后变化。恢复会用收到的初稿替换当前正文，并先保留当前正文快照。继续吗？`,
      )
    )
      return;
    state.currentChapter = number;
    globalThis.saveChapterWithSafety(number, text, 'inspiration-checkpoint-restored', {
      route: 'chapter',
      snapshotSource: 'before inspiration checkpoint recovery',
      previousContent,
      snapshot: !!clean(previousContent),
    });
    state.uiDrafts.generationQualityReports ||= {};
    state.uiDrafts.generationQualityReports.chapters ||= {};
    state.uiDrafts.generationQualityReports.chapters[String(number)] = {
      status: 'unverified',
      reason: '从生成检查点恢复的初稿，尚未完成精修。',
    };
    writer.pendingChapter = number;
    writer.lastTask = 'write';
    writer.phase = 'paused';
    writer.view = 'write';
    viewed = selected = number;
    globalThis.renderWriteTab();
    changeVersion++;
    dirty = true;
    render();
    try {
      await save();
      status(`第 ${number} 章接收初稿已恢复并保存 · 尚未完成精修`);
    } catch (error) {
      status(error.message, true);
      $('inspirationSaveState').textContent = '保存失败 · 点击重试';
    }
  }
  function captureAddition() {
    const value = clean($('inspirationAdditionInput').value);
    if (value) lane().additions.push({ id: id(), text: value });
    lane().additionDraft = '';
    $('inspirationAdditionInput').value = '';
  }
  function sourceContext() {
    const previous = [...state.chapters]
      .filter((item) => clean(item.content))
      .sort((a, b) => Number(a.chapter) - Number(b.chapter));
    return [
      `书名与类型：${state.project.title} / ${state.project.genre}`,
      `背景设定：\n${state.project.setting || ''}`,
      `人物设定：\n${state.project.characters || ''}`,
      `创作方向（未发生的计划，不是正史）：\n${lane().direction || ''}`,
      globalThis.buildExtraWritingContext?.('outline') || '',
      `现有大纲（已写章节不可修改）：\n${JSON.stringify(
        outline().map((item) => ({
          ...item,
          chapter: Number(item.chapter),
          note: item.note || '',
          plotPoints: (item.plotPoints || []).map((point) =>
            typeof point === 'string' ? { desc: point } : { ...point, id: undefined, done: undefined },
          ),
        })),
        (_key, value) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
            : value,
      )}`,
      `辅助记忆（已过滤失效来源；未确认内容仅供参考，正文与作者设定优先）：\n${(globalThis.buildOutlineMemoryContext?.() || '').slice(0, 18000)}`,
      ...previous
        .slice(-2)
        .map((item) => `第 ${item.chapter} 章已写正文（权威事实）：\n${item.content.slice(-16000)}`),
    ]
      .filter(Boolean)
      .join('\n\n');
  }
  function mergeGeneratedOutlineChapter(proposed) {
    const previous = chapter(Number(proposed.chapter));
    const unmatched = [...(previous?.plotPoints || [])];
    const plotPoints = proposed.plotPoints.map((point) => {
      const index = unmatched.findIndex(
        (old) => clean(typeof old === 'string' ? old : old.desc) === clean(point.desc),
      );
      const old = index < 0 ? null : unmatched.splice(index, 1)[0];
      // Parser IDs are relative to the returned array, so a partial outline can
      // collide with preserved chapters. Keep unchanged beats' identity and
      // progress; new or changed beats receive a fresh project-safe identity.
      return old && typeof old === 'object'
        ? { ...old, id: old.id || id(), desc: point.desc }
        : { id: id(), desc: point.desc, done: false };
    });
    // AI owns title/summary/beats, not the author's per-chapter instructions
    // or extension metadata. A regenerated chapter is not a new blank object.
    return {
      ...previous,
      chapter: proposed.chapter,
      title: proposed.title,
      summary: proposed.summary,
      plotPoints,
    };
  }
  function validatedOutline(text, start, end) {
    const parsed = globalThis.parseOutlineJSON(text);
    if (!parsed?.length) throw new Error('没有解析到章节大纲，原大纲与原始输出已保留。');
    const proposed = parsed.filter((item) => item.chapter >= start && item.chapter <= end);
    if (new Set(proposed.map((item) => item.chapter)).size !== proposed.length)
      throw new Error('AI 返回了重复章节编号，原大纲已保留。');
    const missing = [];
    for (let n = start; n <= end; n++) {
      const item = proposed.find((entry) => entry.chapter === n);
      if (
        !item ||
        !clean(item.title) ||
        !clean(item.summary) ||
        !item.plotPoints?.length ||
        item.plotPoints.some((point) => !clean(point.desc))
      )
        missing.push(n);
    }
    if (missing.length)
      throw new Error(`大纲不完整，缺第 ${missing.join('、')} 章。原大纲已保留；可重试或手动补齐。`);
    if (proposed.length !== end - start + 1) throw new Error('大纲包含范围外的非整数章节，原大纲已保留。');
    return proposed.sort((a, b) => a.chapter - b.chapter);
  }
  function renderOutlineBatchPreview() {
    const host = $('inspirationBatchPreview'),
      cache = lane().outlineBatchDraft;
    host.hidden = !Array.isArray(cache?.chapters) || !cache.chapters.length;
    if (host.hidden) return;
    $('inspirationBatchPreviewLabel').textContent =
      `规划草稿 · ${cache.chapters.length} / ${cache.end - cache.start + 1} 章 · 尚未替换原大纲`;
    const contents = $('inspirationBatchPreviewContent');
    contents.replaceChildren();
    for (const item of cache.chapters) {
      const card = document.createElement('article');
      card.className = 'inspiration-outline-card';
      const title = document.createElement('h3'),
        summary = document.createElement('p');
      title.textContent = `第 ${item.chapter} 章 · ${item.title}`;
      summary.textContent = item.summary;
      const points = document.createElement('ol');
      for (const point of item.plotPoints || []) {
        const row = document.createElement('li');
        row.textContent = typeof point === 'string' ? point : point.desc;
        points.append(row);
      }
      card.append(title, summary, points);
      contents.append(card);
    }
  }
  function outlineBatchMessages(start, end, context) {
    return [
      {
        role: 'system',
        content:
          '你是长篇小说结构编辑。作者明确要求与已写正文优先。只输出包含 chapter、title、summary、plotPoints 的 JSON 数组，不写正文、说明或代码围栏。',
      },
      {
        role: 'user',
        content: `【灵感开写 · 章节大纲】\n${context}\n\n生成第 ${start}–${end} 章，严格覆盖全部 ${end - start + 1} 章，编号不重复，不留空缺。已写正文与作者确认设定不可推翻；范围内已写章节只按既有事实概括，不重构剧情。\n每章概要180-320字；每章剧情关键点2-5个。用具体行动、阻力、主动选择、代价、信息或关系变化串起因果。每章有独立叙事职责，前章结果迫使后章行动；避免机械幕式、无代价升级、重复线索和泛泛总结。只在全篇最后一批收束全书，前面各批留下与后续因果弧一致的接力，不把每批都写成独立结局。收尾兑现前文承诺，不凭空新增设定；用作品特有规则与人物矛盾决定事件，而非给模板换名字。\n每项：{"chapter":章节编号,"title":"标题","summary":"本章完整因果链与结尾状态","plotPoints":["可以演出的具体事件与后果"]}。只生成大纲，等待作者确认后才写正文。`,
      },
    ];
  }
  async function planOutline(task, start, end) {
    const context = sourceContext();
    const options = { signal: task.controller.signal, progressOwnerId: task.id };
    const writer = lane(),
      fingerprint = hash([context, start, end]);
    let cache = writer.outlineBatchDraft;
    if (cache && (cache.fingerprint !== fingerprint || cache.start !== start || cache.end !== end)) {
      if (Array.isArray(cache.chapters) && cache.chapters.length) {
        writer.outlineHistory.unshift({
          id: id(),
          time: Date.now(),
          source: '未完成规划草稿（输入已变更）',
          chapters: structuredClone(cache.chapters),
          chapterCount: cache.end,
          planning: { seed: cache.seed, plannedAdditionIds: cache.plannedAdditionIds || [] },
        });
      }
      delete writer.outlineBatchDraft;
      cache = null;
    }
    if (end - start + 1 <= OUTLINE_BATCH_SIZE)
      return globalThis.runOutlineQualityTask(outlineBatchMessages(start, end, context), {
        ...options,
        start,
        end,
      });
    if (cache && cache.fingerprint === fingerprint && cache.start === start && cache.end === end) {
      if (
        cache.version !== 1 ||
        !Number.isInteger(cache.nextStart) ||
        cache.nextStart < start ||
        cache.nextStart > end + 1 ||
        !Array.isArray(cache.chapters) ||
        !Array.isArray(cache.reports)
      )
        throw new Error('分批规划缓存不完整；原大纲和草稿仍保留，请先检查规划草稿。');
      if (cache.nextStart > start)
        validatedOutline(JSON.stringify(cache.chapters), start, cache.nextStart - 1);
      if (cache.chapters.length !== cache.nextStart - start)
        throw new Error('分批规划缓存章数不匹配，原内容已保留。');
      let covered = start;
      for (const report of cache.reports) {
        if (
          report?.start !== covered ||
          !Number.isInteger(report.end) ||
          report.end < covered ||
          report.end - covered + 1 > OUTLINE_BATCH_SIZE ||
          report.end >= cache.nextStart
        )
          throw new Error('分批审校记录与草稿范围不匹配，原内容已保留。');
        covered = report.end + 1;
      }
      if (covered !== cache.nextStart) throw new Error('分批审校记录缺失，原内容已保留。');
    } else {
      cache = writer.outlineBatchDraft = {
        version: 1,
        fingerprint,
        start,
        end,
        nextStart: start,
        chapters: [],
        reports: [],
        architecture: '',
        seed: writer.seed,
        plannedAdditionIds: writer.additions.map((item) => item.id),
      };
    }
    for (let from = cache.nextStart; from <= end; from = cache.nextStart) {
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      const to = Math.min(end, from + OUTLINE_BATCH_SIZE - 1);
      task.batchRange = { start: from, end: to, total: end };
      status(`正在规划第 ${from}–${to} 章 · 已完成 ${cache.chapters.length} / ${end - start + 1} 章草稿`);
      const recent = cache.chapters.slice(-OUTLINE_BATCH_SIZE);
      const earlier = cache.chapters.slice(0, -OUTLINE_BATCH_SIZE).map((item) => ({
        chapter: item.chapter,
        title: item.title,
        handoff: item.plotPoints?.at(-1)?.desc || item.summary,
      }));
      const continuity = cache.chapters.length
        ? `\n\n【已完成批次的规划接力｜不是已发生正史】\n较早章节的末尾事件：${JSON.stringify(earlier)}\n相邻前批完整规划：${JSON.stringify(recent)}\n承接前批结尾的局势、线索和人物选择；不得重写或重复交付前批。`
        : '';
      const result = await globalThis.runOutlineQualityTask(
        outlineBatchMessages(
          from,
          to,
          `${context}\n完整规划范围：第 ${start}–${end} 章。当前只交付第 ${from}–${to} 章；全篇因果与结尾按统一蓝图推进。${continuity}`,
        ),
        {
          ...options,
          start: from,
          end: to,
          architecture: cache.architecture,
          architectureScope: {
            kind: start === 1 ? 'generate' : 'continue',
            start,
            end,
            count: end - start + 1,
          },
        },
      );
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      const rows = validatedOutline(result.text, from, to);
      cache.chapters.push(...rows);
      cache.reports.push({ start: from, end: to, quality: result.quality });
      cache.architecture ||= result.architecture || '';
      cache.nextStart = to + 1;
      // The owned proposal checkpoints before another model request. Canonical
      // chapters and approval remain untouched until every batch is validated.
      await save();
      if (writer.view === task.startingView && writer.view === 'ideas' && !outline().length)
        writer.view = 'outline';
      render();
    }
    const reports = cache.reports.map((entry) => entry.quality);
    const unified = !!cache.architecture && reports.every((report) => clean(report?.outlineArchitecture));
    const statusValue =
      !unified || reports.some((report) => !['reviewed', 'repaired'].includes(report?.status))
        ? 'unverified'
        : reports.some((report) => report.status === 'repaired')
          ? 'repaired'
          : 'reviewed';
    return {
      text: JSON.stringify(cache.chapters),
      quality: {
        status: statusValue,
        feedback: `共 ${cache.reports.length} 批逐批精修，${unified ? '沿用统一全篇结构' : '部分批次未取得完整故事蓝图'}；未额外进行全书整体审校。`,
        reason: [
          !unified ? '全篇蓝图未能完整覆盖所有批次，请核对跨批次的因果与伏笔。' : '',
          ...reports.map((report) => report?.reason).filter(Boolean),
        ]
          .filter(Boolean)
          .join('；'),
        outlineArchitecture: cache.architecture,
        batches: cache.reports.map(({ start, end, quality }) => ({
          start,
          end,
          status: quality?.status || 'unverified',
        })),
      },
    };
  }
  async function foundation(task) {
    const writer = lane(),
      key = hash([writer.seed, pending().map((item) => item.text)]);
    if (writer.foundationKey === key || outline().length || state.project.setting) return;
    showStream('提炼故事方向', '', true);
    const messages = [
      {
        role: 'system',
        content:
          '你是小说策划。把零碎灵感变为独特、有因果关系、能支撑整本小说的创作方向。不让作者填表，不输出正文。只输出有效 JSON。',
      },
      {
        role: 'user',
        content: `【灵感开写 · 故事方向】\n${sourceContext()}\n\n尊重作者灵感；补齐必要世界规则、少量有欲望与矛盾的角色、核心戏剧问题与主要对抗力量。用作品独有机制推动选择与代价，不套升级公式，不提前写成已发生的剧情。写清起点、长线承诺、升级机制与最终问题，允许作者修改。\nJSON：{"title":"书名","genre":"类型","setting":"必要世界规则与背景","characters":"人物欲望、错误信念、关系与代价","direction":"故事方向与整体因果弧"}`,
      },
    ];
    let plan;
    for (let attempt = 0; attempt < 2; attempt++) {
      let started = false;
      const raw = await globalThis.apiStreamChat(
        messages,
        (chunk) => {
          showStream('提炼故事方向', chunk, !started);
          started = true;
        },
        {
          route: 'outline',
          progressOwnerId: task.id,
          signal: task.controller.signal,
          onReasoning: (chunk) => showStream('构思中', chunk),
        },
      );
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      try {
        plan = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        if (
          raw.length > 50000 ||
          !['title', 'genre', 'setting', 'characters', 'direction'].every((field) => clean(plan[field]))
        )
          throw new Error('缺少书名、类型、背景、人物或故事方向');
        break;
      } catch (error) {
        if (attempt) throw new Error(`故事方向格式不完整：${error.message}。灵感已保留。`);
        messages.push(
          { role: 'assistant', content: raw },
          { role: 'user', content: '保持原意，补齐全部字段，返回完整有效JSON，不要解释。' },
        );
      }
    }
    if (writer.autoSetup && state.project.title === writer.initialTitle)
      state.project.title = clean(plan.title).slice(0, 200);
    if (!state.project.genre) state.project.genre = clean(plan.genre).slice(0, 100);
    if (!state.project.setting)
      state.project.setting = `作者灵感：\n${writer.seed}\n\n背景提案（正文优先）：\n${clean(plan.setting)}`;
    if (!state.project.characters) state.project.characters = clean(plan.characters);
    writer.direction = clean(plan.direction);
    if (!state.project.novelNote)
      state.project.novelNote = `创作方向（计划，正文优先）：\n${writer.direction}`;
    writer.foundationKey = key;
    globalThis.loadProjectToUI();
    globalThis.renderWriteTab();
    await save();
  }
  function begin(kind, number = null) {
    if (!ready || active || state.generating || state.autoGenerating) {
      status('另一个生成任务正在运行。', true);
      return null;
    }
    if (!state.baseURL || !state.model) {
      status('尚未配置可用模型。已有全局 API 配置自动沿用，首次使用只需配置一次。', true);
      globalThis.openSettings();
      return null;
    }
    clearTimer();
    const task = {
      id: id(),
      kind,
      chapter: number,
      controller: new AbortController(),
      cancelled: false,
      previousContent: number ? body(number) : '',
      receivedProse: '',
      checkpointVersion: 0,
      checkpointSaved: 0,
      checkpointInFlight: false,
      checkpointFailed: false,
      startingView: lane().view,
    };
    active = task;
    lane().lastTask = kind;
    lane().phase = kind === 'outline' ? 'outlining' : 'writing';
    lane().error = '';
    if (kind === 'write') lane().pendingChapter = number;
    showStream(kind === 'write' ? '准备正文' : '准备大纲', '', true);
    render();
    $('inspirationProcess').open = true;
    return task;
  }
  async function failure(error, task) {
    // The quality pass buffers native callbacks until revision completes. Retain
    // only streamed prose (never planning/critique) through the native safe writer.
    // Existing content was explicitly confirmed before a retry and is snapshotted.
    if (task.kind === 'write' && clean(task.receivedProse) && body(task.chapter) === task.previousContent) {
      const draft = globalThis.sanitizeGeneratedText(task.receivedProse);
      if (clean(draft)) {
        globalThis.saveChapterWithSafety(task.chapter, draft, 'inspiration-interrupted-draft', {
          route: 'chapter',
          snapshotSource: 'before interrupted inspiration generation',
          previousContent: task.previousContent,
          snapshot: !!clean(task.previousContent),
        });
        state.uiDrafts.generationQualityReports ||= {};
        state.uiDrafts.generationQualityReports.chapters ||= {};
        state.uiDrafts.generationQualityReports.chapters[String(task.chapter)] = {
          status: 'unverified',
          reason: '生成中断：仅保留已收到的初稿，尚未完成精修。',
        };
        globalThis.renderWriteTab();
      }
    }
    lane().phase = task.cancelled || error.name === 'AbortError' ? 'paused' : 'error';
    lane().error = task.checkpointConflict
      ? '生成检查点遇到保存冲突，已停止生成；请先对比并解决冲突，接收草稿仍在当前页面。'
      : lane().phase === 'paused'
        ? task.kind === 'outline'
          ? '已停止，原大纲和接收草稿已保留。'
          : '已停止，正文草稿已保留；重试前会保留快照。'
        : error.message;
    status(lane().error, lane().phase === 'error');
    if (task.kind === 'outline' && lane().outlineBatchDraft?.chapters?.length) {
      const cache = lane().outlineBatchDraft;
      lane().error += ` 已保留 ${cache.chapters.length} 章规划草稿；输入不变时重试会从第 ${cache.nextStart} 章继续。`;
      status(lane().error, lane().phase === 'error');
    }
    try {
      await save();
    } catch {
      /* Shared conflict resolver retains local snapshots. */
    }
  }
  function release(task) {
    clearTimeout(checkpointTimer);
    checkpointTimer = null;
    if (state.abortController === task.controller) {
      state.abortController = null;
      state.generating = false;
    }
    active = null;
    render();
  }
  async function generateOutline() {
    if (pendingCompletedResult) return retryCompletedSave();
    const writer = lane();
    writer.seed = clean($('inspirationSeedInput').value);
    if (!writer.seed && !state.project.setting && !outline().length) {
      setView('ideas');
      $('inspirationSeedInput').focus();
      status('写下一句灵感就可以开始。', true);
      return;
    }
    const task = begin('outline');
    if (!task) return;
    captureAddition();
    const additions = pending().map((item) => item.id),
      seed = writer.seed;
    const start = firstUnwritten(),
      end = endChapter();
    if (start > end) {
      status('当前计划已经写完，先扩展章节数，再生成后续大纲。');
      release(task);
      return;
    }
    try {
      await save();
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      state.generating = true;
      state.abortController = task.controller;
      await foundation(task);
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      task.stage = 'outline';
      status(`正在规划第 ${start}–${end} 章 · 可继续浏览已有内容`);
      const result = await planOutline(task, start, end);
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      const proposed = validatedOutline(result.text, start, end);
      snapshot('AI 更新前');
      const preserved = outline().filter(
        (item) => item.chapter < start || item.chapter > end || clean(body(Number(item.chapter))),
      );
      state.outline = preserved
        .concat(
          proposed.filter((item) => !clean(body(Number(item.chapter)))).map(mergeGeneratedOutlineChapter),
        )
        .sort((a, b) => a.chapter - b.chapter);
      state.uiDrafts.generationQualityReports ||= { chapters: {} };
      state.uiDrafts.generationQualityReports.outline = result.quality
        ? globalThis.generationQuality.createReport(
            { ...result.quality, mode: 'outline' },
            'outline',
            0,
            state.outline,
          )
        : null;
      delete writer.outlineQuality;
      writer.builtSeed = seed;
      writer.approvedOutline = null;
      for (const item of writer.additions) if (additions.includes(item.id)) item.planned = true;
      writer.phase = 'review';
      if (writer.view === task.startingView) writer.view = 'outline';
      writer.pendingChapter = null;
      delete writer.recoveryDraft;
      delete writer.outlineBatchDraft;
      globalThis.renderOutline();
      task.resultReady = true;
      pendingCompletedResult = { kind: 'outline', chapter: null };
      await save();
      selected = 0;
      status(`章节大纲已保存 · ${outline().length} 章 · 检查或修改后，再开始正文`);
      $('inspirationProcess').open = false;
      $('inspirationProcessLabel').textContent = '查看生成过程';
      $('toast')?.classList.remove('show');
    } catch (error) {
      if (task.resultReady) completedSaveFailure(error);
      else await failure(error, task);
    } finally {
      release(task);
    }
  }
  async function writeChapter() {
    if (pendingCompletedResult) return retryCompletedSave();
    if (active) return;
    const writer = lane(),
      number = nextChapter();
    if (
      coverage().length ||
      pending().length ||
      clean(writer.additionDraft) ||
      (writer.builtSeed != null && writer.builtSeed !== writer.seed)
    ) {
      status('先补齐并更新章节大纲，正文不会跳过这一步。', true);
      return;
    }
    if (number > endChapter()) {
      status('计划中的章节已经全部写完。');
      return;
    }
    if (
      clean(body(number)) &&
      !confirm(`第 ${number} 章已有草稿。重试会先保留快照，再重新生成本章，继续吗？`)
    )
      return;
    const task = begin('write', number);
    if (!task) return;
    writer.approvedOutline = outlineKey();
    viewed = number;
    selected = number;
    writer.view = 'write';
    render();
    try {
      await save();
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      state.currentChapter = number;
      globalThis.loadProjectToUI();
      globalThis.renderWriteTab();
      status(`正在写第 ${number} 章 · 使用已确认大纲`);
      const result = await globalThis.generateChapter({ progressOwnerId: task.id });
      if (task.cancelled) throw new DOMException('已停止', 'AbortError');
      if (!result || !clean(body(number)))
        throw new Error($('toast')?.textContent || '本章生成未完成，请重试。');
      writer.phase = 'done';
      writer.pendingChapter = null;
      writer.completedChapter = number;
      delete writer.recoveryDraft;
      task.resultReady = true;
      pendingCompletedResult = { kind: 'write', chapter: number };
      await save();
      status(`第 ${number} 章已保存 · 可编辑正文或继续下一章`);
      $('inspirationProcess').open = false;
      $('inspirationProcessLabel').textContent = '查看生成过程';
      $('toast')?.classList.remove('show');
    } catch (error) {
      if (task.resultReady) completedSaveFailure(error);
      else await failure(error, task);
    } finally {
      release(task);
    }
  }
  const nativeSwitch = globalThis.switchTab;
  globalThis.switchTab = function (tab, ...args) {
    const first = !ready;
    ready = true;
    const target = first && params.get('mode') === 'inspiration' ? 'inspiration' : tab;
    if (
      target === 'inspiration' &&
      state.currentTab !== 'inspiration' &&
      !state.generating &&
      state.currentChapter > 0
    )
      globalThis.renderWriteTab();
    document.body.classList.toggle('inspiration-mode', target === 'inspiration');
    const result = nativeSwitch.call(this, target, ...args);
    if (target === 'inspiration') {
      const writer = lane();
      if (first) {
        try {
          const savedView = sessionStorage.getItem(viewKey);
          if (['ideas', 'outline', 'write'].includes(savedView)) writer.view = savedView;
        } catch {
          /* A blocked preference store must not block the novel. */
        }
      }
      viewed = Math.max(
        1,
        ...state.chapters.filter((item) => clean(item.content)).map((item) => Number(item.chapter)),
      );
      render();
      status(
        writer.error ||
          (interruptedPhase() && writer.recoveryDraft
            ? '有生成检查点，可查看已收到的草稿；继续操作时会检测版本冲突。'
            : outline().length
              ? '先检查章节大纲，再开始正文。'
              : '从灵感开始，先生成章节大纲。'),
        writer.phase === 'error',
      );
      if (writer.recoveryDraft) {
        showStream(writer.recoveryDraft.phase, writer.recoveryDraft.text, true);
        $('inspirationProcess').hidden = false;
        if (first && !$('inspirationRecovery').hidden) $('inspirationProcess').open = true;
      }
      rememberView();
      if (first && params.has('start')) {
        params.delete('start');
        history.replaceState(null, '', `${location.pathname}?${params}`);
        if (writer.phase === 'idle' && !outline().length) queueMicrotask(generateOutline);
      }
    }
    return result;
  };
  window.addEventListener('novel-generation-progress', (event) => {
    if (!active || active.resultReady || (active.kind === 'outline' && active.stage !== 'outline')) return;
    const update = event.detail;
    if (update?.ownerId !== active.id) return;
    if (update.type === 'start') showStream(update.label, '', true);
    if (update.type === 'chunk') {
      const proseChunk =
        update.kind !== 'reasoning' && active.kind === 'write' && update.phase === '章节正文';
      if (proseChunk) active.receivedProse += update.text;
      showStream(
        update.kind === 'reasoning' ? `${update.phase} · 思考` : update.phase || streamPhase,
        update.text,
      );
      if (proseChunk && viewed === active.chapter) {
        paintReaderContent(true);
        $('inspirationProseQuality').hidden = true;
      }
    }
    if (update.phase)
      status(
        `${active.kind === 'outline' ? '章节大纲' : `第 ${active.chapter} 章`} · ${update.phase}${update.kind === 'reasoning' ? ' · 思考' : ''}`,
      );
  });
  document.addEventListener('DOMContentLoaded', () => {
    const button = document.createElement('button');
    button.className = 'tab-btn';
    button.dataset.tab = 'inspiration';
    button.textContent = '灵感开写';
    button.onclick = () => globalThis.switchTab('inspiration');
    $('tabBar').prepend(button);
    const panel = document.createElement('section');
    panel.id = 'tab-inspiration';
    panel.className = 'tab-content inspiration-workspace';
    panel.style.display = 'none';
    panel.innerHTML = `
      <header class="inspiration-header"><a href="/" class="btn">← 书库</a><h1 id="inspirationBookTitle">灵感开写</h1><button id="inspirationFull" class="btn">完整工作台 ↗</button></header>
      <nav class="inspiration-steps" aria-label="灵感创作步骤"><button data-inspiration-view="ideas"><span>01</span>灵感</button><button data-inspiration-view="outline"><span>02</span>章节大纲</button><button data-inspiration-view="write"><span>03</span>正文</button><button id="inspirationSaveState" class="inspiration-save-state" title="重试保存">已保存</button></nav>
      <div class="inspiration-status-bar"><span id="inspirationStatus" role="status" aria-live="polite"></span></div>
      <div id="inspirationStudio" class="inspiration-studio is-ideas"><aside id="inspirationSidebar" class="inspiration-sidebar" hidden><div class="inspiration-rail-head"><button id="inspirationOverview" class="btn">大纲总览</button><span id="inspirationOutlineCount"></span></div><div id="inspirationChapterList"></div><button id="inspirationAddChapter" class="btn">＋ 补一章</button><details><summary>更多</summary><button id="inspirationExtend" class="btn">再规划 8 章</button><div id="inspirationHistoryTools" hidden><label for="inspirationHistory">大纲历史</label><select id="inspirationHistory"></select><button id="inspirationRestore" class="btn">恢复未写章节</button></div></details></aside>
      <main class="inspiration-main"><footer class="inspiration-footer"><p id="inspirationPlanGate"></p><span id="inspirationTaskLabel" aria-hidden="true" hidden></span><div><button id="inspirationRun" class="btn">生成章节大纲 →</button><button id="inspirationWrite" class="btn btn-primary">确认大纲，写第 1 章 →</button><button id="inspirationStop" class="btn" hidden>停止</button></div></footer>
      <details id="inspirationProcess" class="inspiration-process"><summary id="inspirationProcessLabel">生成过程</summary><pre id="inspirationProcessText"></pre></details>
      <section id="inspirationView-ideas" class="inspiration-ideas"><div class="inspiration-kicker">灵感开写</div><h2>一个念头，也能成为一本书。</h2><p class="inspiration-muted">先生成章节大纲，改好再写正文。</p><label for="inspirationSeedInput">你的灵感</label><textarea id="inspirationSeedInput" maxlength="20000" rows="8" placeholder="想到什么就写什么：画面、对白、人物困境、一个奇怪的世界规则……"></textarea><details class="inspiration-options"><summary>篇幅选项</summary><div><label>计划章节数<input id="inspirationChapterCount" type="number" min="1" max="200" /></label><label>每章目标字数<input id="inspirationLength" type="number" min="100" max="20000" step="100" /></label></div></details><p id="inspirationDirection" class="inspiration-direction" hidden></p></section>
      <section id="inspirationView-outline" hidden><div class="inspiration-content-head"><h2 id="inspirationOutlineHeading">章节大纲</h2><button id="inspirationAddBeat" class="btn">＋ 关键事件</button></div><div id="inspirationOutlineQuality" class="inspiration-quality" hidden></div><div id="inspirationOutlineOverview"></div><div id="inspirationOutlineEditor" hidden><p id="inspirationOutlineLocked" class="inspiration-muted" hidden>本章已有正文，保留原大纲；正文可在“正文”页修改。</p><label for="inspirationOutlineTitle">章节标题</label><input id="inspirationOutlineTitle" maxlength="200" /><label for="inspirationOutlineSummary">章节概要</label><textarea id="inspirationOutlineSummary" rows="9" maxlength="20000"></textarea><label>关键事件</label><div id="inspirationPlotPoints"></div><details class="inspiration-options"><summary>本章写作要求（可选）</summary><textarea id="inspirationOutlineNote" rows="4" maxlength="20000" aria-label="本章写作要求"></textarea></details></div></section>
      <section id="inspirationView-write" hidden><div class="inspiration-content-head"><h2 id="inspirationChapterTitle">第 1 章</h2><select id="inspirationChapterSelect" aria-label="阅读章节"></select><span id="inspirationWords">0 字</span><button id="inspirationSave" class="btn">保存正文</button></div><div id="inspirationProseQuality" class="inspiration-quality" hidden></div><textarea id="inspirationEditor" aria-label="小说正文" spellcheck="false" placeholder="先确认章节大纲，再开始正文。生成期间可以阅读旧章。"></textarea></section>
      <details id="inspirationAdditional" class="inspiration-options" hidden><summary>补充灵感</summary><form id="inspirationAdditionForm"><textarea id="inspirationAdditionInput" rows="3" maxlength="10000" placeholder="接下来想让……（只更新未写章节，已写正文不变）" aria-label="追加灵感"></textarea><button id="inspirationAddButton" class="btn">记下灵感</button></form><ul id="inspirationAdditions"></ul></details>
      </main></div>`;
    $('app').append(panel);
    const batchHint = document.createElement('p');
    batchHint.id = 'inspirationBatchSizeHint';
    batchHint.className = 'inspiration-muted';
    $('inspirationView-ideas').querySelector('details').append(batchHint);
    const batchPreview = document.createElement('details');
    batchPreview.id = 'inspirationBatchPreview';
    batchPreview.className = 'inspiration-options';
    batchPreview.hidden = true;
    batchPreview.innerHTML =
      '<summary id="inspirationBatchPreviewLabel"></summary><section id="inspirationBatchPreviewContent"></section>';
    $('inspirationOutlineOverview').before(batchPreview);
    const footer = panel.querySelector('.inspiration-footer');
    const measureToolbar = () =>
      document.documentElement.style.setProperty(
        '--inspiration-toolbar-height',
        `${Math.ceil(footer.getBoundingClientRect().height) + 20}px`,
      );
    if (typeof ResizeObserver === 'function') new ResizeObserver(measureToolbar).observe(footer);
    else window.addEventListener('resize', measureToolbar);
    measureToolbar();
    const historyPreview = document.createElement('section');
    historyPreview.id = 'inspirationHistoryPreview';
    historyPreview.className = 'inspiration-history-review';
    historyPreview.hidden = true;
    historyPreview.innerHTML =
      '<div class="inspiration-content-head"><h2>历史大纲对比</h2><button id="inspirationHistoryClose" class="btn">收起对比</button></div><p id="inspirationHistorySummary"></p><p id="inspirationHistorySource"></p><div id="inspirationHistoryChanges"></div><button id="inspirationHistoryConfirm" class="btn">恢复此版本</button>';
    document
      .querySelector('#tab-inspiration .inspiration-main')
      .insertBefore(historyPreview, $('inspirationView-ideas'));
    $('inspirationHistoryClose').onclick = () => {
      comparingHistoryId = null;
      renderHistoryPreview();
    };
    $('inspirationHistory').onchange = () => {
      if (comparingHistoryId) {
        comparingHistoryId = $('inspirationHistory').value;
        renderHistoryPreview();
      }
    };
    const recovery = document.createElement('div');
    recovery.id = 'inspirationRecovery';
    recovery.className = 'inspiration-recovery';
    recovery.hidden = true;
    recovery.innerHTML =
      '<p id="inspirationRecoveryNote"></p><button id="inspirationRecoverProse" class="btn">恢复收到的正文初稿</button>';
    $('inspirationProcess').insertBefore(recovery, $('inspirationProcessText'));
    $('inspirationRecoverProse').onclick = restoreReceivedProse;
    document.querySelectorAll('[data-inspiration-view]').forEach((tab) => {
      tab.onclick = () => setView(tab.dataset.inspirationView);
    });
    $('inspirationFull').onclick = () => {
      if (active) return;
      if (lane().view === 'write') {
        state.currentChapter = viewed;
        globalThis.renderWriteTab();
      }
      globalThis.switchTab(lane().view === 'write' ? 'write' : 'outline');
    };
    $('inspirationRun').onclick = generateOutline;
    $('inspirationWrite').onclick = writeChapter;
    $('inspirationStop').onclick = () => {
      if (!active) return;
      active.cancelled = true;
      active.controller.abort();
      state.abortController?.abort();
      status('正在停止，保留原内容与草稿…');
    };
    $('inspirationOverview').onclick = () => {
      selected = 0;
      setView('outline');
    };
    $('inspirationSeedInput').oninput = () => {
      const writer = lane();
      if (outline().length && writer.builtSeed == null) writer.builtSeed = writer.seed;
      writer.seed = $('inspirationSeedInput').value;
      writer.approvedOutline = null;
      actions();
      scheduleSave();
    };
    for (const [id, field] of [
      ['inspirationChapterCount', 'chapterCount'],
      ['inspirationLength', 'wordsPerChapter'],
    ])
      $(id).onchange = () => {
        if (!$(id).checkValidity()) {
          status('请输入有效篇幅。', true);
          return;
        }
        const value = Number($(id).value),
          max = Math.max(
            0,
            ...state.chapters.filter((item) => clean(item.content)).map((item) => Number(item.chapter)),
            ...outline().map((item) => Number(item.chapter)),
          );
        if (field === 'chapterCount' && value < max) {
          $(id).value = state.project.chapterCount;
          status('不能隐藏已有章节；请在完整工作台调整章节结构。', true);
          return;
        }
        state.project[field] = value;
        globalThis.loadProjectToUI();
        lane().approvedOutline = null;
        actions();
        scheduleSave();
      };
    $('inspirationAdditionInput').oninput = () => {
      lane().additionDraft = $('inspirationAdditionInput').value;
      actions();
      scheduleSave();
    };
    $('inspirationAdditionForm').onsubmit = (event) => {
      event.preventDefault();
      if (active) return;
      captureAddition();
      render();
      scheduleSave();
    };
    for (const [id, field] of [
      ['inspirationOutlineTitle', 'title'],
      ['inspirationOutlineSummary', 'summary'],
      ['inspirationOutlineNote', 'note'],
    ])
      $(id).oninput = () =>
        mutate((item) => {
          item[field] = $(id).value;
        });
    $('inspirationAddBeat').onclick = () => {
      mutate((item) => {
        item.plotPoints ||= [];
        item.plotPoints.push({ id: id(), desc: '', done: false });
      });
      renderPoints();
    };
    $('inspirationAddChapter').onclick = () => {
      if (active) return;
      const n = coverage()[0] || endChapter() + 1;
      if (!chapter(n)) {
        snapshot('补章前');
        state.outline.push({
          chapter: n,
          title: `第 ${n} 章`,
          summary: '',
          plotPoints: [{ id: id(), desc: '', done: false }],
        });
      }
      state.project.chapterCount = Math.max(state.project.chapterCount, n);
      lane().approvedOutline = null;
      selected = n;
      lane().view = 'outline';
      globalThis.loadProjectToUI();
      globalThis.renderOutline();
      render();
      scheduleSave();
    };
    $('inspirationExtend').onclick = () => {
      if (active) return;
      state.project.chapterCount = endChapter() + 8;
      lane().approvedOutline = null;
      globalThis.loadProjectToUI();
      render();
      scheduleSave();
    };
    $('inspirationRestore').onclick = () => {
      comparingHistoryId = $('inspirationHistory').value;
      renderHistoryPreview();
      $('inspirationHistoryPreview').scrollIntoView({ block: 'start' });
    };
    $('inspirationHistoryConfirm').onclick = () => {
      const saved = lane().outlineHistory.find((item) => item.id === comparingHistoryId);
      if (!historyRestorable(saved)) return;
      if (!saved || active || !confirm('恢复未写章节大纲？当前版本会保留在历史中，已写正文与其大纲不变。'))
        return;
      snapshot('恢复前');
      state.outline = outline()
        .filter((item) => clean(body(Number(item.chapter))))
        .concat(
          structuredClone(saved.chapters)
            .filter((item) => !clean(body(Number(item.chapter))))
            .map((item) => ({
              ...item,
              plotPoints: (item.plotPoints || []).map((point) =>
                typeof point === 'string' ? { id: id(), desc: point, done: false } : point,
              ),
            })),
        )
        .sort((a, b) => a.chapter - b.chapter);
      state.project.chapterCount = historyTargetCount(saved);
      const writer = lane();
      writer.approvedOutline = null;
      writer.builtSeed = saved.planning?.seed ?? null;
      const planned = new Set(saved.planning?.plannedAdditionIds || []);
      for (const item of writer.additions) item.planned = planned.has(item.id);
      state.uiDrafts.generationQualityReports ||= { chapters: {} };
      state.uiDrafts.generationQualityReports.outline = structuredClone(saved.quality || null);
      delete writer.outlineQuality;
      if (writer.lastTask !== 'write') {
        writer.phase = 'review';
        writer.error = '';
      }
      writer.view = 'outline';
      comparingHistoryId = null;
      globalThis.loadProjectToUI();
      globalThis.renderOutline();
      selected = 0;
      render();
      status('历史大纲已恢复；请核对灵感来源与章节内容，再确认正文。');
      scheduleSave();
    };
    $('inspirationChapterSelect').onchange = () => {
      viewed = Number($('inspirationChapterSelect').value);
      selected = viewed;
      sidebar();
      reader();
    };
    $('inspirationEditor').oninput = () => {
      if (active) return;
      const value = $('inspirationEditor').value;
      globalThis.setChapterContent(viewed, value, { skipSanitize: true });
      $('inspirationWords').textContent = `${value.replace(/\s/g, '').length.toLocaleString()} 字`;
      sidebar();
      actions();
      qualityNotice(
        'inspirationProseQuality',
        state.uiDrafts.generationQualityReports?.chapters?.[String(viewed)],
        '已完成精修',
        'chapter',
        value,
      );
      scheduleSave();
    };
    const saveNow = async () => {
      if (pendingCompletedResult) return retryCompletedSave();
      clearTimer();
      try {
        await save();
        if (active) {
          active.checkpointFailed = false;
          scheduleCheckpoint();
        }
        status('已保存。');
      } catch (error) {
        status(error.message, true);
      }
    };
    $('inspirationSave').onclick = saveNow;
    $('inspirationSaveState').onclick = saveNow;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      if (active) void checkpoint(active);
      else if (dirty) void saveNow();
    });
    window.addEventListener('beforeunload', (event) => {
      if (active || dirty || timer) {
        event.preventDefault();
        event.returnValue = '';
      }
    });
  });
})();
