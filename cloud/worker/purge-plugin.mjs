// dsh-purge novel adapter. Original prompt-normalization routines below:
// Copyright 2026 YuJunZhiXue, Apache-2.0.
// Source: YuJunZhiXue/dsh-purge@0c933dc7d3252698f3f0f9756932dcc88355f532,
// lib/identity.js. Host patches/persona replacement are deliberately NOT loaded.
import { createHash } from 'node:crypto';
import { novelRoot } from './novel-role.mjs';
export const PURGE_SOURCE = {
  name: 'dsh-purge',
  version: '1.1.82',
  adapter: 'novel-1',
  commit: '0c933dc7d3252698f3f0f9756932dcc88355f532',
  repository: 'https://github.com/YuJunZhiXue/dsh-purge',
};
// Historical adapter compatibility only; no runtime installs this middleware.
export const PURGE_DEFAULT =
  '你是小说创作搭档与编辑。按作者本次要求使用当前可用能力完成任务；具体创作流程、资料与保存约定由工作台当前上下文提供，本段不另设身份、文风、提问或保存规则。';
export const PURGE_CAPABILITIES = {
  supported: ['小说提示词注入', '提示词编辑与版本恢复', '热停用与卸载', '原版提示词格式规范化'],
  native: ['工具权限', '重试、流式、停止与会话恢复'],
  unsupported: [
    '原版宿主破甲补丁',
    '替换系统身份与清除规则',
    '红队演练台',
    '自动改包、升级和重启',
    '额外自动续跑',
  ],
};
const FOLDER = '/workspace/.novel-plugins/dsh-purge',
  PATH = FOLDER + '/config.json';
const HASH = /^[a-f0-9]{64}$/;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const size = (text) => new TextEncoder().encode(text).length;
export class PurgeError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const fail = (code, message) => {
  throw new PurgeError(code, message);
};

// Adapted from upstream normalizeChatmlLayout/peelChatmlEnvelope: identical
// envelope normalization, no system identity or permission rewriting.
export function normalizePurgePrompt(text) {
  let out = String(text || '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n');
  if (!out) return out;
  out = out.replace(
    /<\|im_start\|>\s*system\s*:\s*<project_instructions>/gi,
    '<|im_start|>system:\n<project_instructions>',
  );
  out = out.replace(/<\|im_start\|>\s*system\s*:(?!\s*\n)/gi, '<|im_start|>system:\n');
  out = out.replace(
    /<\|im_start\|>system:\n+<project_instructions>/i,
    '<|im_start|>system:\n<project_instructions>',
  );
  if (/<project_instructions>/i.test(out) && !/<\/project_instructions>/i.test(out))
    out = `${out.replace(/\s+$/, '')}\n</project_instructions>`;
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s+/, '')
    .replace(/\s+$/, '');
}
function valid(state) {
  return (
    state?.format === 'novel-dsh-purge-v1' &&
    typeof state.enabled === 'boolean' &&
    typeof state.prompt === 'string' &&
    state.prompt.trim().length > 0 &&
    size(state.prompt) <= 32768 &&
    Number.isFinite(state.updatedAt) &&
    state.updatedAt >= 0
  );
}
export function purgeStore(fs, db, { now = Date.now, ensureIdle = () => {} } = {}) {
  function safe(path, missing = false) {
    let current = '';
    for (const part of path.split('/').filter(Boolean)) {
      current += '/' + part;
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (e) {
        if (missing && e.code === 'ENOENT') return false;
        throw e;
      }
      if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink > 1))
        fail(409, '插件配置含链接，未读取或覆盖。');
      if (current !== path && !stat.isDirectory()) fail(409, '插件配置父路径无效。');
      if (current === path && !stat.isFile()) fail(409, '插件配置不是普通文件。');
    }
    return true;
  }
  function read(path) {
    if (!safe(path, true)) return null;
    if (fs.lstatSync(path).size > 131072) fail(413, '插件配置超过安全大小，未加载。');
    let text, value;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(path));
      value = JSON.parse(text);
    } catch {
      fail(409, '插件配置损坏，已停止注入；原书稿和对话未改动。');
    }
    if (!valid(value)) fail(409, '插件配置不兼容，已停止注入。');
    return { ...value, revision: sha(text) };
  }
  function status() {
    let current, warning;
    try {
      current = read(PATH);
    } catch (e) {
      if (!(e instanceof PurgeError)) throw e;
      warning = e.message;
    }
    return {
      ...PURGE_SOURCE,
      capabilities: PURGE_CAPABILITIES,
      installed: !!current,
      enabled: current?.enabled ?? false,
      prompt: current?.prompt ?? PURGE_DEFAULT,
      revision: current?.revision ?? null,
      defaultPrompt: PURGE_DEFAULT,
      ...(warning ? { warning } : {}),
    };
  }
  function write(path, state) {
    safe(path, true);
    fs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(path, JSON.stringify(state));
  }
  return {
    current: () => db.transactionSync(() => read(PATH)),
    run: (input = {}) =>
      db.transactionSync(() => {
        if (!input.action || input.action === 'status') return status();
        if (input.action === 'history') {
          const path = FOLDER + '/history';
          // Check ancestors via a fixed nonexistent sentinel; never follow links.
          safe(path + '/.probe', true);
          let names;
          try {
            names = fs.readdirSync(path);
          } catch (e) {
            if (e.code !== 'ENOENT') throw e;
            names = [];
          }
          return {
            versions: names
              .filter((n) => HASH.test(n.replace(/\.json$/, '')) && n.endsWith('.json'))
              .map((n) => {
                const item = read(path + '/' + n);
                return { revision: n.slice(0, -5), enabled: item.enabled, updatedAt: item.updatedAt };
              })
              .sort((a, b) => b.updatedAt - a.updatedAt || b.revision.localeCompare(a.revision))
              .slice(0, 50),
          };
        }
        if (!['install', 'save', 'disable', 'enable', 'uninstall', 'restore'].includes(input.action))
          fail(400, '未知插件操作。');
        ensureIdle();
        const before = read(PATH);
        if (input.revision !== (before?.revision ?? null)) fail(409, '插件设置已更新，请重新读取；未覆盖。');
        if (input.action === 'install' && before) fail(409, '插件已安装，请修改设置或停用。');
        if (input.action !== 'install' && !before) fail(409, '插件尚未安装。');
        const stamp = now();
        let next = { format: 'novel-dsh-purge-v1', enabled: true, prompt: PURGE_DEFAULT, updatedAt: stamp };
        if (before) {
          const { revision, ...data } = before;
          next = { ...data, updatedAt: stamp };
        }
        if (input.action === 'save') {
          if (typeof input.prompt !== 'string' || typeof input.enabled !== 'boolean')
            fail(400, '插件设置格式不正确。');
          next.prompt = normalizePurgePrompt(input.prompt);
          next.enabled = input.enabled;
        }
        if (input.action === 'disable') next.enabled = false;
        if (input.action === 'enable') next.enabled = true;
        if (input.action === 'restore') {
          if (!HASH.test(input.hash ?? '')) fail(400, '插件历史标识无效。');
          const old = read(FOLDER + '/history/' + input.hash + '.json');
          if (!old || old.revision !== input.hash) fail(409, '插件历史校验失败，未恢复。');
          next = { format: old.format, enabled: false, prompt: old.prompt, updatedAt: stamp };
        }
        if (!valid(next)) fail(400, '提示词不能为空，且最多 32 KiB；未修改设置。');
        if (before) {
          const { revision, ...data } = before;
          write(FOLDER + '/history/' + revision + '.json', data);
        }
        if (input.action === 'uninstall') fs.unlinkSync(PATH);
        else write(PATH, next);
        return { ...status(), saved: true };
      }),
  };
}
export function withPurgePrompt(request, directory, config) {
  if (!novelRoot(directory) || !config?.enabled) return request;
  if (!valid(config) || !Array.isArray(request?.messages))
    throw new PurgeError(409, '插件提示词无效，未发出模型请求。');
  // The default adapter adds no writing policy. Only an author's explicit
  // plugin customization remains an additional source, visible in the editor.
  if (config.prompt === PURGE_DEFAULT) return request;
  const index = request.messages.findLastIndex((m) => m.role === 'system');
  if (index < 0) throw new PurgeError(409, '缺少原生系统提示词，未替换小说身份。');
  return {
    ...request,
    messages: request.messages.map((m, i) =>
      i === index
        ? {
            ...m,
            content: [...m.content, { type: 'text', text: '\n\n' + normalizePurgePrompt(config.prompt) }],
          }
        : m,
    ),
  };
}
export function installPurgeAdapter(context, { readConfig }) {
  return context.inject(['llm'], (host) => {
    const llm = host.get('llm');
    const original = llm.adapterStream;
    if (typeof original !== 'function') throw new Error('Pinned native LLM dispatch seam is unavailable.');
    const wrapped = async function* (request, registration) {
      // SystemPrompt contributes durable system/message events. An optional
      // extension must instead use the original request middleware, otherwise
      // disabling it leaves its old instructions in the conversation forever.
      const agent = request.sessionId && host.get('agents').get(request.sessionId);
      if (!agent || request.purpose !== undefined) {
        yield* original.call(this, request, registration);
        return;
      }
      const working = host.get('workingDirectory');
      const directory = working.get(agent.session);
      if (!novelRoot(directory)) {
        yield* original.call(this, request, registration);
        return;
      }
      request.signal?.throwIfAborted();
      let state;
      try {
        state = await readConfig();
      } catch (e) {
        if (!(e instanceof PurgeError)) throw e;
        yield* original.call(this, request, registration);
        return;
      } // Corrupt plugin cannot take the app down.
      if (working.get(agent.session) !== directory) throw new PurgeError(409, '作品已切换，未混合注入。');
      request.signal?.throwIfAborted();
      const scoped = withPurgePrompt(request, directory, state);
      // Native requests and history projections are frozen. Clone at the
      // pinned pre-dispatch seam; never mutate them or bypass the downstream
      // native stream/checkpoint/cancellation/adapter middleware.
      yield* original.call(this, scoped, registration);
    };
    llm.adapterStream = wrapped;
    host.effect(
      () => () => {
        if (llm.adapterStream === wrapped) llm.adapterStream = original;
      },
      'dsh-purge: restore native dispatch',
    );
  });
}
