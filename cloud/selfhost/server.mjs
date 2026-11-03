import { createServer, request } from 'node:http';
import { readFile, writeFile, open, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { visitorIdentity, checkOrigin } from './identity.mjs';

export async function startAnonymousServer({
  port = 3210,
  host = '127.0.0.1',
  publicOrigin,
  maxVisitors = 2,
  runtime = resolve('data/anonymous-runtime'),
} = {}) {
  if (!Number.isInteger(maxVisitors) || maxVisitors < 1 || maxVisitors > 8)
    throw new Error('MAX_ACTIVE_VISITORS must be an integer from 1 to 8.');
  if (publicOrigin && !['http:', 'https:'].includes(new URL(publicOrigin).protocol))
    throw new Error('Invalid PUBLIC_ORIGIN.');
  const marker = JSON.parse(await readFile(join(runtime, '.anonymous-host.json'), 'utf8'));
  if (marker.format !== 'novelharness-anonymous-v1' || !marker.prepared)
    throw new Error('Run npm run build:public first.');
  const lockPath = join(runtime, 'service.lock');
  let lock;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    const pid = Number(await readFile(lockPath, 'utf8'));
    try {
      process.kill(pid, 0);
      throw new Error('Anonymous service already running.');
    } catch (check) {
      if (check.code !== 'ESRCH') throw check;
    }
    await unlink(lockPath);
    lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid));
  let keys;
  const keyPath = join(runtime, 'visitor-secret.json');
  try {
    keys = JSON.parse(await readFile(keyPath, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    keys = { secret: randomBytes(32).toString('hex'), deployment: randomBytes(8).toString('hex') };
    await writeFile(keyPath, JSON.stringify(keys), { mode: 0o600, flag: 'wx' });
  }
  const identity = visitorIdentity(keys.secret, keys.deployment);
  const visitors = new Map(),
    sockets = new Set();
  let origin,
    queue = Promise.resolve(),
    closing = false;
  const error = (res, code, message) => {
    if (!res.headersSent)
      res.writeHead(code, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': '5',
      });
    res.end(JSON.stringify({ error: message }));
  };
  async function idle(entry) {
    if (entry.requests) return false;
    return new Promise((resolveIdle) => {
      const id = randomUUID(),
        timer = setTimeout(() => done(false), 3000);
      const receive = (m) => {
        if (m.type === 'idle' && m.id === id) done(m.idle);
      };
      function done(value) {
        clearTimeout(timer);
        entry.child.off('message', receive);
        resolveIdle(value);
      }
      entry.child.on('message', receive);
      entry.child.send({ type: 'idle', id });
    });
  }
  async function stop(entry) {
    await new Promise((resolveStop, reject) => {
      const receive = (message) => {
        if (message.type === 'busy') {
          entry.child.off('message', receive);
          reject(new Error('Visitor AI became active.'));
        }
      };
      entry.child.on('message', receive);
      entry.child.once('exit', () => {
        entry.child.off('message', receive);
        resolveStop();
      });
      entry.child.send({ type: 'stop' });
    });
  }
  async function getVisitor(id, reserve = true) {
    if (closing) throw new Error('closing');
    const acquire = (entry) => {
      if (reserve) entry.requests++;
      entry.last = Date.now();
      return entry;
    };
    if (visitors.has(id) && !visitors.get(id).evicting) return acquire(visitors.get(id));
    const prepare = async () => {
      if (visitors.has(id)) return acquire(visitors.get(id));
      if (visitors.size >= maxVisitors) {
        let removed = false;
        for (const [key, entry] of [...visitors].sort((a, b) => a[1].last - b[1].last)) {
          entry.evicting = true;
          if (await idle(entry)) {
            try {
              await stop(entry);
              visitors.delete(key);
              removed = true;
              break;
            } catch {
              entry.evicting = false;
            }
          } else entry.evicting = false;
        }
        if (!removed) throw new Error('All active visitor runtimes are busy.');
      }
      const key = randomBytes(32).toString('hex');
      const child = spawn(process.execPath, ['--max-old-space-size=384', 'cloud/selfhost/visitor.mjs', id], {
        cwd: runtime,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        env: Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !/(KEY|TOKEN|SECRET|PASSWORD|PIN|DEEPSEEK|^DSH_|NODE_OPTIONS)/i.test(name),
          ),
        ),
      });
      // Do not emit per-visitor logs: upstream exceptions can contain prose.
      child.stderr.resume();
      const entry = { child, key, requests: 0, last: Date.now() };
      const ready = new Promise((resolveReady, reject) => {
        const timer = setTimeout(() => {
          child.disconnect();
          reject(new Error('Visitor startup timed out.'));
        }, 60000);
        child.on('message', (m) => {
          if (m.type === 'booted') child.send({ type: 'start', key });
          if (m.type === 'ready') {
            clearTimeout(timer);
            entry.origin = m.origin;
            resolveReady(entry);
          }
        });
        child.once('error', (e) => {
          clearTimeout(timer);
          reject(e);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          if (visitors.get(id) === entry) visitors.delete(id);
          reject(new Error('Visitor runtime exited.'));
        });
      });
      await ready;
      visitors.set(id, entry);
      return acquire(entry);
    };
    const pending = queue.then(prepare);
    queue = pending.catch(() => {});
    return pending;
  }
  function headers(req, entry) {
    const values = { ...req.headers, host: new URL(entry.origin).host, 'x-novelharness-internal': entry.key };
    for (const key of [
      'cookie',
      'authorization',
      'x-forwarded-host',
      'x-forwarded-proto',
      'x-novel-host-auth',
      'x-novel-forwarded-origin',
      'x-novel-forward-as',
    ])
      delete values[key];
    if (req.headers.origin) values.origin = entry.origin;
    return values;
  }
  const server = createServer(async (req, res) => {
    if (!checkOrigin(req, origin)) return error(res, 403, '请求来源不正确。');
    if (/^\/login\/?(?:\?|$)/.test(req.url))
      return res.writeHead(302, { location: '/', 'cache-control': 'no-store' }).end();
    if (req.url === '/api/health')
      return res
        .writeHead(200, { 'content-type': 'application/json' })
        .end('{"status":"ok","mode":"anonymous-isolated"}');
    try {
      let id = identity.read(req.headers.cookie);
      if (!id) {
        const token = identity.issue();
        id = token.split('.')[0];
        res.setHeader('set-cookie', identity.cookie(token, new URL(origin).protocol === 'https:'));
      }
      const entry = await getVisitor(id);
      let finished = false;
      const finish = () => {
        if (!finished) {
          finished = true;
          entry.requests--;
          entry.last = Date.now();
        }
      };
      res.once('close', finish);
      const upstream = request(
        entry.origin + req.url,
        { method: req.method, headers: headers(req, entry) },
        (response) => {
          const h = { ...response.headers };
          delete h['set-cookie'];
          res.writeHead(response.statusCode, h);
          pipeline(response, res).catch(() => {});
        },
      );
      upstream.on('error', () => error(res, 503, '访客空间暂不可用，请重试；未切换到其他人的数据。'));
      res.on('close', () => upstream.destroy());
      pipeline(req, upstream).catch(() => {});
    } catch {
      error(res, 503, '当前写作空间繁忙，请稍后重试；数据仍已保留。');
    }
  });
  server.on('upgrade', async (req, socket, head) => {
    const reject = () =>
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const id = identity.read(req.headers.cookie);
    if (!id || !checkOrigin(req, origin)) return reject();
    try {
      const entry = await getVisitor(id, false);
      entry.last = Date.now();
      const outgoing = request(entry.origin + req.url, { headers: headers(req, entry) });
      outgoing.on('error', () => socket.destroy());
      outgoing.on('response', (response) => {
        response.resume();
        reject();
      });
      outgoing.on('upgrade', (response, upstream, upstreamHead) => {
        sockets.add(socket);
        sockets.add(upstream);
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
        socket.on('close', () => {
          sockets.delete(socket);
          upstream.destroy();
        });
        upstream.on('close', () => {
          sockets.delete(upstream);
          socket.destroy();
        });
        let handshake = 'HTTP/1.1 101 Switching Protocols\r\n';
        for (let i = 0; i < response.rawHeaders.length; i += 2)
          handshake += response.rawHeaders[i] + ': ' + response.rawHeaders[i + 1] + '\r\n';
        socket.write(handshake + '\r\n');
        if (upstreamHead.length) socket.write(upstreamHead);
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      });
      outgoing.end();
    } catch {
      reject();
    }
  });
  await new Promise((yes, no) => {
    server.once('error', no);
    server.listen(port, host, yes);
  });
  origin = publicOrigin || 'http://127.0.0.1:' + server.address().port;
  await writeFile(
    join(runtime, 'running.json'),
    JSON.stringify({ pid: process.pid, origin, port: server.address().port }),
  );
  return {
    origin,
    async close() {
      closing = true;
      // Never terminate an active generation to make room or complete shutdown.
      for (const entry of visitors.values())
        if (!(await idle(entry))) {
          closing = false;
          throw new Error('AI or HTTP requests are still active.');
        }
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise((yes) => server.close(yes));
      await queue;
      for (const entry of visitors.values()) await stop(entry);
      await lock.close();
      await unlink(lockPath);
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('cloud/selfhost/server.mjs')) {
  const app = await startAnonymousServer({
    port: Number(process.env.PORT || 3210),
    host: process.env.HOST || '127.0.0.1',
    publicOrigin: process.env.PUBLIC_ORIGIN,
    maxVisitors: Number(process.env.MAX_ACTIVE_VISITORS || 2),
  });
  console.log('NovelHarness: ' + app.origin);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () =>
      app
        .close()
        .then(() => process.exit(0))
        .catch(() => console.error('AI still active; wait for it to finish before stopping.')),
    );
}
