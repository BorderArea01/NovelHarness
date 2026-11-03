# Architecture

- `apps/web`: Vite browser client for login, library, editing, migration and the story bible.
- `apps/server`: Express API and static asset server.
- `packages/shared`: Zod request schemas and shared constants.
- `novel-writer-V4.4.3.html`: frozen legacy client and migration source.

SQLite is authoritative. Project state updates run in one transaction and increment `projects.revision`. Clients send their last revision; stale writes receive HTTP 409 and never overwrite newer data.

API settings are global. Prompts, chat, memory, writing rules, chapters, snapshots and Agent history remain project-scoped. API keys are encrypted with `data/server.key`; authenticated clients receive runtime settings because V5 keeps direct browser-to-provider calls.

Database releases add numbered entries to `schema_migrations`. Browser imports are normalized and tracked by SHA-256 fingerprint in `legacy_imports`.

## Row-wise persistence (schema 3, pending verification)

The new writer compares chapter content and bridges by chapter number instead of deleting and reinserting the whole collection. Unchanged chapters retain their `rowid` and `updated_at`. Snapshot, operation-log and Agent-history collections retain stable IDs; changed text and changed ordering use separate updates. A nullable `sort_order` column preserves explicit collection order, with legacy rows read in their original `rowid` order until their first save materializes the positions. The migration adds metadata columns only, without rewriting history JSON.

The dedicated single-chapter PUT endpoint follows the same identity rule: exact repeats verify the revision but do not bump it or update the chapter timestamp; real edits update the existing row. Existing full-resource semantics remain unchanged, including explicitly clearing a bridge. This path is also pending API regression verification.

The project metadata blob is written only when its serialized value changes. Memory-to-card synchronization runs only when the memory fields actually used for cards change. The outer SQLite transaction still owns all writes, including revision increments; a later failure rolls back earlier row changes. Full project reads and content fingerprinting remain in use, so this does not claim paginated loading or constant-memory saving.

Schema migration is transactional and closes its database connection on failure. A schema newer than the supported version is rejected rather than downgraded. The new path must pass write-count, history-order, failure rollback, migration, API and browser tests before deployment.
