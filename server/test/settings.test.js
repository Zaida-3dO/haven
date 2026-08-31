import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadSettings, SETTINGS_DEFAULTS } from '../src/settings.js';

/** Writes `content` to a throwaway settings file and returns its path. */
function settingsFile(t, content) {
  const dir = mkdtempSync(join(tmpdir(), 'haven-settings-'));
  const path = join(dir, 'settings.json');
  writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return path;
}

test('a missing settings file yields defaults rather than throwing', () => {
  const settings = loadSettings({ path: join(tmpdir(), 'haven-does-not-exist-12345.json') });

  assert.equal(settings.weather.units, SETTINGS_DEFAULTS.weather.units);
  assert.equal(settings.weather.latitude, null);
});

test('a malformed settings file is warned about and falls back to defaults', (t) => {
  const path = settingsFile(t, '{ not json');
  const warnings = [];

  const settings = loadSettings({ path, logger: { warn: (...args) => warnings.push(args) } });

  assert.equal(settings.weather.units, 'metric');
  assert.equal(warnings.length, 1, 'a typo must be reported, not silently swallowed');
});

test('a valid file is read through', (t) => {
  const path = settingsFile(t, {
    version: 1,
    weather: { units: 'imperial', locationName: 'Testville', latitude: 12.5, longitude: -3.25 },
  });

  const { weather } = loadSettings({ path });

  assert.equal(weather.units, 'imperial');
  assert.equal(weather.locationName, 'Testville');
  assert.equal(weather.latitude, 12.5);
  assert.equal(weather.longitude, -3.25);
});

test('an unknown unit system falls back to metric', (t) => {
  const path = settingsFile(t, { weather: { units: 'kelvinish' } });

  assert.equal(loadSettings({ path }).weather.units, 'metric');
});

// A half-configured or out-of-range location must not be forwarded upstream,
// where it comes back as a confusing 400 rather than a "set your location" hint.
for (const [description, weather] of [
  ['a latitude with no longitude', { latitude: 51.5 }],
  ['a longitude with no latitude', { longitude: -0.12 }],
  ['string coordinates', { latitude: '51.5', longitude: '-0.12' }],
  ['a latitude past the pole', { latitude: 91, longitude: 0 }],
  ['a longitude past the date line', { latitude: 0, longitude: 181 }],
  ['NaN coordinates', { latitude: Number.NaN, longitude: Number.NaN }],
]) {
  test(`${description} is rejected as unconfigured`, (t) => {
    const path = settingsFile(t, { weather });

    const loaded = loadSettings({ path }).weather;

    assert.equal(loaded.latitude, null, description);
    assert.equal(loaded.longitude, null, description);
  });
}

test('coordinates of exactly zero are accepted, not treated as missing', (t) => {
  // 0,0 is a real coordinate. Rejecting it because it is falsy is the classic
  // bug this asserts against.
  const path = settingsFile(t, { weather: { latitude: 0, longitude: 0 } });

  const { weather } = loadSettings({ path });

  assert.equal(weather.latitude, 0);
  assert.equal(weather.longitude, 0);
});

test('a blank location name normalises to null', (t) => {
  const path = settingsFile(t, { weather: { locationName: '   ' } });

  assert.equal(loadSettings({ path }).weather.locationName, null);
});

test('a settings file that is not an object falls back to defaults', (t) => {
  const path = settingsFile(t, '["not", "an", "object"]');

  assert.equal(loadSettings({ path }).weather.units, 'metric');
});

test('the shipped example config loads cleanly and reads as unconfigured', () => {
  // The example is what a new install copies, so it must survive the loader —
  // and it must NOT ship a location, or a user who copies it verbatim gets the
  // weather for null island in the Atlantic instead of a "set your location"
  // hint. That is why the example uses null rather than 0.0.
  const settings = loadSettings({
    path: new URL('../../config/settings.example.json', import.meta.url).pathname,
  });

  assert.equal(settings.weather.units, 'metric');
  assert.equal(settings.weather.latitude, null, 'the example must not ship a location');
  assert.equal(settings.weather.longitude, null);
});
