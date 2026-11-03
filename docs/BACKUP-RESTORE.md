# Backup and Restore

The server creates SQLite online backups under `DATA_DIR/backups` and retains seven daily plus four weekly copies. `server.key` is copied alongside them because encrypted API settings cannot be recovered without it.

## Restore

1. Stop the service.
2. Copy the current `DATA_DIR` to a safe location.
3. Replace `novel-writer.sqlite` with the selected backup.
4. Ensure the matching `server.key` is present.
5. Start the service and verify projects before removing the safety copy.

Treat database backups and `server.key` as sensitive secrets.

## Before a schema upgrade

Create a separate online database backup and copy the matching host key before restarting into a schema-changing release. Keep this recovery copy independently of daily backup rotation. For a rollback, retain the current data directory first, including any newer work; use a service version compatible with the selected database schema. Do not run an older writer blindly against a newer schema or discard post-upgrade work.

Restore into a clean, stopped data directory: do not leave a previous database's `-wal` or `-shm` files beside the restored database. Keep the old directory intact as the safety copy until projects, chapter counts, history and shared settings are verified.
