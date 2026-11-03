// Public errors must identify infrastructure failures without exposing stacks,
// SQL, cookies, keys or manuscript text. Quota errors are not bad PINs.
export function serviceFailure(error, now = Date.now()) {
  const message = String(error?.message ?? error);
  if (/Exceeded allowed rows (?:read|written) in Durable Objects free tier/i.test(message)) {
    const reset = new Date(now);
    reset.setUTCHours(24, 0, 0, 0);
    return {
      status: 503,
      body: {
        code: 'STORAGE_DAILY_LIMIT',
        error:
          'Cloudflare 数据库今日免费额度已耗尽，不是 PIN 错误。已保存数据未因此删除；自动同步已暂停，请在北京时间 08:00 额度重置后重试。未提交的修改请保留或下载。',
        retryAt: reset.toISOString(),
      },
      headers: { 'retry-after': String(Math.max(1, Math.ceil((reset.getTime() - now) / 1000))) },
    };
  }
  return {
    status: 503,
    body: {
      code: 'SERVICE_UNAVAILABLE',
      error: '数据服务暂不可用，未切换数据源。请保留本地修改后稍后重试；这不代表 PIN 错误。',
    },
    headers: { 'retry-after': '60' },
  };
}
