// Presentation of author checkpoints; the ORIGINAL native Agent owns execution.
export const validRunId = (id) =>
  typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id);
export function writingRunPrompt(book, run) {
  if (
    !validRunId(run?.id) ||
    !['review', 'new-chapters'].includes(run.publication) ||
    run.phase !== 'open' ||
    run.completed
  )
    throw new Error('连写任务不能继续，请核对检查点；未重建任务。');
  return JSON.stringify({
    request: run.instruction || '按大纲连写所选章节',
    kind: 'writing-run',
    book: book.root,
    run_id: run.id,
    range: run.range,
  });
}
export function runItemStatus(item) {
  return item.skipped
    ? '已有正文 · 跳过'
    : item.published
      ? '已保存正文'
      : item.generated
        ? '草稿完成 · 尚未保存'
        : item.partial
          ? '部分草稿 · 可继续'
          : item.proposalId
            ? '准备就绪'
            : '待生成';
}
