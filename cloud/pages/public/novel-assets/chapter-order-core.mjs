export function moveChapter(keys, key, destination) {
  const from = keys.indexOf(key);
  if (from < 0 || !Number.isSafeInteger(destination) || destination < 0 || destination >= keys.length)
    throw new Error('请选择列表内的目标位置。');
  const next = [...keys];
  next.splice(destination, 0, next.splice(from, 1)[0]);
  return next;
}
export function orderReviewOf(text) {
  try {
    const value = JSON.parse(text.replace(/^\uFEFF/, ''));
    return value?.chapterOrderReview?.format === 'novel-chapter-order-review-v1' &&
      value.chapterOrderReview.required === true
      ? value.chapterOrderReview
      : null;
  } catch {
    return null;
  }
}
export function acknowledgeOrderReview(text) {
  if (!orderReviewOf(text)) throw new Error('当前文件没有待核对的章节重排标记。');
  const value = JSON.parse(text.replace(/^\uFEFF/, ''));
  value.chapterOrderReview.required = false;
  return (
    (text.startsWith('\uFEFF') ? '\uFEFF' : '') +
    JSON.stringify(value, null, 2) +
    (text.endsWith('\n') ? '\n' : '')
  );
}
