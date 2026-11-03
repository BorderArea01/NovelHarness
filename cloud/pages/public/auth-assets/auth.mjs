const $ = (id) => document.getElementById(id);
let busy = false;
function maskPasswords() {
  for (const button of document.querySelectorAll('[data-reveal]')) {
    $(button.dataset.reveal).type = 'password';
    button.textContent = '显示';
    button.setAttribute('aria-pressed', 'false');
    button.setAttribute('aria-label', '显示' + button.dataset.label);
  }
}
for (const button of document.querySelectorAll('[data-reveal]')) {
  button.addEventListener('click', () => {
    const input = $(button.dataset.reveal),
      show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    button.textContent = show ? '隐藏' : '显示';
    button.setAttribute('aria-pressed', String(show));
    button.setAttribute('aria-label', (show ? '隐藏' : '显示') + button.dataset.label);
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) maskPasswords();
});
const recoveryInput = $('bootstrap-key');
recoveryInput?.addEventListener('input', () => {
  const value = recoveryInput.value.trim(),
    hint = $('credential-hint');
  const looksLikePin = /^[0-9]{4,12}$/.test(value);
  hint.textContent = looksLikePin
    ? '这看起来是短数字 PIN。此处需要部署恢复口令，PIN 会在下一步设置。'
    : value
      ? '已输入 ' + value.length + ' 个字符，请确认已复制完整。'
      : '';
  hint.classList.toggle('warning', looksLikePin);
});
function message(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}
for (const input of document.querySelectorAll('form input'))
  input.addEventListener('input', () => {
    if (!busy && $('message').classList.contains('error')) message('');
  });
function pending(value) {
  busy = value;
  document.querySelectorAll('form button, form input').forEach((control) => (control.disabled = value));
  document.querySelector('main')?.setAttribute('aria-busy', String(value));
}
async function api(path, data) {
  const response = await fetch(path, {
    method: data ? 'POST' : 'GET',
    credentials: 'same-origin',
    signal: AbortSignal.timeout(15000),
    redirect: 'error',
    headers: data ? { 'content-type': 'application/json' } : {},
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error('认证服务暂不可用，请稍后重试。');
  }
  if (!response.ok) {
    const retry = response.headers.get('retry-after');
    const error = new Error(
      (result.error || '请求未完成。') + (retry ? ` 请约 ${Math.ceil(Number(retry) / 60)} 分钟后重试。` : ''),
    );
    error.status = response.status;
    throw error;
  }
  return result;
}
function wireForm(id, path, success) {
  const form = $(id);
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    const data = Object.fromEntries(new FormData(form));
    if (typeof data.accessKey === 'string') data.accessKey = data.accessKey.trim();
    if (data.newPin !== undefined && data.newPin !== data.confirmPin) {
      message('两次输入的新 PIN 不一致。', true);
      form.querySelector('[name="confirmPin"]')?.focus();
      return;
    }
    pending(true);
    maskPasswords();
    message(data.newPin !== undefined ? '正在保存 PIN…' : '正在验证身份…');
    try {
      await api(path, data);
      form.reset();
      if (id === 'bootstrap-form') $('credential-hint').textContent = '';
      await success();
    } catch (error) {
      if (id === 'setup-form' && error.status === 401) {
        await load().catch(() => {});
        message('登录或设置状态已变化，请按当前页面重新验证；没有自动重发新 PIN。', true);
        return;
      }
      message(
        error.name === 'TimeoutError'
          ? '请求超时；如刚保存 PIN，请尝试新 PIN 登录，无法登录时可使用恢复口令。'
          : error.name === 'TypeError'
            ? '无法连接认证服务，请检查网络后重试。'
            : error.message || '请求结果未知；如刚修改 PIN，请尝试新 PIN 登录或使用恢复口令。',
        true,
      );
    } finally {
      pending(false);
    }
  });
}
wireForm('login-form', '/api/auth/login', () => location.assign('/novels/'));
wireForm('bootstrap-form', '/api/auth/recover', () => load(true));
wireForm('setup-form', '/api/auth/pin', () => location.assign('/novels/'));
wireForm('recovery-form', '/api/auth/recover', () => location.assign('/novels/'));
wireForm('pin-form', '/api/auth/pin', async () => {
  message('PIN 已保存，书稿、对话与模型配置未改动。');
  await load();
});
async function load(afterVerification = false) {
  const state = await api('/api/auth/pin');
  if (document.body.dataset.page === 'login') {
    if (state.authenticated && state.configured) {
      location.replace('/novels/');
      return;
    }
    const setup = state.authenticated && !state.configured;
    $('auth-heading').textContent = state.configured ? '欢迎回来' : setup ? '设置你的 PIN' : '首次使用';
    document.title = (state.configured ? 'PIN 登录' : '首次设置') + ' · 小说工作台';
    $('login-form').hidden = !state.configured;
    $('bootstrap').hidden = state.configured || setup;
    $('setup').hidden = !setup;
    $('setup-steps').hidden = state.configured;
    for (const step of document.querySelectorAll('[data-step]')) {
      if (step.dataset.step === (setup ? 'pin' : 'verify')) step.setAttribute('aria-current', 'step');
      else step.removeAttribute('aria-current');
    }
    $('recovery').hidden = !state.configured;
    if (afterVerification) message('身份已验证，请设置 PIN。');
    requestAnimationFrame(() => $(state.configured ? 'pin' : setup ? 'setup-pin' : 'bootstrap-key').focus());
    if (afterVerification && !state.authenticated)
      throw new Error(
        state.configured
          ? 'PIN 已设置，但当前浏览器未建立有效会话。请使用 PIN 登录，或使用恢复入口。'
          : '身份已验证，但浏览器未保留登录会话。请允许此站点的 Cookie 后重试。',
      );
  } else {
    if (!state.authenticated) {
      location.replace('/login');
      return;
    }
    $('current-row').hidden = !state.configured;
    $('current-pin').required = state.configured;
    $('pin-form').hidden = false;
    $('save-pin').textContent = state.configured ? '保存新 PIN' : '设置 PIN';
  }
  $('loading').hidden = true;
}
load().catch((error) => {
  $('loading').hidden = true;
  message(error.message, true);
});
