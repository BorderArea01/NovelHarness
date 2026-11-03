import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { NovelDb } from './db.js';

const COOKIE = 'nw_session';
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieValue = (req: Request, name: string) =>
  (req.headers.cookie ?? '')
    .split(';')
    .map((x) => x.trim().split('='))
    .find((x) => x[0] === name)?.[1];

export class Auth {
  constructor(private db: NovelDb) {}

  create(req: Request, res: Response) {
    const token = randomBytes(32).toString('base64url'),
      time = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<?').run(time);
    this.db
      .prepare('INSERT INTO sessions(id_hash,ip,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?)')
      .run(hash(token), req.ip, time, time + SESSION_MS, time);
    res.setHeader(
      'Set-Cookie',
      `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_MS / 1000)}`,
    );
  }

  clear(req: Request, res: Response) {
    const token = cookieValue(req, COOKIE);
    if (token) this.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash(token));
    res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
  }

  check(req: Request): boolean {
    const token = cookieValue(req, COOKIE);
    if (!token) return false;
    const time = Date.now(),
      row = this.db.prepare('SELECT expires_at FROM sessions WHERE id_hash=?').get(hash(token)) as any;
    if (!row || row.expires_at < time) {
      if (row) this.db.prepare('DELETE FROM sessions WHERE id_hash=?').run(hash(token));
      return false;
    }
    this.db
      .prepare('UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id_hash=?')
      .run(time, time + SESSION_MS, hash(token));
    req.sessionId = hash(token);
    return true;
  }

  middleware = (req: Request, res: Response, next: NextFunction) => {
    if (this.check(req)) next();
    else res.status(401).json({ error: '请先登录' });
  };

  loginStatus(ip: string) {
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip=?').get(ip) as any;
    const time = Date.now();
    return {
      locked: !!row && row.locked_until > time,
      retryAfterMs: row ? Math.max(0, row.locked_until - time) : 0,
    };
  }
  record(ip: string, success: boolean) {
    const time = Date.now();
    this.db
      .prepare('INSERT INTO login_audit(ip,success,occurred_at) VALUES(?,?,?)')
      .run(ip, success ? 1 : 0, new Date().toISOString());
    if (success) {
      this.db.prepare('DELETE FROM login_attempts WHERE ip=?').run(ip);
      return;
    }
    const row = this.db.prepare('SELECT * FROM login_attempts WHERE ip=?').get(ip) as any;
    if (!row || time - row.first_failure_at > 5 * 60_000) {
      this.db
        .prepare(
          'INSERT OR REPLACE INTO login_attempts(ip,failures,first_failure_at,locked_until) VALUES(?,1,?,0)',
        )
        .run(ip, time);
      return;
    }
    const failures = row.failures + 1,
      locked = failures >= 5 ? time + 15 * 60_000 : 0;
    this.db
      .prepare('UPDATE login_attempts SET failures=?,locked_until=? WHERE ip=?')
      .run(failures, locked, ip);
  }
}

export function isLoopback(req: Request): boolean {
  const ip = (req.ip ?? '').replace('::ffff:', '');
  return ip === '127.0.0.1' || ip === '::1';
}
