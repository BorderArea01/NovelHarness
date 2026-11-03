import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DB_SCHEMA_VERSION } from '@novel-writer/shared';

export type NovelDb = Database.Database;

export function openDatabase(path: string): NovelDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    const hasVersionTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get();
    if (hasVersionTable) {
      const version = (db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as any)?.version;
      if (Number(version) > DB_SCHEMA_VERSION) throw new Error('数据库版本高于当前服务支持版本，禁止降级写入');
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    migrate(db);
  }
  catch (error) { db.close(); throw error; }
  return db;
}

function migrate(db: NovelDb): void {
  db.transaction(() => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS server_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, title TEXT NOT NULL, genre TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'active',
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_opened_at TEXT,
      deleted_at TEXT
    );
    CREATE TABLE IF NOT EXISTS project_state(
      project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE, schema_version INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL DEFAULT '{}'
    );
    CREATE TABLE IF NOT EXISTS chapters(
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, chapter INTEGER NOT NULL,
      content TEXT NOT NULL DEFAULT '', bridge TEXT, updated_at TEXT NOT NULL, PRIMARY KEY(project_id, chapter)
    );
    CREATE TABLE IF NOT EXISTS chapter_snapshots(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS operation_logs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_edit_history(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS story_characters(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_characters_project ON story_characters(project_id);
    CREATE TABLE IF NOT EXISTS story_locations(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_locations_project ON story_locations(project_id);
    CREATE TABLE IF NOT EXISTS story_items(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_project ON story_items(project_id);
    CREATE TABLE IF NOT EXISTS story_organizations(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, name TEXT NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_organizations_project ON story_organizations(project_id);
    CREATE TABLE IF NOT EXISTS story_relations(
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_type TEXT NOT NULL, source_id TEXT NOT NULL, target_type TEXT NOT NULL, target_id TEXT NOT NULL,
      label TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', data TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS global_settings(id INTEGER PRIMARY KEY CHECK(id=1), encrypted_data TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(
      id_hash TEXT PRIMARY KEY, ip TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS login_attempts(ip TEXT PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0, first_failure_at INTEGER NOT NULL, locked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS login_audit(id INTEGER PRIMARY KEY AUTOINCREMENT, ip TEXT NOT NULL, success INTEGER NOT NULL, occurred_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS legacy_imports(fingerprint TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), imported_at TEXT NOT NULL);
  `);
  const relationColumns = db.prepare('PRAGMA table_info(story_relations)').all() as { name: string }[];
  if (!relationColumns.some((column) => column.name === 'data'))
    db.exec("ALTER TABLE story_relations ADD COLUMN data TEXT NOT NULL DEFAULT '{}'");
  const currentRow = db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as
    { version: number | null } | undefined;
  const current = Number(currentRow?.version ?? 0);
  if (current > DB_SCHEMA_VERSION) throw new Error('数据库版本高于当前服务支持版本，禁止降级写入');
  for (const table of ['chapter_snapshots', 'operation_logs', 'agent_edit_history']) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((column) => column.name === 'sort_order'))
      db.exec(`ALTER TABLE ${table} ADD COLUMN sort_order INTEGER`);
  }
  if (current < DB_SCHEMA_VERSION) {
    db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
      DB_SCHEMA_VERSION,
      new Date().toISOString(),
    );
  }
  })();
}
