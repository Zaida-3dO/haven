import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { HA_STATUS } from '../src/connectors/home-assistant.js';
import { migrate } from '../src/db/migrate.js';
import { MAX_BATCH } from '../src/routes/notices.js';
import { buildServer } from '../src/server.js';

/**
 * The routes are driven through `app.inject()` with a stubbed Home Assistant
 * connector, so no test here needs a token, a Home Assistant or the network.
 * The connector's own behaviour is covered in home-assistant.test.js; what
 * these assert is the HTTP contract the widget depends on.
 */

const NOW = Date.parse('2026-09-01T12:00:00Z');

async function appWith(t, { ha = { status: HA_STATUS.OK, notices: [] }, now = NOW } = {}) {
  const db = new Database(':memory:');
  migrate(db);

  const performed = [];

  const app = await buildServer({
    logger: false,
    db,
    // Keep the weather routes off the network too.
    widgets: {
      settings: { units: 'metric', latitude: 0, longitude: 0 },
      weatherConnector: {
        async get() {
          return { status: 'not_configured', reason: 'missing_api_key', hint: 'x' };
        },
      },
    },
    notices: {
      now: () => now,
      homeAssistantConnector: {
        async get() {
          return typeof ha === 'function' ? ha() : ha;
        },
        async perform(action) {
          performed.push(action);
          return { status: HA_STATUS.OK };
        },
      },
    },
  });

  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, db, performed };
}

const post = (app, url, payload) => app.inject({ method: 'POST', url, payload });
const get = (app, url = '/api/widgets/notices') => app.inject({ method: 'GET', url });

const notice = (overrides = {}) => ({
  id: 'bin-day',
  severity: 'warn',
  title: 'Recycling goes out tonight',
  source: 'chores',
  ...overrides,
});

// ── Ingest ────────────────────────────────────────────────────────────────

test('POST accepts a valid notice and reports what it stored', async (t) => {
  const { app } = await appWith(t);

  const res = await post(app, '/api/widgets/notices', notice());

  assert.equal(res.statusCode, 201);
  assert.equal(res.json().written, 1);
  assert.deepEqual(res.json().ids, ['chores:bin-day']);
});

test('POST accepts a batch', async (t) => {
  const { app } = await appWith(t);

  const res = await post(app, '/api/widgets/notices', [
    notice({ id: 'a', title: 'A' }),
    notice({ id: 'b', title: 'B' }),
  ]);

  assert.equal(res.statusCode, 201);
  assert.equal(res.json().written, 2);
});

test('a malformed notice is rejected with a message naming the field', async (t) => {
  const { app } = await appWith(t);

  const res = await post(app, '/api/widgets/notices', notice({ severity: 'catastrophic' }));

  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'INVALID_NOTICE');
  assert.equal(res.json().errors[0].field, 'severity');
  // Useful enough that the sender can fix it without reading our source.
  assert.match(res.json().errors[0].message, /info, warn, urgent/);
});

test('a rejected batch stores NOTHING, not just the good ones', async (t) => {
  const { app } = await appWith(t);

  const res = await post(app, '/api/widgets/notices', [
    notice({ id: 'good', title: 'Fine' }),
    notice({ id: 'bad', title: '' }),
  ]);

  assert.equal(res.statusCode, 400);
  // A partial write would leave the sender unsure what landed.
  assert.deepEqual((await get(app)).json().notices, []);
});

test('every bad entry is reported, not just the first', async (t) => {
  const { app } = await appWith(t);

  const res = await post(app, '/api/widgets/notices', [
    notice({ id: 'a', title: '' }),
    notice({ id: 'b', severity: 'nope' }),
    notice({ id: 'c', due: 'tomorrow' }),
  ]);

  assert.equal(res.json().errors.length, 3);
  assert.deepEqual(
    res.json().errors.map((e) => e.field),
    ['title', 'severity', 'due']
  );
});

test('an empty array is a 400 rather than a no-op 201', async (t) => {
  const { app } = await appWith(t);
  const res = await post(app, '/api/widgets/notices', []);
  assert.equal(res.statusCode, 400);
});

test('an oversized batch is refused with the limit', async (t) => {
  const { app } = await appWith(t);

  const batch = Array.from({ length: MAX_BATCH + 1 }, (_, i) => notice({ id: `n${i}` }));
  const res = await post(app, '/api/widgets/notices', batch);

  assert.equal(res.statusCode, 413);
  assert.match(res.json().message, new RegExp(String(MAX_BATCH)));
});

test('a notice posted twice updates rather than duplicating', async (t) => {
  const { app } = await appWith(t);

  await post(app, '/api/widgets/notices', notice());
  await post(app, '/api/widgets/notices', notice({ title: 'Updated' }));

  const notices = (await get(app)).json().notices;
  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Updated');
});

// ── Read ──────────────────────────────────────────────────────────────────

test('GET returns notices soonest-first', async (t) => {
  const { app } = await appWith(t);

  await post(app, '/api/widgets/notices', [
    notice({ id: 'later', title: 'Later', due: '2026-09-05T00:00:00Z' }),
    notice({ id: 'sooner', title: 'Sooner', due: '2026-09-02T00:00:00Z' }),
  ]);

  assert.deepEqual(
    (await get(app)).json().notices.map((n) => n.title),
    ['Sooner', 'Later']
  );
});

test('GET is never cached — a dismissal must take effect on the next poll', async (t) => {
  const { app } = await appWith(t);
  const res = await get(app);
  assert.match(res.headers['cache-control'], /no-store/);
});

test('an empty board is a 200 with an empty list, not a 404', async (t) => {
  const { app } = await appWith(t);

  const res = await get(app);

  // "Nothing needs you" is good news the widget renders, not a failure.
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.deepEqual(res.json().notices, []);
});

test('an unconfigured Home Assistant yields a hint tile, not an error', async (t) => {
  const { app } = await appWith(t, {
    ha: { status: HA_STATUS.NOT_CONFIGURED, reason: 'missing_token', hint: 'Set HAVEN_HA_TOKEN.' },
  });

  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'not_configured');
  assert.match(res.json().hint, /HAVEN_HA_TOKEN/);
});

test('with notices from another source, an unconfigured HA is NOT reported', async (t) => {
  const { app } = await appWith(t, {
    ha: { status: HA_STATUS.NOT_CONFIGURED, reason: 'missing_token', hint: 'Set HAVEN_HA_TOKEN.' },
  });

  await post(app, '/api/widgets/notices', notice());
  const res = await get(app);

  // A hint about a source the user may not even want would be noise on top of
  // notices that are working fine.
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().notices.length, 1);
});

test('a stale Home Assistant read is a soft notice on real data', async (t) => {
  const { app } = await appWith(t, {
    ha: {
      status: HA_STATUS.OK,
      notices: [],
      stale: true,
      notice: 'Showing the last reading — Home Assistant is unreachable.',
    },
  });

  await post(app, '/api/widgets/notices', notice());
  const res = await get(app);

  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().notices.length, 1, 'the data still draws');
  assert.match(res.json().notice, /unreachable/);
});

test('a Home Assistant error does not stop stored notices being served', async (t) => {
  const { app } = await appWith(t, {
    ha: { status: HA_STATUS.ERROR, error: 'UPSTREAM_UNAVAILABLE' },
  });

  await post(app, '/api/widgets/notices', notice());
  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().notices.length, 1);
});

test('a connector that throws does not blank the tile', async (t) => {
  const { app } = await appWith(t, {
    ha: () => {
      throw new Error('boom');
    },
  });

  await post(app, '/api/widgets/notices', notice());
  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().notices.length, 1);
});

test('Home Assistant notices are ingested and appear in the list', async (t) => {
  const { app } = await appWith(t, {
    ha: {
      status: HA_STATUS.OK,
      notices: [
        {
          id: 'persistent_notification.backup_failed',
          severity: 'warn',
          title: 'Backup failed',
          source: 'home-assistant',
          actions: [
            {
              id: 'ha-dismiss',
              label: 'Dismiss in Home Assistant',
              service: 'persistent_notification/dismiss',
              data: { notification_id: 'backup_failed' },
            },
          ],
        },
      ],
    },
  });

  const notices = (await get(app)).json().notices;

  assert.equal(notices.length, 1);
  assert.equal(notices[0].title, 'Backup failed');
});

test('an action target NEVER appears in the GET payload', async (t) => {
  const { app } = await appWith(t);

  await post(
    app,
    '/api/widgets/notices',
    notice({
      actions: [{ id: 'open', label: 'Open', target: 'https://internal.invalid/secret-path' }],
    })
  );

  const body = (await get(app)).body;

  // The browser gets an opaque id; the backend resolves what it means.
  assert.ok(!body.includes('internal.invalid'), 'an internal URL reached the browser');
  assert.ok(!body.includes('secret-path'));
  assert.deepEqual(Object.keys((await get(app)).json().notices[0].actions[0]).sort(), [
    'dismisses',
    'id',
    'label',
  ]);
});

// ── Dismissal ─────────────────────────────────────────────────────────────

test('dismissing removes a notice from the next read, persistently', async (t) => {
  const { app } = await appWith(t);
  await post(app, '/api/widgets/notices', notice());

  const res = await post(app, '/api/widgets/notices/chores:bin-day/dismiss');

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dismissed, true);
  assert.deepEqual((await get(app)).json().notices, []);
});

test('a dismissal survives the source re-posting the same notice', async (t) => {
  const { app } = await appWith(t);
  await post(app, '/api/widgets/notices', notice());
  await post(app, '/api/widgets/notices/chores:bin-day/dismiss');

  await post(app, '/api/widgets/notices', notice());

  assert.deepEqual((await get(app)).json().notices, []);
});

test('dismissing an unknown notice is a 404', async (t) => {
  const { app } = await appWith(t);
  const res = await post(app, '/api/widgets/notices/chores:nothing/dismiss');
  assert.equal(res.statusCode, 404);
});

// ── Actions ───────────────────────────────────────────────────────────────

test('an action with no target records and dismisses without calling out', async (t) => {
  const { app, performed } = await appWith(t);
  await post(app, '/api/widgets/notices', notice({ actions: [{ id: 'done', label: 'Done' }] }));

  const res = await post(app, '/api/widgets/notices/chores:bin-day/actions/done');

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().dismissed, true);
  assert.deepEqual(performed, [], 'a "Done" button needs no upstream at all');
  assert.deepEqual((await get(app)).json().notices, []);
});

test('a Home Assistant action is performed server-side with the stored target', async (t) => {
  const { app, performed } = await appWith(t, {
    ha: {
      status: HA_STATUS.OK,
      notices: [
        {
          id: 'persistent_notification.backup_failed',
          title: 'Backup failed',
          source: 'home-assistant',
          actions: [
            {
              id: 'ha-dismiss',
              label: 'Dismiss in Home Assistant',
              service: 'persistent_notification/dismiss',
              data: { notification_id: 'backup_failed' },
            },
          ],
        },
      ],
    },
  });

  await get(app);
  const id = 'home-assistant:persistent_notification.backup_failed';
  const res = await post(app, `/api/widgets/notices/${id}/actions/ha-dismiss`);

  assert.equal(res.statusCode, 200);
  // The browser sent only the opaque action id; the service came from storage.
  assert.equal(performed.length, 1);
  assert.equal(performed[0].service, 'persistent_notification/dismiss');
  assert.deepEqual(performed[0].data, { notification_id: 'backup_failed' });
});

test('an unknown action id on a real notice is a 404', async (t) => {
  const { app } = await appWith(t);
  await post(app, '/api/widgets/notices', notice({ actions: [{ id: 'done', label: 'Done' }] }));

  const res = await post(app, '/api/widgets/notices/chores:bin-day/actions/nope');
  assert.equal(res.statusCode, 404);
});

test('an action on an unknown notice is a 404', async (t) => {
  const { app } = await appWith(t);
  const res = await post(app, '/api/widgets/notices/chores:nothing/actions/done');
  assert.equal(res.statusCode, 404);
});

test('a targeted action from a non-HA source is refused, not forwarded', async (t) => {
  const { app } = await appWith(t);

  await post(
    app,
    '/api/widgets/notices',
    notice({ actions: [{ id: 'go', label: 'Go', target: 'https://elsewhere.invalid/do' }] })
  );

  const res = await post(app, '/api/widgets/notices/chores:bin-day/actions/go');

  // Fetching an arbitrary stored target would make ingest a request forwarder.
  assert.equal(res.statusCode, 501);
  assert.equal(res.json().error, 'UNSUPPORTED_SOURCE');
});

test('an action that does not dismiss leaves the notice on the board', async (t) => {
  const { app } = await appWith(t);

  await post(
    app,
    '/api/widgets/notices',
    notice({ actions: [{ id: 'snooze', label: 'Snooze', dismisses: false }] })
  );

  const res = await post(app, '/api/widgets/notices/chores:bin-day/actions/snooze');

  assert.equal(res.json().dismissed, false);
  assert.equal((await get(app)).json().notices.length, 1);
});

test('a failing upstream action is reported rather than claiming success', async (t) => {
  const db = new Database(':memory:');
  migrate(db);

  const app = await buildServer({
    logger: false,
    db,
    widgets: {
      settings: { units: 'metric', latitude: 0, longitude: 0 },
      weatherConnector: {
        async get() {
          return { status: 'not_configured', reason: 'missing_api_key', hint: 'x' };
        },
      },
    },
    notices: {
      now: () => NOW,
      homeAssistantConnector: {
        async get() {
          return {
            status: HA_STATUS.OK,
            notices: [
              {
                id: 'persistent_notification.x',
                title: 'A thing',
                source: 'home-assistant',
                actions: [{ id: 'go', label: 'Go', service: 'a/b' }],
              },
            ],
          };
        },
        async perform() {
          return { status: HA_STATUS.ERROR, error: 'UPSTREAM_UNAVAILABLE', message: 'down' };
        },
      },
    },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });

  await get(app);
  const res = await post(
    app,
    '/api/widgets/notices/home-assistant:persistent_notification.x/actions/go'
  );

  // 502: the action was well-formed, the upstream failed. The widget must not
  // be told the button worked.
  assert.equal(res.statusCode, 502);
  assert.equal((await get(app)).json().notices.length, 1, 'and the notice stays');
});
