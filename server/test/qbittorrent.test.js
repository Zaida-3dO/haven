import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  RESULT,
  createQbittorrentConnector,
  normaliseState,
  normaliseTorrent,
  readQbittorrentConfig,
  loginBackoff,
} from '../src/connectors/qbittorrent.js';
import { createFakeQbittorrent, rawTorrent, FAKE_URL } from './helpers/fake-qbittorrent.js';

const connectorFor = (fake, opts = {}) =>
  createQbittorrentConnector({ env: fake.env(), fetchImpl: fake.fetchImpl, ...opts });

test('logs in once and reuses the session across calls', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  const first = await qbt.getTorrents();
  const second = await qbt.getTorrents();

  assert.equal(first.status, RESULT.OK);
  assert.equal(second.status, RESULT.OK);
  // The point of holding the cookie: one login, two data calls. A connector
  // that logs in per request is a login storm at every refresh interval.
  assert.equal(fake.state.calls.login, 1);
  assert.equal(fake.state.calls.info, 2);
});

test('normalises the torrent payload', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  const { torrents } = await qbt.getTorrents();

  assert.equal(torrents.length, 1);
  assert.deepEqual(torrents[0], {
    hash: 'aaaa1111',
    name: 'ubuntu-24.04-desktop-amd64.iso',
    progress: 0.42,
    state: 'downloading',
    rawState: 'downloading',
    dlspeed: 1_500_000,
    upspeed: 250_000,
    size: 6_000_000_000,
    completed: 2_520_000_000,
    eta: 2_400,
    ratio: 0.35,
    category: 'linux',
    addedOn: 1_700_000_000,
  });
});

/**
 * The 3am path. A dashboard open for a week, qBittorrent restarts, and the
 * held cookie is silently no longer valid.
 */
test('re-authenticates and retries when the session has expired', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  await qbt.getTorrents();
  assert.equal(fake.state.calls.login, 1);

  fake.expireSession();
  const result = await qbt.getTorrents();

  assert.equal(result.status, RESULT.OK, 'an expired session must self-heal, not surface an error');
  assert.equal(result.torrents.length, 1);
  // Logged in a second time, and retried the data call exactly once.
  assert.equal(fake.state.calls.login, 2);
  assert.equal(fake.state.calls.info, 3);
});

test('gives up after one re-authentication rather than looping', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);
  await qbt.getTorrents();

  // Every session is invalid from here on: login succeeds, the data call still
  // 403s. A connector without a retry bound would spin here forever.
  const originalFetch = fake.fetchImpl;
  let infoCalls = 0;
  const alwaysForbidden = async (url, options) => {
    if (String(url).endsWith('/torrents/info')) {
      infoCalls += 1;
      return {
        status: 403,
        ok: false,
        headers: { get: () => null },
        async text() {
          return 'Forbidden';
        },
        async json() {
          return null;
        },
      };
    }
    return originalFetch(url, options);
  };

  const stubborn = createQbittorrentConnector({
    env: fake.env(),
    fetchImpl: alwaysForbidden,
  });

  const result = await stubborn.getTorrents();

  assert.equal(result.status, RESULT.AUTH_FAILED);
  assert.equal(infoCalls, 2, 'exactly one retry — the original call plus one after re-login');
});

test('a wrong password is an auth failure, not an unreachable service', async () => {
  const fake = createFakeQbittorrent();
  const qbt = createQbittorrentConnector({
    env: fake.env({ HAVEN_QBITTORRENT_PASS: 'wrong' }),
    fetchImpl: fake.fetchImpl,
  });

  const result = await qbt.getTorrents();

  // qBittorrent answers 200 with the body `Fails.`; a connector that only
  // checks the status code would report success and then 403 forever.
  assert.equal(result.status, RESULT.AUTH_FAILED);
  assert.match(result.message, /username or password/i);
  assert.equal(qbt.hasSession, false);
});

test('backs off rather than retrying a rejected login every tick', async () => {
  const fake = createFakeQbittorrent();
  let clock = 1_000;
  const qbt = createQbittorrentConnector({
    env: fake.env({ HAVEN_QBITTORRENT_PASS: 'wrong' }),
    fetchImpl: fake.fetchImpl,
    now: () => clock,
  });

  await qbt.getTorrents();
  assert.equal(fake.state.calls.login, 1);

  // Immediately again: inside the backoff window, so no second login attempt.
  const second = await qbt.getTorrents();
  assert.equal(second.status, RESULT.AUTH_FAILED);
  assert.equal(fake.state.calls.login, 1, 'must not hammer the service while backing off');

  // Past the window, it tries again.
  clock += loginBackoff(1) + 1;
  await qbt.getTorrents();
  assert.equal(fake.state.calls.login, 2);
});

test('a refused connection is unreachable, and keeps no session', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  fake.setOffline(true);
  const result = await qbt.getTorrents();

  assert.equal(result.status, RESULT.UNREACHABLE);
  assert.equal(qbt.hasSession, false);
});

test('recovers on its own once the service comes back', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  fake.setOffline(true);
  assert.equal((await qbt.getTorrents()).status, RESULT.UNREACHABLE);

  fake.setOffline(false);
  const result = await qbt.getTorrents();

  // A network failure must NOT arm the login backoff — only an auth failure
  // does, or a brief outage would lock the connector out for minutes.
  assert.equal(result.status, RESULT.OK);
});

test('no URL configured is a result, not a crash', async () => {
  const qbt = createQbittorrentConnector({
    env: { HAVEN_QBITTORRENT_URL: '', HAVEN_QBITTORRENT_USER: '', HAVEN_QBITTORRENT_PASS: '' },
    fetchImpl: async () => {
      throw new Error('a connector with no URL must never make a request');
    },
  });

  assert.equal(qbt.configured, false);
  assert.equal((await qbt.getTorrents()).status, RESULT.NOT_CONFIGURED);
});

test('works against an instance with authentication bypassed', async () => {
  // qBittorrent can skip auth for local subnets; then there is no username and
  // `/torrents/info` answers directly. Requiring a login would break that.
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  fake.state.validSids.add('anything');
  const openFetch = async (url, options) => {
    if (String(url).endsWith('/torrents/info')) {
      return {
        status: 200,
        ok: true,
        headers: { get: () => null },
        async text() {
          return '[]';
        },
        async json() {
          return fake.state.torrents;
        },
      };
    }
    return fake.fetchImpl(url, options);
  };

  const qbt = createQbittorrentConnector({
    env: {
      HAVEN_QBITTORRENT_URL: FAKE_URL,
      HAVEN_QBITTORRENT_USER: '',
      HAVEN_QBITTORRENT_PASS: '',
    },
    fetchImpl: openFetch,
  });

  const result = await qbt.getTorrents();

  assert.equal(result.status, RESULT.OK);
  assert.equal(fake.state.calls.login, 0, 'no credentials means no login attempt');
});

test('concurrent callers share one login', async () => {
  const fake = createFakeQbittorrent({ torrents: [rawTorrent()] });
  const qbt = connectorFor(fake);

  await Promise.all([qbt.getTorrents(), qbt.getTorrents(), qbt.getTorrents()]);

  assert.equal(fake.state.calls.login, 1);
});

test('readQbittorrentConfig trims a trailing slash and reports configuredness', () => {
  const withSlash = readQbittorrentConfig({
    HAVEN_QBITTORRENT_URL: 'http://qbittorrent.invalid:8080/',
    HAVEN_QBITTORRENT_USER: 'haven',
    HAVEN_QBITTORRENT_PASS: 'x',
  });
  assert.equal(withSlash.url, 'http://qbittorrent.invalid:8080');
  assert.equal(withSlash.configured, true);

  assert.equal(readQbittorrentConfig({}).configured, false);
  assert.equal(readQbittorrentConfig({ HAVEN_QBITTORRENT_URL: '   ' }).configured, false);
});

test('normaliseState collapses qBittorrent states to a small vocabulary', () => {
  assert.equal(normaliseState('stalledUP'), 'seeding');
  assert.equal(normaliseState('forcedDL'), 'downloading');
  assert.equal(normaliseState('pausedUP'), 'completed');
  assert.equal(normaliseState('missingFiles'), 'error');
  assert.equal(normaliseState('something-new-in-v6'), 'unknown');
});

test('normaliseTorrent guards the values a tile would render badly', () => {
  // 8640000 is qBittorrent's "unknown ETA" sentinel; showing it as 100 days
  // would be a confident lie.
  assert.equal(normaliseTorrent(rawTorrent({ eta: 8_640_000 })).eta, null);
  assert.equal(normaliseTorrent(rawTorrent({ eta: 0 })).eta, null);
  // A rechecking torrent can briefly report progress above 1.
  assert.equal(normaliseTorrent(rawTorrent({ progress: 1.4 })).progress, 1);
  assert.equal(normaliseTorrent(rawTorrent({ progress: 'nonsense' })).progress, 0);
  assert.equal(normaliseTorrent({}).name, '');
});

test('loginBackoff widens and then caps', () => {
  assert.equal(loginBackoff(1), 5_000);
  assert.equal(loginBackoff(2), 10_000);
  assert.equal(loginBackoff(3), 20_000);
  assert.equal(loginBackoff(50), 300_000);
});
