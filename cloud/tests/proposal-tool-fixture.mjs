import assert from 'node:assert/strict';

// Synthetic model follows the ACTUAL native tool result, not a guessed empty
// candidate hash. Works for both pinned provider wires and repaired candidates.
export function proposalSteps(prompt, content, { complete = false } = {}) {
  const id = [...prompt.matchAll(/"proposal_id"\s*:\s*"([a-f0-9-]{36})"/g)].at(-1)?.[1];
  assert.ok(id, 'The real writing task must identify its existing proposal.');
  return [
    { name: 'novel_proposal_inspect', input: { proposal_id: id }, expected: '"published":false' },
    {
      name: 'novel_proposal_submit',
      input: ({ task, results, step }) => {
        const text = results.get('fixture_' + task.id + '_' + (step - 1))?.text;
        const state = JSON.parse(text);
        assert.equal(state.proposalId, id);
        assert.equal(state.editable, true);
        return { proposal_id: id, expected_hash: state.expectedHash, content, complete };
      },
      expected: '"saved":true',
    },
  ];
}
