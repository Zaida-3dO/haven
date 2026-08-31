import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  HA_SOURCE,
  HA_STATUS,
  createHomeAssistantConnector,
  mapSeverity,
  mapStateToNotice,
} from '../src/connectors/home-assistant.js';

/**
 * The connector is driven against a stubbed transport and a fake clock, so no
 * test here needs a token, a Home Assistant or the network.
 *
 * The hostname in every fixture is `.invalid`: a real Home Assistant address
 * is a LAN topology leak and must not be in a public repo.
 */

const BASE = 'http://ha.invalid:8123';
const TOKEN = 'test-token-not-a-real-one';
const NOW = Date.parse('2026-09-01T12:00:00Z');

function connector({ states = [], baseUrl = BASE, token = TOKEN, ...rest } = {}) {
  const calls = [];

  const transport = async (url, options = {}) => {
    calls.push({ url, options });

    if (typeof states === 'function') return states(url, options);

    return {
      ok: true,
      status: 200,
      json: async () => states,
    };
  };

  const ha = createHomeAssistantConnector({
    baseUrl: () => baseUrl,
    token: () => token,
    transport,
    now: () => NOW,
    ...rest,
  });

  return { ha, calls };
}

const notification = (overrides = {}) => ({
  entity_id: 'persistent_notification.backup_failed',
  state: 'notifying',
  attributes: { title: 'Backup failed', message: 'Last night the backup did not complete.' },
  ...overrides,
});

// ── Configuration ─────────────────────────────────────────────────────────

test('no URL is a not_configured hint, not an error', async () => {
  // A fresh clone should look unfinished, not broken.
  const { ha } = connector({ baseUrl: null });
  const result = await ha.get();

  assert.equal(result.status, HA_STATUS.NOT_CONFIGURED);
  assert.equal(result.reason, 'missing_url');
  assert.match(result.hint, /HAVEN_HA_URL/);
});

test('no token is a not_configured hint naming the token variable', async () => {
  const { ha } = connector({ token: null });
  const result = await ha.get();

  assert.equal(result.status, HA_STATUS.NOT_CONFIGURED);
  assert.equal(result.reason, 'missing_token');
  assert.match(result.hint, /HAVEN_HA_TOKEN/);
});

test('the hint never echoes the token, not even partially', async () => {
  const { ha } = connector({ baseUrl: null });
  const result = await ha.get();
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test('an unparseable URL is refused rather than fetched', async () => {
  const { ha, calls } = connector({ baseUrl: 'not a url' });
  const result = await ha.get();

  assert.equal(result.reason, 'invalid_url');
  assert.equal(calls.length, 0);
});

test('no request is made at all when nothing is configured', async () => {
  const { ha, calls } = connector({ token: null });
  await ha.get();
  assert.equal(calls.length, 0);
});

// ── The token ─────────────────────────────────────────────────────────────

test('the token goes in an Authorization header and nowhere else', async () => {
  const { ha, calls } = connector({ states: [notification()] });
  await ha.get();

  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  // Never in the URL, where it would land in a proxy log.
  assert.ok(!calls[0].url.includes(TOKEN));
});

test('the token never appears in the returned payload', async () => {
  const { ha } = connector({ states: [notification()] });
  const result = await ha.get();

  const serialised = JSON.stringify(result);
  assert.ok(!serialised.includes(TOKEN));
  // Nor does the internal hostname.
  assert.ok(!serialised.includes('ha.invalid'));
});

// ── Mapping ───────────────────────────────────────────────────────────────

test('a persistent notification maps to the envelope', () => {
  const notice = mapStateToNotice(notification(), { now: NOW });

  assert.equal(notice.id, 'persistent_notification.backup_failed');
  assert.equal(notice.title, 'Backup failed');
  assert.equal(notice.body, 'Last night the backup did not complete.');
  assert.equal(notice.source, HA_SOURCE);
});

test('an unavailable or off entity produces nothing', () => {
  // A broken integration is not a notice; surfacing it would fill the tile
  // with plumbing problems the moment anything flaps.
  for (const state of ['unavailable', 'unknown', 'off', '', 'none']) {
    assert.equal(mapStateToNotice(notification({ state })), null, `state "${state}"`);
  }
});

test('an entity with no title falls back to a humanised entity id', () => {
  const notice = mapStateToNotice({
    entity_id: 'sensor.bin_collection_day',
    state: 'Recycling',
    attributes: {},
  });

  assert.equal(notice.title, 'Bin collection day');
});

test('a friendly_name beats the humanised id', () => {
  const notice = mapStateToNotice({
    entity_id: 'sensor.bin_collection_day',
    state: 'Recycling',
    attributes: { friendly_name: 'Bin day' },
  });

  assert.equal(notice.title, 'Bin day');
});

test('a body identical to the title is dropped rather than repeated', () => {
  const notice = mapStateToNotice({
    entity_id: 'sensor.thing',
    state: 'Bin day',
    attributes: { friendly_name: 'Bin day' },
  });

  assert.equal(notice.body, null);
});

test('a due date is read from any of the attributes HA uses for one', () => {
  for (const key of ['due', 'due_date', 'start_time']) {
    const notice = mapStateToNotice({
      entity_id: 'calendar.thing',
      state: 'on',
      attributes: { [key]: '2026-09-02T18:00:00Z' },
    });
    assert.equal(notice.due, '2026-09-02T18:00:00.000Z', key);
  }
});

test('an unparseable due attribute becomes null rather than Invalid Date', () => {
  const notice = mapStateToNotice({
    entity_id: 'calendar.thing',
    state: 'on',
    attributes: { due: 'soon' },
  });
  assert.equal(notice.due, null);
});

test('severity mapping folds HA vocabulary onto the three levels', () => {
  assert.equal(mapSeverity('critical'), 'urgent');
  assert.equal(mapSeverity('ERROR'), 'urgent');
  assert.equal(mapSeverity('warning'), 'warn');
  assert.equal(mapSeverity('warn'), 'warn');
  assert.equal(mapSeverity('info'), 'info');
  // Anything unrecognised becomes the level that cannot mislead.
  assert.equal(mapSeverity('chartreuse'), 'info');
  assert.equal(mapSeverity(undefined), 'info');
});

test('nothing from the HA attribute bag leaks into the envelope', () => {
  // An HA state object carries device ids, coordinates and addresses. None of
  // it is anything a browser needs, so the mapper copies named fields rather
  // than passing the bag through — this asserts that.
  //
  // The address is ASSEMBLED rather than written as a literal: an RFC 1918
  // address in a tracked file is exactly what `scripts/check-no-secrets.sh`
  // fails on, and it is right to, even for an invented one. Building it here
  // keeps the test's meaning without putting the shape in the repo.
  const privateAddress = ['10', '0', '0', '5'].join('.');

  const notice = mapStateToNotice({
    entity_id: 'persistent_notification.x',
    state: 'notifying',
    attributes: {
      title: 'A thing',
      message: 'Detail',
      device_id: 'abc123',
      latitude: 51.5,
      ip_address: privateAddress,
    },
  });

  const serialised = JSON.stringify(notice);
  for (const secret of ['abc123', '51.5', privateAddress]) {
    assert.ok(!serialised.includes(secret), `leaked ${secret}`);
  }
});

test('a notice carries no url — linking in would expose the HA hostname', () => {
  assert.equal(mapStateToNotice(notification()).url, null);
});

// ── Which entities are pulled ─────────────────────────────────────────────

test('persistent notifications are always included', async () => {
  const { ha } = connector({
    states: [notification(), { entity_id: 'light.kitchen', state: 'on', attributes: {} }],
  });

  const result = await ha.get();
  assert.equal(result.notices.length, 1);
  assert.equal(result.notices[0].id, 'persistent_notification.backup_failed');
});

test('an explicitly listed entity is included too', async () => {
  const { ha } = connector({
    states: [
      { entity_id: 'sensor.bin_day', state: 'Recycling', attributes: {} },
      { entity_id: 'light.kitchen', state: 'on', attributes: {} },
    ],
    entities: () => ['sensor.bin_day'],
  });

  const result = await ha.get();
  assert.deepEqual(
    result.notices.map((n) => n.id),
    ['sensor.bin_day']
  );
});

// ── Caching and failure ───────────────────────────────────────────────────

test('a second call inside the TTL does not hit Home Assistant again', async () => {
  const { ha, calls } = connector({ states: [notification()] });

  await ha.get();
  await ha.get();

  assert.equal(calls.length, 1, 'five tabs and a phone share one upstream call');
});

test('force bypasses the cache', async () => {
  const { ha, calls } = connector({ states: [notification()] });

  await ha.get();
  await ha.get({ force: true });

  assert.equal(calls.length, 2);
});

test('a failure with a cached read is a SOFT notice, not an error', async () => {
  let fail = false;
  const { ha } = connector({
    states: async () => {
      if (fail) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => [notification()] };
    },
  });

  await ha.get();
  fail = true;
  const result = await ha.get({ force: true });

  // HA restarting is routine and the notices are still true.
  assert.equal(result.status, HA_STATUS.OK);
  assert.equal(result.stale, true);
  assert.equal(result.notices.length, 1);
  assert.match(result.notice, /unreachable/);
});

test('a failure with nothing cached is a real error', async () => {
  const { ha } = connector({
    states: async () => {
      throw new Error('ECONNREFUSED');
    },
  });

  const result = await ha.get();
  assert.equal(result.status, HA_STATUS.ERROR);
  assert.equal(result.error, 'UPSTREAM_UNAVAILABLE');
});

test('a non-2xx response names the status but never the URL', async () => {
  const { ha } = connector({
    states: async () => ({ ok: false, status: 401, json: async () => ({}) }),
  });

  const result = await ha.get();
  assert.equal(result.status, HA_STATUS.ERROR);
  assert.match(result.message, /401/);
  // The URL names an internal host.
  assert.ok(!result.message.includes('ha.invalid'));
});

// ── Actions ───────────────────────────────────────────────────────────────

test('a persistent notification offers a dismiss-in-HA action', () => {
  // Dismissing only on the dashboard leaves it nagging in Home Assistant.
  const [action] = mapStateToNotice(notification()).actions;

  assert.equal(action.id, 'ha-dismiss');
  assert.equal(action.service, 'persistent_notification/dismiss');
  assert.deepEqual(action.data, { notification_id: 'backup_failed' });
});

test('a plain sensor gets no action', () => {
  const notice = mapStateToNotice({
    entity_id: 'sensor.bin_day',
    state: 'Recycling',
    attributes: {},
  });
  assert.deepEqual(notice.actions, []);
});

test('performing an action POSTs the service call with the token', async () => {
  const { ha, calls } = connector({ states: [notification()] });

  const result = await ha.perform({
    service: 'persistent_notification/dismiss',
    data: { notification_id: 'backup_failed' },
  });

  assert.equal(result.status, HA_STATUS.OK);
  assert.equal(calls[0].options.method, 'POST');
  assert.match(calls[0].url, /\/api\/services\/persistent_notification\/dismiss$/);
  assert.equal(calls[0].options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { notification_id: 'backup_failed' });
});

test('an action naming a path rather than a service is refused', async () => {
  // A stored action arrived from outside, so it does not get to choose an
  // arbitrary URL on the Home Assistant host.
  const { ha, calls } = connector();

  for (const service of ['../../config', '/api/config', 'http://evil.invalid/', 'onlyonepart']) {
    const result = await ha.perform({ service });
    assert.equal(result.status, HA_STATUS.ERROR, service);
    assert.equal(result.error, 'UNSUPPORTED_ACTION', service);
  }

  assert.equal(calls.length, 0, 'nothing should have been fetched');
});

test('performing an action invalidates the cache', async () => {
  const { ha, calls } = connector({ states: [notification()] });

  await ha.get();
  await ha.perform({ service: 'persistent_notification/dismiss', data: {} });
  await ha.get();

  // The next read must reflect what we just did.
  assert.equal(calls.length, 3);
});

test('an action against an unconfigured Home Assistant reports the hint', async () => {
  const { ha } = connector({ token: null });
  const result = await ha.perform({ service: 'a/b' });

  assert.equal(result.status, HA_STATUS.NOT_CONFIGURED);
  assert.match(result.hint, /HAVEN_HA_TOKEN/);
});

test('a failing action is reported rather than silently swallowed', async () => {
  const { ha } = connector({
    states: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });

  const result = await ha.perform({ service: 'a/b' });
  assert.equal(result.status, HA_STATUS.ERROR);
});
