// Chapter labels are derived from the manuscript/outline, never a second index.
export function chapterHeading(text) {
  return /^(\uFEFF?)#[\t ]+([^\r\n]*)(\r\n|\n|\r|$)/.exec(text);
}
export function chapterTitle(text, path) {
  const heading = chapterHeading(text);
  return heading?.[2].trim() || path.split('/').pop();
}
export function titleText(text, title) {
  const heading = chapterHeading(text);
  if (heading) return heading[1] + '# ' + title + heading[3] + text.slice(heading[0].length);
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = /\r\n|\n|\r/.exec(text)?.[0] ?? '\n';
  return bom + '# ' + title + newline + newline + text.slice(bom.length);
}
