import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editRules } from '../pages/public/novel-assets/rules-core.mjs';

test('only task templates remain editable here; an assistant rule channel cannot be recreated', () => {
  const input = { extension: { keep: true }, savedPrompts: { write: '旧模板' } };
  const after = editRules(input, { kind: 'prompt', key: 'write', value: '作者新模板' });
  assert.deepEqual(after.extension, input.extension);
  assert.equal(input.savedPrompts.write, '旧模板');
  assert.throws(() => editRules(input, { kind: 'assistant-prompt', value: '隐藏总规则' }), /不支持/);
});
test('native host does not register a separate authoring workflow, rewrite plugin prompt files or proxy plugin editing', async () => {
  const tools = await readFile(new URL('../official/novel/tools.mjs', import.meta.url), 'utf8');
  const boot = await readFile(new URL('../official/novel/runtime.mjs', import.meta.url), 'utf8');
  const web = await readFile(new URL('../official/novel/web.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(tools, /novel:authoring-workflow|readAuthoringPrompt|AUTHORING_WORKFLOW/);
  assert.doesNotMatch(boot, /repairNativeOperatorPrompt|prompt-inject/);
  assert.doesNotMatch(web, /nativePromptSettings|saveOverrideContent/);
  assert.match(boot, /configureNovelProfile/);
});
