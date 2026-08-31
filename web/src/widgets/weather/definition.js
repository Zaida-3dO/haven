/**
 * The weather widget's registry entry.
 *
 * Deliberately separate from `element.js`: this module touches no DOM and
 * extends no `HTMLElement`, so the definition — the schema, the sizes, the
 * data source — can be imported and asserted in a plain Node test. A
 * definition bundled with its custom element could only be tested in a
 * browser, and the contract details worth testing all live here.
 */

export const WEATHER_WIDGET_TYPE = 'weather';
export const WEATHER_WIDGET_TAG = 'haven-widget-weather';

/** The endpoint. The browser never learns anything about upstream. */
export const WEATHER_ENDPOINT = '/api/widgets/weather';

/**
 * The fetcher key shared with the greeting widget.
 *
 * Both widgets read the same weather, so they request it under one key and the
 * fetcher collapses them into a single call. Having both on the board costs
 * one request, not two.
 */
export const WEATHER_FETCH_KEY = 'weather';

/**
 * How often the HOST refetches. Five minutes against a thirty-minute server
 * cache: the tile picks up a new reading promptly, while upstream is still
 * called at most twice an hour however many browsers are open.
 */
export const WEATHER_REFRESH_MS = 5 * 60 * 1000;

export const weatherWidget = {
  type: WEATHER_WIDGET_TYPE,
  name: 'Weather',
  tag: WEATHER_WIDGET_TAG,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 3, h: 3 },
  mobileSize: { w: 4, h: 3 },
  refreshMs: WEATHER_REFRESH_MS,
  searchable: false,
  configVersion: 1,
  configSchema: [
    {
      key: 'showForecast',
      type: 'select',
      label: 'Show the 4-day forecast',
      default: true,
      options: [
        { value: true, label: 'Yes' },
        { value: false, label: 'No' },
      ],
    },
  ],
  /** "Add widget" must produce something that works immediately. */
  getStubConfig: () => ({ showForecast: true }),
  /** How the host turns a config into a request. */
  dataSource: () => ({ key: WEATHER_FETCH_KEY, url: WEATHER_ENDPOINT }),
};
