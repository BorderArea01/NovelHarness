const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
export const pointText = (point) =>
  typeof point === 'string' ? point : object(point) && typeof point.desc === 'string' ? point.desc : '';
export function parseOutline(text) {
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  const rows = Array.isArray(value)
    ? value
    : object(value) && Array.isArray(value.chapters)
      ? value.chapters
      : null;
  if (!rows || rows.some((row) => !object(row)))
    throw new Error('大纲格式不兼容，请检查源文件；不会自动转换或丢弃内容。');
  return { value, rows };
}
export function editOutline(text, operation, uuid = () => crypto.randomUUID()) {
  const { value, rows } = parseOutline(text);
  if (operation.kind === 'add') {
    const numbers = rows.map((row) => Number(row.chapter)).filter((n) => Number.isSafeInteger(n) && n > 0);
    rows.push({ chapter: Math.max(0, ...numbers) + 1, title: '新章节', summary: '', plotPoints: [] });
  } else {
    const row = rows[operation.index];
    if (!row) throw new Error('章节已变化，请重新选择。');
    if (operation.kind === 'remove') rows.splice(operation.index, 1);
    else if (operation.kind === 'field') {
      if (!['chapter', 'title', 'summary', 'note', 'chapterPath'].includes(operation.field))
        throw new Error('不支持的章纲字段。');
      if (operation.field === 'chapterPath' && operation.value === '') row.chapterPath = null;
      else row[operation.field] = operation.value;
    } else {
      if (
        row.plotPoints !== undefined &&
        (!Array.isArray(row.plotPoints) ||
          row.plotPoints.some(
            (point) => typeof point !== 'string' && (!object(point) || typeof point.desc !== 'string'),
          ))
      )
        throw new Error('原剧情点结构不兼容，未覆盖；请先检查源文件。');
      row.plotPoints ??= [];
      if (operation.kind === 'add-point') row.plotPoints.push({ id: uuid(), desc: '', done: false });
      else {
        if (
          !Number.isSafeInteger(operation.point) ||
          operation.point < 0 ||
          operation.point >= row.plotPoints.length
        )
          throw new Error('剧情点已变化。');
        if (operation.kind === 'point')
          row.plotPoints[operation.point] = object(row.plotPoints[operation.point])
            ? { ...row.plotPoints[operation.point], desc: operation.value }
            : operation.value;
        else if (operation.kind === 'remove-point') row.plotPoints.splice(operation.point, 1);
        else if (operation.kind === 'move-point') {
          if (
            !Number.isSafeInteger(operation.to) ||
            operation.to < 0 ||
            operation.to >= row.plotPoints.length
          )
            throw new Error('移动位置无效。');
          row.plotPoints.splice(operation.to, 0, row.plotPoints.splice(operation.point, 1)[0]);
        } else throw new Error('未知章纲操作。');
      }
    }
  }
  return (
    (text.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(value, null, 2) +
    (text.endsWith('\n') ? '\n' : '')
  );
}
export { outlinePrompt, DIRECTION_PATH } from '../../../worker/shared/writing-prompts.mjs';
