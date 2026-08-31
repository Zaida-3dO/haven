import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** `001-initial.sql` → { id: 1, name: '001-initial.sql' }. */
const FILENAME = /^(\d+)-[\w-]+\.sql$/;

/**
 * Reads the migration files off disk, in numeric order.
 *
 * Ordering is by the parsed number, not by filename string, so `010-x.sql`
 * sorts after `009-x.sql` rather than between `001` and `002`.
 */
export function loadMigrations(dir = MIGRATIONS_DIR) {
  const seen = new Map();

  const migrations = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .map((name) => {
      const match = FILENAME.exec(name);
      if (!match) {
        throw new Error(
          `Migration "${name}" is not named <number>-<slug>.sql — refusing to guess its order.`
        );
      }

      const id = Number.parseInt(match[1], 10);
      if (seen.has(id)) {
        throw new Error(`Migrations ${seen.get(id)} and ${name} share id ${id}.`);
      }
      seen.set(id, name);

      const sql = readFileSync(join(dir, name), 'utf8');
      return { id, name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });

  return migrations.sort((a, b) => a.id - b.id);
}

/**
 * Applies every migration the database has not seen yet, forward only.
 *
 * Forward-only is a deliberate choice: down-migrations on a single-user
 * dashboard are write-only code that gets tested the first time something has
 * already gone wrong. Rolling back means restoring the SQLite file, which is
 * one file copy.
 *
 * Idempotent — a second call applies nothing, because `schema_migrations`
 * records what ran. Each migration runs inside its own transaction, so a
 * failure part-way leaves the database at the last complete migration rather
 * than in a half-applied state.
 *
 * @returns {string[]} the names actually applied by this call.
 */
export function migrate(db, { dir = MIGRATIONS_DIR, logger } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          INTEGER PRIMARY KEY,
      name        TEXT    NOT NULL,
      checksum    TEXT    NOT NULL,
      applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Map(
    db
      .prepare('SELECT id, name, checksum FROM schema_migrations')
      .all()
      .map((row) => [row.id, row])
  );

  const migrations = loadMigrations(dir);
  const ran = [];

  for (const migration of migrations) {
    const previous = applied.get(migration.id);

    if (previous) {
      // An already-applied migration whose file has since changed means the
      // database and the code disagree about what the schema *is*. Surface it
      // loudly — silently skipping is how a schema drifts undetected.
      if (previous.checksum !== migration.checksum) {
        throw new Error(
          `Migration ${migration.name} has changed since it was applied. ` +
            `Migrations are immutable once applied — add a new one instead.`
        );
      }
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, checksum) VALUES (?, ?, ?)').run(
        migration.id,
        migration.name,
        migration.checksum
      );
    });

    apply();
    ran.push(migration.name);
    logger?.info?.(`Applied migration ${migration.name}`);
  }

  return ran;
}
