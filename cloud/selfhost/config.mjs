import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

export const MODES = ['isolated', 'shared'];
export function ingressMode(mode, publicOrigin, selected) {
  const kind = selected ?? (publicOrigin ? 'reverse-proxy' : 'lan');
  if (!['lan', 'reverse-proxy', 'cloudflare-vpc'].includes(kind))
    throw new Error('ingress 只能是 lan、reverse-proxy 或 cloudflare-vpc。');
  if ((kind === 'lan') === !!publicOrigin)
    throw new Error('局域网模式不填 publicOrigin；公网转发必须填写 publicOrigin。');
  if (kind === 'cloudflare-vpc' && (mode !== 'shared' || !publicOrigin.startsWith('https://')))
    throw new Error('Cloudflare VPC 认证转发需要 shared 模式和 HTTPS publicOrigin。');
  return kind;
}
export function storageDirectory(config) {
  return resolve(
    config.dataDirectory ??
      join(
        config.runtimeDirectory,
        'data/official-validation/integration',
        config.mode === 'shared' ? 'shared' : 'visitors',
      ),
  );
}
export function deploymentConfig(value = {}, env = {}, cwd = process.cwd()) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('部署配置必须是 JSON 对象。');
  const known = [
    'mode',
    'host',
    'port',
    'publicOrigin',
    'ingress',
    'maxVisitors',
    'runtimeDirectory',
    'dataDirectory',
  ];
  for (const key of Object.keys(value)) if (!known.includes(key)) throw new Error('未知部署配置项：' + key);
  const mode = env.NOVEL_MODE ?? value.mode ?? 'isolated';
  if (!MODES.includes(mode)) throw new Error('NOVEL_MODE 只能是 isolated 或 shared。');
  const port = Number(env.PORT ?? value.port ?? 3210);
  const maxVisitors = Number(env.MAX_ACTIVE_VISITORS ?? value.maxVisitors ?? 2);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效端口。');
  if (!Number.isInteger(maxVisitors) || maxVisitors < 1 || maxVisitors > 8)
    throw new Error('MAX_ACTIVE_VISITORS 必须是 1–8。');
  const host = env.HOST ?? value.host ?? '127.0.0.1';
  if (typeof host !== 'string' || !host.trim()) throw new Error('HOST 不能为空。');
  const publicOrigin = env.PUBLIC_ORIGIN ?? value.publicOrigin ?? '';
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('PUBLIC_ORIGIN 必须是不带路径、凭证或查询的 HTTP(S) 来源。');
  }
  const runtimeDirectory = resolve(
    cwd,
    env.NOVEL_RUNTIME_DIR ?? value.runtimeDirectory ?? 'data/anonymous-runtime',
  );
  const directory = env.NOVEL_DATA_DIR ?? value.dataDirectory;
  if (directory !== undefined && (typeof directory !== 'string' || !directory.trim()))
    throw new Error('数据目录不能为空。');
  return {
    mode,
    host,
    port,
    publicOrigin: publicOrigin ? new URL(publicOrigin).origin : '',
    ingress: ingressMode(mode, publicOrigin, env.NOVEL_INGRESS ?? value.ingress),
    maxVisitors,
    runtimeDirectory,
    dataDirectory: directory === undefined ? undefined : resolve(cwd, directory),
    initialPin: env.NOVEL_INITIAL_PIN,
  };
}

export async function loadDeploymentConfig({ env = process.env, cwd = process.cwd() } = {}) {
  const path = resolve(cwd, env.NOVEL_CONFIG ?? 'novelharness.config.json');
  let value = {};
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('无法读取部署配置：' + error.message);
  }
  return deploymentConfig(value, env, cwd);
}
