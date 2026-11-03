// One lightweight revision check per mounted book client, shared by manuscript
// and continuous-writing views. Never poll full documents when nothing changed.
const monitors = new WeakMap();
export function createBookSync(
  api,
  {
    clock = Date.now,
    schedule = setTimeout,
    cancel = clearTimeout,
    events = globalThis.window,
    visibility = globalThis.document,
  } = {},
) {
  const listeners = new Set();
  let version = null,
    timer,
    running = false,
    disposed = false,
    wakeRequested = false,
    failures = 0,
    blockedUntil = 0;
  const visible = () => visibility?.visibilityState !== 'hidden';
  const arm = (delay) => {
    cancel(timer);
    if (!disposed && listeners.size) timer = schedule(tick, delay);
  };
  async function tick() {
    if (disposed || running) return;
    running = true;
    try {
      const ready = [...listeners].filter((l) => visible() && (l.ready?.() ?? true));
      if (!ready.length || clock() < blockedUntil) return;
      const value = await api('changes');
      if (typeof value?.revision !== 'string' || !value.revision)
        throw new Error('书稿版本检查失败，未替换本地内容。');
      if (disposed) return;
      // A newly mounted view must receive the current revision even if another
      // subscriber has already acknowledged it. Failed/busy refreshes retry.
      for (const listener of ready) {
        if (!listeners.has(listener) || !(listener.ready?.() ?? true)) continue;
        if (listener.version === value.revision) continue;
        const accepted = await listener.refresh();
        if (accepted !== false) listener.version = value.revision;
      }
      version = value.revision;
      failures = 0;
    } catch (error) {
      failures++;
      if (error.code === 'STORAGE_DAILY_LIMIT') {
        blockedUntil = Math.max(clock() + 60000, Date.parse(error.retryAt) || clock() + 300000);
      } else {
        blockedUntil =
          clock() + Math.max(error.retryAfterMs ?? 0, Math.min(300000, 15000 * 2 ** Math.min(failures, 5)));
      }
      for (const listener of listeners) listener.error?.(error);
    } finally {
      running = false;
      const active = [...listeners].some((l) => l.active?.());
      const immediate = wakeRequested && clock() >= blockedUntil;
      wakeRequested = false;
      arm(immediate ? 0 : Math.max(active ? 4000 : 10000, blockedUntil - clock()));
    }
  }
  const wake = () => {
    if (visible() && !disposed && clock() >= blockedUntil) {
      if (running) wakeRequested = true;
      else arm(0);
    }
  };
  events?.addEventListener('focus', wake);
  events?.addEventListener('online', wake);
  events?.addEventListener('pageshow', wake);
  visibility?.addEventListener('visibilitychange', wake);
  return {
    subscribe(listener) {
      const entry = { ...listener, version: null };
      listeners.add(entry);
      wake();
      return () => listeners.delete(entry);
    },
    wake,
    dispose() {
      disposed = true;
      cancel(timer);
      listeners.clear();
      events?.removeEventListener('focus', wake);
      events?.removeEventListener('online', wake);
      events?.removeEventListener('pageshow', wake);
      visibility?.removeEventListener('visibilitychange', wake);
    },
    get version() {
      return version;
    },
  };
}
export function watchBookChanges(api, listener) {
  let shared = monitors.get(api);
  if (!shared) {
    shared = { sync: createBookSync(api), count: 0 };
    monitors.set(api, shared);
  }
  shared.count++;
  const release = shared.sync.subscribe(listener);
  return () => {
    release();
    if (--shared.count === 0) {
      shared.sync.dispose();
      monitors.delete(api);
    }
  };
}
export function wakeBookChanges(api) {
  monitors.get(api)?.sync.wake();
}
