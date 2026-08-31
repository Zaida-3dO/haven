import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { config } from '../config.js';
import { migrate } from './migrate.js';

/**
 * Opens the SQLite database and brings the schema up to date.
 *
 * NOTE FOR REVIEW: a fuller version of this file is in flight on
 * `feat/m1-data-layer` (WAL, pragmas, checksummed migrations). This is the
 * minimum the app registry needs to run, written to the same signature so the
 * richer one drops in as a replacement. See the PR description.
 *
 * `:memory:` is passed through untouched — tests use it, and it has no parent
 * directory to create.
 */
export function openDatabase({ path = config.dbPath, logger } = {}) {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');

  if (!isMemory) {
    // First boot against a fresh Docker volume has an empty /data.
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const db = new Database(path);

  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!isMemory) db.pragma('journal_mode = WAL');

  migrate(db, { logger });

  return db;
}

export { migrate } from './migrate.js';
