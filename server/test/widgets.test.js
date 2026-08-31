import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';
import { STATUS } from '../src/connectors/weather.js';

/**
 * The route is driven through `app.inject()` with a stubbed connector, so no
 * test here needs a key, a settings file or the network. The connector's own
 * behaviour is covered in weather.test.js; what these assert is the HTTP
 * contract the widget depends on.
 */
async function appWith(t, weatherResult) {
  const db = new Database(':memory:');
  migrate(db);

  const calls = [];
  const app = await buildServer({
    logger: false,
    db,
    widgets: {
      // A fixed settings object, so the real config/settings.json on the
      // machine running the tests is never read.
      settings: { units: 'metric', locationName: 'Testville', latitude: 0, longitude: 0 },
      weatherConnector: {
        async get(options) {
          calls.push(options);
          return typeof weatherResult === 'function' ? weatherResult() : weatherResult;
        },
      },
    },
  });

  t.after(async () => {
    await app.close();
    db.close();
  });

  return { app, calls };
}

const get = (app, url = '/api/widgets/weather') => app.inject({ method: 'GET', url });

const okResult = {
  status: STATUS.OK,
  stale: false,
  expiresIn: 30 * 60 * 1000,
  cachedAt: 1_700_000_000_000,
  data: {
    units: 'metric',
    location: 'Testville',
    current: { temp: 11, description: 'light rain', icon: '10d', conditionId: 500 },
    forecast: [{ date: '2026-03-02', min: 8, max: 14, temp: 11, icon: '01d' }],
  },
};

test('GET /api/widgets/weather returns the connector payload', async (t) => {
  const { app } = await appWith(t, okResult);

  const res = await get(app);

  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ok');
  assert.equal(res.json().data.current.temp, 11);
  assert.equal(res.json().data.forecast.length, 1);
});

test('a fresh response carries a cache-control matching the server cache', async (t) => {
  const { app } = await appWith(t, okResult);

  const res = await get(app);

  assert.match(res.headers['cache-control'], /max-age=1800/);
  assert.match(res.headers['cache-control'], /private/);
});

test('an unconfigured connector answers 200, not an error', async (t) => {
  const { app } = await appWith(t, {
    status: STATUS.NOT_CONFIGURED,
    reason: 'missing_api_key',
    hint: 'Set HAVEN_OPENWEATHER_API_KEY in the environment to enable weather.',
  });

  const res = await get(app);

  assert.equal(res.statusCode, 200, 'not configured is a state to render, not a failure');
  assert.equal(res.json().status, 'not_configured');
  assert.match(res.json().hint, /HAVEN_OPENWEATHER_API_KEY/);
  assert.equal(res.headers['cache-control'], 'no-store', 'so fixing it takes effect at once');
});

test('stale data answers 200 with its marker, not an error status', async (t) => {
  const { app } = await appWith(t, {
    ...okResult,
    stale: true,
    notice: 'Showing the last good reading — the weather service is unreachable.',
  });

  const res = await get(app);

  assert.equal(res.statusCode, 200, 'a soft notice is not a hard error');
  assert.equal(res.json().stale, true);
  assert.match(res.json().notice, /unreachable/i);
  assert.equal(res.headers['cache-control'], 'no-store', 'stale data must not be cached further');
});

test('an unrecoverable upstream failure answers 503', async (t) => {
  const { app } = await appWith(t, {
    status: STATUS.ERROR,
    error: 'UPSTREAM_UNAVAILABLE',
    message: 'OpenWeatherMap responded 500',
  });

  const res = await get(app);

  assert.equal(res.statusCode, 503, 'the weather service is down, Haven is not');
  assert.equal(res.json().error, 'UPSTREAM_UNAVAILABLE');
});

test('?force=true is passed through to the connector', async (t) => {
  const { app, calls } = await appWith(t, okResult);

  await get(app);
  await get(app, '/api/widgets/weather?force=true');

  assert.deepEqual(
    calls.map((c) => c.force),
    [false, true]
  );
});

test('the weather route does not disturb the rest of the API', async (t) => {
  const { app } = await appWith(t, okResult);

  const health = await app.inject({ method: 'GET', url: '/api/health' });
  const layout = await app.inject({ method: 'GET', url: '/api/layout' });

  assert.equal(health.statusCode, 200);
  assert.equal(layout.statusCode, 200);
});
