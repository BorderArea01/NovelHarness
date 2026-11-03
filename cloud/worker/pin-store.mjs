const enc = new TextEncoder();
import { migrationAuthorized, storageSnapshotResponse } from './storage-snapshot.mjs';
import { initialFreeze, freezeHostStore, maintenanceResponse } from './host-cutover.mjs';
const WINDOW = 15 * 60 * 1000;
export const PIN_PATTERN = /^[0-9]{4,12}$/;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const random = () => hex(crypto.getRandomValues(new Uint8Array(16)));
const unhex = (text) =>
  /^[a-f0-9]{64}$/.test(text ?? '')
    ? Uint8Array.from(text.match(/../g), (p) => parseInt(p, 16))
    : new Uint8Array();
function result(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', ...headers } });
}
class Fault extends Error {
  constructor(status, message, retryAfter) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

// Separate SQLite-backed DO: never place PIN hashes or throttling records in the
// Agent-readable story filesystem. The upstream owner DO remains untouched.
export class PinAuth {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.queue = Promise.resolve();
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get('pin-state');
      if (saved && (saved.version !== 1 || typeof saved.epoch !== 'string'))
        throw new Error('Unsupported PIN state.');
      this.state = saved ?? { version: 1, epoch: random(), pin: null, attempts: {}, audit: [] };
      if (!saved) await ctx.storage.put('pin-state', this.state);
      this.hostFreezeState = initialFreeze(ctx, env);
    });
  }
  key() {
    if (typeof this.env.DSH_EDGE_ACCESS_KEY !== 'string' || this.env.DSH_EDGE_ACCESS_KEY.length < 32)
      throw new Error('Missing owner secret.');
    return (this.macKey ??= crypto.subtle.importKey(
      'raw',
      enc.encode(this.env.DSH_EDGE_ACCESS_KEY),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    ));
  }
  async mac(text) {
    return hex(await crypto.subtle.sign('HMAC', await this.key(), enc.encode(text)));
  }
  async derive(pin, salt) {
    const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
    // workerd caps PBKDF2 at 100,000. A separate host-secret HMAC pepper prevents
    // an exported auth database alone from enabling offline numeric-PIN guessing.
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 100000 },
      key,
      256,
    );
    return enc.encode('novel-pin-hash-v1\0' + hex(bits));
  }
  async matches(pin) {
    if (typeof pin !== 'string' || !PIN_PATTERN.test(pin)) return false;
    return crypto.subtle.verify(
      'HMAC',
      await this.key(),
      unhex(this.state.pin.hash),
      await this.derive(pin, this.state.pin.salt),
    );
  }
  async save(next) {
    await this.ctx.storage.put('pin-state', next);
    this.state = next;
  }
  async ipKey(ip, kind = 'pin') {
    return kind + ':' + (await this.mac('novel-pin-ip-v1\0' + String(ip).slice(0, 128)));
  }
  keys(ipKey, kind) {
    return kind === 'recovery' ? [ipKey] : [ipKey, 'global'];
  }
  rateKey(ipKey, kind, attempts = this.state.attempts) {
    const active = Object.entries(attempts).filter(([, row]) => row.until > Date.now());
    return active.some(([key]) => key === ipKey) || active.length < 128 ? ipKey : kind + ':overflow';
  }
  checkLimit(ipKey, kind) {
    const now = Date.now();
    for (const key of this.keys(this.rateKey(ipKey, kind), kind)) {
      const entry = this.state.attempts[key],
        limit = key === 'global' ? 20 : 5;
      if (entry && entry.until > now && entry.count >= limit)
        throw new Fault(
          429,
          '尝试次数过多，请稍后再试。',
          Math.max(1, Math.ceil((entry.until - now) / 1000)),
        );
    }
  }
  async attempt(ipKey, kind, ok, event) {
    const now = Date.now(),
      next = structuredClone(this.state);
    for (const [key, value] of Object.entries(next.attempts))
      if (value.until <= now) delete next.attempts[key];
    // Bound stored identities even if arbitrary clients omit/spoof local test IPs.
    ipKey = this.rateKey(ipKey, kind, next.attempts);
    for (const key of this.keys(ipKey, kind)) {
      if (ok) {
        if (key !== 'global') delete next.attempts[key];
        continue;
      }
      const row = next.attempts[key] ?? { count: 0, until: now + WINDOW };
      row.count++;
      if (row.count === (key === 'global' ? 20 : 5)) row.until = now + WINDOW;
      next.attempts[key] = row;
    }
    next.audit = [...next.audit, { at: now, event, ok, ipHash: ipKey }].slice(-50);
    await this.save(next);
  }
  async allowed(cookie, gate) {
    if (!this.state.pin) return true;
    if (typeof cookie !== 'string' || !cookie || typeof gate !== 'string') return false;
    const [epoch, signature, ...rest] = gate.split('.');
    if (rest.length || epoch !== this.state.epoch) return false;
    return crypto.subtle.verify(
      'HMAC',
      await this.key(),
      unhex(signature),
      enc.encode('novel-pin-gate-v1\0' + epoch + '\0' + cookie),
    );
  }
  async dispatch(data) {
    const kind = data.action.startsWith('recovery') ? 'recovery' : 'pin';
    const ipKey = await this.ipKey(data.ip ?? 'unknown', kind);
    if (data.action === 'recovery-check') {
      this.checkLimit(ipKey, kind);
      return result({ ok: true });
    }
    if (data.action === 'recovery-failed') {
      await this.attempt(ipKey, kind, false, 'recovery');
      return result({ error: '恢复口令不正确。' }, 401);
    }
    if (data.action === 'recovery-ok') {
      await this.attempt(ipKey, kind, true, 'recovery');
      return result({ epoch: this.state.epoch });
    }
    if (data.action === 'verify') {
      if (!this.state.pin) throw new Fault(409, '尚未设置 PIN，请先使用现有登录进入账号页设置。');
      this.checkLimit(ipKey, kind);
      const ok = await this.matches(data.pin);
      await this.attempt(ipKey, kind, ok, 'login');
      if (!ok) throw new Fault(401, 'PIN 不正确。');
      return result({ epoch: this.state.epoch });
    }
    if (data.action === 'set') {
      if (
        typeof data.newPin !== 'string' ||
        !PIN_PATTERN.test(data.newPin) ||
        data.confirmPin !== data.newPin
      )
        throw new Fault(400, '请输入两次相同的 4–12 位数字 PIN。');
      if (this.state.pin && !data.recoveryAuthorized) {
        this.checkLimit(ipKey, kind);
        const ok = await this.matches(data.currentPin);
        await this.attempt(ipKey, kind, ok, 'change-check');
        if (!ok) throw new Fault(401, '当前 PIN 不正确，未修改。');
      }
      const salt = random(),
        hash = hex(await crypto.subtle.sign('HMAC', await this.key(), await this.derive(data.newPin, salt)));
      const next = {
        ...this.state,
        epoch: random(),
        pin: {
          algorithm: 'PBKDF2-SHA256-HMAC-pepper-v1',
          iterations: 100000,
          salt,
          hash,
          updatedAt: Date.now(),
        },
      };
      next.attempts = {};
      next.audit = [...next.audit, { at: Date.now(), event: 'pin-set', ok: true }].slice(-50);
      await this.save(next);
      return result({ epoch: next.epoch });
    }
    if (data.action === 'issue') {
      if (typeof data.cookie !== 'string' || !data.cookie || data.epoch !== this.state.epoch)
        throw new Fault(409, 'PIN 刚被修改，请使用新 PIN 重新登录。');
      return result({
        gate:
          this.state.epoch +
          '.' +
          (await this.mac('novel-pin-gate-v1\0' + this.state.epoch + '\0' + data.cookie)),
      });
    }
    throw new Fault(404, '未知认证操作。');
  }
  async fetch(request) {
    try {
      await this.ready;
      if (new URL(request.url).pathname === '/__host_freeze') {
        await this.queue;
        return freezeHostStore(this, request, { kind: 'pin' });
      }
      if (new URL(request.url).pathname === '/__private_storage_snapshot') {
        if (request.method !== 'POST' || !migrationAuthorized(request, this.env)) return new Response('', { status: 404 });
        await this.queue;
        return storageSnapshotResponse(this.ctx, 'pin', () => {}, request, this.env.NOVEL_STORAGE_ROLE === 'host');
      }
      const data = await request.json();
      if (data.action === 'authorize')
        return result({ configured: !!this.state.pin, allowed: await this.allowed(data.cookie, data.gate) });
      if (this.hostFreezeState) return maintenanceResponse();
      if (typeof data.action !== 'string') throw new Fault(400, '无效请求。');
      const job = this.queue.then(() => this.dispatch(data));
      this.queue = job.catch(() => {});
      return await job;
    } catch (error) {
      return result(
        { error: error instanceof Fault ? error.message : 'PIN 服务暂不可用，未重置配置。' },
        error instanceof Fault ? error.status : 503,
        error.retryAfter ? { 'retry-after': String(error.retryAfter) } : {},
      );
    }
  }
}
