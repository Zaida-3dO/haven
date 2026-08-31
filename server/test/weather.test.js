import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWeatherConnector,
  shapeWeather,
  summariseForecast,
  STATUS,
} from '../src/connectors/weather.js';

/**
 * Every test here runs against a stubbed transport and a fake clock. Nothing
 * in this file touches the network or needs an API key — the key used below is
 * an obvious fake, and one of the tests exists specifically to prove no key
 * ever reaches the response body.
 */
const FAKE_KEY = 'test-key-not-a-real-credential';

/** Two coordinates that are deliberately not anywhere anyone lives. */
const LOCATION = { latitude: 0, longitude: 0, units: 'metric', locationName: 'Testville' };

const currentFixture = {
  name: 'Upstream Name',
  main: { temp: 11.4, feels_like: 9.8, humidity: 81 },
  wind: { speed: 5.2 },
  weather: [{ id: 500, description: 'light rain', icon: '10d' }],
  sys: { sunrise: 1_700_000_000, sunset: 1_700_040_000 },
};

/** Three-hourly slots across four distinct days, as OWM returns them. */
function forecastFixture(startMs) {
  const list = [];
  for (let day = 0; day < 5; day += 1) {
    for (let slot = 0; slot < 8; slot += 1) {
      list.push({
        dt: Math.floor((startMs + day * 86_400_000 + slot * 3 * 3_600_000) / 1000),
        main: { temp: 10 + day + slot * 0.5 },
        weather: [{ id: 800, description: 'clear sky', icon: slot < 2 ? '01n' : '01d' }],
      });
    }
  }
  return { list };
}

/**
 * A transport that answers both endpoints from fixtures and counts calls.
 * `fail` flips it to throwing, which is how the stale path is exercised.
 */
function stubTransport({ now }) {
  const stub = {
    calls: [],
    fail: false,
    status: 200,
    async fetch(url) {
      stub.calls.push(url);
      if (stub.fail) throw new Error('network down');
      if (stub.status !== 200) {
        return {
          ok: false,
          status: stub.status,
          async json() {
            return {};
          },
        };
      }
      const body = url.includes('/forecast') ? forecastFixture(now()) : currentFixture;
      return {
        ok: true,
        status: 200,
        async json() {
          return body;
        },
      };
    },
  };
  return stub;
}

/** A connector wired to a stub, with a clock the test advances by hand. */
function harness({ key = FAKE_KEY, settings = LOCATION, ...overrides } = {}) {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const stub = stubTransport({ now });

  const connector = createWeatherConnector({
    apiKey: () => key,
    settings: () => settings,
    transport: (url, options) => stub.fetch(url, options),
    now,
    ...overrides,
  });

  return { connector, stub, advance: (ms) => (clock += ms), now };
}

// ── not configured ───────────────────────────────────────────────────────

test('no API key returns not_configured rather than an error', async () => {
  const { connector, stub } = harness({ key: null });

  const result = await connector.get();

  assert.equal(result.status, STATUS.NOT_CONFIGURED);
  assert.equal(result.reason, 'missing_api_key');
  assert.match(result.hint, /HAVEN_OPENWEATHER_API_KEY/);
  assert.equal(stub.calls.length, 0, 'must not call upstream without a key');
});

test('no location returns not_configured and names the setting to fix', async () => {
  const { connector, stub } = harness({ settings: { units: 'metric' } });

  const result = await connector.get();

  assert.equal(result.status, STATUS.NOT_CONFIGURED);
  assert.equal(result.reason, 'missing_location');
  assert.match(result.hint, /settings\.json/);
  assert.equal(stub.calls.length, 0);
});

test('a half-configured location is treated as unconfigured, not sent upstream', async () => {
  const { connector, stub } = harness({ settings: { latitude: 12, units: 'metric' } });

  assert.equal((await connector.get()).status, STATUS.NOT_CONFIGURED);
  assert.equal(stub.calls.length, 0);
});

// ── the happy path ───────────────────────────────────────────────────────

test('returns current conditions and a 4-day forecast', async () => {
  const { connector } = harness();

  const result = await connector.get();

  assert.equal(result.status, STATUS.OK);
  assert.equal(result.stale, false);
  assert.equal(result.data.current.temp, 11, 'temperature is rounded');
  assert.equal(result.data.current.description, 'light rain');
  assert.equal(result.data.current.conditionId, 500);
  assert.equal(result.data.forecast.length, 4, 'exactly four forecast days');
  assert.equal(result.data.location, 'Testville', 'the configured name wins');
});

test('both upstream endpoints are called, and only those', async () => {
  const { connector, stub } = harness();

  await connector.get();

  assert.equal(stub.calls.length, 2);
  assert.ok(stub.calls.some((u) => u.includes('/weather?')));
  assert.ok(stub.calls.some((u) => u.includes('/forecast?')));
});

// ── the security property this whole connector exists for ────────────────

test('the API key never appears anywhere in the response', async () => {
  const { connector, stub } = harness();

  const result = await connector.get();

  // The key must be on the wire to upstream...
  assert.ok(
    stub.calls.every((url) => url.includes(`appid=${FAKE_KEY}`)),
    'the key is sent upstream'
  );
  // ...and must not be in anything we hand back to a browser.
  assert.ok(
    !JSON.stringify(result).includes(FAKE_KEY),
    'the key must never reach the browser — this is the reason the backend exists'
  );
});

test('an upstream error message names the status but never the URL', async () => {
  const { connector, stub } = harness();
  stub.status = 401;

  const result = await connector.get();

  assert.equal(result.status, STATUS.ERROR);
  assert.match(result.message, /401/);
  assert.ok(
    !JSON.stringify(result).includes(FAKE_KEY),
    'the upstream URL carries the key, so it must not be echoed'
  );
});

// ── the shared 30-minute cache ───────────────────────────────────────────

test('a second call inside the TTL is served from cache, not upstream', async () => {
  const { connector, stub, advance } = harness();

  await connector.get();
  advance(29 * 60 * 1000);
  const second = await connector.get();

  assert.equal(stub.calls.length, 2, 'still just the one pair of upstream calls');
  assert.equal(second.status, STATUS.OK);
  assert.ok(second.expiresIn > 0);
});

test('the cache expires after 30 minutes', async () => {
  const { connector, stub, advance } = harness();

  await connector.get();
  advance(30 * 60 * 1000 + 1);
  await connector.get();

  assert.equal(stub.calls.length, 4, 'a second pair of upstream calls after the TTL');
});

test('the cache is shared across callers rather than per-browser', async () => {
  const { connector, stub } = harness();

  // Two "browsers" hitting the endpoint at the same moment.
  const [a, b] = await Promise.all([connector.get(), connector.get()]);

  assert.equal(stub.calls.length, 2, 'concurrent callers share one upstream fetch');
  assert.deepEqual(a.data, b.data);
});

test('force bypasses the cache', async () => {
  const { connector, stub } = harness();

  await connector.get();
  await connector.get({ force: true });

  assert.equal(stub.calls.length, 4);
});

// ── soft notice vs hard error ────────────────────────────────────────────

test('an upstream failure over a warm cache is a stale notice, not an error', async () => {
  const { connector, stub, advance } = harness();

  const fresh = await connector.get();
  advance(31 * 60 * 1000);
  stub.fail = true;

  const result = await connector.get();

  assert.equal(result.status, STATUS.OK, 'stale data is still a success');
  assert.equal(result.stale, true);
  assert.match(result.notice, /unreachable/i);
  assert.deepEqual(result.data, fresh.data, 'the last good reading is what is served');
});

test('an upstream failure with an empty cache is a hard error', async () => {
  const { connector, stub } = harness();
  stub.fail = true;

  const result = await connector.get();

  assert.equal(result.status, STATUS.ERROR);
  assert.equal(result.error, 'UPSTREAM_UNAVAILABLE');
  assert.equal(result.data, undefined);
});

test('cached data too old to be useful becomes an error rather than a notice', async () => {
  const { connector, stub, advance } = harness({ staleMaxMs: 60 * 60 * 1000 });

  await connector.get();
  advance(2 * 60 * 60 * 1000);
  stub.fail = true;

  const result = await connector.get();

  assert.equal(result.status, STATUS.ERROR, 'day-old weather is not worth showing');
});

test('the cache recovers once upstream comes back', async () => {
  const { connector, stub, advance } = harness();

  await connector.get();
  advance(31 * 60 * 1000);
  stub.fail = true;
  assert.equal((await connector.get()).stale, true);

  advance(1000);
  stub.fail = false;
  const recovered = await connector.get();

  assert.equal(recovered.stale, false, 'a recovered upstream clears the staleness marker');
});

// ── forecast summarising ─────────────────────────────────────────────────

test('summariseForecast skips today and returns at most four days', () => {
  const start = Date.parse('2026-03-01T00:00:00Z');
  const days = summariseForecast(forecastFixture(start).list, { now: start });

  assert.equal(days.length, 4);
  assert.ok(
    days.every((d) => d.date !== '2026-03-01'),
    'today is covered by current conditions'
  );
  assert.deepEqual(
    days.map((d) => d.date),
    ['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05'],
    'days come back in chronological order'
  );
});

test('a day summary carries min, max and the most frequent icon', () => {
  const start = Date.parse('2026-03-01T00:00:00Z');
  const [day] = summariseForecast(forecastFixture(start).list, { now: start });

  assert.ok(day.min <= day.temp && day.temp <= day.max);
  // Six of eight slots are '01d', two are '01n' — the majority must win.
  assert.equal(day.icon, '01d');
});

test('summariseForecast tolerates malformed slots rather than throwing', () => {
  const start = Date.parse('2026-03-01T00:00:00Z');
  const list = [
    null,
    { dt: null },
    { dt: 1, main: null, weather: [] },
    ...forecastFixture(start).list,
  ];

  assert.equal(summariseForecast(list, { now: start }).length, 4);
});

test('shapeWeather passes through only the fields the widget renders', () => {
  const shaped = shapeWeather(
    { ...currentFixture, id: 2_643_743, coord: { lat: 51.5, lon: -0.12 } },
    { list: [] },
    { units: 'metric', locationName: 'Testville', now: 0 }
  );

  const serialised = JSON.stringify(shaped);
  assert.ok(!serialised.includes('2643743'), 'the upstream station id is not forwarded');
  assert.ok(!serialised.includes('coord'), 'precise coordinates are not forwarded');
});
