import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { isWritingRuntimeRelease, WRITING_RUNTIME_FILES } from '../scripts/runtime-release-policy.mjs';
import { isContentRuntimeRelease, CONTENT_RUNTIME_FILES } from '../scripts/runtime-release-policy.mjs';
import { isPurgeRuntimeRelease, PURGE_RUNTIME_FILES } from '../scripts/runtime-release-policy.mjs';
import { bookStorageFingerprint } from '../scripts/book-storage-fingerprint.mjs';
import { isPromptRuntimeRelease, PROMPT_RUNTIME_FILES } from '../scripts/runtime-release-policy.mjs';

test('prompt cleanup release permits only existing prompt modules, not data migration, native, auth, host or network changes', () => {
  const receipt = {
    format: 'novel-local-runtime-release-v1',
    feature: 'prompt-policy',
    backendUnchanged: false,
    databaseChanged: false,
    backendChanges: [...PROMPT_RUNTIME_FILES].map((path) => ({
      path,
      previousSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    })),
  };
  assert.equal(isPromptRuntimeRelease(receipt), true);
  assert.equal(isWritingRuntimeRelease(receipt), false);
  for (const path of [
    'worker/native/index.js',
    'worker/entry.mjs',
    'worker/pin-store.mjs',
    'worker/novel-documents.mjs',
    'host/host-wire.mjs',
  ])
    assert.equal(
      isPromptRuntimeRelease({
        ...receipt,
        backendChanges: [
          ...receipt.backendChanges,
          { path, previousSha256: 'a'.repeat(64), sha256: 'b'.repeat(64) },
        ],
      }),
      false,
    );
  assert.equal(isPromptRuntimeRelease({ ...receipt, databaseChanged: true }), false);
  assert.equal(isPromptRuntimeRelease({ ...receipt, backendChanges: [] }), false);
  assert.equal(
    isPromptRuntimeRelease({
      ...receipt,
      backendChanges: [{ path: 'worker/novel-role.mjs', previousSha256: null, sha256: 'b'.repeat(64) }],
    }),
    false,
  );
});

test('runtime writing release cannot authorize native/auth/storage/network changes or claim a database migration', () => {
  const receipt = {
    format: 'novel-local-runtime-release-v1',
    feature: 'unified-writing',
    backendUnchanged: false,
    databaseChanged: false,
    backendChanges: [...WRITING_RUNTIME_FILES].map((path) => ({
      path,
      previousSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    })),
  };
  assert.equal(isWritingRuntimeRelease(receipt), true);
  for (const path of [
    'worker/native/index.js',
    'worker/pin.mjs',
    'host/host-wire.mjs',
    'worker/document-storage.mjs',
  ])
    assert.equal(
      isWritingRuntimeRelease({
        ...receipt,
        backendChanges: [
          ...receipt.backendChanges,
          { path, previousSha256: 'a'.repeat(64), sha256: 'b'.repeat(64) },
        ],
      }),
      false,
    );
  assert.equal(isWritingRuntimeRelease({ ...receipt, databaseChanged: true }), false);
  assert.equal(isWritingRuntimeRelease({ ...receipt, backendChanges: [] }), false);
});

test('manual content release grants only its reviewed manuscript storage adapter and authenticated route, not native/auth/network changes', () => {
  const receipt = {
    format: 'novel-local-runtime-release-v1',
    feature: 'manual-content',
    backendUnchanged: false,
    databaseChanged: false,
    backendChanges: [...CONTENT_RUNTIME_FILES].map((path) => ({
      path,
      previousSha256: 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    })),
  };
  assert.equal(isContentRuntimeRelease(receipt), true);
  assert.equal(isWritingRuntimeRelease(receipt), false);
  for (const path of [
    'worker/native/index.js',
    'worker/entry.mjs',
    'worker/pin-store.mjs',
    'host/gateway-entry.mjs',
  ])
    assert.equal(
      isContentRuntimeRelease({
        ...receipt,
        backendChanges: [
          ...receipt.backendChanges,
          { path, previousSha256: 'a'.repeat(64), sha256: 'b'.repeat(64) },
        ],
      }),
      false,
    );
  assert.equal(isContentRuntimeRelease({ ...receipt, databaseChanged: true }), false);
  assert.equal(isContentRuntimeRelease({ ...receipt, backendChanges: [] }), false);
});

test('purge adapter release allows its one added module, not native package/auth/network replacements', () => {
  const receipt = {
    format: 'novel-local-runtime-release-v1',
    feature: 'dsh-purge-novel',
    backendUnchanged: false,
    databaseChanged: false,
    backendChanges: [...PURGE_RUNTIME_FILES].map((path) => ({
      path,
      previousSha256: path === 'worker/purge-plugin.mjs' ? null : 'a'.repeat(64),
      sha256: 'b'.repeat(64),
    })),
  };
  assert.equal(isPurgeRuntimeRelease(receipt), true);
  for (const path of ['worker/native/index.js', 'worker/pin-store.mjs', 'host/host-wire.mjs'])
    assert.equal(
      isPurgeRuntimeRelease({
        ...receipt,
        backendChanges: [
          ...receipt.backendChanges,
          { path, previousSha256: 'a'.repeat(64), sha256: 'b'.repeat(64) },
        ],
      }),
      false,
    );
  assert.equal(isPurgeRuntimeRelease({ ...receipt, databaseChanged: true }), false);
  assert.equal(
    isPurgeRuntimeRelease({
      ...receipt,
      backendChanges: [{ path: 'worker/entry.mjs', previousSha256: null, sha256: 'b'.repeat(64) }],
    }),
    false,
  );
});

test('read-only book fingerprint covers bytes, directory paths and manifest references, not transient metadata', () => {
  const temp = mkdtempSync(resolve(tmpdir(), 'novel-fingerprint-'));
  const folder = resolve(temp, 'do', 'fixture-main');
  mkdirSync(folder, { recursive: true });
  const db = new Database(resolve(folder, 'a'.repeat(64) + '.sqlite'));
  try {
    db.exec(`CREATE TABLE vfs_dirents(parent_inode INTEGER,name TEXT,child_inode INTEGER);
      CREATE TABLE vfs_nodes(inode INTEGER,type TEXT,size INTEGER,link_target TEXT,manifest_hash TEXT,stub_size INTEGER);
      CREATE TABLE vfs_chunks(inode INTEGER,idx INTEGER,hash TEXT);
      CREATE TABLE vfs_blob_bytes(hash TEXT,bytes BLOB);
      INSERT INTO vfs_dirents VALUES(1,'workspace',2),(2,'novels',3),(3,'book',4),(4,'chapter.md',5);
      INSERT INTO vfs_nodes VALUES(4,'dir',0,NULL,NULL,NULL),(5,'file',3,NULL,'manifest-a',NULL);
      INSERT INTO vfs_chunks VALUES(5,0,'blob');`);
    db.prepare('INSERT INTO vfs_blob_bytes VALUES(?,?)').run('blob', Buffer.from('one'));
    const before = bookStorageFingerprint(temp);
    assert.equal(before.nodes, 2);
    assert.equal(before.bytes, 3);
    assert.deepEqual(bookStorageFingerprint(temp), before);
    db.prepare('UPDATE vfs_blob_bytes SET bytes=?').run(Buffer.from('two'));
    assert.notEqual(bookStorageFingerprint(temp).sha256, before.sha256);
    db.prepare('UPDATE vfs_blob_bytes SET bytes=?').run(Buffer.from('one'));
    assert.deepEqual(bookStorageFingerprint(temp), before);
    db.exec("UPDATE vfs_dirents SET name='renamed.md' WHERE child_inode=5");
    assert.notEqual(bookStorageFingerprint(temp).sha256, before.sha256);
    db.exec(
      "UPDATE vfs_dirents SET name='chapter.md' WHERE child_inode=5; UPDATE vfs_nodes SET manifest_hash='manifest-b' WHERE inode=5",
    );
    assert.notEqual(bookStorageFingerprint(temp).sha256, before.sha256);
  } finally {
    db.close();
    rmSync(temp, { recursive: true, force: true });
  }
});
