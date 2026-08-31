import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { buildServer } from '../src/server.js';
import { registerTorrentRoutes, STALE_MAX_AGE_MS } from '../src/routes/torrents.js';
import { RESULT, createQbittorrentConnector } from '../src/connectors/qbittorrent.js';
import { createFakeQbittorrent, rawTorrent } from './helpers/fake-qbittorrent.js';

/** A connector double that returns whatever the test sets next. */
function scriptedConnector(initial = { status: RESULT.OK, torrents: [] }) {
  let next = initial;
  return {
    configured: true,
    setNext(result) {
      next = result;
    },
    async getTorrents() {
      return next;
    },
  };
}

async function serverWith(connector, opts = {}) {
  // Connectors are injected through the `widgets` bag, which is how every
  // widget route takes its overrides — so no test needs a live service.
  return buildServer({
    logger: false,
    dbPath: ':memory:',
    widgets: { torrentConnector: connector },
    ...opts,
  });
}

test('GET /api/widgets/torrents returns the normalised list', async (t) => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const app = await serverWith(
    createQbittorrentConnector({ env: fake.env(), fetchImpl: fake.fetchImpl })
  );
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, true);
  assert.equal(body.torrents.length, 1);
  assert.equal(body.torrents[0].name, 'ubuntu-24.04-desktop-amd64.iso');
  assert.deepEqual(body.notices, []);
});

test('the response never carries the credentials or the session cookie', async (t) => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const app = await serverWith(
    createQbittorrentConnector({ env: fake.env(), fetchImpl: fake.fetchImpl })
  );
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  // The whole reason this connector lives in the backend. If any of these ever
  // appear in the payload, the design has failed in the way that matters.
  const serialised = res.payload;
  assert.doesNotMatch(serialised, /correct-horse/);
  assert.doesNotMatch(serialised, /SID=/);
  assert.equal(res.headers['set-cookie'], undefined);
});

test('not configured is a 200 with a hint, not an error', async (t) => {
  const app = await serverWith({
    configured: false,
    async getTorrents() {
      return { status: RESULT.NOT_CONFIGURED, message: 'qBittorrent is not configured.' };
    },
  });
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.configured, false);
  assert.deepEqual(body.torrents, []);
  assert.match(body.notices[0].hint, /HAVEN_QBITTORRENT_URL/);
});

test('a service that goes down serves the last good data with a stale notice', async (t) => {
  const connector = scriptedConnector({ status: RESULT.OK, torrents: [rawTorrent()] });
  const app = await serverWith(connector);
  t.after(() => app.close());

  const good = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });
  assert.equal(good.json().torrents.length, 1);

  connector.setNext({ status: RESULT.UNREACHABLE, message: 'qBittorrent is not reachable.' });
  const afterOutage = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  // A soft notice is not a hard error: the data is still there, marked stale.
  assert.equal(afterOutage.statusCode, 200);
  const body = afterOutage.json();
  assert.equal(body.stale, true);
  assert.equal(body.torrents.length, 1);
  assert.equal(body.notices[0].stale, true);
  assert.equal(body.unreachable, undefined);
});

test('with no cache at all, a down service is a clear unreachable tile', async (t) => {
  const app = await serverWith(
    scriptedConnector({ status: RESULT.UNREACHABLE, message: 'qBittorrent is not reachable.' })
  );
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  // Still a 200 — a down upstream is a state of the world, not a 5xx, and a
  // 5xx here would make the shell draw an error card for a transient blip.
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.unreachable, true);
  assert.equal(body.authFailed, false);
  assert.deepEqual(body.torrents, []);
});

test('an auth failure is flagged separately, because the fix is different', async (t) => {
  const app = await serverWith(
    scriptedConnector({ status: RESULT.AUTH_FAILED, message: 'Rejected the password.' })
  );
  t.after(() => app.close());

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/torrents' })).json();

  assert.equal(body.unreachable, true);
  assert.equal(body.authFailed, true);
});

test('cached data stops being served once it is too old to believe', async (t) => {
  const connector = scriptedConnector({ status: RESULT.OK, torrents: [rawTorrent()] });
  let clock = 1_000_000;

  // A bare instance rather than `buildServer`, which already registers this
  // route — the point of this test is the injected clock, not the whole server.
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await registerTorrentRoutes(app, { connector, now: () => clock });

  await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  connector.setNext({ status: RESULT.UNREACHABLE, message: 'down' });
  clock += STALE_MAX_AGE_MS - 1;
  assert.equal(
    (await app.inject({ method: 'GET', url: '/api/widgets/torrents' })).json().stale,
    true
  );

  // Past the horizon: hour-old progress bars are worse than saying "unreachable".
  clock += 2;
  const expired = (await app.inject({ method: 'GET', url: '/api/widgets/torrents' })).json();
  assert.equal(expired.unreachable, true);
  assert.deepEqual(expired.torrents, []);
});

test('a recovered service replaces the stale cache with fresh data', async (t) => {
  const connector = scriptedConnector({ status: RESULT.OK, torrents: [rawTorrent()] });
  const app = await serverWith(connector);
  t.after(() => app.close());

  await app.inject({ method: 'GET', url: '/api/widgets/torrents' });
  connector.setNext({ status: RESULT.UNREACHABLE, message: 'down' });
  await app.inject({ method: 'GET', url: '/api/widgets/torrents' });

  connector.setNext({
    status: RESULT.OK,
    torrents: [rawTorrent({ hash: 'bbbb2222', name: 'something-else.iso' })],
  });
  const body = (await app.inject({ method: 'GET', url: '/api/widgets/torrents' })).json();

  assert.equal(body.stale, undefined);
  assert.equal(body.torrents[0].hash, 'bbbb2222');
});
