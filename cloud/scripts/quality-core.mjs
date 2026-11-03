// Diagnostic only: never imported by the application or CI model transport.
export const QUALITY_LIMIT = Object.freeze({ requests: 3, outputTokens: 2000 });

export async function cappedCompletion({
  request,
  endpoint,
  apiKey,
  model,
  messages,
  reserve,
  progress = () => {},
}) {
  // A durable reservation precedes any network operation. No retry path.
  await reserve();
  const started = Date.now();
  const response = await request(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(120000),
    headers: { authorization: 'Bearer ' + apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: QUALITY_LIMIT.outputTokens,
      stream: true,
      stream_options: { include_usage: true },
      thinking: { type: 'disabled' },
      temperature: 0.8,
    }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error('模型请求 HTTP ' + response.status + '；已计入次数，不自动重试。');
  }
  let buffer = '',
    text = '',
    bytes = 0,
    firstContentMs = null,
    reasoningChars = 0,
    finishReason = null,
    usage = null,
    done = false;
  const decoder = new TextDecoder();
  function line(value) {
    if (!value.startsWith('data:')) return;
    const data = value.slice(5).trim();
    if (!data) return;
    if (data === '[DONE]') {
      done = true;
      return;
    }
    const event = JSON.parse(data);
    if (event.error) throw new Error('模型在流中报告错误；已计入次数，不自动重试。');
    if (event.usage) usage = event.usage;
    const choice = event.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    reasoningChars += choice?.delta?.reasoning_content?.length ?? 0;
    const content = choice?.delta?.content;
    if (typeof content === 'string' && content) {
      firstContentMs ??= Date.now() - started;
      text += content;
      progress({ characters: text.length, elapsedMs: Date.now() - started });
    }
  }
  const reader = response.body.getReader();
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('评测流超过安全读取上限，已停止；不自动重试。');
      buffer += decoder.decode(part.value, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) line(buffer.replace(/\r$/, ''));
    if (!done || !finishReason || !text.trim())
      throw new Error('评测流未完整结束或没有正文；不把半份结果当作成功。');
    return { text, firstContentMs, elapsedMs: Date.now() - started, finishReason, usage, reasoningChars };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function reserveQualityAttempt(ledger, name) {
  if (ledger.limit !== 3 || ledger.outputTokens !== 2000 || ledger.attempts.length >= QUALITY_LIMIT.requests)
    throw new Error('本轮真实请求额度已用完或账本不匹配，拒绝发送。');
  if (ledger.attempts.some((attempt) => attempt.name === name))
    throw new Error('该评测已尝试，不自动重复收费请求。');
  const attempt = { name, reservedAt: new Date().toISOString(), status: 'reserved' };
  ledger.attempts.push(attempt);
  return attempt;
}
