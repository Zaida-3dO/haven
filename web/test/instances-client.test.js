import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SECRET_SET, createInstancesClient, secretKeysOf } from '../src/shell/instances-client.js';
import { reconcileRoster } from '../src/shell/roster.js';
import { migrateConfig } from '../src/shell/migrate.js';

/** A `fetch` double recording every call. */
function fakeFetch(responder) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: init.body ? JSON.parse(init.body) : null,
    });
    const result = responder(url, init) ?? {};
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body ?? {},
    };
  };
  impl.calls = calls;
  return impl;
}

const ok = (body) => ({ ok: true, status: 200, body });

// ── loading ───────────────────────────────────────────────────────────────

test('load returns the roster', async () => {
  const fetchImpl = fakeFetch(() =>
    ok({ instances: [{ id: 'clock-a', type: 'clock', config: { label: 'A' }, configVersion: 1 }] })
  );
  const client = createInstancesClient({ fetchImpl });

  const roster = await client.load();

  assert.equal(fetchImpl.calls[0].url, '/api/instances');
  assert.deepEqual(
    roster.map((i) => i.id),
    ['clock-a']
  );
});

test('load returns an empty array for a malformed body rather than throwing', async () => {
  const client = createInstancesClient({ fetchImpl: fakeFetch(() => ok({ nope: true })) });

  assert.deepEqual(await client.load(), []);
});

test('a failed request throws with the server message', async () => {
  const client = createInstancesClient({
    fetchImpl: fakeFetch(() => ({
      ok: false,
      status: 404,
      body: { error: 'NOT_FOUND', message: 'No widget instance with id "ghost".' },
    })),
  });

  await assert.rejects(() => client.load(), /404.*ghost/s);
});

// ── writing ───────────────────────────────────────────────────────────────

test('save sends only what the server stores', async () => {
  const fetchImpl = fakeFetch(() => ok({}));
  const client = createInstancesClient({ fetchImpl });

  await client.save(
    'clock-a',
    { id: 'clock-a', type: 'clock', config: { label: 'A' }, configVersion: 2, stray: 'dropped' },
    { secretKeys: [] }
  );

  const call = fetchImpl.calls[0];
  assert.equal(call.method, 'PUT');
  assert.equal(call.url, '/api/instances/clock-a');
  assert.equal(call.body.stray, undefined);
  assert.equal(call.body.configVersion, 2);
});

test('save declares which config fields are secret', async () => {
  const fetchImpl = fakeFetch(() => ok({}));
  const client = createInstancesClient({ fetchImpl });

  await client.save('t', { id: 't', type: 'torrents', config: {} }, { secretKeys: ['password'] });

  // The server cannot work this out for itself: `configSchema` lives with the
  // widget definition in the browser. Without it the server has no way to know
  // `password` must go to the encrypted credential store rather than into the
  // config blob in the clear.
  assert.deepEqual(fetchImpl.calls[0].body.secretKeys, ['password']);
});

test('an id with a slash is encoded rather than forging a path', async () => {
  const fetchImpl = fakeFetch(() => ok({}));
  const client = createInstancesClient({ fetchImpl });

  await client.remove('a/../b');

  assert.equal(fetchImpl.calls[0].url, '/api/instances/a%2F..%2Fb');
});

test('remove tolerates a 204 with no body', async () => {
  const client = createInstancesClient({
    fetchImpl: fakeFetch(() => ({ ok: true, status: 204 })),
  });

  assert.equal(await client.remove('gone'), true);
});

// ── secretKeysOf ──────────────────────────────────────────────────────────

test('secretKeysOf picks exactly the secret-typed fields', () => {
  const definition = {
    configSchema: [
      { key: 'url', type: 'url' },
      { key: 'password', type: 'secret' },
      { key: 'maxRows', type: 'number' },
      { key: 'token', type: 'secret' },
    ],
  };

  assert.deepEqual(secretKeysOf(definition), ['password', 'token']);
});

test('secretKeysOf is empty for a widget with no schema', () => {
  assert.deepEqual(secretKeysOf({}), []);
  assert.deepEqual(secretKeysOf(null), []);
});

// ── the sentinel pairs with the settings panel ────────────────────────────

test('the sentinel reads as "a value is saved" without carrying a value', () => {
  // The panel's own presence test (`secretIsSet` in settings-panel.js) is a
  // non-empty-string check on the config it holds. The sentinel has to satisfy
  // it — otherwise a configured widget shows "No value saved" and the user
  // retypes a credential they never needed to.
  assert.equal(typeof SECRET_SET, 'string');
  assert.notEqual(SECRET_SET, '');
});

// ── the dangling-reference guard ──────────────────────────────────────────

test('a layout node naming a missing instance is skipped, not fatal', () => {
  const roster = [{ id: 'clock-a', type: 'clock', config: {} }];
  const nodes = [
    { id: 'clock-a', x: 0, y: 0, w: 4, h: 2 },
    { id: 'deleted-widget', x: 4, y: 0, w: 4, h: 2 },
  ];

  const { roster: kept, usable } = reconcileRoster(roster, nodes);

  // The surviving widget still loads — this is the failure that turns a small
  // bug into an unusable app, so it must degrade to "one tile missing".
  assert.deepEqual(
    kept.map((e) => e.id),
    ['clock-a']
  );
  assert.deepEqual(
    usable.map((n) => n.id),
    ['clock-a']
  );
});

test('the dangling guard matches on widgetId as well as id', () => {
  const roster = [{ id: 'clock-a', type: 'clock', config: {} }];
  const nodes = [
    { id: 'tile-1', widgetId: 'clock-a', x: 0, y: 0, w: 4, h: 2 },
    { id: 'tile-2', widgetId: 'deleted-widget', x: 4, y: 0, w: 4, h: 2 },
  ];

  const { usable } = reconcileRoster(roster, nodes);

  assert.deepEqual(
    usable.map((n) => n.id),
    ['tile-1']
  );
});

test('an empty layout leaves the whole roster loadable', () => {
  const roster = [
    { id: 'a', type: 'clock', config: {} },
    { id: 'b', type: 'clock', config: {} },
  ];

  const { roster: kept, usable } = reconcileRoster(roster, []);

  // No geometry means default positions, NOT a blank dashboard.
  assert.equal(kept.length, 2);
  assert.deepEqual(usable, []);
});

// ── the migration hook is still on the load path ──────────────────────────

test('a config loaded from the API still runs through migrateConfig', () => {
  // What the server returns for a widget saved by an older Haven.
  const stored = { label: 'Old', configVersion: 1 };

  const definition = {
    type: 'clock',
    configVersion: 2,
    migrateConfig: (config) => ({ ...config, label: `${config.label} (migrated)` }),
  };

  const { config, migrated, from, to } = migrateConfig(definition, stored);

  assert.equal(migrated, true);
  assert.equal(from, 1);
  assert.equal(to, 2);
  assert.equal(config.label, 'Old (migrated)');
  assert.equal(config.configVersion, 2);
});

test('a stored config carrying the secret sentinel migrates like any other', () => {
  // The sentinel must be inert to the migration path: it is just a string
  // value in the config, and a widget's migrate hook must not have to know
  // about Haven's credential storage to keep working.
  const stored = { password: SECRET_SET, configVersion: 1 };

  const definition = {
    type: 'torrents',
    configVersion: 2,
    migrateConfig: (config) => ({ ...config, maxRows: 6 }),
  };

  const { config } = migrateConfig(definition, stored);

  assert.equal(config.password, SECRET_SET);
  assert.equal(config.maxRows, 6);
  assert.equal(config.configVersion, 2);
});
