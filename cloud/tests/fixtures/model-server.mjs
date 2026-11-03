// LOCAL ONLY: a deterministic HTTP provider, not a second production engine.
// Both native wires are supported so the pinned artifact decides the protocol.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
      : '';
export async function startModelFixture() {
  const cases = [],
    requests = [],
    errors = [],
    holds = new Set();
  const server = createServer(async (request, response) => {
    try {
      if (
        request.method !== 'POST' ||
        !/\/(?:v1\/messages|chat\/completions)$/.test(new URL(request.url, 'http://local.invalid').pathname)
      ) {
        response.writeHead(404).end();
        return;
      }
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 8 * 1024 * 1024) throw new Error('Fixture body limit exceeded.');
      }
      const body = JSON.parse(raw),
        legacy = new URL(request.url, 'http://local.invalid').pathname.endsWith('/chat/completions');
      const userTexts = (body.messages ?? [])
        .filter((message) => message.role === 'user')
        .map((message) => textOf(message.content));
      // Route the latest author turn, not a marker somewhere in old history.
      // Tool-result-only user messages have no text blocks of their own.
      const latestUserText = userTexts.findLast((text) => text.trim()) ?? '';
      const hasTools = (body.tools ?? []).some((tool) => (tool.name ?? tool.function?.name) === 'read');
      // Auxiliary title requests do not execute fixture tools.
      const task = hasTools
        ? [...cases].reverse().find((item) => latestUserText.includes(item.marker))
        : null;
      const observed = {
        url: request.url,
        task: task?.id ?? null,
        tools: (body.tools ?? []).map((tool) => tool.name ?? tool.function?.name),
        keysSynthetic:
          request.headers['x-api-key'] === 'fixture-only-no-real-provider-key' ||
          request.headers.authorization === 'Bearer fixture-only-no-real-provider-key',
      };
      requests.push(observed);
      if (task) {
        task.observe?.(body);
        const prompt = latestUserText;
        if (!task.prepared) {
          task.prepared = true;
          task.prepare?.(prompt, task);
        }
        task.bodies.push(body);
        task.observed = true;
        if (task.httpStatus) {
          response.writeHead(task.httpStatus, { 'content-type': 'application/json' });
          response.end(
            JSON.stringify({
              type: 'error',
              error: { type: 'fixture_error', message: task.errorMessage || 'Synthetic provider failure.' },
            }),
          );
          return;
        }
      }
      const results = new Map();
      for (const message of body.messages ?? []) {
        if (message.role === 'tool')
          results.set(message.tool_call_id, { text: textOf(message.content), error: false });
        for (const block of Array.isArray(message.content) ? message.content : [])
          if (block.type === 'tool_result')
            results.set(block.tool_use_id, { text: textOf(block.content), error: !!block.is_error });
      }
      let step = 0;
      if (task)
        while (step < task.steps.length && results.has('fixture_' + task.id + '_' + step)) {
          const result = results.get('fixture_' + task.id + '_' + step);
          if (result.error && task.steps[step].expectedError !== true)
            throw new Error(
              'Native tool returned an error for fixture step ' + step + ': ' + result.text.slice(0, 500),
            );
          if (!result.error && task.steps[step].expectedError === true)
            throw new Error('Expected native tool refusal did not occur.');
          const expected = task.steps[step].expected;
          if (expected && !result.text.includes(expected))
            throw new Error(
              'Native result mismatch at fixture step ' +
                step +
                ' (' +
                task.steps[step].name +
                '): ' +
                result.text.slice(0, 500),
            );
          task.completedSteps = ++step;
        }
      let block = 0;
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      const event = (value) =>
        response.write(
          legacy
            ? 'data: ' + JSON.stringify(value) + '\n\n'
            : 'event: ' + value.type + '\ndata: ' + JSON.stringify(value) + '\n\n',
        );
      if (!legacy)
        event({
          type: 'message_start',
          message: {
            id: 'msg_' + randomUUID(),
            type: 'message',
            role: 'assistant',
            model: body.model ?? 'fixture',
            content: [],
            stop_reason: null,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        });
      const text = (value) => {
        if (legacy) event({ choices: [{ delta: { content: value } }] });
        else {
          event({ type: 'content_block_start', index: block, content_block: { type: 'text', text: '' } });
          event({ type: 'content_block_delta', index: block, delta: { type: 'text_delta', text: value } });
          event({ type: 'content_block_stop', index: block++ });
        }
      };
      text(
        task
          ? step < task.steps.length
            ? '正在核对本书资料，步骤 ' + (step + 1) + '。'
            : (task.finalText ?? '候选已写入，等待作者确认。')
          : '钟楼来信',
      );
      const holdStage =
        task && (task.holdBeforeStep === step || (task.holdFinish && step === task.steps.length));
      const park = async (stage) => {
        const hold = { task, step, stage, response, closed: false, release: null };
        response.on('close', () => {
          hold.closed = true;
        });
        const wait = new Promise((resolve) => {
          hold.release = resolve;
        });
        holds.add(hold);
        task.holds.push(hold);
        await wait;
        holds.delete(hold);
      };
      if (holdStage) {
        await park('before-step');
        if (response.destroyed) return;
      }
      const current = task?.steps[step];
      if (current) {
        const input =
          typeof current.input === 'function' ? current.input({ task, results, step, body }) : current.input;
        const callId = 'fixture_' + task.id + '_' + step;
        if (!observed.tools.includes(current.name))
          throw new Error('Native runtime did not advertise required tool: ' + current.name);
        const argumentText = JSON.stringify(input);
        const marker = task.argumentPreviewAtStep === step ? task.argumentPreviewText : null;
        const split = marker ? argumentText.indexOf(marker) + marker.length : 0;
        if (marker && (split < marker.length || split >= argumentText.length))
          throw new Error('Argument preview marker must be inside the actual streamed tool input.');
        const chunks = marker ? [argumentText.slice(0, split), argumentText.slice(split)] : [argumentText];
        if (!legacy)
          event({
            type: 'content_block_start',
            index: block,
            content_block: { type: 'tool_use', id: callId, name: current.name, input: {} },
          });
        for (let part = 0; part < chunks.length; part++) {
          if (legacy)
            event({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        ...(part === 0 ? { id: callId, type: 'function' } : {}),
                        function: { ...(part === 0 ? { name: current.name } : {}), arguments: chunks[part] },
                      },
                    ],
                  },
                },
              ],
            });
          else
            event({
              type: 'content_block_delta',
              index: block,
              delta: { type: 'input_json_delta', partial_json: chunks[part] },
            });
          if (marker && part === 0) {
            await park('tool-arguments');
            if (response.destroyed) return;
          }
        }
        if (!legacy) event({ type: 'content_block_stop', index: block });
        task.issuedSteps.push({ step, name: current.name, input });
      }
      if (legacy) {
        event({
          choices: [{ delta: {}, finish_reason: current ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        });
        response.write('data: [DONE]\n\n');
      } else {
        event({
          type: 'message_delta',
          delta: { stop_reason: current ? 'tool_use' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 10 },
        });
        event({ type: 'message_stop' });
      }
      response.end();
    } catch (error) {
      errors.push(error.message);
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Synthetic fixture protocol failure.' } }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    requests,
    errors,
    register(options) {
      const id = randomUUID().replaceAll('-', '');
      const task = {
        id,
        marker: 'native-fixture-' + id,
        steps: [],
        bodies: [],
        holds: [],
        issuedSteps: [],
        completedSteps: 0,
        ...options,
      };
      cases.push(task);
      return task;
    },
    release(task) {
      for (const hold of holds) if (hold.task === task) hold.release();
    },
    async close() {
      for (const hold of holds) {
        hold.response.destroy();
        hold.release();
      }
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
