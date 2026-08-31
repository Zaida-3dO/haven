/**
 * Data access for the app registry.
 *
 * Deliberately thin, and deliberately the ONLY place that knows how an app is
 * stored. The routes speak the API shape (camelCase, nested `urls` and
 * `version` objects); SQLite stores flat columns with JSON blobs. Keeping the
 * translation here means reconciling with the data layer on
 * `feat/m1-data-layer` is a change to one file, not to every route.
 *
 * See docs/DESIGN.md §6.2.
 */

import { readFileSync } from 'node:fs';

/** Categories carried over from the old dashboard. */
export const CATEGORIES = ['personal', 'media', 'home', 'ai', 'tools'];

const COLUMNS = `id, name, description, category, icon, urls, version_info, visit_count, sort_order`;

/**
 * Row → API shape.
 *
 * `urls` and `version_info` are stored as JSON text. A row whose JSON has been
 * corrupted degrades to an empty list rather than throwing: one bad row must
 * not take down the whole registry listing.
 */
function toApp(row) {
  if (!row) return null;

  let urls = [];
  try {
    const parsed = JSON.parse(row.urls ?? '[]');
    if (Array.isArray(parsed)) urls = parsed;
  } catch {
    urls = [];
  }

  let version;
  try {
    version = row.version_info ? JSON.parse(row.version_info) : null;
  } catch {
    version = null;
  }

  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    category: row.category,
    icon: row.icon ?? null,
    urls,
    version,
    visitCount: row.visit_count ?? 0,
    sortOrder: row.sort_order ?? 0,
  };
}

/** API shape → row parameters. */
function toRow(app) {
  return {
    id: app.id,
    name: app.name,
    description: app.description ?? '',
    category: app.category ?? 'tools',
    icon: app.icon ?? null,
    urls: JSON.stringify(app.urls ?? []),
    version_info: app.version ? JSON.stringify(app.version) : null,
    sort_order: app.sortOrder ?? 0,
  };
}

export function listApps(db, { category } = {}) {
  // Visit count first: the dashboard sorts by how often something is actually
  // opened (DESIGN §6.2), with sort_order and name only breaking ties.
  const where = category ? 'WHERE category = @category' : '';
  const rows = db
    .prepare(
      `SELECT ${COLUMNS} FROM apps ${where} ORDER BY visit_count DESC, sort_order ASC, name ASC`
    )
    .all(category ? { category } : {});
  return rows.map(toApp);
}

export function getApp(db, id) {
  return toApp(db.prepare(`SELECT ${COLUMNS} FROM apps WHERE id = ?`).get(id));
}

export function createApp(db, app) {
  db.prepare(
    `INSERT INTO apps (id, name, description, category, icon, urls, version_info, sort_order)
     VALUES (@id, @name, @description, @category, @icon, @urls, @version_info, @sort_order)`
  ).run(toRow(app));
  return getApp(db, app.id);
}

/**
 * Full replace of the mutable fields. `visit_count` is deliberately NOT
 * updatable here — it is internal, counted by the server, and not something a
 * client may set (DESIGN §6.2: "counts kept per-app internally, not
 * user-editable").
 */
export function updateApp(db, id, app) {
  const result = db
    .prepare(
      `UPDATE apps SET
         name = @name, description = @description, category = @category,
         icon = @icon, urls = @urls, version_info = @version_info,
         sort_order = @sort_order, updated_at = datetime('now')
       WHERE id = @id`
    )
    .run({ ...toRow(app), id });

  return result.changes ? getApp(db, id) : null;
}

export function deleteApp(db, id) {
  return db.prepare('DELETE FROM apps WHERE id = ?').run(id).changes > 0;
}

/** Records a visit. Returns the new count, or null if the app is unknown. */
export function recordVisit(db, id) {
  const result = db
    .prepare(
      `UPDATE apps SET visit_count = visit_count + 1, updated_at = datetime('now') WHERE id = ?`
    )
    .run(id);
  if (!result.changes) return null;
  return db.prepare('SELECT visit_count FROM apps WHERE id = ?').get(id).visit_count;
}

export function countApps(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM apps').get().n;
}

/**
 * Seeds the registry from `config/apps.json` if — and only if — the table is
 * empty.
 *
 * The file is the SEED; the database is the source of truth afterwards. That
 * asymmetry is the whole point: edits made in the UI must not be silently
 * reverted on the next restart by a stale file on disk. A deployment that
 * wants to re-seed empties the table.
 *
 * Missing or unreadable file is not an error — a fresh install has no
 * `config/apps.json` at all (it is gitignored), and an empty registry is a
 * perfectly valid state.
 *
 * @returns {{ seeded: number, reason: string }}
 */
export function seedApps(db, { path, logger } = {}) {
  if (countApps(db) > 0) {
    return { seeded: 0, reason: 'registry not empty' };
  }

  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'no seed file' : `unreadable seed file: ${err.message}`;
    logger?.info?.(`App registry not seeded — ${reason}.`);
    return { seeded: 0, reason };
  }

  const apps = Array.isArray(parsed?.apps) ? parsed.apps : [];
  const insert = db.transaction((rows) => {
    rows.forEach((app, index) => {
      createApp(db, { ...app, sortOrder: app.sortOrder ?? index });
    });
  });

  try {
    insert(apps);
  } catch (err) {
    logger?.error?.(`App registry seed failed: ${err.message}`);
    return { seeded: 0, reason: `seed failed: ${err.message}` };
  }

  logger?.info?.(`Seeded ${apps.length} app(s) from ${path}.`);
  return { seeded: apps.length, reason: 'seeded' };
}
