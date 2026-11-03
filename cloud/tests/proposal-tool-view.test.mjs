import test from 'node:test';
import assert from 'node:assert/strict';
import {
  proposalToolModel,
  installProposalToolViews,
} from '../pages/public/novel-assets/proposal-tool-view.mjs';

test('live candidate presentation reads native incremental arguments and never treats partial or failed calls as saved', () => {
  let content = '前半句';
  const args = { text: (key) => (key === 'content' ? content : undefined) };
  const partial = { phase: 'preparing', args };
  assert.equal(proposalToolModel('novel_proposal_submit', partial).content, '前半句');
  assert.match(proposalToolModel('novel_proposal_submit', partial).label, /正在写作/);
  content += '，后半句。';
  assert.equal(proposalToolModel('novel_proposal_submit', partial).content, content);
  const saved = {
    kind: 'tool-result',
    args,
    content: [{ type: 'text', text: '{"saved":true,"published":false}' }],
  };
  assert.equal(proposalToolModel('novel_proposal_submit', saved).label, '草稿已保留');
  assert.match(proposalToolModel('novel_proposal_submit', { ...saved, isError: true }).label, /失败/);
  assert.match(
    proposalToolModel('novel_proposal_submit', { ...saved, isError: true, error: { code: 'interrupted' } })
      .label,
    /停止/,
  );
  assert.doesNotMatch(proposalToolModel('novel_proposal_submit', { ...saved, content: [] }).label, /已保存/);
});

test('novel tool views extend only the original keyed tool slot, without replacing the conversation or creating a new event source', () => {
  const registrations = [];
  const ctx = {
    effect: (fn) => fn(),
    slots: {
      inject: (name, fn) => {
        assert.equal(name, 'tool.call.toolview');
        return [...fn()];
      },
      register: (options) => {
        registrations.push(options);
      },
    },
  };
  installProposalToolViews(ctx, {});
  assert.deepEqual(
    registrations.map((r) => r.key),
    ['novel_proposal_prepare', 'novel_proposal_inspect', 'novel_proposal_submit'],
  );
});
