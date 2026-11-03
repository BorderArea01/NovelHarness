import { createServer, request } from 'node:http';
import { readFile, writeFile, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { visitorIdentity, checkOrigin, sharedCookies } from './identity.mjs';
import { productionAuthority } from '../official/novel/production-wire.mjs';
import { claimDataDirectory, sharedOwnerKey, visitorSigningKeys } from './data-directory.mjs';
import { loadDeploymentConfig } from './config.mjs';
import { networkInterfaces } from 'node:os';
import { initialPinForCli } from './initial-pin.mjs';
import { setTimeout as delay } from 'node:timers/promises';
import { claimInstallationLease } from './installation-lease.mjs';

export async function startSelfHostedServer({
  port = 3210,
  host = '127.0.0.1',
  publicOrigin,
  maxVisitors = 2,
  runtime = resolve('data/anonymous-runtime'),
  mode = 'isolated',
  dataDirectory,
  initialPin,
} = {}) {
  if (!['isolated', 'shared'].includes(mode)) throw new Error('Invalid deployment mode.');
  const shared = mode === 'shared';
  if (!Number.isInteger(maxVisitors) || maxVisitors < 1 || maxVisitors > 8)
    throw new Error('MAX_ACTIVE_VISITORS must be an integer from 1 to 8.');
  if (publicOrigin && !['http:', 'https:'].includes(new URL(publicOrigin).protocol))
    throw new Error('Invalid PUBLIC_ORIGIN.');
  const marker = JSON.parse(await readFile(join(runtime, '.anonymous-host.json'), 'utf8'));
  if (marker.format !== 'novelharness-anonymous-v1' || !marker.prepared)
    throw new Error('Run npm run build:public first.');
  let lease, dataClaim, server, stopRuntime;
  const visitors = new Map();
  try {
    const dataRoot = resolve(
      dataDirectory ?? join(runtime, 'data/official-validation/integration', shared ? 'shared' : 'visitors'),
    );
    dataClaim = await claimDataDirectory(dataRoot, mode);
    const ownerKey = shared ? await sharedOwnerKey(dataRoot) : null;
    const storeMetadata = JSON.parse(await readFile(join(dataRoot, '.novelharness-store.json'), 'utf8'));
    const privateCookies = shared
      ? sharedCookies(ownerKey, storeMetadata.legacyCookies, await realpath(dataRoot))
      : null;
    const { novelAssetsRevision: revision } = JSON.parse(
      await readFile(join(runtime, 'data/official-validation/integration/baseline.json'), 'utf8'),
    );
    lease = await claimInstallationLease(runtime, dataRoot, mode);
    let identity;
    if (!shared) {
      const legacy =
        dataRoot === resolve(runtime, 'data/official-validation/integration/visitors')
          ? join(runtime, 'visitor-secret.json')
          : undefined;
      const keys = await visitorSigningKeys(dataRoot, legacy);
      identity = visitorIdentity(keys.secret, keys.deployment);
    }
    const sockets = new Set();
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
    stopRuntime = stop;
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
        const key = shared ? ownerKey : randomBytes(32).toString('hex');
        const child = spawn(
          process.execPath,
          ['--max-old-space-size=' + (shared ? 512 : 384), 'cloud/selfhost/visitor.mjs', mode, id, dataRoot],
          {
            cwd: runtime,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            env: Object.fromEntries(
              Object.entries(process.env).filter(
                ([name]) => !/(KEY|TOKEN|SECRET|PASSWORD|PIN|DEEPSEEK|^DSH_|NODE_OPTIONS)/i.test(name),
              ),
            ),
          },
        );
        // Do not emit per-visitor logs: upstream exceptions can contain prose.
        child.stderr.resume();
        const entry = { child, key, requests: 0, last: Date.now() };
        const ready = new Promise((resolveReady, reject) => {
          let startupError;
          const timer = setTimeout(() => {
            startupError = new Error('Writing runtime startup timed out; existing data retained.');
            // Before ready no request or generation can reach this owned child.
            // Wait for exit before releasing the single-writer data lock, even
            // if it hung before installing its IPC disconnect handler.
            child.kill();
          }, 60000);
          child.on('message', (m) => {
            if (m.type === 'booted') child.send({ type: 'start', key, ...(shared ? { initialPin } : {}) });
            if (m.type === 'failed') {
              startupError = new Error(
                m.code === 'PIN_SETUP_REQUIRED'
                  ? '首次启动私人模式请设置 NOVEL_INITIAL_PIN（4–12 位数字），以后在页面修改 PIN。'
                  : '写作内核启动失败，已有数据保留。',
              );
            }
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
            reject(startupError ?? new Error('Writing runtime exited.'));
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
    function headers(req, entry, outside) {
      const values = {
        ...req.headers,
        host: new URL(entry.origin).host,
        'x-novelharness-internal': entry.key,
      };
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
      if (shared) {
        values.cookie = privateCookies.read(req.headers.cookie ?? '', outside.startsWith('https:'));
        values['x-novelharness-peer'] = req.socket.remoteAddress;
      }
      if (req.headers.origin) values.origin = entry.origin;
      return values;
    }
    const directHosts = new Set();
    function requestOrigin(req) {
      if (
        ['x-novel-host-auth', 'x-novel-forwarded-origin', 'x-novel-forward-as'].some(
          (k) => req.headers[k] !== undefined,
        )
      ) {
        if (!shared || !publicOrigin) return null;
        return (
          productionAuthority(req, {
            ownerKey,
            publicOrigin,
            port: server.address().port,
            authorities: directHosts,
          })?.outside.origin ?? null
        );
      }
      if (publicOrigin && req.headers.host === new URL(publicOrigin).host) return publicOrigin;
      return directHosts.has(req.headers.host) ? 'http://' + req.headers.host : null;
    }
    function validRequest(req, outside) {
      // Existing authenticated Cloudflare relays use a loopback Host with a
      // separately signed public origin. Normalize only after proving it.
      const headers =
        req.headers['x-novel-host-auth'] !== undefined
          ? { ...req.headers, host: new URL(outside).host }
          : req.headers;
      return checkOrigin({ url: req.url, headers }, outside);
    }
    server = createServer(async (req, res) => {
      const outside = requestOrigin(req);
      if (!outside || !validRequest(req, outside)) return error(res, 403, '请求来源不正确。');
      if (!shared && /^\/login\/?(?:\?|$)/.test(req.url))
        return res.writeHead(302, { location: '/', 'cache-control': 'no-store' }).end();
      if (req.url === '/api/health')
        return res
          .writeHead(200, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ status: 'ok', mode, runtime: 'deepseek-harness', revision, published: true }),
          );
      if (req.url === '/api/deployment' && req.method === 'GET')
        return res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(
          JSON.stringify({
            mode,
            title: shared ? '私人共享空间' : '访客独立空间',
            changeRequiresRestart: true,
          }),
        );
      try {
        let id = shared ? 'shared' : identity.read(req.headers.cookie);
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
          { method: req.method, headers: headers(req, entry, outside) },
          (response) => {
            const h = { ...response.headers };
            if (!shared) delete h['set-cookie'];
            else if (h['set-cookie'])
              h['set-cookie'] = h['set-cookie'].flatMap((v) =>
                privateCookies.write(v, outside.startsWith('https:')),
              );
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
      const id = shared ? 'shared' : identity.read(req.headers.cookie),
        outside = requestOrigin(req);
      if (!id || !outside || !validRequest(req, outside)) return reject();
      try {
        const entry = await getVisitor(id, false);
        entry.last = Date.now();
        const outgoing = request(entry.origin + req.url, { headers: headers(req, entry, outside) });
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
    if (shared) await getVisitor('shared', false);
    await new Promise((yes, no) => {
      server.once('error', no);
      server.listen(port, host, yes);
    });
    const localHost = ['0.0.0.0', '::', 'localhost'].includes(host)
      ? '127.0.0.1'
      : host.includes(':')
        ? '[' + host + ']'
        : host;
    origin = publicOrigin || 'http://' + localHost + ':' + server.address().port;
    const hosts = ['127.0.0.1', 'localhost', '[::1]'];
    if (host === '0.0.0.0' || host === '::')
      hosts.push(
        ...Object.values(networkInterfaces())
          .flat()
          .filter((i) => i && i.family === 'IPv4')
          .map((i) => i.address),
      );
    else if (!hosts.includes(host)) hosts.push(host);
    for (const h of hosts) directHosts.add(h + ':' + server.address().port);
    await writeFile(
      join(runtime, 'running.json'),
      JSON.stringify({
        pid: process.pid,
        origin,
        port: server.address().port,
        mode,
        dataDirectory: dataRoot,
      }),
    );
    await lease.ready({ pid: process.pid, origin, port: server.address().port });
    return {
      origin,
      localOrigin: 'http://' + localHost + ':' + server.address().port,
      async close() {
        closing = true;
        // Never terminate an active generation to make room or complete shutdown.
        for (const entry of visitors.values()) {
          // A closed browser can leave its final short RPC in flight for one
          // event-loop tick. Drain it; do not confuse it with active generation
          // or forcibly abort uploads/streams to make shutdown pass.
          const deadline = Date.now() + 2000;
          while (entry.requests && Date.now() < deadline) await delay(25);
          if (!(await idle(entry))) {
            closing = false;
            throw new Error('AI or HTTP requests are still active.');
          }
        }
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await new Promise((yes) => server.close(yes));
        await queue;
        for (const entry of visitors.values()) await stop(entry);
        await lease.release();
        await dataClaim.release();
      },
    };
  } catch (error) {
    if (server?.listening) await new Promise((done) => server.close(done));
    for (const entry of visitors.values()) await stopRuntime(entry);
    if (lease) await lease.release();
    if (dataClaim) await dataClaim.release();
    throw error;
  }
}

export function startAnonymousServer(options = {}) {
  return startSelfHostedServer({ ...options, mode: 'isolated' });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve('cloud/selfhost/server.mjs')) {
  const config = await loadDeploymentConfig();
  config.initialPin = await initialPinForCli(config);
  const app = await startSelfHostedServer({ ...config, runtime: config.runtimeDirectory });
  console.log('NovelHarness · ' + (config.mode === 'shared' ? '私人共享' : '访客隔离') + ': ' + app.origin);
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () =>
      app
        .close()
        .then(() => process.exit(0))
        .catch(() => console.error('AI still active; wait for it to finish before stopping.')),
    );
}
