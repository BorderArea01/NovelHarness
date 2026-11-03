// Read-only operator checks. Never creates a store, starts a tunnel, migrates
// data, resets a PIN or prints secret contents.
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { loadDeploymentConfig, storageDirectory } from './config.mjs';
import { pinIsConfigured } from './initial-pin.mjs';

export async function checkDeployment(config) {
  const directory = storageDirectory(config),
    checks = [];
  const add = (name, status, message) => checks.push({ name, status, message });
  try {
    const runtime = JSON.parse(await readFile(join(config.runtimeDirectory, '.anonymous-host.json'), 'utf8'));
    const prepared = runtime.format === 'novelharness-anonymous-v1' && runtime.prepared === true;
    add('program', prepared ? 'ok' : 'error', prepared ? '程序已构建。' : '请先 npm run build。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    add('program', 'error', '程序尚未构建，请先 npm run build。');
  }
  try {
    const marker = JSON.parse(await readFile(join(directory, '.novelharness-store.json'), 'utf8'));
    add(
      'data-mode',
      marker.format === 'novelharness-store-v1' && marker.mode === config.mode ? 'ok' : 'error',
      '数据目录登记的模式：' + marker.mode,
    );
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let names = [];
    try {
      names = await readdir(directory);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const legacyVisitor = config.mode === 'isolated' && names.every((n) => /^[a-f0-9]{64}$/.test(n));
    add(
      'data-mode',
      names.length && !legacyVisitor ? 'error' : 'warning',
      names.length && !legacyVisitor
        ? '旧数据尚未登记，不能直接启动；请先核验旧服务并登记原目录。'
        : '首次启动会登记该目录；不会导入其他目录的数据。',
    );
  }
  if (config.mode === 'shared') {
    if (!existsSync(join(directory, 'main.sqlite')))
      add('database', 'warning', '该目录尚无书稿库；首次启动将新建空库。请确认目录、权限和挂载。');
    else
      try {
        const db = new Database(join(directory, 'main.sqlite'), { readonly: true, fileMustExist: true });
        try {
          const valid =
            db.pragma('quick_check', { simple: true }) === 'ok' &&
            db.prepare("SELECT v FROM vfs_meta WHERE k='schema_version'").get()?.v === 8;
          add(
            'database',
            valid ? 'ok' : 'error',
            valid ? '原生书稿 SQLite 完整性与版本通过。' : '数据库完整性或版本不符。',
          );
        } finally {
          db.close();
        }
      } catch (error) {
        if (error.code === 'SQLITE_CANTOPEN')
          add(
            'database',
            'warning',
            '该目录尚无可打开的书稿库；请确认目录、权限和挂载。空目录首次启动将新建空库。',
          );
        else add('database', 'error', '数据库读取失败或不是原生 SQLite 书稿库；未尝试修复或覆盖。');
      }
    try {
      const configured = pinIsConfigured(directory);
      add(
        'pin',
        configured ? 'ok' : 'warning',
        configured
          ? '已有 PIN，首次初始化变量不会重设它。'
          : '首次 npm start 设置 PIN；无人值守启动需 NOVEL_INITIAL_PIN。',
      );
    } catch {
      add('pin', 'error', '已有 PIN 库无法读取；未重置或覆盖，请先检查权限和完整性。');
    }
  } else {
    add('database', 'ok', '每位访客在此目录下拥有独立 SQLite、原生对话和模型配置；Cookie 是访问凭证。');
  }
  const rel = relative(resolve(config.runtimeDirectory), directory);
  if (!rel.startsWith('..') && !isAbsolute(rel))
    add(
      'persistence',
      'warning',
      '数据位于程序构建目录内。完整备份此目录；生产部署建议显式指定独立持久目录或容器卷，不能只复制程序。',
    );
  else add('persistence', 'ok', '数据目录已与程序构建目录分开；仍需部署者保证磁盘或挂载卷持久保存。');
  add(
    'access',
    config.ingress === 'lan' ? 'ok' : 'warning',
    config.ingress === 'lan'
      ? ['127.0.0.1', 'localhost', '::1'].includes(config.host)
        ? '仅本机监听；局域网访问需配置 host。'
        : '已配置网络监听，仍需实际设备验证访问。'
      : '已声明公网入口，但本命令未验证连接。反向代理 / Cloudflare Tunnel 及 VPC binding 必须单独配置；不会自动建立穿透。',
  );
  return {
    mode: config.mode,
    ingress: config.ingress,
    dataDirectory: directory,
    database: config.mode === 'shared' ? join(directory, 'main.sqlite') : '<每个访客目录>/main.sqlite',
    publicOrigin: config.publicOrigin || null,
    networkChanged: false,
    dataChanged: false,
    configurationValid: checks.every((c) => c.status !== 'error'),
    publicConnectionVerified: false,
    checks,
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await checkDeployment(await loadDeploymentConfig());
  console.log(JSON.stringify(result, null, 2));
  if (!result.configurationValid) process.exitCode = 1;
}
