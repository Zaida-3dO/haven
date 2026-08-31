/**
 * The greeting widget's registry entry.
 *
 * Separate from `element.js` for the same reason as the weather widget's: this
 * module touches no DOM, so the schema, the sizes and the data source can be
 * asserted in a plain Node test.
 */

import { WEATHER_ENDPOINT, WEATHER_FETCH_KEY } from '../weather/definition.js';

export const GREETING_WIDGET_TYPE = 'greeting';
export const GREETING_WIDGET_TAG = 'haven-widget-greeting';

/**
 * How often the HOST refetches the weather for this widget.
 *
 * This is emphatically NOT the clock's tick. The clock is driven by the shared
 * `clockTicker` in `clock.js`, because the time changes every second while the
 * weather changes every half hour — two different rates, and conflating them
 * would mean either a frozen clock or a pointlessly hammered endpoint.
 */
export const GREETING_REFRESH_MS = 5 * 60 * 1000;

export const greetingWidget = {
  type: GREETING_WIDGET_TYPE,
  name: 'Greeting & clock',
  tag: GREETING_WIDGET_TAG,
  defaultSize: { w: 4, h: 2 },
  minSize: { w: 3, h: 2 },
  mobileSize: { w: 4, h: 2 },
  refreshMs: GREETING_REFRESH_MS,
  searchable: false,
  configVersion: 1,
  configSchema: [
    {
      key: 'name',
      type: 'text',
      label: 'Name to greet',
      required: false,
    },
    {
      key: 'showSeconds',
      type: 'select',
      label: 'Show seconds',
      default: false,
      options: [
        { value: true, label: 'Yes' },
        { value: false, label: 'No' },
      ],
    },
  ],
  getStubConfig: () => ({ showSeconds: false }),
  /**
   * The same endpoint and the SAME KEY as the weather widget, so the fetcher
   * collapses both widgets into one request rather than two.
   */
  dataSource: () => ({ key: WEATHER_FETCH_KEY, url: WEATHER_ENDPOINT }),
};
