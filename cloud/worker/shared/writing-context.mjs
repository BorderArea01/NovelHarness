// Material metadata only. No independently injected assistant workflow.
export const MATERIAL_ROLES = Object.freeze({
  'seed.md': 'author-intent',
  'setting.md': 'author-setting',
  'canon.json': 'confirmed-records-and-ai-suggestions',
  'rules.json': 'task-templates-and-project-parameters',
  'outline.json': 'planned-chapters',
  'notes/story-plan.md': 'story-direction',
  'memory.json': 'retrieval-notes',
});
export function materialSources(book, documents = []) {
  return documents.map((item) => ({
    path: book.root + '/' + item.path,
    ...(item.parts?.length ? { parts: item.parts.map((path) => book.root + '/' + path) } : {}),
    role: MATERIAL_ROLES[item.path] ?? 'book-document',
    ...(item.hash ? { hash: item.hash } : {}),
  }));
}
export function documentReadHint(book, document) {
  return document.parts?.length
    ? JSON.stringify({
        path: book.root + '/' + document.path,
        parts: document.parts.map((path) => book.root + '/' + path),
      })
    : book.root + '/' + document.path;
}
export function writingReferences(book, documents = []) {
  return JSON.stringify({ book: book.root, materials: materialSources(book, documents) });
}
export function templateContext(proposal) {
  const value = proposal.promptTemplate;
  if (value === undefined) return '';
  if (value.version !== 1 || typeof value.body !== 'string' || !Array.isArray(value.unknownFields))
    throw new Error('任务模板快照无效，原稿保留。');
  return JSON.stringify({ template: value });
}
