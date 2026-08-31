import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase } from '../src/db/index.js';
import { loadMigrations, migrate } from '../src/db/migrate.js';

const tableNames = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);

test('migrations apply to a fresh database', () => {
  const db = new Database(':memory:');

  const applied = migrate(db);

  assert.ok(applied.length > 0, 'a fresh database should have migrations to apply');

  const tables = tableNames(db);
  for (const expected of ['apps', 'credentials', 'layout', 'schema_migrations', 'widgets']) {
    assert.ok(tables.includes(expected), `expected table "${expected}", got ${tables.join(', ')}`);
  }

  db.close();
});

test('migrations are idempotent — a second run applies nothing', () => {
  const db = new Database(':memory:');

  const first = migrate(db);
  const second = migrate(db);

  assert.ok(first.length > 0);
  assert.deepEqual(second, [], 'second run must apply no migrations');

  // And the ledger must not have grown a duplicate row per migration.
  const recorded = db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
  assert.equal(recorded, first.length);

  db.close();
});

test('idempotency survives a reopen of a real file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-migrate-'));
  const path = join(dir, 'nested', 'haven.db');

  try {
    // Also covers "creates parent directories as needed" — `nested/` does not
    // exist until openDatabase makes it.
    const first = openDatabase({ path });
    const firstCount = first.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;
    first.prepare("INSERT INTO layout (breakpoint, nodes) VALUES ('desktop', '[]')").run();
    first.close();

    const second = openDatabase({ path });
    const secondCount = second.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get().n;

    assert.equal(secondCount, firstCount, 'reopening must not re-apply migrations');
    // Re-running a CREATE TABLE would have wiped this row.
    assert.equal(second.prepare('SELECT COUNT(*) AS n FROM layout').get().n, 1);

    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an already-applied migration that changed on disk is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-migrate-checksum-'));

  try {
    writeFileSync(join(dir, '001-first.sql'), 'CREATE TABLE thing (id TEXT PRIMARY KEY);');

    const db = new Database(':memory:');
    migrate(db, { dir });

    // Somebody edits a migration that has already run.
    writeFileSync(
      join(dir, '001-first.sql'),
      'CREATE TABLE thing (id TEXT PRIMARY KEY, extra TEXT);'
    );

    assert.throws(() => migrate(db, { dir }), /has changed since it was applied/);

    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('migrations are ordered numerically, not lexically', () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-migrate-order-'));

  try {
    for (const name of ['002-second.sql', '010-tenth.sql', '001-first.sql']) {
      writeFileSync(join(dir, name), '-- noop\n');
    }

    assert.deepEqual(
      loadMigrations(dir).map((m) => m.id),
      [1, 2, 10]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a badly named migration is refused rather than silently ordered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'haven-migrate-name-'));

  try {
    writeFileSync(join(dir, 'add-a-column.sql'), '-- noop\n');
    assert.throws(() => loadMigrations(dir), /not named/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
