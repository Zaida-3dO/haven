import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import {
  DEFAULT_INSTANCES,
  SECRET_SET,
  createInstanceStore,
  secretName,
  seedInstances,
} from '../src/db/instances-store.js';
import { buildServer } from '../src/server.js';

/**
 * An in-memory credential store double.
 *
 * The real one refuses to write without HAVEN_SECRET_KEY, deliberately and
 * with no plaintext fallback (`credentials.js`). Injecting a double is what
 * lets this suite exercise the secret *routing* — which value goes to the
 * credential store and which to the config blob — without the suite needing a
 * key. `credentials.test.js` already covers the encryption itself.
 *
 * It records every write so a test can assert the plaintext went HERE and not
 * into `widgets.config`.
 */
function fakeCredentials() {
  const values = new Map();
  return {
    values,
    set(name, value) {
      values.set(name, value);
      return { name };
    },
    get(name) {
      return values.has(name) ? values.get(name) : null;
    },
    delete(name) {
      return values.delete(name);
    },
    has(name) {
      return values.has(name);
    },
  };
}

/** A server on a private in-memory DB, torn down with the test. */
async function freshApp(t, { seed = true } = {}) {
  const db = new Database(':memory:');
  migrate(db);

  const credentials = fakeCredentials();
  const app = await buildServer({
    logger: false,
    db,
    credentials,
    // A path that cannot exist, so the app-registry seed is a no-op and this
    // suite never depends on whatever config/apps.json happens to hold.
    seedPath: '/nonexistent/apps.invalid.json',
    instancesSeedPath: seed ? '/nonexistent/instances.invalid.json' : null,
  });

  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, db, credentials };
}

const post = (app, body) =>
  app.inject({
    method: 'POST',
    url: '/api/instances',
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const put = (app, id, body) =>
  app.inject({
    method: 'PUT',
    url: `/api/instances/${id}`,
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const list = (app) => app.inject({ method: 'GET', url: '/api/instances' });
const getOne = (app, id) => app.inject({ method: 'GET', url: `/api/instances/${id}` });
const del = (app, id) => app.inject({ method: 'DELETE', url: `/api/instances/${id}` });

const putLayout = (app, body) =>
  app.inject({
    method: 'PUT',
    url: '/api/layout',
    payload: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

// ── the roster round-trips ────────────────────────────────────────────────

test('a fresh install is seeded with a usable roster rather than a blank page', async (t) => {
  const { app } = await freshApp(t);

  const res = await list(app);

  assert.equal(res.statusCode, 200);
  const { instances } = res.json();
  assert.equal(instances.length, DEFAULT_INSTANCES.length);
  assert.deepEqual(
    instances.map((i) => i.id),
    DEFAULT_INSTANCES.map((i) => i.id)
  );
});

test('the seeded roster keeps its declared order, not alphabetical order', async (t) => {
  const { app } = await freshApp(t);

  const ids = (await list(app)).json().instances.map((i) => i.id);

  // The order is meaningful: the hero is a banner across the top and the apps
  // widget leads the grid below it. Ordering by `created_at` looks like it
  // would preserve this and does not — a seed writes every row inside one
  // `datetime('now')` second, so the sort collapses to the id tiebreaker and
  // comes back alphabetically ('apps-main' before 'hero-main'). Hence the
  // explicit `sort_order` column in migration 004.
  assert.equal(ids[0], 'hero-main');
  assert.equal(ids[1], 'apps-main');
  assert.notDeepEqual(ids, [...ids].sort(), 'the roster came back alphabetised');
});

test('a widget added later goes to the end rather than reshuffling the roster', async (t) => {
  const { app } = await freshApp(t);

  const before = (await list(app)).json().instances.map((i) => i.id);
  await post(app, { id: 'clock-new', type: 'clock', config: {} });
  const after = (await list(app)).json().instances.map((i) => i.id);

  assert.deepEqual(after, [...before, 'clock-new']);
});

test('an instance round-trips through create and read', async (t) => {
  const { app } = await freshApp(t);

  const created = await post(app, {
    id: 'clock-berlin',
    type: 'clock',
    config: { label: 'Berlin', source: 'timezone', timezone: 'Europe/Berlin' },
    configVersion: 1,
  });

  assert.equal(created.statusCode, 201);
  assert.equal(created.json().type, 'clock');

  const read = await getOne(app, 'clock-berlin');
  assert.equal(read.statusCode, 200);
  assert.deepEqual(read.json().config, {
    label: 'Berlin',
    source: 'timezone',
    timezone: 'Europe/Berlin',
  });
});

test('config survives a restart — the whole point of the table', async (t) => {
  const db = new Database(':memory:');
  migrate(db);
  const credentials = fakeCredentials();

  const first = await buildServer({ logger: false, db, credentials, seedPath: '/none.invalid' });
  await post(first, { id: 'clock-a', type: 'clock', config: { label: 'Before' } });
  await put(first, 'clock-a', { type: 'clock', config: { label: 'After' } });
  await first.close();

  // A second server on the same database is exactly what a restart is.
  const second = await buildServer({ logger: false, db, credentials, seedPath: '/none.invalid' });
  t.after(async () => {
    await second.close();
    db.close();
  });

  const read = await getOne(second, 'clock-a');
  assert.equal(read.json().config.label, 'After');
});

test('configVersion is stored and returned, not invented per read', async (t) => {
  const { app } = await freshApp(t);

  await post(app, { id: 'v3', type: 'clock', config: {}, configVersion: 3 });

  assert.equal((await getOne(app, 'v3')).json().configVersion, 3);
});

test('a PUT cannot rename the row it addresses', async (t) => {
  const { app } = await freshApp(t);

  await post(app, { id: 'stay', type: 'clock', config: {} });
  const res = await put(app, 'stay', { id: 'moved', type: 'clock', config: { x: 1 } });

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().id, 'stay');
  assert.equal((await getOne(app, 'moved')).statusCode, 404);
});

// ── secrets ───────────────────────────────────────────────────────────────

test('a stored secret cannot be read back through the API', async (t) => {
  const { app, db, credentials } = await freshApp(t);

  const PASSWORD = 'correct-horse-battery-staple';

  await post(app, {
    id: 'torrents-secure',
    type: 'torrents',
    config: { url: 'http://qbittorrent.invalid:8080', password: PASSWORD },
    secretKeys: ['password'],
  });

  // 1. Not through the single-instance read.
  const one = (await getOne(app, 'torrents-secure')).body;
  assert.ok(!one.includes(PASSWORD), 'GET /api/instances/:id leaked the secret');

  // 2. Not through the list.
  const all = (await list(app)).body;
  assert.ok(!all.includes(PASSWORD), 'GET /api/instances leaked the secret');

  // 3. Not in the row itself — it must not be sitting in the config blob in
  //    the clear waiting for some future endpoint to serve it.
  const row = db.prepare('SELECT config FROM widgets WHERE id = ?').get('torrents-secure');
  assert.ok(!row.config.includes(PASSWORD), 'the secret was stored in the config blob');

  // 4. It did go to the credential store, which encrypts at rest.
  assert.equal(credentials.get(secretName('torrents-secure', 'password')), PASSWORD);

  // What the API serves instead is the sentinel: presence, not value.
  assert.equal((await getOne(app, 'torrents-secure')).json().config.password, SECRET_SET);
});

test('a secret survives an unrelated config change', async (t) => {
  const { app, credentials } = await freshApp(t);

  await post(app, {
    id: 'torrents-secure',
    type: 'torrents',
    config: { url: 'http://qbittorrent.invalid:8080', password: 'keep-me' },
    secretKeys: ['password'],
  });

  // Exactly what the settings panel sends when the user edits another field:
  // the sentinel echoed back, because it omits an untouched secret from the
  // patch and `{...current, ...patch}` therefore keeps what the server served.
  await put(app, 'torrents-secure', {
    type: 'torrents',
    config: { url: 'http://qbittorrent.invalid:9090', password: SECRET_SET },
    secretKeys: ['password'],
  });

  assert.equal(credentials.get(secretName('torrents-secure', 'password')), 'keep-me');
  assert.equal((await getOne(app, 'torrents-secure')).json().config.url.endsWith('9090'), true);
});

test('an omitted secret is not read as a deletion', async (t) => {
  const { app, credentials } = await freshApp(t);

  await post(app, {
    id: 'torrents-secure',
    type: 'torrents',
    config: { password: 'keep-me' },
    secretKeys: ['password'],
  });

  // The key absent entirely, rather than echoed as the sentinel.
  await put(app, 'torrents-secure', {
    type: 'torrents',
    config: {},
    secretKeys: ['password'],
  });

  assert.equal(credentials.get(secretName('torrents-secure', 'password')), 'keep-me');
  assert.equal((await getOne(app, 'torrents-secure')).json().config.password, SECRET_SET);
});

test('an explicit empty string clears the stored secret', async (t) => {
  const { app, credentials } = await freshApp(t);

  await post(app, {
    id: 'torrents-secure',
    type: 'torrents',
    config: { password: 'remove-me' },
    secretKeys: ['password'],
  });

  await put(app, 'torrents-secure', {
    type: 'torrents',
    config: { password: '' },
    secretKeys: ['password'],
  });

  assert.equal(credentials.get(secretName('torrents-secure', 'password')), null);
  assert.equal((await getOne(app, 'torrents-secure')).json().config.password, undefined);
});

test('a new secret value replaces the old one', async (t) => {
  const { app, credentials } = await freshApp(t);

  await post(app, {
    id: 'torrents-secure',
    type: 'torrents',
    config: { password: 'old' },
    secretKeys: ['password'],
  });

  await put(app, 'torrents-secure', {
    type: 'torrents',
    config: { password: 'new' },
    secretKeys: ['password'],
  });

  assert.equal(credentials.get(secretName('torrents-secure', 'password')), 'new');
});

// ── deletion cascades ─────────────────────────────────────────────────────

test('deleting an instance drops its layout node', async (t) => {
  const { app } = await freshApp(t);

  await post(app, { id: 'doomed', type: 'clock', config: {} });
  await putLayout(app, {
    desktop: [
      { id: 'doomed', x: 0, y: 0, w: 4, h: 2 },
      { id: 'survivor', x: 4, y: 0, w: 4, h: 2 },
    ],
    mobile: [{ id: 'doomed', x: 0, y: 0, w: 4, h: 2 }],
  });

  assert.equal((await del(app, 'doomed')).statusCode, 204);

  const layout = (await app.inject({ method: 'GET', url: '/api/layout' })).json().layout;
  assert.deepEqual(
    layout.desktop.map((n) => n.id),
    ['survivor']
  );
  assert.deepEqual(layout.mobile, []);
});

test('deleting drops a layout node that points via widgetId too', async (t) => {
  const { app } = await freshApp(t);

  await post(app, { id: 'doomed', type: 'clock', config: {} });
  await putLayout(app, {
    desktop: [{ id: 'tile-1', widgetId: 'doomed', x: 0, y: 0, w: 4, h: 2 }],
  });

  await del(app, 'doomed');

  assert.deepEqual(
    (await app.inject({ method: 'GET', url: '/api/layout' })).json().layout.desktop,
    [
      // The node named `doomed` through `widgetId`, so it goes with it.
    ]
  );
});

test('deleting an instance drops its stored credentials', async (t) => {
  const { app, credentials } = await freshApp(t);

  await post(app, {
    id: 'doomed',
    type: 'torrents',
    config: { password: 'orphan-me' },
    secretKeys: ['password'],
  });
  assert.equal(credentials.has(secretName('doomed', 'password')), true);

  await del(app, 'doomed');

  assert.equal(
    credentials.has(secretName('doomed', 'password')),
    false,
    'an orphaned credential is a secret nobody knows they still store'
  );
});

test('deleting an unknown instance is a 404, not a silent success', async (t) => {
  const { app } = await freshApp(t);

  assert.equal((await del(app, 'never-existed')).statusCode, 404);
});

// ── validation ────────────────────────────────────────────────────────────

test('a duplicate id is refused', async (t) => {
  const { app } = await freshApp(t);

  await post(app, { id: 'twice', type: 'clock', config: {} });
  const second = await post(app, { id: 'twice', type: 'clock', config: {} });

  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, 'DUPLICATE_ID');
});

test('a malformed instance is rejected before it is stored', async (t) => {
  const { app } = await freshApp(t);

  for (const [label, body] of [
    ['no id', { type: 'clock' }],
    ['empty id', { id: '  ', type: 'clock' }],
    ['no type', { id: 'x' }],
    ['config is an array', { id: 'x', type: 'clock', config: [] }],
    ['configVersion is zero', { id: 'x', type: 'clock', configVersion: 0 }],
    ['configVersion is fractional', { id: 'x', type: 'clock', configVersion: 1.5 }],
    ['secretKeys is not an array', { id: 'x', type: 'clock', secretKeys: 'password' }],
  ]) {
    const res = await post(app, body);
    assert.equal(res.statusCode, 400, `${label} should be a 400`);
    assert.equal(res.json().error, 'INVALID_INSTANCE', label);
  }

  // Nothing above reached the database.
  assert.equal((await getOne(app, 'x')).statusCode, 404);
});

test('PUT on an unknown instance is a 404 rather than an implicit create', async (t) => {
  const { app } = await freshApp(t);

  const res = await put(app, 'ghost', { type: 'clock', config: {} });

  assert.equal(res.statusCode, 404);
  assert.equal((await getOne(app, 'ghost')).statusCode, 404);
});

test('the roster is never cached', async (t) => {
  const { app } = await freshApp(t);

  assert.equal((await list(app)).headers['cache-control'], 'no-store');
});

// ── store-level behaviour ─────────────────────────────────────────────────

test('a corrupted config blob degrades to {} rather than taking down the list', (t) => {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  const store = createInstanceStore(db, { credentials: fakeCredentials() });
  store.create({ id: 'fine', type: 'clock', config: { label: 'ok' }, configVersion: 1 });

  db.prepare('INSERT INTO widgets (id, type, config) VALUES (?, ?, ?)').run(
    'broken',
    'clock',
    '{not json'
  );

  const all = store.list();
  assert.equal(all.length, 2);
  assert.deepEqual(all.find((i) => i.id === 'broken').config, {});
  assert.deepEqual(all.find((i) => i.id === 'fine').config, { label: 'ok' });
});

test('seeding is skipped when the roster is not empty', (t) => {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  const store = createInstanceStore(db, { credentials: fakeCredentials() });
  store.create({ id: 'mine', type: 'clock', config: {}, configVersion: 1 });

  const result = seedInstances(db, { path: null });

  assert.equal(result.seeded, 0);
  assert.equal(result.reason, 'roster not empty');
  // The user's own roster is not joined by the defaults on the next restart.
  assert.deepEqual(
    store.list().map((i) => i.id),
    ['mine']
  );
});

test('a removed widget stays removed across a restart', (t) => {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());

  seedInstances(db, { path: null });
  const store = createInstanceStore(db, { credentials: fakeCredentials() });
  store.delete('clock-tokyo');

  // Restart: the seed must not resurrect it. The file is the SEED; the
  // database is the source of truth afterwards.
  seedInstances(db, { path: null });

  assert.equal(
    store.list().some((i) => i.id === 'clock-tokyo'),
    false
  );
});
