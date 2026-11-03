// Textarea offsets use UTF-16 and LF; native ranges retain newline policy.
export const editorValue = (source) => source.replace(/\r\n|\r/g, '\n');
// One bounded edit for an external revision. Keep unchanged CodeMirror lines,
// selections and viewport instead of replacing a megabyte document for a small
// tail correction. Offsets are UTF-16 and never split a surrogate pair.
export function editorChange(before, after) {
  if (before === after) return null;
  let from = 0,
    to = before.length,
    end = after.length;
  const splitPair = (text, at) =>
    at > 0 && at < text.length && /[\uD800-\uDBFF]/.test(text[at - 1]) && /[\uDC00-\uDFFF]/.test(text[at]);
  while (from < to && from < end && before[from] === after[from]) from++;
  if (splitPair(before, from) || splitPair(after, from)) from--;
  while (to > from && end > from && before[to - 1] === after[end - 1]) {
    to--;
    end--;
  }
  if (splitPair(before, to) || splitPair(after, end)) {
    to++;
    end++;
  }
  return { from, to, insert: after.slice(from, end) };
}
export const mixedEndings = (source) =>
  source.includes('\r\n')
    ? /[\r\n]/.test(source.replaceAll('\r\n', ''))
    : source.includes('\r') && source.includes('\n');
export function editorText(value, source) {
  const ending = source.match(/\r\n|\r|\n/)?.[0] ?? '\n';
  return value.replace(/\r\n|\r|\n/g, ending);
}
export function editorRange(value, start, end, source) {
  if (value !== editorValue(source)) source = editorText(value, source);
  let from = 0,
    to = 0,
    dom = 0;
  for (let i = 0; dom <= end && i <= source.length; dom++) {
    if (dom === start) from = i;
    if (dom === end) {
      to = i;
      break;
    }
    i += source[i] === '\r' && source[i + 1] === '\n' ? 2 : 1;
  }
  return { start: from, end: to, text: source.slice(from, to) };
}
