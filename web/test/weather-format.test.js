import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  degrees,
  describe,
  formatTemp,
  iconUrl,
  staleness,
  weekday,
  windUnit,
} from '../src/widgets/weather/format.js';

test('each unit system gets its own degree symbol', () => {
  assert.equal(degrees('metric'), '°C');
  assert.equal(degrees('imperial'), '°F');
  assert.equal(degrees('standard'), 'K');
  assert.equal(degrees(undefined), '°C', 'an unknown unit system falls back to metric');
});

test('wind is mph for imperial and m/s otherwise', () => {
  assert.equal(windUnit('imperial'), 'mph');
  assert.equal(windUnit('metric'), 'm/s');
  assert.equal(windUnit('standard'), 'm/s');
});

test('temperatures render rounded, with the right symbol', () => {
  assert.equal(formatTemp(11.4, 'metric'), '11°C');
  assert.equal(formatTemp(11.6, 'metric'), '12°C');
  assert.equal(formatTemp(52.2, 'imperial'), '52°F');
  assert.equal(formatTemp(-3.2, 'metric'), '-3°C');
});

test('a temperature just below zero renders as 0, never as -0', () => {
  // Math.round(-0.4) is -0, and "-0°C" on a weather tile looks like a bug.
  assert.equal(formatTemp(-0.4, 'metric'), '0°C');
});

test('a missing temperature renders as a placeholder, never NaN', () => {
  // "NaN°C" on the tile is the failure this prevents.
  assert.equal(formatTemp(undefined, 'metric'), '--');
  assert.equal(formatTemp(null, 'metric'), '--');
  assert.equal(formatTemp(Number.NaN, 'metric'), '--');
  assert.equal(formatTemp('12', 'metric'), '--');
});

// ── weekday labels ───────────────────────────────────────────────────────

const now = Date.parse('2026-03-15T10:00:00Z');

test('today and tomorrow are named rather than given a weekday', () => {
  assert.equal(weekday('2026-03-15', { locale: 'en-GB', now }), 'Today');
  assert.equal(weekday('2026-03-16', { locale: 'en-GB', now }), 'Tomorrow');
});

test('other days get a short weekday in the browser locale', () => {
  assert.equal(weekday('2026-03-17', { locale: 'en-GB', now }), 'Tue');
  assert.equal(weekday('2026-03-18', { locale: 'en-GB', now }), 'Wed');
});

test('a weekday is computed from the date, not from the array position', () => {
  // 2026-03-19 is a Thursday. Getting this wrong by an off-by-one is the
  // classic forecast-labelling bug.
  assert.equal(weekday('2026-03-19', { locale: 'en-GB', now }), 'Thu');
});

test('a malformed date yields an empty label rather than "Invalid Date"', () => {
  assert.equal(weekday('not-a-date', { locale: 'en-GB', now }), '');
});

// ── icons ────────────────────────────────────────────────────────────────

test('icon URLs follow the documented OpenWeatherMap shape', () => {
  assert.equal(iconUrl('10d'), 'https://openweathermap.org/img/wn/10d@2x.png');
});

test('a missing icon yields null so no broken image renders', () => {
  assert.equal(iconUrl(null), null);
  assert.equal(iconUrl(undefined), null);
  assert.equal(iconUrl(''), null);
});

// ── staleness ────────────────────────────────────────────────────────────

test('staleness reads in coarse, human terms', () => {
  const at = Date.parse('2026-03-15T10:00:00Z');

  assert.equal(staleness(at, { now: at + 30_000 }), 'just now');
  assert.equal(staleness(at, { now: at + 5 * 60_000 }), '5 min ago');
  assert.equal(staleness(at, { now: at + 60 * 60_000 }), '1 hour ago');
  assert.equal(staleness(at, { now: at + 5 * 60 * 60_000 }), '5 hours ago');
  assert.equal(staleness(at, { now: at + 26 * 60 * 60_000 }), '1 day ago');
  assert.equal(staleness(at, { now: at + 72 * 60 * 60_000 }), '3 days ago');
});

test('staleness with no timestamp still reads as a sentence', () => {
  assert.equal(staleness(undefined), 'a while ago');
});

// ── descriptions ─────────────────────────────────────────────────────────

test('upstream descriptions are sentence-cased', () => {
  assert.equal(describe('light rain'), 'Light rain');
  assert.equal(describe('clear sky'), 'Clear sky');
});

test('a missing description yields an empty string, not "undefined"', () => {
  assert.equal(describe(undefined), '');
  assert.equal(describe(null), '');
  assert.equal(describe(''), '');
});
