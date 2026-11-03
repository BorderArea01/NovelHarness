import { FORMAT, FILE_LIMIT, digest } from './bundle.mjs';

export const BACKUP_FORMAT = 'novel-harness-workspace-backup-v1';
export const BACKUP_LIMIT = 64 * 1024 * 1024;
export const BACKUP_JSON_LIMIT = 90 * 1024 * 1024;
export const TRANSFER_FILE_LIMIT = 1024 * 1024;
export const BACKUP_FILE_COUNT = 2048;
const encoder = new TextEncoder();

export function validRelativePath(path) {
  return (
    typeof path === 'string' &&
    path.length <= 2048 &&
    !/[\\\u0000-\u001f\u007f]/.test(path) &&
    path.split('/').every((part) => part && part !== '.' && part !== '..')
  );
}
export function contentBytes(content) {
  if (typeof content === 'string') return encoder.encode(content);
  if (content instanceof Uint8Array) return content;
  throw new Error('无法识别文件内容。');
}
export function sameBytes(left, right) {
  return left !== null && left.length === right.length && left.every((byte, index) => byte === right[index]);
}
export function wireBytes(content) {
  const bytes = contentBytes(content);
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error('备份包含非 UTF-8 文件，本版不能自动恢复；原备份完整保留，未上传。');
  }
  // The pinned diagnostic PUT decodes UTF-8 and consumes one BOM. Send a second
  // BOM only when necessary so the persisted original bytes remain unchanged.
  if (bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) {
    const body = new Uint8Array(bytes.length + 3);
    body.set([239, 187, 191]);
    body.set(bytes, 3);
    return body;
  }
  return bytes;
}
function base64(bytes) {
  let text = '';
  for (let start = 0; start < bytes.length; start += 8192)
    text += String.fromCharCode(...bytes.subarray(start, start + 8192));
  return btoa(text);
}
function decode(file) {
  if (
    file.encoding !== 'base64' ||
    typeof file.data !== 'string' ||
    file.data.length !== 4 * Math.ceil(file.bytes / 3) ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)
  )
    throw new Error('备份文件编码无效。');
  const text = atob(file.data);
  const bytes = Uint8Array.from(text, (char) => char.charCodeAt(0));
  if (bytes.length !== file.bytes || base64(bytes) !== file.data) throw new Error('备份文件长度无效。');
  return bytes;
}

export async function makeBackup(book, files) {
  const encoded = [];
  for (const { path, content } of files) {
    const bytes = contentBytes(content);
    encoded.push({
      path,
      bytes: bytes.length,
      sha256: await digest(bytes),
      encoding: 'base64',
      data: base64(bytes),
    });
  }
  const backup = {
    format: BACKUP_FORMAT,
    createdAt: new Date().toISOString(),
    sourceId: book.id,
    title: book.title,
    consistency: 'double-read-not-atomic',
    scope: 'book-directory-only-not-native-sessions-or-global-settings',
    files: encoded,
  };
  // Base64 is ASCII; calculate exact JSON bytes without allocating another
  // complete encoded copy of a potentially large book just for this check.
  const metadata = { ...backup, files: encoded.map((file) => ({ ...file, data: '' })) };
  if (
    encoder.encode(JSON.stringify(metadata)).length +
      encoded.reduce((sum, file) => sum + file.data.length, 0) >
    BACKUP_JSON_LIMIT
  )
    throw new Error('备份元数据超过可恢复的文件上限，未下载不完整档案。');
  return backup;
}

export async function restoreBackup(input) {
  if (
    input?.format !== BACKUP_FORMAT ||
    !/^b-[a-f0-9]{32}$/.test(input.sourceId) ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > BACKUP_FILE_COUNT
  )
    throw new Error('无法识别的本书备份。');
  let total = 0;
  const seen = new Set(),
    files = [];
  // Validate the full package before the caller is allowed to upload anything.
  for (const file of input.files) {
    if (
      !file ||
      !validRelativePath(file.path) ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > TRANSFER_FILE_LIMIT ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error('备份路径、长度或校验值无效。');
    seen.add(file.path);
    total += file.bytes;
    if (total > BACKUP_LIMIT) throw new Error('本书备份超过 64 MiB 恢复上限，未上传。');
    const content = decode(file);
    if ((await digest(content)) !== file.sha256) throw new Error(`备份校验失败（${file.path}），未上传。`);
    if (wireBytes(content).length > TRANSFER_FILE_LIMIT)
      throw new Error('含 BOM 的文件超过安全传输上限，未上传。');
    files.push({ path: file.path, content, bytes: file.bytes, sha256: file.sha256, kind: 'workspace' });
  }
  // A file/directory collision must fail before any partially restored writes.
  for (const path of seen) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++)
      if (seen.has(parts.slice(0, i).join('/'))) throw new Error('备份含文件与目录冲突，未上传。');
  }
  const receipt = files.find((file) => file.path === 'book.json');
  let original;
  try {
    original = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(receipt?.content));
  } catch {
    throw new Error('备份缺少有效小说收据，未上传。');
  }
  if (
    original.format !== FORMAT ||
    original.id !== input.sourceId ||
    original.root !== `/workspace/novels/${input.sourceId}`
  )
    throw new Error('备份来源与小说收据不一致，未上传。');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const fingerprint = await digest(
    JSON.stringify(['restore-workspace-v1', input.sourceId, files.map(({ path, sha256 }) => [path, sha256])]),
  );
  const id = `b-${fingerprint.slice(0, 32)}`;
  if (id === input.sourceId) throw new Error('恢复标识与原书冲突，未上传。');
  const restoredFiles = files.filter((file) => file.path !== 'book.json');
  const stat = (key) =>
    Number.isSafeInteger(original.stats?.[key]) && original.stats[key] >= 0 ? original.stats[key] : 0;
  const manifest = {
    format: FORMAT,
    id,
    root: `/workspace/novels/${id}`,
    fingerprint,
    title: `${String((typeof input.title === 'string' && input.title.trim()) || original.title || '未命名小说').slice(0, 190)}（恢复副本）`,
    stats: Object.fromEntries(
      ['chapters', 'chats', 'snapshots', 'operationLogs', 'agentHistory'].map((key) => [key, stat(key)]),
    ),
    archive: Array.isArray(original.archive)
      ? original.archive.filter((path) => typeof path === 'string' && seen.has(path))
      : [],
    restoredFrom: {
      id: input.sourceId,
      backedUpAt: String(input.createdAt || ''),
      receiptSha256: receipt.sha256,
    },
    removedCredentialFields: [],
    files: restoredFiles.map(({ content: _content, ...metadata }) => metadata),
  };
  // Keep the original receipt in the downloaded package. Only the active marker
  // changes on restore; prose, binaries and embedded old paths stay byte-exact.
  if (encoder.encode(JSON.stringify(manifest, null, 2)).length > FILE_LIMIT)
    throw new Error('恢复收据过大，未上传。');
  return { manifest, files: restoredFiles, backup: true, totalBytes: total };
}
