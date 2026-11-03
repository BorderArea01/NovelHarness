// Read only bounded session metadata, never prompts/events/model credentials.
export async function requireIdleRuntime(url, ownerKey, fetcher, { pinWrapper = false } = {}) {
  const response = await fetcher(url + (pinWrapper ? '/api/auth/recover' : '/api/auth/login'), {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(15000),
    headers: {
      origin: url,
      'content-type': pinWrapper ? 'application/json' : 'application/x-www-form-urlencoded',
    },
    body: pinWrapper ? JSON.stringify({ accessKey: ownerKey }) : new URLSearchParams({ accessKey: ownerKey }),
  });
  if (response.status !== (pinWrapper ? 200 : 303))
    throw new Error('Could not verify active writing before runtime update; no Worker upload started.');
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  let after,
    total = 0;
  for (let page = 0; page < 10; page++) {
    const target = new URL('/api/sessions', url);
    target.searchParams.set('limit', '100');
    if (after) target.searchParams.set('after', after);
    const result = await fetcher(target.href, { headers: { cookie }, signal: AbortSignal.timeout(15000) });
    if (!result.ok) throw new Error('Session activity check failed; no Worker upload started.');
    const data = await result.json();
    if (
      !Array.isArray(data.sessions) ||
      data.sessions.some((session) => !['idle', 'running'].includes(session.status))
    )
      throw new Error('Unrecognized session activity; no Worker upload started.');
    if (data.sessions.some((session) => session.status === 'running'))
      throw new Error('A writing session is running. Worker update not started; retry after it finishes.');
    total += data.sessions.length;
    if (data.hasMore === false) return { idle: true, sessionsChecked: total };
    if (typeof data.nextAfter !== 'string' || data.nextAfter === after)
      throw new Error('Incomplete session activity listing; no Worker upload started.');
    after = data.nextAfter;
  }
  throw new Error('Session activity exceeds the bounded check; no Worker upload started.');
}
