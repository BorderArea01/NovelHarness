// Book-local, content-addressed assets. UTF-8 envelopes remain compatible with
// the existing complete book backup/restore; chapter text only stores a link.
export const ILLUSTRATION_LIMIT = 384 * 1024;
export const illustrationPath = (path) => /^illustrations\/[a-f0-9]{64}\.json$/.test(path ?? '');
export function imageAsset(text) {
  if (typeof text !== 'string' || text.length > ILLUSTRATION_LIMIT)
    throw new Error('插图文件过大或格式无效。');
  const value = JSON.parse(text);
  if (
    value?.format !== 'novel-illustration-v1' ||
    !Number.isInteger(value.width) ||
    !Number.isInteger(value.height) ||
    value.width < 1 ||
    value.height < 1 ||
    value.width > 1600 ||
    value.height > 1600 ||
    typeof value.data !== 'string' ||
    !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.data)
  )
    throw new Error('插图必须是有效的本书 WebP 图片。');
  const data = value.data.slice('data:image/webp;base64,'.length);
  const bytes = atob(data);
  if (
    btoa(bytes) !== data ||
    bytes.slice(0, 4) !== 'RIFF' ||
    bytes.slice(8, 12) !== 'WEBP' ||
    bytes.length < 20
  )
    throw new Error('插图编码损坏，未加载。');
  return {
    format: value.format,
    width: value.width,
    height: value.height,
    label: typeof value.label === 'string' ? value.label.slice(0, 160) : '',
    data: value.data,
  };
}
const captionText = (text) =>
  String(text ?? '')
    .replace(/[\r\n\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 160);
export function illustrationMarker(path, caption = '') {
  if (!illustrationPath(path)) throw new Error('插图路径无效。');
  return '![' + captionText(caption).replace(/[\\\[\]]/g, '\\$&') + '](' + path + ')';
}
export function illustrationEntries(text) {
  if (!text.includes('](illustrations/')) return [];
  const entries = [];
  let fence = null,
    from = 0;
  for (const line of text.split(/\r\n|\n|\r/)) {
    const fenced = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenced) {
      if (!fence) fence = { char: fenced[1][0], size: fenced[1].length };
      else if (fenced[1][0] === fence.char && fenced[1].length >= fence.size && !fenced[2].trim())
        fence = null;
    } else if (!fence) {
      const match = /^!\[((?:\\.|[^\]\\]){0,320})\]\((illustrations\/[a-f0-9]{64}\.json)\)$/.exec(line);
      if (match)
        entries.push({
          from,
          to: from + line.length,
          marker: line,
          path: match[2],
          caption: match[1].replace(/\\([\\\[\]])/g, '$1'),
        });
    }
    const at = from + line.length;
    from = at + (text.slice(at, at + 2) === '\r\n' ? 2 : at < text.length ? 1 : 0);
  }
  return entries;
}
export function insertIllustration(text, path, caption, end = text.length) {
  if (!Number.isInteger(end) || end < 0 || end > text.length) throw new Error('插图位置已失效。');
  const newline = /\r\n|\r|\n/.exec(text)?.[0] ?? '\n';
  // Insert after the selected paragraph; never split a sentence or title.
  const next = /(?:\r\n|\n|\r)[\t ]*(?:\r\n|\n|\r)/.exec(text.slice(end));
  const at = next ? end + next.index : text.length;
  return (
    text.slice(0, at) +
    newline +
    newline +
    illustrationMarker(path, caption) +
    text.slice(at) +
    (at === text.length ? newline : '')
  );
}
export function placeIllustration(text, { imagePath, caption, after, remove = false }) {
  const existing = illustrationEntries(text).filter((entry) => entry.path === imagePath);
  if (!illustrationPath(imagePath) || existing.length > 1)
    throw new Error('插图路径无效或在本章多次出现，请明确位置后再改。');
  if (remove && !existing.length) throw new Error('本章没有这张插图。');
  let result = existing.length ? text.slice(0, existing[0].from) + text.slice(existing[0].to) : text;
  if (remove) return result;
  if (typeof after !== 'string' || !after.trim() || after.length > 2000)
    throw new Error('请提供插图前的一段原文定位。');
  const at = result.indexOf(after);
  if (at < 0 || result.indexOf(after, at + 1) !== -1) throw new Error('定位原文不存在或不唯一，未修改正文。');
  return insertIllustration(result, imagePath, caption ?? existing[0]?.caption ?? '', at + after.length);
}
