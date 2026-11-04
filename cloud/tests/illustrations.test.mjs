import test from 'node:test';
import assert from 'node:assert/strict';
import {
  imageAsset,
  illustrationEntries,
  illustrationMarker,
  insertIllustration,
  placeIllustration,
} from '../worker/shared/illustrations.mjs';
import { makeBackup, restoreBackup } from '../pages/public/novel-assets/backup.mjs';
import {
  collectReadingEdition,
  renderReadingEdition,
} from '../pages/public/novel-assets/reading-edition.mjs';
import { digest } from '../pages/public/novel-assets/bundle.mjs';

export const assetText = JSON.stringify({
  format: 'novel-illustration-v1',
  width: 1,
  height: 1,
  label: '雨港',
  data: 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA',
});
const path = 'illustrations/' + (await digest(assetText)) + '.json';
test('illustration links preserve prose, emoji, line endings, escapes and fenced author examples', () => {
  const source = '\uFEFF# 第一章\r\n\r\n雨🌧️落在港口。\r\n\r\n她走进门。';
  const inserted = insertIllustration(source, path, '雨[港]\\图', source.indexOf('港口'));
  assert.equal(inserted.replace('\r\n\r\n' + illustrationMarker(path, '雨[港]\\图'), ''), source);
  assert.equal(illustrationEntries(inserted)[0].caption, '雨[港]\\图');
  assert.equal(illustrationEntries('```markdown\n' + illustrationMarker(path) + '\n```').length, 0);
  assert.equal(illustrationEntries('![外网](https://example.com/a.jpg)').length, 0);
  const moved = placeIllustration(inserted, { imagePath: path, after: '她走进门。' });
  assert(moved.indexOf('她走进门。') < moved.indexOf('!['));
  assert.equal(illustrationEntries(moved).length, 1);
  assert(!placeIllustration(moved, { imagePath: path, remove: true }).includes('!['));
  assert.throws(() => placeIllustration(source, { imagePath: path, after: '不存在' }), /不存在/);
  assert.throws(() => placeIllustration('重复\n\n重复', { imagePath: path, after: '重复' }), /不唯一/);
  assert.throws(() => illustrationMarker('../other-book.json'));
  assert.throws(() => insertIllustration(source, path, '', -1));
});
test('image envelopes reject active content, invalid dimensions, encoding and oversized payloads', () => {
  assert.equal(imageAsset(assetText).width, 1);
  for (const change of [
    { data: 'data:image/svg+xml;base64,PHN2Zz4=' },
    { width: 2000 },
    { height: -1 },
    { data: 'data:image/webp;base64,AAAA' },
  ])
    assert.throws(() => imageAsset(JSON.stringify({ ...JSON.parse(assetText), ...change })));
  assert.throws(() => imageAsset(' '.repeat(768 * 1024 + 1)), /过大/);
});
test('complete book backup restores image bytes and book-relative placements into a different book', async () => {
  const id = 'b-' + 'a'.repeat(32),
    root = '/workspace/novels/' + id;
  const book = { id, root, title: '插图测试', format: 'novel-harness-book-v1' };
  const prose = '# 第一章\n\n雨港。\n\n' + illustrationMarker(path, '雨港');
  const backup = await makeBackup(book, [
    { path: 'book.json', content: JSON.stringify(book) },
    { path: 'chapters/1.md', content: prose },
    { path, content: assetText },
  ]);
  const restored = await restoreBackup(backup);
  assert.notEqual(restored.manifest.id, id);
  assert.equal(new TextDecoder().decode(restored.files.find((f) => f.path === path).content), assetText);
  assert.equal(
    new TextDecoder().decode(restored.files.find((f) => f.path === 'chapters/1.md').content),
    prose,
  );
});
test('reading export embeds verified pictures in HTML and Markdown, keeps TXT readable, refuses lost or changed assets', async () => {
  const id = 'b-' + 'a'.repeat(32),
    root = '/workspace/novels/' + id;
  const files = new Map([
    [
      root + '/chapters/1.md',
      new TextEncoder().encode('# 第一章\n\n雨港。\n\n' + illustrationMarker(path, '<script>')),
    ],
    [root + '/' + path, new TextEncoder().encode(assetText)],
  ]);
  const api = async () => ({
    book: { id, title: '插图小说' },
    documents: [{ path: 'chapters/1.md', category: 'chapter', title: '雨港' }],
  });
  const readFile = async (p) => files.get(p) ?? null;
  const edition = await collectReadingEdition(api, readFile, { includeImages: true });
  const html = renderReadingEdition(edition, 'html').text;
  assert(html.includes('<figure><img'));
  assert(html.includes('img-src data:'));
  assert(!html.includes('<script>'));
  assert(renderReadingEdition(edition, 'markdown').text.includes('data:image/webp;base64,'));
  assert(!renderReadingEdition(edition, 'txt').text.includes('illustrations/'));
  const plain = await collectReadingEdition(api, readFile);
  assert.throws(() => renderReadingEdition(plain, 'html'), /缺少插图/);
  let seen = 0;
  await assert.rejects(
    collectReadingEdition(
      api,
      async (p) => {
        if (p.endsWith('.json') && ++seen === 2) return new TextEncoder().encode(assetText + ' ');
        return readFile(p);
      },
      { includeImages: true },
    ),
    /有变化/,
  );
  files.delete(root + '/' + path);
  await assert.rejects(collectReadingEdition(api, readFile, { includeImages: true }), /插图不存在/);
});
