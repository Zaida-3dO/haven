/**
 * Per-widget qBittorrent configuration.
 *
 * Two torrents widgets may point at two different qBittorrent instances with
 * different credentials. That is the feature; these are the properties it has
 * to hold while it does it.
 *
 * The most important test in this file is `the API key is never returned by
 * any endpoint`. UI-editable credentials are only acceptable because a secret
 * is write-only: it can be set and replaced, and its *presence* reported, but
 * no GET ever returns it. If that test can pass while the secret leaks, this
 * whole feature is a credential-disclosure bug with a settings form on top.
 *
 * Hostnames are `.invalid` throughout, per docs/SECURITY.md — the repo is
 * public and a fixture is a tracked file.
 */

import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { SECRET_SET } from '../src/db/instances-store.js';
import { resolveQbittorrentSettings } from '../src/connectors/qbittorrent.js';
import { buildServer } from '../src/server.js';

/**
 * An in-memory credential store double.
 *
 * The same one `instances.test.js` uses, and for the same reason: the real
 * store refuses to write without HAVEN_SECRET_KEY, and `credentials.test.js`
 * already proves the encryption. What is under test here is the ROUTING —
 * which value reaches the connector, and which never reaches the browser.
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

/**
 * A fake qBittorrent that serves a DIFFERENT torrent per base URL, and refuses
 * anything but that instance's own key.
 *
 * Serving different data per instance is what makes the independence test
 * meaningful: if the two widgets were ever collapsed into one connector or one
 * cache, they would return the same name and the assertion would catch it.
 */
function createMultiHostQbittorrent(instances) {
  const calls = [];

  async function fetchImpl(url, options = {}) {
    const target = instances.find((instance) => url.startsWith(instance.url));
    calls.push({ url, authorization: options.headers?.Authorization ?? null });

    if (!target) return { ok: false, status: 404, async json() {}, async text() {} };

    const bearer = /^Bearer (.+)$/.exec(options.headers?.Authorization ?? '')?.[1];
    if (bearer !== target.apiKey) {
      return { ok: false, status: 403, async text() {}, async json() {} };
    }

    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      async json() {
        return [
          {
            hash: target.hash,
            name: target.name,
            progress: 0.5,
            state: 'downloading',
            dlspeed: 1,
            upspeed: 1,
            size: 2,
            completed: 1,
            eta: 60,
            ratio: 0,
            category: '',
            added_on: 0,
          },
        ];
      },
    };
  }

  return { fetchImpl, calls };
}

/**
 * A server whose torrents route reaches a fake qBittorrent.
 *
 * The FETCH is stubbed, not the connector — one layer further out, so the
 * config-to-connector wiring this feature actually consists of stays real.
 * `weather-settings-wiring.test.js` learned that the hard way: a seam every
 * test stubs is a seam no test covers, and stubbing the connector here would
 * leave `resolveQbittorrentSettings` and the per-instance lookup unexercised.
 *
 * `fetch` is read through a mutable box so a test can make a service die
 * part-way through, which is what the stale-cache case needs.
 */
async function appWith(t, { instances = [], env = {}, fetchImpl } = {}) {
  const db = new Database(':memory:');
  migrate(db);
  const credentials = fakeCredentials();

  const box = { impl: fetchImpl ?? (async () => ({ ok: false, status: 503 })) };

  const app = await buildServer({
    logger: false,
    db,
    credentials,
    seedPath: '/nonexistent/apps.invalid.json',
    instancesSeedPath: '/nonexistent/instances.invalid.json',
    widgets: {
      torrentOptions: {
        env,
        fetchImpl: (url, options) => box.impl(url, options),
      },
    },
  });

  app.useFetch = (next) => {
    box.impl = next;
  };

  t.after(async () => {
    await app.close();
    db.close();
  });

  for (const instance of instances) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/instances',
      payload: JSON.stringify(instance),
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.statusCode, 201, `could not create ${instance.id}`);
  }

  return { app, db, credentials };
}

const get = (app, query = '') =>
  app.inject({ method: 'GET', url: `/api/widgets/torrents${query}` });

// ── the security property the whole feature rests on ──────────────────────

test('the API key is never returned by any endpoint', async (t) => {
  const KEY = 'qbt_this_must_never_be_returned';

  const { app, db } = await appWith(t, {
    instances: [
      {
        id: 'torrents-a',
        type: 'torrents',
        config: { url: 'https://qbt-a.invalid:8080', apiKey: KEY, maxRows: 6 },
        secretKeys: ['apiKey'],
      },
    ],
  });

  // Every endpoint that can see this instance, including the one this feature
  // added. A leak through ANY of them is the same disclosure.
  const responses = [
    await get(app, '?instance=torrents-a'),
    await app.inject({ method: 'GET', url: '/api/instances' }),
    await app.inject({ method: 'GET', url: '/api/instances/torrents-a' }),
  ];

  for (const response of responses) {
    assert.equal(
      response.payload.includes(KEY),
      false,
      `${response.request?.url ?? 'a response'} returned the stored API key`
    );
  }

  // Nor is it sitting in the config blob in the clear, waiting for some future
  // endpoint to serve it.
  const row = db.prepare('SELECT config FROM widgets WHERE id = ?').get('torrents-a');
  assert.equal(row.config.includes(KEY), false, 'the key was stored in the config blob');

  // What IS served is the sentinel: presence, not value. This is what lets the
  // settings panel say "a value is saved" without ever holding one.
  const instance = (await app.inject({ method: 'GET', url: '/api/instances/torrents-a' })).json();
  assert.equal(instance.config.apiKey, SECRET_SET);
});

test('the API key does not leak through a failure, which is where a value gets quoted back', async (t) => {
  const KEY = 'qbt_must_not_appear_in_an_error';

  // No fake fetch is wired here, so the address is simply unreachable — the
  // path where a connector is most likely to interpolate what it tried.
  const { app } = await appWith(t, {
    instances: [
      {
        id: 'torrents-a',
        type: 'torrents',
        config: { url: 'https://unreachable.invalid:8080', apiKey: KEY },
        secretKeys: ['apiKey'],
      },
    ],
  });

  const response = await get(app, '?instance=torrents-a');

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.includes(KEY), false, 'the key appeared in a failure response');
  // The address is not echoed either: it is upstream topology, and
  // docs/SECURITY.md counts internal hostnames alongside credentials.
  assert.equal(response.payload.includes('unreachable.invalid'), false);
});

// ── the feature itself ────────────────────────────────────────────────────

test('two widgets with different configs fetch independently', async (t) => {
  const qbt = createMultiHostQbittorrent([
    {
      url: 'https://qbt-a.invalid:8080',
      apiKey: 'qbt_key_a',
      hash: 'aaaa1111',
      name: 'from-instance-a.iso',
    },
    {
      url: 'https://qbt-b.invalid:9090',
      apiKey: 'qbt_key_b',
      hash: 'bbbb2222',
      name: 'from-instance-b.iso',
    },
  ]);

  const { app } = await appWith(t, {
    instances: [
      {
        id: 'torrents-a',
        type: 'torrents',
        config: { url: 'https://qbt-a.invalid:8080', apiKey: 'qbt_key_a' },
        secretKeys: ['apiKey'],
      },
      {
        id: 'torrents-b',
        type: 'torrents',
        config: { url: 'https://qbt-b.invalid:9090', apiKey: 'qbt_key_b' },
        secretKeys: ['apiKey'],
      },
    ],
  });

  app.useFetch(qbt.fetchImpl);

  const a = (await get(app, '?instance=torrents-a')).json();
  const b = (await get(app, '?instance=torrents-b')).json();

  // The whole point of the feature: each widget sees its OWN service.
  assert.equal(a.torrents[0].name, 'from-instance-a.iso');
  assert.equal(b.torrents[0].name, 'from-instance-b.iso');

  // And each authenticated with its own key, rather than one config being
  // used for both.
  const keysUsed = qbt.calls.map((c) => c.authorization);
  assert.ok(keysUsed.includes('Bearer qbt_key_a'));
  assert.ok(keysUsed.includes('Bearer qbt_key_b'));
});

test('one widget going down does not blank the other', async (t) => {
  const qbt = createMultiHostQbittorrent([
    {
      url: 'https://qbt-a.invalid:8080',
      apiKey: 'qbt_key_a',
      hash: 'aaaa1111',
      name: 'from-instance-a.iso',
    },
  ]);

  const { app } = await appWith(t, {
    instances: [
      {
        id: 'torrents-a',
        type: 'torrents',
        config: { url: 'https://qbt-a.invalid:8080', apiKey: 'qbt_key_a' },
        secretKeys: ['apiKey'],
      },
      {
        id: 'torrents-b',
        type: 'torrents',
        config: { url: 'https://qbt-down.invalid:9090', apiKey: 'qbt_key_b' },
        secretKeys: ['apiKey'],
      },
    ],
  });

  app.useFetch(qbt.fetchImpl);

  const a = (await get(app, '?instance=torrents-a')).json();
  const b = (await get(app, '?instance=torrents-b')).json();

  assert.equal(a.torrents[0].name, 'from-instance-a.iso');
  // B is unreachable, and says so — without taking A's data with it. The
  // last-good cache is per instance for exactly this reason: one shared
  // variable would have served A's list to B.
  assert.equal(b.unreachable, true);
  assert.deepEqual(b.torrents, []);
});

test("a widget's stale cache is its own, not the other widget's data", async (t) => {
  const qbt = createMultiHostQbittorrent([
    {
      url: 'https://qbt-a.invalid:8080',
      apiKey: 'qbt_key_a',
      hash: 'aaaa1111',
      name: 'from-instance-a.iso',
    },
    {
      url: 'https://qbt-b.invalid:9090',
      apiKey: 'qbt_key_b',
      hash: 'bbbb2222',
      name: 'from-instance-b.iso',
    },
  ]);

  const { app } = await appWith(t, {
    instances: [
      {
        id: 'torrents-a',
        type: 'torrents',
        config: { url: 'https://qbt-a.invalid:8080', apiKey: 'qbt_key_a' },
        secretKeys: ['apiKey'],
      },
      {
        id: 'torrents-b',
        type: 'torrents',
        config: { url: 'https://qbt-b.invalid:9090', apiKey: 'qbt_key_b' },
        secretKeys: ['apiKey'],
      },
    ],
  });

  app.useFetch(qbt.fetchImpl);

  // Both warm their caches.
  await get(app, '?instance=torrents-a');
  await get(app, '?instance=torrents-b');

  // Now B's service dies. A must be untouched, and B must fall back to B's
  // OWN last-good list rather than to A's.
  app.useFetch(async (url, options) => {
    if (url.startsWith('https://qbt-b.invalid:9090')) throw new Error('connection refused');
    return qbt.fetchImpl(url, options);
  });

  const b = (await get(app, '?instance=torrents-b')).json();

  assert.equal(b.stale, true);
  assert.equal(b.torrents[0].name, 'from-instance-b.iso', 'B was served another widget’s data');
});

// ── precedence: the widget wins, or the environment does ──────────────────

test('a widget with no url of its own falls back to the environment', () => {
  const env = {
    HAVEN_QBITTORRENT_URL: 'https://from-env.invalid:8080',
    HAVEN_QBITTORRENT_API_KEY: 'qbt_from_env',
  };

  // The upgrade case: an install with env vars and no per-widget config keeps
  // working exactly as it did.
  const settings = resolveQbittorrentSettings({ maxRows: 6 }, null, env);

  assert.equal(settings.url, 'https://from-env.invalid:8080');
  assert.equal(settings.apiKey, 'qbt_from_env');
  assert.equal(settings.configured, true);
});

test("a widget's own url wins over the environment", () => {
  const env = {
    HAVEN_QBITTORRENT_URL: 'https://from-env.invalid:8080',
    HAVEN_QBITTORRENT_API_KEY: 'qbt_from_env',
  };

  const settings = resolveQbittorrentSettings(
    { url: 'https://from-widget.invalid:9090' },
    'qbt_from_widget',
    env
  );

  assert.equal(settings.url, 'https://from-widget.invalid:9090');
  assert.equal(settings.apiKey, 'qbt_from_widget');
});

test('a configured widget does not inherit the environment key', () => {
  const env = {
    HAVEN_QBITTORRENT_URL: 'https://from-env.invalid:8080',
    HAVEN_QBITTORRENT_API_KEY: 'qbt_from_env',
  };

  // The reason precedence is whole-instance rather than field-by-field. A
  // widget deliberately pointed at an unauthenticated instance must not
  // silently authenticate as whoever the environment is.
  const settings = resolveQbittorrentSettings({ url: 'https://open.invalid:9090' }, null, env);

  assert.equal(settings.url, 'https://open.invalid:9090');
  assert.equal(settings.apiKey, '', 'the widget inherited the environment API key');
  // And likewise the credentials — an instance is configured from one source.
  assert.equal(settings.username, '');
  assert.equal(settings.password, '');
});

test('a blank or whitespace url is not a configuration', () => {
  const env = { HAVEN_QBITTORRENT_URL: 'https://from-env.invalid:8080' };

  // Whitespace must read as "not configured" rather than as a url, or the
  // fallback silently stops working the moment someone clears the field by
  // pressing space.
  assert.equal(
    resolveQbittorrentSettings({ url: '   ' }, null, env).url,
    'https://from-env.invalid:8080'
  );
  assert.equal(
    resolveQbittorrentSettings({ url: '' }, null, env).url,
    'https://from-env.invalid:8080'
  );
  assert.equal(resolveQbittorrentSettings({}, null, env).url, 'https://from-env.invalid:8080');
});

test('a trailing slash is trimmed, so the api path is never doubled', () => {
  const settings = resolveQbittorrentSettings({ url: 'https://qbt.invalid:8080/' }, 'k', {});

  assert.equal(settings.url, 'https://qbt.invalid:8080');
});

test('a whitespace-only key is no key, rather than a bare Bearer header', () => {
  const settings = resolveQbittorrentSettings({ url: 'https://qbt.invalid:8080' }, '   ', {});

  assert.equal(settings.apiKey, '');
});

// ── the route without an instance ─────────────────────────────────────────

test('a request with no instance id is served by the environment', async (t) => {
  const { app } = await appWith(t, { env: {} });

  // Nothing configured anywhere: the pre-existing behaviour, unchanged.
  const body = (await get(app)).json();

  assert.equal(body.configured, false);
  assert.match(body.notices[0].hint, /settings/i);
});

test('an unknown instance id falls back rather than failing', async (t) => {
  const { app } = await appWith(t);

  // A widget deleted in another tab should render "not configured", not a 500.
  const response = await get(app, '?instance=no-such-widget');

  assert.equal(response.statusCode, 200);
  assert.equal(response.json().configured, false);
});
