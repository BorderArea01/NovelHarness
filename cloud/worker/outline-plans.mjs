const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const STORY_PLAN_PATH = 'notes/story-plan.md';
const clean = (value) => (typeof value === 'string' ? value.trim() : '');
export const beatText = (value) =>
  typeof value === 'string' ? value : object(value) && typeof value.desc === 'string' ? value.desc : '';
export function outlineShape(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  const chapters = Array.isArray(value)
    ? value
    : object(value) && Array.isArray(value.chapters)
      ? value.chapters
      : null;
  if (!chapters || chapters.some((row) => !object(row)))
    throw new Error('大纲需为章节数组或含 chapters 数组的对象；未转换原格式。');
  return { value, chapters };
}
export function planningRange(value) {
  return (
    object(value) &&
    Number.isSafeInteger(value.start) &&
    value.start >= 1 &&
    Number.isSafeInteger(value.end) &&
    value.end >= value.start &&
    value.end <= 10000 &&
    value.end - value.start < 12
  );
}
const projection = (row) => ({
  chapter: Number(row.chapter),
  title: row.title ?? '',
  summary: row.summary ?? '',
  plotPoints: (row.plotPoints ?? []).map(beatText),
});
export function assessOutline(beforeText, draftText, plan, directionText = '') {
  const result = { issues: [], chapters: [], storyPlan: '', previousStoryPlan: directionText, valid: false };
  let before, candidate;
  try {
    before = outlineShape(beforeText).chapters;
    candidate = JSON.parse(draftText.replace(/^\uFEFF/, ''));
  } catch (error) {
    result.issues.push(
      error instanceof SyntaxError ? '规划候选尚未完整，原大纲未改动；可继续浏览。' : error.message,
    );
    return result;
  }
  if (!planningRange(plan?.range)) {
    result.issues.push('提案缺少有效规划范围，请重新发起；原候选仍保留。');
    return result;
  }
  const { start, end } = plan.range;
  let rows = Array.isArray(candidate) ? candidate : object(candidate) ? candidate.chapters : null;
  if (!Array.isArray(rows) || rows.some((row) => !object(row))) {
    result.issues.push('候选缺少 chapters 章节数组。');
    return result;
  }
  // Current tasks submit an ORDERED list of chapter content. The frozen range,
  // not the model, assigns identifiers. Legacy explicit-number payloads remain
  // supported without guessing how an ambiguous/misnumbered list should map.
  if (rows.every((row) => !Object.hasOwn(row, 'chapter'))) {
    if (rows.length !== end - start + 1) {
      result.issues.push(
        '本批需要 ' + (end - start + 1) + ' 份章纲，当前收到 ' + rows.length + ' 份；请补齐本批内容。',
      );
      return result;
    }
    rows = rows.map((row, index) => ({ ...row, chapter: start + index }));
  }
  result.storyPlan =
    object(candidate) && typeof candidate.storyPlan === 'string' ? candidate.storyPlan : directionText;
  if (!clean(result.storyPlan))
    result.issues.push('首批规划需要 storyPlan 全篇方向；也可先在大纲页手工写下方向。');
  if (directionText.trim() && result.storyPlan !== directionText)
    result.issues.push('全篇方向已有定稿，本次分批规划不能顺手替换；请先在大纲页明确修改方向。');
  const oldNumbers = before.map((row) => Number(row.chapter));
  if (
    oldNumbers.some((number) => !Number.isSafeInteger(number) || number < 1) ||
    new Set(oldNumbers).size !== before.length
  )
    result.issues.push('原大纲存在空白、非整数或重复编号，请先手工修正。');
  const numbers = new Set(),
    missing = [];
  for (const row of rows) {
    const number = Number(row.chapter);
    if (!Number.isSafeInteger(number) || number < start || number > end || numbers.has(number))
      result.issues.push('章纲顺序无法对应本次范围；请按顺序只提交本批章节内容，章号由系统分配。');
    numbers.add(number);
    const previous = before.find((item) => Number(item.chapter) === number),
      locked = (plan.sources ?? []).some((source) => source.chapter === number && source.written);
    if (previous?.plotPoints !== undefined && !Array.isArray(previous.plotPoints))
      result.issues.push('第 ' + number + ' 章原剧情点结构不兼容，请先手工检查。');
    if (
      !clean(row.title) ||
      !clean(row.summary) ||
      !Array.isArray(row.plotPoints) ||
      !row.plotPoints.length ||
      row.plotPoints.some((point) => !clean(beatText(point)))
    )
      result.issues.push('第 ' + String(row.chapter) + ' 章缺少标题、概要或有效剧情点。');
    if (locked && previous) {
      try {
        if (JSON.stringify(projection(previous)) !== JSON.stringify(projection(row)))
          result.issues.push('第 ' + number + ' 章已有正文，本次不能改动其原规划；可手工校准。');
      } catch {
        result.issues.push('第 ' + number + ' 章原剧情点结构不兼容，请先检查。');
      }
    }
    for (const point of Array.isArray(previous?.plotPoints) ? previous.plotPoints : [])
      if (
        point?.done === true &&
        !(Array.isArray(row.plotPoints) ? row.plotPoints : []).some(
          (next) => clean(beatText(next)) === clean(beatText(point)),
        )
      )
        result.issues.push('第 ' + number + ' 章已完成的剧情点不能被 AI 移除或改名。');
    result.chapters.push({
      chapter: number,
      title: row.title,
      summary: row.summary,
      plotPoints: Array.isArray(row.plotPoints) ? row.plotPoints.map(beatText) : [],
      before: previous ?? null,
      locked,
    });
  }
  for (let number = start; number <= end; number++) if (!numbers.has(number)) missing.push(number);
  if (missing.length)
    result.issues.push('缺少第 ' + missing.join('、') + ' 章，请补齐候选；不必重生成已完成内容。');
  result.chapters.sort((a, b) => a.chapter - b.chapter);
  result.valid = result.issues.length === 0;
  return result;
}
export function mergeOutline(beforeText, assessment, uuid = () => crypto.randomUUID()) {
  if (!assessment.valid) throw new Error(assessment.issues[0] || '规划尚未通过检查。');
  const { value, chapters } = outlineShape(beforeText),
    next = structuredClone(chapters);
  for (const proposed of assessment.chapters) {
    const index = next.findIndex((row) => Number(row.chapter) === proposed.chapter),
      previous = index < 0 ? null : next[index];
    if (proposed.locked && previous) continue;
    const unmatched = [...(previous?.plotPoints ?? [])];
    const points = proposed.plotPoints.map((text) => {
      const found = unmatched.findIndex((old) => clean(beatText(old)) === clean(text));
      const old = found < 0 ? null : unmatched.splice(found, 1)[0];
      return object(old)
        ? { ...old, id: old.id || uuid(), desc: text }
        : { id: uuid(), desc: text, done: false };
    });
    const row = {
      ...previous,
      chapter: previous?.chapter ?? proposed.chapter,
      title: proposed.title,
      summary: proposed.summary,
      plotPoints: points,
    };
    if (index < 0) {
      const at = next.findIndex((item) => Number(item.chapter) > proposed.chapter);
      if (at < 0) next.push(row);
      else next.splice(at, 0, row);
    } else next[index] = row;
  }
  const result = Array.isArray(value) ? next : { ...value, chapters: next };
  return (
    (beforeText.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(result, null, 2) +
    (beforeText.endsWith('\n') ? '\n' : '')
  );
}
