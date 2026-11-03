// Diagnostic boundary only; NEVER used by the production provider.
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
export const NATIVE_QUALITY_LIMIT = Object.freeze({ requests: 12, outputTokens: 4096 });

export function boundedNativeRequest(path, body, model) {
  if (path !== '/v1/messages' || !body || !Array.isArray(body.messages))
    throw new Error('Unrecognized diagnostic protocol; no upstream request.');
  if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.n > 1)
    throw new Error('Unrecognized output limit; no upstream request.');
  if (body.max_completion_tokens !== undefined || body.max_output_tokens !== undefined)
    throw new Error('Ambiguous output limit; no upstream request.');
  // Keep native tools/messages/thinking intact. max_tokens includes thinking.
  return { ...body, model, max_tokens: Math.min(body.max_tokens, 4096) };
}

export async function startQualityBoundary({
  ledger,
  persist,
  request,
  apiKey,
  model,
  completed,
  log = () => {},
}) {
  let queue = Promise.resolve(),
    enabled = true;
  const controllers = new Set();
  function serialized(action) {
    const result = queue.then(action);
    queue = result.catch(() => {
      enabled = false;
    });
    return result;
  }
  const server = createServer(async (req, res) => {
    let attempt, controller;
    try {
      if (req.method !== 'POST' || req.headers['x-api-key'] !== 'fixture-only-no-real-provider-key')
        throw new Error('Diagnostic credentials/method mismatch; no upstream request.');
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 4 * 1024 * 1024) throw new Error('Diagnostic body too large.');
      }
      const body = boundedNativeRequest(req.url, JSON.parse(raw), model);
      await serialized(async () => {
        if (!enabled || ledger.limit !== 12 || ledger.outputTokens !== 4096 || ledger.attempts.length >= 12)
          throw new Error('Diagnostic request budget closed/exhausted.');
        attempt = {
          number: ledger.attempts.length + 1,
          status: 'reserved',
          reservedAt: new Date().toISOString(),
          maxTokens: body.max_tokens,
          stream: body.stream === true,
          requestHash: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
          tools: (body.tools ?? []).map((tool) => tool.name),
          messageCount: body.messages.length,
        };
        ledger.attempts.push(attempt);
        await persist(); // Must finish before request, including concurrent title calls.
      });
      log('真实请求 ' + attempt.number + '/12，输出上限 ' + body.max_tokens);
      controller = new AbortController();
      controllers.add(controller);
      const started = Date.now(),
        signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const response = await request('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      attempt.httpStatus = response.status;
      res.writeHead(response.status, {
        'content-type': response.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      });
      let buffer = '',
        bytes = 0,
        firstContentMs = null;
      const decoder = new TextDecoder(),
        output = { blocks: [], usage: {}, stopReason: null };
      function eventLine(line) {
        if (!line.startsWith('data:')) return;
        let event;
        try {
          event = JSON.parse(line.slice(5));
        } catch {
          return;
        }
        if (event.type === 'message_start') Object.assign(output.usage, event.message?.usage);
        if (event.type === 'content_block_start') {
          const block = event.content_block;
          if (block?.type === 'text') output.blocks[event.index] = { type: 'text', text: block.text ?? '' };
          if (block?.type === 'tool_use')
            output.blocks[event.index] = { type: 'tool_use', name: block.name, input: '' };
        }
        if (event.type === 'content_block_delta') {
          const delta = event.delta,
            block = output.blocks[event.index];
          if (delta?.type === 'text_delta' && block?.type === 'text') {
            firstContentMs ??= Date.now() - started;
            block.text += delta.text;
          }
          if (delta?.type === 'input_json_delta' && block?.type === 'tool_use') {
            firstContentMs ??= Date.now() - started;
            block.input += delta.partial_json;
          }
        }
        if (event.type === 'message_delta') {
          Object.assign(output.usage, event.usage);
          output.stopReason = event.delta?.stop_reason;
        }
        // Never retain reasoning/signature blocks.
      }
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > 2 * 1024 * 1024) throw new Error('Diagnostic response too large.');
        buffer += decoder.decode(chunk, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          eventLine(buffer.slice(0, index));
          buffer = buffer.slice(index + 1);
        }
        if (!res.write(chunk)) await once(res, 'drain', { signal });
      }
      buffer += decoder.decode();
      if (buffer.trim()) eventLine(buffer);
      res.end();
      output.blocks = output.blocks.filter(Boolean);
      attempt.elapsedMs = Date.now() - started;
      attempt.firstContentMs = firstContentMs;
      attempt.status = response.ok ? 'finished' : 'http-failed-counted';
      attempt.usage = output.usage;
      attempt.stopReason = output.stopReason;
      await completed(attempt.number, output);
      await serialized(persist);
      log('请求 ' + attempt.number + ' 结束：' + response.status + ' / ' + output.stopReason);
    } catch (error) {
      if (attempt) {
        attempt.status = 'interrupted-counted';
        await serialized(persist).catch(() => {});
      }
      // Local permanent error discourages native retries; all forwarded retries count regardless.
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' });
      if (!res.destroyed)
        res.end(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'invalid_request_error',
              message: 'Isolated diagnostic stopped; request budget is not extended.',
            },
          }),
        );
      log('诊断边界停止请求：' + (attempt ? '已计费尝试 ' + attempt.number : '未转发'));
    } finally {
      if (controller) controllers.delete(controller);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    url: 'http://127.0.0.1:' + server.address().port,
    close: async () => {
      enabled = false;
      for (const c of controllers) c.abort();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await queue;
    },
  };
}
