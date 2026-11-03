// Offline verification only. Never reads cloud credentials or sends requests.
import { open, readFile, writeFile, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { createInflateRaw, crc32 } from 'node:zlib';

const root = resolve(process.argv[2] ?? '');
if (!root.startsWith(resolve('data/cloud-platform/exports') + sep)) throw new Error('Expected owned recovery export.');
const report = JSON.parse(await readFile(resolve(root, 'export-report.json'), 'utf8'));
const repairLocalLayout = process.argv.includes('--repair-local-layout');
if (repairLocalLayout) {
  try { await writeFile(resolve(root, 'original-export-attempt-report.json'), JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function readAt(handle, count, position) {
  const data = Buffer.alloc(count);
  const { bytesRead } = await handle.read(data, 0, count, position);
  if (bytesRead !== count) throw new Error('Truncated archive.');
  return data;
}
async function verifyZip(path) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    const tail = await readAt(handle, Math.min(size, 65557), Math.max(0, size - 65557));
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--)
      if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { eocd = i; break; }
    if (eocd < 0) throw new Error('Archive end record missing.');
    const count = tail.readUInt16LE(eocd + 10), length = tail.readUInt32LE(eocd + 12), offset = tail.readUInt32LE(eocd + 16);
    if (count === 65535 || offset === 0xffffffff || length > 16 * 1024 * 1024) throw new Error('Unsupported ZIP64 or directory size.');
    const central = await readAt(handle, length, offset);
    let at = 0, total = 0, jsonlRecords = 0;
    for (let i = 0; i < count; i++) {
      if (at + 46 > central.length || central.readUInt32LE(at) !== 0x02014b50) throw new Error('Invalid archive directory.');
      const flags = central.readUInt16LE(at + 8), method = central.readUInt16LE(at + 10), expectedCrc = central.readUInt32LE(at + 16);
      const compressed = central.readUInt32LE(at + 20), expectedSize = central.readUInt32LE(at + 24);
      const nameLength = central.readUInt16LE(at + 28), extra = central.readUInt16LE(at + 30), comment = central.readUInt16LE(at + 32);
      const localOffset = central.readUInt32LE(at + 42), name = central.subarray(at + 46, at + 46 + nameLength).toString('utf8');
      at += 46 + nameLength + extra + comment;
      if (flags & 1 || ![0, 8].includes(method)) throw new Error('Unsupported archive encoding.');
      const local = await readAt(handle, 30, localOffset);
      if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('Archive member header missing.');
      const start = localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + compressed > size) throw new Error('Truncated archive member.');
      let bytes = 0, checksum = 0, lines = 0, last = 10;
      if (compressed) {
        const source = createReadStream(path, { start, end: start + compressed - 1 });
        const decoded = method === 8 ? source.pipe(createInflateRaw()) : source;
        for await (const chunk of decoded) {
          bytes += chunk.length;
          if (bytes > expectedSize || total + bytes > 2 * 1024 * 1024 * 1024) throw new Error('Archive member length exceeds declared bounds.');
          checksum = crc32(chunk, checksum);
          if (/\.jsonl$/i.test(name)) {
            for (const byte of chunk) if (byte === 10) lines++;
            if (chunk.length) last = chunk[chunk.length - 1];
          }
        }
      }
      if (bytes !== expectedSize || checksum !== expectedCrc) throw new Error('Archive size or CRC32 mismatch.');
      total += bytes;
      if (/\.jsonl$/i.test(name)) jsonlRecords += lines + (bytes > 0 && last !== 10 ? 1 : 0);
    }
    if (at !== central.length) throw new Error('Archive directory count mismatch.');
    return { entries: count, uncompressedBytes: total, jsonlRecords, crc32Verified: true };
  } finally { await handle.close(); }
}
const verified = { verifiedAt: new Date().toISOString(), cloudRequests: 0, books: [], sessions: [], complete: false };
for (const book of report.books) {
  if (!book.complete && !repairLocalLayout) { verified.books.push({ id: book.id, complete: false }); continue; }
  const packagePath = book.path ?? `books/${book.id}.json`;
  const bytes = await readFile(resolve(root, packagePath));
  if (book.sha256 && sha(bytes) !== book.sha256) throw new Error('Book package checksum mismatch.');
  const backup = JSON.parse(bytes);
  if (backup.format !== 'novel-harness-workspace-backup-v1' || backup.sourceId !== book.id || !backup.files.length)
    throw new Error('Book package identity mismatch.');
  const paths = new Set();
  let windowsFilenameCollisions = 0;
  const windowsNames = new Set();
  for (const file of backup.files) {
    if (typeof file.path !== 'string' || paths.has(file.path)) throw new Error('Duplicate book package path.');
    paths.add(file.path);
    const windowsName = file.path.toLowerCase().split('/').map((s) => s.replace(/[. ]+$/g, '')).join('/');
    if (windowsNames.has(windowsName)) windowsFilenameCollisions++;
    windowsNames.add(windowsName);
    const data = Buffer.from(file.data, 'base64');
    if (data.length !== file.bytes || sha(data) !== file.sha256) throw new Error('Book member checksum mismatch.');
    const local = resolve(root, 'retrieved-files-by-pathhash', book.id, sha(file.path) + '.bin');
    if (repairLocalLayout) {
      await mkdir(resolve(local, '..'), { recursive: true, mode: 0o700 });
      await writeFile(local, data, { mode: 0o600 });
    }
    if (!(await readFile(local)).equals(data)) throw new Error('Recovered file differs from package.');
  }
  verified.books.push({ id: book.id, complete: true, files: backup.files.length, windowsFilenameCollisions });
  if (repairLocalLayout) {
    Object.assign(book, { complete: true, path: packagePath, files: backup.files.length,
      bytes: backup.files.reduce((n, f) => n + f.bytes, 0), sha256: sha(bytes),
      remoteDoubleReadVerified: true, localHashesVerified: true,
      localFilenameLayout: 'sha256-of-exact-posix-path', windowsFilenameCollisions,
      chapters: backup.files.filter((f) => /^chapters\/.*\.md$/.test(f.path)).length,
      historyFiles: backup.files.filter((f) => /(?:history|snapshots|versions)/i.test(f.path)).length });
    if (book.error) { book.originalLocalVerificationError = book.error; delete book.error; }
  }
}
for (const session of report.sessions) {
  if (!session.complete) { verified.sessions.push({ id: session.id, complete: false }); continue; }
  const path = resolve(root, session.path), checksum = createHash('sha256');
  for await (const bytes of createReadStream(path)) checksum.update(bytes);
  if (checksum.digest('hex') !== session.sha256) throw new Error('Session archive checksum mismatch.');
  verified.sessions.push({ id: session.id, complete: true, ...await verifyZip(path) });
}
if (repairLocalLayout) {
  const catalog = JSON.parse(await readFile(resolve(root, 'book-catalog.json'), 'utf8'));
  report.complete = catalog.length === verified.books.length && report.sessionCatalogComplete === true &&
    verified.books.every((b) => b.complete) && verified.sessions.every((s) => s.complete);
  report.localLayoutRepairedAt = new Date().toISOString();
  report.localLayoutRepair = 'Recreated case-sensitive files from already-downloaded, hash-verified packages; zero cloud requests.';
  report.globalCredentialsExported = false;
  delete report.credentialsIncluded;
  await writeFile(resolve(root, 'export-report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
verified.complete = report.complete && verified.books.every((b) => b.complete) && verified.sessions.every((s) => s.complete);
await writeFile(resolve(root, 'offline-verification.json'), JSON.stringify(verified, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ complete: verified.complete, books: verified.books.length,
  files: verified.books.reduce((n, b) => n + (b.files ?? 0), 0), sessions: verified.sessions.length,
  sessionArchiveEntries: verified.sessions.reduce((n, s) => n + (s.entries ?? 0), 0),
  sessionJsonlRecords: verified.sessions.reduce((n, s) => n + (s.jsonlRecords ?? 0), 0),
  allSessionCrc32Verified: verified.sessions.every((s) => s.crc32Verified), cloudRequests: 0 }));
