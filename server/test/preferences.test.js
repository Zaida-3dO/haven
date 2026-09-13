/**
 * `/api/preferences` — singleton dashboard preferences.
 *
 * ⚠️ Not `server/src/settings.js`, which is a different concept sharing the
 * English word: that one reads `config/settings.json` (weather units, human
 * edited, read-only to the app) and is covered by `settings.test.js`. This is
 * database-backed state the USER changes from the UI.
 *
 * The sidebar's width lives here rather than in `/api/layout` because
 * `validateNode` rebuilds every node from an `id/x/y/w/h` whitelist, so an
 * unrecognised key there is dropped SILENTLY. See migration 007.
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';
import {
  SIDEBAR_WIDTH,
  createPreferenceStore,
  validatePreferences,
} from '../src/db/preferences-store.js';

/** A server on a private in-memory DB, torn down with the test. */
async function freshApp(t) {
  const db = new Database(':memory:');
  migrate(db);

  const app = await buildServer({ logger: false, db });
  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, db };
}

/**
 * A raw string payload would be sent without a JSON content-type and bounce at
 * 415 before the handler runs, so the body is serialised here and the header
 * set explicitly — keeping these tests about Haven's validator rather than
 * Fastify's content-type negotiation. Same reason as `layout.test.js`.
 */
const patch = (app, body) =>
  app.inject({
    method: 'PATCH',
    url: '/api/preferences',
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const get = (app) => app.inject({ method: 'GET', url: '/api/preferences' });

/* ── the validator ───────────────────────────────────────────────────────── */

test('an unknown preference is REFUSED, not silently dropped', () => {
  // The whole reason this is not stored in `layout`. A preference that
  // vanishes with no error is worse than one that is rejected, because the
  // user sets it, sees nothing happen, and has nowhere to look.
  assert.throws(
    () => validatePreferences({ sidebarColour: 'red' }),
    /Unknown preference\(s\): sidebarColour/
  );
});

test('a non-numeric width is refused rather than coerced', () => {
  // `Number('320px')` is NaN and `Number(null)` is 0, so coercing here would
  // store a width that silently reads back as the minimum.
  assert.throws(() => validatePreferences({ sidebarWidth: '320px' }), /must be a finite number/);
  assert.throws(() => validatePreferences({ sidebarWidth: null }), /must be a finite number/);
  assert.throws(() => validatePreferences({ sidebarWidth: NaN }), /must be a finite number/);
});

test('an empty payload is refused', () => {
  assert.throws(() => validatePreferences({}), /empty/);
});

test('a width outside the range is CLAMPED, not refused', () => {
  // A drag naturally overshoots; refusing a gesture that went 3px too far
  // would make the handle feel broken. A bad TYPE is a caller bug and is
  // refused above; a bad VALUE is a gesture and is clamped.
  assert.equal(validatePreferences({ sidebarWidth: 10 }).sidebarWidth, SIDEBAR_WIDTH.min);
  assert.equal(validatePreferences({ sidebarWidth: 99_999 }).sidebarWidth, SIDEBAR_WIDTH.max);
  assert.equal(validatePreferences({ sidebarWidth: 420.4 }).sidebarWidth, 420);
});

/* ── the store ───────────────────────────────────────────────────────────── */

test('a fresh install reads the default width rather than nothing', (t) => {
  // The client must not have to special-case "never saved". Same contract as
  // `layout.getAll()` returning empty arrays.
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  assert.equal(createPreferenceStore(db).getAll().sidebarWidth, SIDEBAR_WIDTH.default);
});

test('a corrupted stored value degrades to the default rather than throwing', (t) => {
  // One bad row must not take down the dashboard — the same rule
  // `instances-store` applies to a corrupted config blob.
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  db.prepare("INSERT INTO preferences (key, value) VALUES ('sidebarWidth', 'banana')").run();

  assert.equal(createPreferenceStore(db).getAll().sidebarWidth, SIDEBAR_WIDTH.default);
});

/* ── the routes ──────────────────────────────────────────────────────────── */

test('GET /api/preferences returns the defaults on a fresh install', async (t) => {
  const { app } = await freshApp(t);

  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().preferences.sidebarWidth, SIDEBAR_WIDTH.default);
});

test('PATCH then GET round-trips the width', async (t) => {
  const { app } = await freshApp(t);

  const written = await patch(app, { sidebarWidth: 460 });
  assert.equal(written.statusCode, 200);
  assert.deepEqual(written.json().saved, ['sidebarWidth']);

  const read = await get(app);
  assert.equal(read.json().preferences.sidebarWidth, 460);
});

test('an unknown preference is a 400 with a readable message', async (t) => {
  const { app } = await freshApp(t);

  const res = await patch(app, { nope: 1 });

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_PREFERENCE');
  assert.match(res.json().message, /Unknown preference/);
});

test('the preferences response is never cached', async (t) => {
  // A stale width renders the column at the wrong size on the next load.
  const { app } = await freshApp(t);

  assert.match((await get(app)).headers['cache-control'], /no-store/);
});

test('preferences do not disturb the rest of the API', async (t) => {
  // A new route registered wrongly can shadow others — the static handler is
  // registered last for exactly that reason.
  const { app } = await freshApp(t);

  await patch(app, { sidebarWidth: 500 });

  assert.equal((await app.inject({ method: 'GET', url: '/api/health' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/layout' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/api/instances' })).statusCode, 200);
});
