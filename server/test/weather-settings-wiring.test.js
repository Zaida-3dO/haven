import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { buildServer } from '../src/server.js';

/**
 * The route must hand the weather connector `settings.weather`, not `settings`.
 *
 * This exists because it did the latter. The connector destructures
 * `latitude`/`longitude` straight off whatever `settings()` returns, and those
 * live under the `weather` key — so every deployment answered
 * `not_configured / missing_location` with a perfectly valid settings.json on
 * disk, and the hint told the user to set fields they had already set.
 *
 * Why 461 tests missed it: every existing weather test injects a STUBBED
 * connector (`widgets.weatherConnector`), which is the right call for testing
 * the route's behaviour — but it means nothing exercised the real wiring
 * between the two. A seam that every test stubs is a seam no test covers.
 *
 * So this deliberately does NOT stub the connector. It stubs the FETCH
 * instead, one layer further out, leaving the settings-to-connector wiring
 * real.
 */

const LOCATION = { latitude: 51.5, longitude: -0.12 };

/** Shaped exactly as `loadSettings()` returns it — nested under `weather`. */
const settingsObject = (weather = LOCATION) => ({
  version: 1,
  weather: { units: 'metric', locationName: 'Home', ...weather },
});

/**
 * Stand-ins for the two OpenWeatherMap endpoints the connector calls —
 * `/weather` and `/forecast`, in that order, in a Promise.all.
 */
const CURRENT = {
  main: { temp: 19, feels_like: 19, humidity: 82 },
  wind: { speed: 6.2 },
  weather: [{ description: 'overcast clouds', icon: '04d', main: 'Clouds' }],
};

const FORECAST = {
  list: Array.from({ length: 8 }, (_, i) => ({
    dt: 1_700_000_000 + i * 10_800,
    main: { temp: 12 + i, temp_min: 10, temp_max: 15 },
    weather: [{ description: 'cloudy', icon: '04d', main: 'Clouds' }],
  })),
};

const stubFetch = async (url) => ({
  ok: true,
  status: 200,
  async json() {
    return String(url).includes('/forecast') ? FORECAST : CURRENT;
  },
});

async function appWith(t, settings) {
  const db = new Database(':memory:');
  migrate(db);
  const app = await buildServer({
    logger: false,
    db,
    widgets: {
      settings,
      // The connector is REAL. Only the network is stubbed, so the wiring
      // this test exists for stays in the path.
      weatherOptions: { apiKey: () => 'test-key-0000000000000000000000', fetchFn: stubFetch },
    },
  });
  t.after(async () => {
    await app.close();
    db.close();
  });
  return app;
}

test('a configured location reaches the connector — not "missing_location"', async (t) => {
  const app = await appWith(t, settingsObject());

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/weather' })).json();

  // The wiring is the whole point, so the assertion is about the wiring: the
  // connector must have SEEN the coordinates. Whether the upstream call then
  // succeeds is the connector's own business and is covered by weather.test.js
  // — asserting 'ok' here would only couple this test to a stub shape it does
  // not care about.
  assert.notEqual(
    body.reason,
    'missing_location',
    'the route handed the connector the wrong slice of settings'
  );
  assert.notEqual(body.status, 'not_configured');
});

test('a genuinely absent location still reports missing_location', async (t) => {
  // The guard must still fire when it should — a fix that just stops the
  // check running would pass the test above and break a fresh install.
  const app = await appWith(t, settingsObject({ latitude: undefined, longitude: undefined }));

  const body = (await app.inject({ method: 'GET', url: '/api/widgets/weather' })).json();

  assert.equal(body.status, 'not_configured');
  assert.equal(body.reason, 'missing_location');
});
