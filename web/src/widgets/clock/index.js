/**
 * Registration entry for the clock widget.
 *
 * A widget module exports one **definition** — its static metadata plus the
 * hooks the host needs before it ever instantiates the element:
 * `getStubConfig` for insertion and `migrateConfig` for stored configs.
 * `registry.register()` normalises and freezes it, and validates
 * `configSchema` there and then, so a malformed schema fails at boot rather
 * than mysteriously inside a form.
 *
 * This one declares no `dataSource`, which is explained at length in
 * `clock.js` — the short version is that the time is pushed in by a
 * host-owned scheduler task rather than fetched over HTTP.
 */

import {
  CONFIG_VERSION,
  HavenClock,
  configSchema,
  defineClock,
  getStubConfig,
  migrateConfig,
} from './clock.js';

export const TAG = 'haven-clock';

/** Everything the host needs to list, insert, migrate and build a clock. */
export const definition = Object.freeze({
  type: 'clock',
  name: 'Clock',
  tag: TAG,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 1 },
  mobileSize: { w: 4, h: 2 },
  configSchema,
  configVersion: CONFIG_VERSION,
  // No `refreshMs` and no `dataSource`: the clock has nothing to fetch. Its
  // time is pushed in by a host-owned scheduler task (`shell/clock-source.js`)
  // so the widget still owns no timer. See the note in clock.js.
  refreshMs: null,
  searchable: true,
  getStubConfig,
  migrateConfig,
});

/**
 * Registers the clock and defines its custom element.
 *
 * Defining the element is done here rather than at import time so a test can
 * import the definition without touching a custom-element registry.
 */
export function register(registry) {
  defineClock(TAG);
  return registry.register(definition);
}

export { HavenClock, getStubConfig, migrateConfig };
