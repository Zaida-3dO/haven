import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BANDS,
  PHRASES,
  bandFor,
  greetingFor,
  moodFor,
  phraseFor,
  toCelsius,
} from '../src/widgets/greeting/phrases.js';

/** Deterministic phrase choice, so a random greeting is still assertable. */
const first = (candidates) => candidates[0];
const at = (hour, minute = 0) => new Date(2026, 2, 15, hour, minute, 0);

// ── time bands ───────────────────────────────────────────────────────────

for (const [hour, expected] of [
  [5, 'morning'],
  [8, 'morning'],
  [11, 'morning'],
  [12, 'afternoon'],
  [16, 'afternoon'],
  [17, 'evening'],
  [21, 'evening'],
  [22, 'night'],
  [23, 'night'],
  [0, 'night'],
  [3, 'night'],
  [4, 'night'],
]) {
  test(`${String(hour).padStart(2, '0')}:00 is ${expected}`, () => {
    assert.equal(bandFor(hour).id, expected);
  });
}

test('the night band wraps past midnight rather than leaving a gap', () => {
  // Every hour must land in the RIGHT band. Asserting only that some band
  // comes back is not enough: `bandFor` ends with a fallback `return`, so a
  // broken wrap still returns night for 23:00 while silently misfiling 02:00.
  const expected = {
    morning: [5, 6, 7, 8, 9, 10, 11],
    afternoon: [12, 13, 14, 15, 16],
    evening: [17, 18, 19, 20, 21],
    night: [22, 23, 0, 1, 2, 3, 4],
  };

  const actual = { morning: [], afternoon: [], evening: [], night: [] };
  for (let hour = 0; hour < 24; hour += 1) {
    actual[bandFor(hour).id].push(hour);
  }

  for (const band of BANDS) {
    assert.deepEqual(
      actual[band.id].sort((a, b) => a - b),
      expected[band.id].sort((a, b) => a - b),
      `${band.id} covers the wrong hours`
    );
  }
});

test('the small hours are night, not the fallback band', () => {
  // 02:00 is the hour a non-wrapping band check gets wrong: it falls through
  // every range and lands on `bandFor`'s trailing fallback. That the fallback
  // happens to BE night is a coincidence this asserts against by checking an
  // hour where the two differ in behaviour.
  for (const hour of [22, 23, 0, 1, 2, 3, 4]) {
    assert.equal(bandFor(hour).id, 'night', `${hour}:00 must be night`);
  }
  // ...and the hour either side must not be.
  assert.equal(bandFor(21).id, 'evening');
  assert.equal(bandFor(5).id, 'morning');
});

// ── weather moods ────────────────────────────────────────────────────────

for (const [conditionId, expected] of [
  [200, 'thunder'],
  [232, 'thunder'],
  [300, 'rain'],
  [500, 'rain'],
  [531, 'rain'],
  [600, 'snow'],
  [622, 'snow'],
  [701, 'fog'],
  [781, 'fog'],
  [800, 'clear'],
  [801, 'cloudy'],
  [804, 'cloudy'],
]) {
  test(`condition ${conditionId} reads as ${expected}`, () => {
    assert.equal(moodFor({ conditionId, temperatureC: 15 }), expected);
  });
}

test('a dramatic sky beats an extreme temperature', () => {
  // Snow at -5 should say snow, not "freezing" — snow is the thing you would
  // actually mention.
  assert.equal(moodFor({ conditionId: 600, temperatureC: -5 }), 'snow');
});

test('an extreme temperature beats a bland sky', () => {
  assert.equal(moodFor({ conditionId: 800, temperatureC: -3 }), 'freezing');
  assert.equal(moodFor({ conditionId: 801, temperatureC: 30 }), 'hot');
  assert.equal(moodFor({ conditionId: 800, temperatureC: 5 }), 'cold');
});

test('a mild bland sky keeps its own mood', () => {
  assert.equal(moodFor({ conditionId: 800, temperatureC: 18 }), 'clear');
  assert.equal(moodFor({ conditionId: 803, temperatureC: 18 }), 'cloudy');
});

test('no usable weather yields no mood', () => {
  assert.equal(moodFor({}), null);
  assert.equal(moodFor({ conditionId: null, temperatureC: null }), null);
});

// ── unit conversion, so the thresholds mean one thing ────────────────────

test('temperatures convert to Celsius before the thresholds are applied', () => {
  assert.equal(Math.round(toCelsius(32, 'imperial')), 0);
  assert.equal(Math.round(toCelsius(212, 'imperial')), 100);
  assert.equal(Math.round(toCelsius(273.15, 'standard')), 0);
  assert.equal(toCelsius(20, 'metric'), 20);
  assert.equal(toCelsius(null, 'metric'), null);
});

test('a freezing day in Fahrenheit is still recognised as freezing', () => {
  // 30F is below zero Celsius. Reading it as 30 degrees "hot" is the bug.
  const { mood } = greetingFor({
    date: at(8),
    weather: { conditionId: 800, temp: 30, units: 'imperial' },
    pick: first,
  });

  assert.equal(mood, 'freezing');
});

// ── the greeting itself ──────────────────────────────────────────────────

test('a morning with rain gets the grim-out phrasing', () => {
  const { band, mood, text } = greetingFor({
    date: at(8),
    weather: { conditionId: 500, temp: 11, units: 'metric' },
    pick: first,
  });

  assert.equal(band, 'morning');
  assert.equal(mood, 'rain');
  assert.equal(text, PHRASES.morning.rain[0]);
});

test('every band and mood combination has a line', () => {
  // A missing line is the failure this catches: it would silently fall back
  // to the weather-less phrasing and quietly drop the weather adaptation.
  const moods = ['clear', 'rain', 'thunder', 'snow', 'fog', 'cloudy', 'freezing', 'cold', 'hot'];

  for (const band of BANDS) {
    assert.ok(PHRASES[band.id]?.null?.length, `${band.id} has no weather-less line`);
    for (const mood of moods) {
      assert.ok(PHRASES[band.id][mood]?.length > 0, `${band.id} has no line for ${mood}`);
    }
  }
});

// ── the degraded path, which is the one that has to be right ─────────────

test('with no weather at all the greeting falls back to time-only phrasing', () => {
  const { band, mood, text } = greetingFor({ date: at(8), weather: null, pick: first });

  assert.equal(band, 'morning');
  assert.equal(mood, null, 'no weather means no mood, not a guessed one');
  assert.equal(text, PHRASES.morning.null[0]);
});

test('every band degrades to a real phrase with no weather', () => {
  for (const hour of [8, 14, 19, 23]) {
    const { text } = greetingFor({ date: at(hour), weather: null, pick: first });
    assert.ok(typeof text === 'string' && text.length > 0, `hour ${hour} produced no greeting`);
  }
});

test('an unknown mood falls back to the weather-less line rather than throwing', () => {
  // Adding a mood to MOODS without adding lines must degrade, not crash.
  const text = phraseFor({ band: 'morning', mood: 'meteor-shower', pick: first });

  assert.equal(text, PHRASES.morning.null[0]);
});

test('an unknown band falls back rather than throwing', () => {
  assert.ok(phraseFor({ band: 'brunch', mood: null, pick: first }).length > 0);
});

test('phrasing is picked from the band-and-mood list, not a global one', () => {
  // Asserting the LAST candidate proves the pick really indexes the right
  // list rather than always returning something plausible.
  const last = (candidates) => candidates[candidates.length - 1];

  assert.equal(
    phraseFor({ band: 'night', mood: 'rain', pick: last }),
    PHRASES.night.rain[PHRASES.night.rain.length - 1]
  );
});

test('the random picker stays inside the candidate list', () => {
  // No injected pick: this exercises the real Math.random path.
  for (let i = 0; i < 50; i += 1) {
    const { text } = greetingFor({
      date: at(8),
      weather: { conditionId: 500, temp: 11, units: 'metric' },
    });
    assert.ok(PHRASES.morning.rain.includes(text), `"${text}" is not a morning rain line`);
  }
});
