import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal forward-only migration runner.
 *
 * NOTE FOR REVIEW: the full data layer is being built in parallel on
 * `feat/m1-data-layer` and is not on `main` yet. This file is a deliberately
 * small stand-in so the app registry has a schema to run against — it follows
 * the same conventions (`<number>-<slug>.sql`, a `schema_migrations` ledger,
 * forward-only, one transaction per migration) so that when the data layer
 * lands, this file is deleted and `002-apps.sql` is kept as-is. See the PR
 * description.
 */

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** `001-initial.sql` -> { id: 1, name: '001-initial.sql' }. */
const FILENAME = /^(\d+)-[\w-]+\.sql$/;

/** Reads the migration files off disk, ordered by their parsed number. */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const match = FILENAME.exec(name);
      if (!match) {
        throw new Error(
          `Migration "${name}" is not named <number>-<slug>.sql — refusing to guess its order.`
        );
      }
      return {
        id: Number.parseInt(match[1], 10),
        name,
        sql: readFileSync(join(dir, name), 'utf8'),
      };
    })
    .sort((a, b) => a.id - b.id);
}

/**
 * Applies every migration the database has not seen yet.
 *
 * Idempotent: a second call applies nothing, because `schema_migrations`
 * records what ran. Each migration runs in its own transaction, so a failure
 * part-way leaves the database at the last complete migration.
 *
 * @returns {string[]} the names actually applied by this call.
 */
export function migrate(db, { dir = MIGRATIONS_DIR, logger } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT id FROM schema_migrations')
      .all()
      .map((row) => row.id)
  );

  const ran = [];

  for (const migration of loadMigrations(dir)) {
    if (applied.has(migration.id)) continue;

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(
        migration.id,
        migration.name
      );
    });

    apply();
    ran.push(migration.name);
    logger?.info?.(`Applied migration ${migration.name}`);
  }

  return ran;
}
