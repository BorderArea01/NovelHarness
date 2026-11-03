import test from 'node:test';
import assert from 'node:assert/strict';
import { startModelFixture } from './fixtures/model-server.mjs';
test('local model fixture routes the latest author turn, not a stopped or failed marker in older context', async () => {
  const model = await startModelFixture();
  try {
    const task = model.register({ httpStatus: 402 });
    const ask = (messages) =>
      fetch(model.url + '/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': 'fixture-only-no-real-provider-key' },
        body: JSON.stringify({ tools: [{ name: 'read' }], messages }),
      });
    let response = await ask([{ role: 'user', content: task.marker }]);
    assert.equal(response.status, 402);
    await response.text();
    response = await ask([
      { role: 'user', content: task.marker },
      { role: 'user', content: [{ type: 'text', text: '这是后来的普通聊天，不重跑旧任务。' }] },
    ]);
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(model.requests.at(-1).task, null);
    response = await ask([
      { role: 'user', content: task.marker },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'synthetic',
            content: 'A tool result, not a new author prompt.',
          },
        ],
      },
    ]);
    assert.equal(response.status, 402);
    await response.text();
    assert.equal(model.requests.at(-1).task, task.id);
    assert.deepEqual(model.errors, []);
  } finally {
    await model.close();
  }
});
