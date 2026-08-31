import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrate.js';

/**
 * Opens the SQLite database, creating its parent directory if the volume is
 * empty, and brings the schema up to date.
 *
 * `:memory:` is passed straight through untouched — tests use it, and it has
 * no parent directory to create.
 */
export function openDatabase({ path = config.dbPath, logger, readonly = false } = {}) {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');

  if (!isMemory) {
    // First boot against a fresh Docker volume has an empty /data, so the
    // directory may genuinely not exist yet.
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new Database(path, { readonly });

  // WAL lets reads continue during a write, which matters because the
  // dashboard polls while layout edits are being saved. It is persistent —
  // set once and stored in the file — but setting it every boot is harmless
  // and keeps behaviour independent of how the file was created.
  if (!isMemory && !readonly) {
    db.pragma('journal_mode = WAL');
  }

  // NORMAL rather than FULL: with WAL this is durable across process crashes
  // (only an OS-level crash can lose the last commits) and avoids an fsync on
  // every single write. Right trade for a dashboard's layout state.
  db.pragma('synchronous = NORMAL');

  // Off by default in SQLite, for backwards compatibility. Haven wants them.
  db.pragma('foreign_keys = ON');

  // Wait rather than immediately throwing SQLITE_BUSY if another connection
  // holds the write lock.
  db.pragma('busy_timeout = 5000');

  if (!readonly) {
    migrate(db, { logger });
  }

  return db;
}

export { migrate } from './migrate.js';
