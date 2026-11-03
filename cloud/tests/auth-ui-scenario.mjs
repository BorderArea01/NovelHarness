// UI-only failure fixture; actual salted hashes/cookies are tested by PinAuth
// and native-runtime. Never reads production credentials or changes real PINs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function verifyAuthUI(browser, root) {
  const key = 'f'.repeat(64),
    pin = '046219';
  const work = resolve(root, 'test-results/cloud-auth-ui');
  await mkdir(work, { recursive: true });
  const state = {
    configured: false,
    pin: '',
    epoch: 0,
    recoverCalls: 0,
    pinCalls: 0,
    hold: false,
    release: null,
  };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://fixture.invalid').pathname;
      const authenticated = req.headers.cookie?.includes('fixture_auth=' + state.epoch) === true;
      const json = (data, status = 200, headers = {}) => {
        res.writeHead(status, {
          'content-type': 'application/json',
          'cache-control': 'no-store',
          ...headers,
        });
        res.end(JSON.stringify(data));
      };
      if (path === '/api/auth/pin' && req.method === 'GET')
        return json({ configured: state.configured, authenticated });
      if (path.startsWith('/api/')) {
        let raw = '';
        for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw);
        const success = () =>
          json({ authenticated: true }, 200, {
            'set-cookie': 'fixture_auth=' + state.epoch + '; Path=/; HttpOnly; SameSite=Strict',
          });
        if (path === '/api/auth/recover') {
          state.recoverCalls++;
          if (body.accessKey !== key) return json({ error: '恢复口令不正确。' }, 401);
          if (state.hold)
            await new Promise((resolve) => {
              state.release = resolve;
            });
          return success();
        }
        if (path === '/api/auth/pin') {
          state.pinCalls++;
          if (!authenticated) return json({ error: '请先登录。' }, 401);
          state.configured = true;
          state.pin = body.newPin;
          state.epoch++;
          return success();
        }
        if (path === '/api/auth/login') {
          if (body.pin !== state.pin) return json({ error: 'PIN 不正确。' }, 401);
          return success();
        }
        return json({ error: 'Unexpected fixture API.' }, 404);
      }
      if (path === '/novels/') {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>Fixture library</h1>');
        return;
      }
      const files = {
        '/login': 'login/index.html',
        '/auth-assets/auth.mjs': 'auth-assets/auth.mjs',
        '/auth-assets/auth.css': 'auth-assets/auth.css',
      };
      if (!files[path]) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'content-type': path.endsWith('.mjs')
          ? 'text/javascript'
          : path.endsWith('.css')
            ? 'text/css'
            : 'text/html',
      });
      res.end(await readFile(resolve(root, 'cloud/pages/public', files[path])));
    } catch {
      res.writeHead(500).end('Synthetic fixture failure.');
    }
  });
  let context;
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(origin + '/login');
    await page.getByRole('heading', { name: '首次使用', exact: true }).waitFor();
    assert.equal(await page.locator('#login-form').isVisible(), false);
    assert.equal(await page.locator('#setup').isVisible(), false);
    await page.locator('#bootstrap-key').fill('123456');
    await page.locator('#credential-hint').filter({ hasText: '这看起来是短数字 PIN' }).waitFor();
    assert.equal(state.recoverCalls, 0);
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.locator('#message').filter({ hasText: '恢复口令不正确' }).waitFor();
    assert.equal(await page.locator('#setup').isVisible(), false);
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1280, 900],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(work, 'verify-' + width + '.png'), fullPage: true });
    }
    await page.route(
      '**/api/auth/recover',
      (route) =>
        route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'Synthetic temporary failure.' }),
        }),
      { times: 1 },
    );
    await page.locator('#bootstrap-key').fill(key);
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.locator('#message').filter({ hasText: 'Synthetic temporary failure.' }).waitFor();
    assert.equal(await page.locator('#bootstrap-key').isEnabled(), true);
    await page.route('**/api/auth/recover', (route) => route.abort('failed'), { times: 1 });
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.locator('#message').filter({ hasText: '无法连接认证服务' }).waitFor();
    assert.equal(await page.locator('#bootstrap-key').isEnabled(), true);
    state.hold = true;
    await page.locator('#bootstrap-key').fill('  ' + key + '  ');
    await page.getByRole('button', { name: '显示部署恢复口令', exact: true }).click();
    assert.equal(await page.locator('#bootstrap-key').getAttribute('type'), 'text');
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('#bootstrap-key').disabled);
    assert.equal(await page.locator('#bootstrap-key').getAttribute('type'), 'password');
    await page.locator('#bootstrap-form').evaluate((form) => form.requestSubmit());
    const holdDeadline = Date.now() + 10000;
    while (!state.release && Date.now() < holdDeadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(state.release, 'Synthetic verification request did not reach the pending fixture.');
    state.release();
    await page.getByRole('heading', { name: '设置你的 PIN', exact: true }).waitFor();
    assert.equal(
      state.recoverCalls,
      2,
      'Duplicate submit while pending must not send a second verification.',
    );
    assert.equal(await page.locator('#bootstrap-key').inputValue(), '');
    assert.equal(new URL(page.url()).pathname, '/login');
    await page.reload();
    await page.getByRole('heading', { name: '设置你的 PIN', exact: true }).waitFor();
    assert.equal(await page.locator('[data-step="pin"]').getAttribute('aria-current'), 'step');
    await page.locator('#setup-pin').fill(pin);
    await page.locator('#setup-confirm').fill('999999');
    await page.getByRole('button', { name: '设置 PIN 并进入书库', exact: true }).click();
    await page.locator('#message').filter({ hasText: '两次输入的新 PIN 不一致' }).waitFor();
    assert.equal(state.pinCalls, 0);
    await page.locator('#setup-confirm').fill(pin);
    assert.equal(await page.locator('#message').textContent(), '');
    for (const [width, height] of [
      [390, 844],
      [768, 1024],
      [1280, 900],
    ]) {
      await page.setViewportSize({ width, height });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: resolve(work, 'setup-' + width + '.png'), fullPage: true });
    }
    assert.equal(
      await page.evaluate(
        (key) =>
          Object.values(localStorage).some((value) => value.includes(key)) ||
          Object.values(sessionStorage).some((value) => value.includes(key)),
        key,
      ),
      false,
    );
    await page.getByRole('button', { name: '设置 PIN 并进入书库', exact: true }).click();
    await page.getByRole('heading', { name: 'Fixture library', exact: true }).waitFor();
    assert.equal(state.pin, pin, 'Leading zero is preserved.');
    assert.equal(state.pinCalls, 1);
    await context.clearCookies();
    await page.goto(origin + '/login');
    await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
    assert.equal(await page.locator('#bootstrap').isVisible(), false);
    await page.locator('#pin').fill(pin);
    await page.getByRole('button', { name: '进入书库', exact: true }).click();
    await page.getByRole('heading', { name: 'Fixture library', exact: true }).waitFor();
    state.hold = false;
    state.configured = false;
    state.pin = '';
    state.epoch++;
    await context.clearCookies();
    await page.goto(origin + '/login');
    await page.getByRole('heading', { name: '首次使用', exact: true }).waitFor();
    await page.route(
      '**/api/auth/recover',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ authenticated: true }),
        }),
      { times: 1 },
    );
    await page.locator('#bootstrap-key').fill(key);
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.locator('#message').filter({ hasText: '浏览器未保留登录会话' }).waitFor();
    assert.equal(
      await page.locator('#setup').isVisible(),
      false,
      'A success JSON without a retained session is not successful verification.',
    );
    await page.locator('#bootstrap-key').fill(key);
    await page.getByRole('button', { name: '验证恢复口令', exact: true }).click();
    await page.getByRole('heading', { name: '设置你的 PIN', exact: true }).waitFor();
    state.configured = true;
    state.pin = '781204';
    state.epoch++;
    await page.locator('#setup-pin').fill('815703');
    await page.locator('#setup-confirm').fill('815703');
    await page.getByRole('button', { name: '设置 PIN 并进入书库', exact: true }).click();
    await page.getByRole('heading', { name: '欢迎回来', exact: true }).waitFor();
    await page.locator('#message').filter({ hasText: '登录或设置状态已变化' }).waitFor();
    assert.equal(state.pin, '781204', 'A stale initial setup must not overwrite the other device PIN.');
    assert.deepEqual(errors, []);
    console.log(
      'Auth UI fixture passed: in-place verify/setup, refresh, no credential storage, masked/reveal, short-PIN hint, pending duplicate guard, error retry, confirmation, leading zero and 390/768/1280 layouts. Not a crypto/provider test.',
    );
  } finally {
    state.release?.();
    await context?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
