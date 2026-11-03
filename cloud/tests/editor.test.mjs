import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EditorState, EditorView, history } from '../pages/public/novel-assets/editor-vendor.mjs';
import { editorText, editorValue, editorChange } from '../pages/public/novel-assets/editor-text.mjs';

test('external revisions update only changed text, preserve unchanged long lines and never split emoji pairs', () => {
  const long = '钟声从纸背传来。\n'.repeat(24000);
  const change = editorChange(long + '当前尾标', long + '历史尾标');
  assert.deepEqual(change, { from: long.length, to: long.length + 2, insert: '历史' });
  for (const [before, after] of [
    ['🌧️雨夜', '🌈雨夜'],
    ['a🌧️z', 'a🌦️z'],
    ['', '新文'],
    ['删除', ''],
    ['一样', '一样'],
  ]) {
    const edit = editorChange(before, after);
    if (!edit) {
      assert.equal(before, after);
      continue;
    }
    assert.equal(before.slice(0, edit.from) + edit.insert + before.slice(edit.to), after);
    assert.equal(EditorState.create({ doc: before }).update({ changes: edit }).state.doc.toString(), after);
  }
});
test('original CodeMirror state edits large immutable prose without a rendered DOM or second stored document', () => {
  const source = '\ufeff' + '长章🌧️。\r\n'.repeat(60000);
  const state = EditorState.create({ doc: editorValue(source), extensions: [history()] });
  const next = state.update({ changes: { from: 1, to: 3, insert: '作者新句' } }).state;
  assert.equal(state.doc.toString(), editorValue(source));
  assert.equal(editorText(next.doc.toString(), source), source.replace('长章', '作者新句'));
  assert.equal(typeof EditorView.findFromDOM, 'function');
});
test('the deployed virtual editor has pinned MIT dependencies and a checked local browser bundle', async () => {
  const lock = JSON.parse(await readFile(new URL('../tools/package-lock.json', import.meta.url), 'utf8'));
  for (const [name, version] of [
    ['state', '6.7.6'],
    ['view', '6.43.15'],
    ['commands', '6.11.1'],
  ]) {
    const pkg = lock.packages['node_modules/@codemirror/' + name];
    assert.equal(pkg.version, version);
    assert.equal(pkg.license, 'MIT');
  }
  const asset = await readFile(new URL('../pages/public/novel-assets/editor-vendor.mjs', import.meta.url));
  assert.equal(
    createHash('sha256').update(asset).digest('hex'),
    '483f210e046f5c14a830ed315c88634fb4ed04e9d06f79af9a11801d94878427',
  );
  assert.match(asset.toString('utf8'), /@marijn\/find-cluster-break/);
  assert.match(asset.toString('utf8'), /Permission is hereby granted/);
});
