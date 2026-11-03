import { newFixtureApi } from './fixture-api.mjs';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
// Called only against isolated synthetic data, never production.
export async function verifyRulesEditor({ page, context, origin, api, root }) {
  const client = await newFixtureApi(context);
  try {
    const read = async () => (await client.get(origin + api + 'document?path=rules.json')).json();
    const before = await read();
    const sample = {
      ...JSON.parse(before.text.replace(/^\uFEFF/, '')),
      extension: { preserve: [1, '旧元数据'] },
      savedPrompts: { write: '{chapter} 的作者模板', unknown: { legacy: true } },
    };
    assert.equal(
      (
        await client.put(origin + api + 'document', {
          data: {
            path: 'rules.json',
            expectedHash: before.hash,
            text: '\uFEFF' + JSON.stringify(sample) + '\n',
          },
        })
      ).status(),
      200,
    );
    await page.getByRole('button', { name: '提示词', exact: true }).click();
    const editor = page.getByLabel('提示词编辑器', { exact: true });
    await editor.waitFor();
    for (const name of ['风格与禁忌', '人称与角色视角', '参考风格与手法'])
      assert.equal(await editor.getByText(name, { exact: true }).count(), 0);
    assert.equal(
      await editor
        .locator('summary')
        .filter({ hasText: /^写作卡片/ })
        .count(),
      0,
    );
    const prompt = editor.getByRole('textbox', { name: '提示词 write', exact: true });
    const customized = '{chapter}：先读正文，再按作者要求创作。';
    await prompt.fill(customized);
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    const saved = await read(),
      value = JSON.parse(saved.text.replace(/^\uFEFF/, ''));
    assert(saved.text.startsWith('\uFEFF'));
    assert.deepEqual(value.extension, sample.extension);
    assert.deepEqual(value.savedPrompts.unknown, sample.savedPrompts.unknown);
    assert.equal(value.savedPrompts.write, customized);
    const history = await (await client.get(origin + api + 'history?path=rules.json')).json();
    assert(history.versions.some((v) => v.hash !== saved.hash));
    await editor.getByRole('button', { name: '恢复默认正文模板', exact: true }).click();
    await editor.getByRole('button', { name: '取消恢复', exact: true }).click();
    assert.equal(await prompt.inputValue(), customized);
    await editor.getByRole('button', { name: '恢复默认正文模板', exact: true }).click();
    await editor.getByRole('button', { name: '确认恢复默认正文模板', exact: true }).click();
    await page.waitForFunction(() =>
      document.querySelector('textarea[aria-label="提示词 write"]')?.value.includes('{chapterNumber}'),
    );
    assert((await prompt.inputValue()).includes('按作者要求写小说正文'));
    assert((await prompt.inputValue()).includes('彼此的回应推动事情发展'));
    assert((await prompt.inputValue()).includes('关系和性格从相处中显现，不宣读人设'));
    const defaults = await (await client.get(origin + '/api/novel-prompt-templates')).json();
    assert.equal(await prompt.inputValue(), defaults.defaults.write);
    assert(defaults.defaults.deai.includes('指代、因果、应答与动作衔接'));
    assert(defaults.defaults.ending.includes('不强制悬念或突然反转人物立场'));
    assert.equal(JSON.parse((await read()).text.replace(/^\uFEFF/, '')).savedPrompts.write, customized);
    await page.getByRole('button', { name: '保存提示词', exact: true }).click();
    await page.locator('.novel-ms-status').filter({ hasText: '已保存' }).waitFor();
    assert(!Object.hasOwn(JSON.parse((await read()).text.replace(/^\uFEFF/, '')).savedPrompts, 'write'));
    await page.reload();
    await page.getByRole('button', { name: '提示词', exact: true }).click();
    await prompt.waitFor();
    assert((await prompt.inputValue()).includes('{chapterNumber}'));
    for (const width of [1280, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({
        path: resolve(root, 'test-results/cloud-native-rules-' + width + '.png'),
        fullPage: true,
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByRole('button', { name: '正文', exact: true }).click();
    console.log(
      'Prompt editor passed: style/POV/cards removed; template edit/reset/cancel, BOM/metadata/history/reload and desktop/mobile layout preserved.',
    );
  } finally {
    await client.dispose();
  }
}
