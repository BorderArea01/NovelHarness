// Read the INSTALLED plugin, not a reimplementation inferred from its README.
// Synthetic files only. No host patches, global prompt commits, model or API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { resolveInjectText, readWorkspacePolicy } from '../official/node_modules/dsh-purge/lib/rules.js';
import { rewritePromptAssembly } from '../official/node_modules/dsh-purge/lib/identity.js';

test('installed purge selects prompt-inject before its factory fallback, not AGENTS or START', async () => {
  const home = resolve('data/official-validation/integration/purge-source-fixture');
  await mkdir(home, { recursive: true });
  const path = join(home, 'prompt-inject.md');
  try {
    await unlink(path);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeFile(join(home, 'AGENTS.md'), 'AGENTS_SENTINEL_NOT_OPERATOR');
  await writeFile(join(home, 'START.md'), 'START_SENTINEL_NOT_OPERATOR');
  const fallback = resolveInjectText(home);
  assert.equal(fallback.source, 'default');
  assert(!fallback.text.includes('AGENTS_SENTINEL_NOT_OPERATOR'));
  assert(!fallback.text.includes('START_SENTINEL_NOT_OPERATOR'));
  await writeFile(path, 'EXPLICIT_OPERATOR_SENTINEL');
  assert.equal(resolveInjectText(home).text, 'EXPLICIT_OPERATOR_SENTINEL');
  assert.equal(readWorkspacePolicy(home), 'fallback');
});

test('purge assembly rewrites system sections, preserves tools/contexts, and workspace exclusion is optional rather than AGENTS-first', () => {
  const workspace = { name: 'workspace:instructions', text: 'Synthetic workspace baseline.' };
  const assembled = {
    sections: [workspace],
    contexts: [{ name: 'synthetic-context', text: 'retained' }],
    tools: [{ name: 'synthetic_tool', inputSchema: { type: 'object' } }],
  };
  const rewrite = (dropWorkspaceBaseline) =>
    rewritePromptAssembly(assembled, {
      fallbackInject: 'SYNTHETIC_OPERATOR',
      capabilityProtocol: false,
      dropWorkspaceBaseline,
    });
  const keep = rewrite(false),
    drop = rewrite(true);
  assert(keep.sections.some((s) => s.text.includes(workspace.text)));
  assert(!drop.sections.some((s) => s.text.includes(workspace.text)));
  assert.equal(drop.tools, assembled.tools);
  assert.equal(drop.contexts, assembled.contexts);
  assert.equal(assembled.sections[0], workspace);
});
