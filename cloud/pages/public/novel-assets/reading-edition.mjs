// Read-only export from the ORIGINAL native chapter catalog and physical files.
// Two reads detect changes; this is not an atomic database snapshot or a backup.
import { digest } from './bundle.mjs';
export const READING_LIMIT = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const safePath = (p) =>
  typeof p === 'string' &&
  /^chapters\/.+\.(md|txt)$/.test(p) &&
  !/[\\\u0000-\u001f\u007f]/.test(p) &&
  p.split('/').every((s) => s && s !== '.' && s !== '..');
const escape = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export function readingCatalog(listing) {
  if (!/^b-[a-f0-9]{32}$/.test(listing?.book?.id ?? '')) throw new Error('成稿目录来源无效，未下载。');
  if (listing.navigationWarning) throw new Error('章节顺序需先核对：' + listing.navigationWarning);
  const chapters = listing.documents.filter((item) => item.category === 'chapter');
  if (!chapters.length) throw new Error('还没有正式正文可导出。');
  if (chapters.length > 2048) throw new Error('章节超过 2048 项，未生成不完整成稿。');
  const seen = new Set();
  for (const item of chapters) {
    if (!safePath(item.path) || seen.has(item.path)) throw new Error('正文目录含重复或无效路径，未导出。');
    seen.add(item.path);
    if (
      item.parts !== undefined &&
      (!Array.isArray(item.parts) ||
        !item.parts.length ||
        item.parts.some((p, i) => p !== item.path + '.part-' + String(i + 1).padStart(4, '0')))
    )
      throw new Error('正文分片目录不连续，未拼接半份正文。');
  }
  const title = String(listing.book.title || '未命名小说');
  return {
    id: listing.book.id,
    title,
    chapters,
    signature: JSON.stringify([
      listing.book.id,
      title,
      chapters.map((c) => [c.path, c.title, c.chapter, c.parts ?? null, c.size, c.updatedAt]),
    ]),
  };
}
export async function collectReadingEdition(api, readFile, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  const catalog = readingCatalog(await api('documents'));
  const root = '/workspace/novels/' + catalog.id;
  const sources = [],
    chapters = [];
  let totalBytes = 0;
  for (let i = 0; i < catalog.chapters.length; i++) {
    const row = catalog.chapters[i],
      decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    let text = '';
    for (const path of row.parts ?? [row.path]) {
      signal?.throwIfAborted();
      const bytes = await readFile(root + '/' + path, { signal });
      if (!(bytes instanceof Uint8Array)) throw new Error('导出时正文消失或不可读取，未视作空章：' + path);
      totalBytes += bytes.length;
      if (totalBytes > READING_LIMIT) throw new Error('正式正文超过 64 MiB 导出上限，未生成不完整成稿。');
      sources.push({ path, hash: await digest(bytes) });
      signal?.throwIfAborted();
      try {
        text += decoder.decode(bytes, { stream: true });
      } catch {
        throw new Error('正文不是有效 UTF-8，未生成乱码成稿：' + path);
      }
    }
    try {
      text += decoder.decode();
    } catch {
      throw new Error('正文分片尾部不是完整 UTF-8，未截短。');
    }
    // Match the existing native chapterHeading contract: a literal hashtag or
    // level-two heading is prose, not a disposable chapter-title line.
    const body = text.replace(/^\uFEFF?#[\t ]+[^\r\n]*(?:\r\n|\r|\n|$)/, '');
    if (body.trim())
      chapters.push({
        path: row.path,
        title: String(row.title || row.path.split('/').pop()),
        chapter: row.chapter,
        body,
      });
    onProgress({ phase: 'read', done: i + 1, total: catalog.chapters.length });
  }
  if (!chapters.length) throw new Error('当前只有空章或标题，尚无正文可导出。');
  for (let i = 0; i < sources.length; i++) {
    signal?.throwIfAborted();
    const source = sources[i],
      current = await readFile(root + '/' + source.path, { signal });
    if (!(current instanceof Uint8Array) || (await digest(current)) !== source.hash)
      throw new Error('导出期间正文有变化，未下载混合版本；请停止生成或保存完成后重试。');
    signal?.throwIfAborted();
    onProgress({ phase: 'verify', done: i + 1, total: sources.length });
  }
  signal?.throwIfAborted();
  if (readingCatalog(await api('documents')).signature !== catalog.signature)
    throw new Error('导出期间章序、标题或文件布局变化，未下载旧目录。');
  signal?.throwIfAborted();
  return {
    title: catalog.title,
    chapters,
    skipped: catalog.chapters.length - chapters.length,
    sourceBytes: totalBytes,
    consistency: 'double-read-not-atomic',
  };
}
function label(chapter) {
  const title = chapter.title.replace(/[\r\n]+/g, ' ');
  return Number.isSafeInteger(chapter.chapter) && chapter.chapter > 0 && !/^第\s*\d+\s*[章回节]/.test(title)
    ? '第' + chapter.chapter + '章 ' + title
    : title;
}
export function renderReadingEdition(edition, format) {
  if (!['txt', 'markdown', 'html'].includes(format) || !edition?.chapters?.length)
    throw new Error('请选择有效的成稿格式。');
  const title = String(edition.title),
    heading = (text) => text.replace(/[\r\n]+/g, ' ');
  let text, type, extension;
  if (format === 'html') {
    extension = 'html';
    type = 'text/html;charset=utf-8';
    const toc = edition.chapters
      .map((ch, i) => `<li><a href="#chapter-${i + 1}">${escape(label(ch))}</a></li>`)
      .join('');
    text = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>${escape(title)}</title><style>:root{color-scheme:light dark}body{margin:auto;max-width:42rem;padding:2rem 1.25rem;font:1.05rem/1.95 Georgia,serif;overflow-wrap:anywhere}h1{font-size:1.8rem}h2{font-size:1.3rem}nav{font-size:.9rem}a{color:inherit}section{margin-top:3rem;break-before:page}.prose{white-space:pre-wrap}@media print{nav{display:none}body{padding:0;color:#000;background:#fff}}</style></head><body><h1>${escape(title)}</h1><nav aria-label="目录"><ol>${toc}</ol></nav>${edition.chapters.map((ch, i) => `<section id="chapter-${i + 1}"><h2>${escape(label(ch))}</h2><div class="prose">${escape(ch.body)}</div></section>`).join('')}</body></html>`;
  } else {
    extension = format === 'markdown' ? 'md' : 'txt';
    type = format === 'markdown' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8';
    text =
      (format === 'markdown' ? '# ' : '') +
      heading(title) +
      '\n\n' +
      edition.chapters
        .map((ch) => (format === 'markdown' ? '## ' : '') + label(ch) + '\n\n' + ch.body)
        .join('\n\n') +
      '\n';
  }
  if (encoder.encode(text).length > 128 * 1024 * 1024)
    throw new Error('排版结果超过 128 MiB，未下载半份成稿。');
  let name =
    title
      .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
      .slice(0, 100)
      .replace(/[. ]+$/, '') || '小说成稿';
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) name = '_' + name;
  return { text, type, filename: name + '.' + extension };
}
