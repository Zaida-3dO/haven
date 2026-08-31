/**
 * Registration entry for the calendar widget.
 *
 * Follows the same shape as the other widgets: the module exports a frozen
 * `definition` (static metadata plus the hooks the host needs before it ever
 * instantiates the element) and a `register()` that defines the custom
 * element. Defining happens here rather than at import time so a test can
 * import the definition without touching a custom-element registry.
 */

import {
  CALENDAR_REFRESH_MS,
  CALENDAR_WIDGET_TAG,
  CalendarWidget,
  calendarConfigSchema,
  calendarDataSource,
  calendarStubConfig,
} from './calendar-widget.js';

export const TAG = CALENDAR_WIDGET_TAG;

/** Everything the host needs to list, insert and build a calendar. */
export const definition = Object.freeze({
  type: 'calendar',
  name: 'Calendar',
  tag: TAG,
  defaultSize: { w: 3, h: 4 },
  minSize: { w: 2, h: 2 },
  mobileSize: { w: 4, h: 4 },
  configSchema: calendarConfigSchema,
  configVersion: 1,
  // The HOST refetches on this interval — the widget owns no timer. Calendars
  // change slowly, and the connector caches harder still behind this.
  refreshMs: CALENDAR_REFRESH_MS,
  searchable: true,
  getStubConfig: calendarStubConfig,
  // Describes the request; the shell performs it. Every calendar instance
  // shares one cache key, so two tiles make one backend call.
  dataSource: calendarDataSource,
});

export function register(registry) {
  if (globalThis.customElements && !globalThis.customElements.get(TAG)) {
    globalThis.customElements.define(TAG, CalendarWidget);
  }
  return registry.register(definition);
}

export { CalendarWidget, calendarStubConfig };
