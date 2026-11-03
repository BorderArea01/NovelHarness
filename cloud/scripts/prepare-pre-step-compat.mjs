// Patch only the isolated host seam AFTER the original plugin has patched it.
// The plugin's source and update mechanism stay untouched.
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function installPreStepCompatibility() {
  const path = resolve('cloud/official/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js');
  let source = await readFile(path, 'utf8');
  const marker = '// novel-host-pre-step-compat-v1';
  if (source.includes(marker)) return;
  const before = 'const decision = await this.dispatch.waterfall("agent/pre-step", {';
  if (source.split(before).length !== 2) throw new Error('Native pre-step dispatch seam changed.');
  source = source.replace(
    before,
    'const decision = await runCompatiblePreStep(this.session, position, () => this.dispatch.waterfall("agent/pre-step", {',
  );
  const end = '\n\t\tsignal.throwIfAborted();\n\t\tif (decision.kind === "reject") return decision;';
  if (source.split(end).length !== 2) throw new Error('Native pre-step result seam changed.');
  source = source.replace(
    end,
    [
      '\n\t\t, (append) => {',
      '\t\t\tfor (const { message, intent } of this.systemPrompt.project(renderPrompt(assembly), { inHistory: false, startsSeries: false }))',
      '\t\t\t\tappend("system/message", { turn: position.turn, step: position.step, message }, intent);',
      '\t\t}, () => { this.phase.step = position.step; });',
      end,
    ].join('\n'),
  );
  // The preceding waterfall's original `);` needs to close the callback call
  // instead; exact local boundary prevents touching other dispatches.
  const close = '\n\t\t});\n\t\t, (append) => {';
  if (source.split(close).length !== 2) throw new Error('Native pre-step callback boundary changed.');
  source = source.replace(close, '\n\t\t})\n\t\t, (append) => {');
  source =
    marker +
    '\nimport { runCompatiblePreStep } from ' +
    JSON.stringify(pathToFileURL(resolve('cloud/official/novel/pre-step-compat.mjs')).href) +
    ';\n' +
    source;
  await writeFile(path, source);
}
