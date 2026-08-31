/**
 * The hero widget's registry entry.
 *
 * Separate from `element.js` for the same reason as the weather and greeting
 * definitions: this module touches no DOM, so the schema, the sizes and the
 * data source can be asserted in a plain Node test.
 */

export const HERO_WIDGET_TYPE = 'hero';
export const HERO_WIDGET_TAG = 'haven-widget-hero';

/** The endpoint. The browser learns nothing about upstream. */
export const HERO_ENDPOINT = '/api/widgets/hero';

/**
 * The fetcher key. One key for every hero on the board, so two heroes cost one
 * request rather than two.
 */
export const HERO_FETCH_KEY = 'hero';

/**
 * How often the HOST refetches the slide list.
 *
 * Ten minutes, and emphatically NOT the rotation interval. Which slides exist
 * changes when someone edits the registry — rarely; which slide is SHOWING
 * changes every few seconds. Conflating the two would mean either a hero that
 * never picks up an edit or an endpoint polled once a rotation.
 */
export const HERO_REFRESH_MS = 10 * 60 * 1000;

/** Bounds on the configurable rotation interval, in seconds. */
export const MIN_ROTATE_SECONDS = 3;
export const MAX_ROTATE_SECONDS = 120;
export const DEFAULT_ROTATE_SECONDS = 8;

export const heroWidget = {
  type: HERO_WIDGET_TYPE,
  name: 'Hero',
  tag: HERO_WIDGET_TAG,
  // A hero is a banner: wide and short. It is the one widget that looks wrong
  // at a square-ish default size.
  defaultSize: { w: 12, h: 3 },
  minSize: { w: 4, h: 2 },
  mobileSize: { w: 4, h: 3 },
  refreshMs: HERO_REFRESH_MS,
  searchable: true,
  configVersion: 1,
  configSchema: [
    {
      key: 'rotateSeconds',
      type: 'number',
      label: 'Seconds per slide',
      default: DEFAULT_ROTATE_SECONDS,
      min: MIN_ROTATE_SECONDS,
      max: MAX_ROTATE_SECONDS,
      help: 'Ignored when the system asks for reduced motion.',
    },
    {
      key: 'showTagline',
      type: 'select',
      label: 'Show taglines',
      default: true,
      options: [
        { value: true, label: 'Yes' },
        { value: false, label: 'No' },
      ],
    },
  ],
  /** "Add widget" must produce something that works immediately. */
  getStubConfig: () => ({
    rotateSeconds: DEFAULT_ROTATE_SECONDS,
    showTagline: true,
  }),
  /** How the host turns a config into a request. */
  dataSource: () => ({ key: HERO_FETCH_KEY, url: HERO_ENDPOINT }),
};
