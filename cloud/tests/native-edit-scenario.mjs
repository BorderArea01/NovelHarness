import assert from 'node:assert/strict';

// Real native tool registry, output validation, SQLite and browser; only a
// synthetic draft in the test book. No real provider or user manuscript.
export async function verifyNativeEditContract({ page, model, service, root }) {
  const relative = 'drafts/native-edit-contract.md';
  const file_path = root + '/' + relative;
  const original = '# 工具测试\r\n\r\n第一行。\r\n第二行。\r\n\r\n重复词，重复词。\r\n';
  const replacement = "修改后的第一行。\r\n价格符号 $& $$ $` $' 原样保留。";
  const edited = original.replace('第一行。\r\n第二行。', () => replacement);
  const final = edited.replaceAll('重复词', '新词');
  let originalHash, editedHash;
  const task = model.register({
    finalText: '独立草稿的原生编辑工具验证完成。',
    steps: [
      {
        name: 'write',
        input: { file_path, content: original },
        expected: 'characters (editor, excluding whitespace): ' + original.replace(/\s/g, '').length,
      },
      {
        name: 'read',
        input: () => {
          originalHash = service.run({ kind: 'read', path: relative }).hash;
          return { file_path };
        },
        expected: '第二行。',
      },
      {
        name: 'edit',
        input: { file_path, old_string: '第一行。\n第二行。', new_string: replacement },
        expected: 'characters (editor, excluding whitespace): ' + edited.replace(/\s/g, '').length,
      },
      {
        name: 'read',
        input: () => {
          const read = service.run({ kind: 'read', path: relative });
          assert.equal(read.text, edited);
          editedHash = read.hash;
          return { file_path };
        },
        expected: '价格符号',
      },
      {
        name: 'edit',
        input: { file_path, old_string: '第一行。\n第二行。', new_string: '不能再次追加' },
        expectedError: true,
        expected: 'no change was made',
      },
      {
        name: 'edit',
        input: () => {
          assert.equal(service.run({ kind: 'read', path: relative }).hash, editedHash);
          return { file_path, old_string: '重复词', new_string: '未确认多处替换' };
        },
        expectedError: true,
        expected: 'matched 2 times',
      },
      {
        name: 'edit',
        input: () => {
          assert.equal(service.run({ kind: 'read', path: relative }).hash, editedHash);
          return { file_path, old_string: '重复词', new_string: '新词', replace_all: true };
        },
        expected: 'All occurrences were successfully replaced',
      },
      { name: 'read', input: { file_path }, expected: '新词，新词。' },
    ],
  });
  await page.getByRole('button', { name: '创作助手', exact: true }).click();
  const composer = page
    .locator('.novel-author-input [role="textbox"][contenteditable="true"]:visible')
    .first();
  await composer.fill(task.marker + ' 只验证独立测试草稿，不改小说正文。');
  await composer.press('Enter');
  await page.getByText(task.finalText, { exact: true }).waitFor({ timeout: 30000 });
  assert.equal(task.completedSteps, task.steps.length);
  assert.deepEqual(model.errors, []);
  assert.equal(service.run({ kind: 'read', path: relative }).text, final);
  assert.equal(service.run({ kind: 'history', path: relative, hash: originalHash }).text, original);
  await page.getByRole('button', { name: '返回书稿', exact: true }).click();
  return {
    strictOutputAccepted: true,
    crlfAndLiteralReplacement: true,
    failedEditsUnchanged: true,
    originalHistoryPreserved: true,
  };
}
