/**
 * `config/settings.json` — non-secret preferences.
 *
 * Secrets live in the environment (see `config.js`); this file holds the
 * things it is safe to read out of a JSON file that a human edits, such as
 * units and the location to show weather for. The repo ships
 * `config/settings.example.json` and gitignores the real one, so the file is
 * routinely ABSENT — every read here falls back to a default rather than
 * throwing, because a missing preferences file is a normal state, not an error.
 *
 * See docs/CONFIGURATION.md and docs/SECURITY.md.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** `server/src` -> repo root -> `config/settings.json`. */
export const DEFAULT_SETTINGS_PATH =
  process.env.HAVEN_SETTINGS_PATH ?? resolve(here, '../../config/settings.json');

/**
 * Defaults for everything Haven reads. Deliberately neutral: no real
 * coordinates and no place name belong in a public repo, so an unconfigured
 * install gets null island and renders a "not configured" hint rather than
 * quietly showing the weather somewhere the user does not live.
 */
export const SETTINGS_DEFAULTS = Object.freeze({
  version: 1,
  weather: Object.freeze({
    units: 'metric',
    locationName: null,
    latitude: null,
    longitude: null,
  }),
});

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** OpenWeatherMap's three unit systems; anything else falls back to metric. */
const UNITS = ['standard', 'metric', 'imperial'];

/**
 * Normalise the weather block.
 *
 * Latitude and longitude are only accepted as a genuine pair of in-range
 * numbers. A half-configured location (lat but no lon, or a string "51.5")
 * would otherwise be sent upstream and come back as a confusing 400.
 */
function normaliseWeather(raw = {}) {
  const latitude = num(raw.latitude);
  const longitude = num(raw.longitude);

  const inRange =
    latitude !== null &&
    longitude !== null &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180;

  return {
    units: UNITS.includes(raw.units) ? raw.units : SETTINGS_DEFAULTS.weather.units,
    locationName:
      typeof raw.locationName === 'string' && raw.locationName.trim() !== ''
        ? raw.locationName.trim()
        : null,
    latitude: inRange ? latitude : null,
    longitude: inRange ? longitude : null,
  };
}

/**
 * Read and normalise the settings file.
 *
 * A missing file is not an error. A malformed one is logged and then treated
 * as missing: a typo in a preferences file must not stop the dashboard
 * booting, because the alternative is a server that will not start until
 * someone SSHes in to fix a comma.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] file to read; defaults to `config/settings.json`
 * @param {object} [opts.logger] Fastify-style logger
 */
export function loadSettings({ path = DEFAULT_SETTINGS_PATH, logger } = {}) {
  let raw = {};

  try {
    const text = readFileSync(path, 'utf8');
    const parsed = JSON.parse(text);
    if (isPlainObject(parsed)) {
      raw = parsed;
    } else {
      logger?.warn?.({ path }, 'settings.json is not an object — using defaults');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Malformed JSON, bad permissions: say so loudly, then carry on.
      logger?.warn?.({ path, err: error }, 'could not read settings.json — using defaults');
    }
  }

  return {
    version: Number.isInteger(raw.version) ? raw.version : SETTINGS_DEFAULTS.version,
    weather: normaliseWeather(isPlainObject(raw.weather) ? raw.weather : {}),
  };
}
