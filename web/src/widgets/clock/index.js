/**
 * Registration entry for the clock widget.
 *
 * A widget module exports one **definition** — its static metadata plus the
 * hooks the host needs before it ever instantiates the element: `dataSource`
 * to turn a config into a request, `getStubConfig` for insertion, and
 * `migrateConfig` for stored configs. `registry.register()` normalises and
 * freezes it, and validates `configSchema` there and then, so a malformed
 * schema fails at boot rather than mysteriously inside a form.
 */

import {
  CONFIG_VERSION,
  HavenClock,
  configSchema,
  dataSource,
  defineClock,
  getStubConfig,
  migrateConfig,
} from './clock.js';

export const TAG = 'haven-clock';

/** Everything the host needs to list, insert, migrate, fetch for and build a clock. */
export const definition = Object.freeze({
  type: 'clock',
  name: 'Clock',
  tag: TAG,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 1 },
  mobileSize: { w: 4, h: 2 },
  configSchema,
  configVersion: CONFIG_VERSION,
  // The host refetches on this cadence and pushes the result in via `onData`.
  // The widget itself never schedules anything.
  refreshMs: 1_000,
  searchable: true,
  dataSource,
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

export { HavenClock, dataSource, getStubConfig, migrateConfig };
