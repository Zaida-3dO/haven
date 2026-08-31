/**
 * The notices widget's registry entry.
 *
 * Deliberately separate from `element.js`, following the weather widget: this
 * module touches no DOM and extends no `HTMLElement`, so the definition — the
 * schema, the sizes, the data source — can be imported and asserted in a plain
 * Node test.
 */

export const NOTICES_WIDGET_TYPE = 'notices';
export const NOTICES_WIDGET_TAG = 'haven-widget-notices';

/** The endpoint. The browser learns nothing about any upstream source. */
export const NOTICES_ENDPOINT = '/api/widgets/notices';

/** The dedup key. A second notices tile costs no extra request. */
export const NOTICES_FETCH_KEY = 'notices';

/**
 * How often the HOST refetches.
 *
 * A minute, matching the server's Home Assistant cache: the tile picks up a
 * new alert promptly without the poll outrunning the data behind it. Notices
 * are the one widget where being a few minutes stale actually matters — the
 * point of the tile is that something needs you now.
 */
export const NOTICES_REFRESH_MS = 60 * 1000;

export const noticesWidget = {
  type: NOTICES_WIDGET_TYPE,
  name: 'Notices',
  tag: NOTICES_WIDGET_TAG,
  defaultSize: { w: 4, h: 4 },
  minSize: { w: 3, h: 2 },
  // Full width on mobile: a notice is a line of prose, and a two-column phone
  // layout would wrap every title.
  mobileSize: { w: 4, h: 4 },
  refreshMs: NOTICES_REFRESH_MS,
  /**
   * Notices go into the global index. The index is IN-MEMORY ONLY — it holds
   * alert contents, which are the most personal data on the dashboard — and
   * `shell/search-index.js` has a tripwire test enforcing that.
   */
  searchable: true,
  configVersion: 1,
  configSchema: [
    {
      key: 'maxItems',
      type: 'number',
      label: 'Most notices to show',
      default: 8,
    },
    {
      key: 'minSeverity',
      type: 'select',
      label: 'Show notices at least this urgent',
      default: 'info',
      options: [
        { value: 'info', label: 'Everything' },
        { value: 'warn', label: 'Warnings and above' },
        { value: 'urgent', label: 'Urgent only' },
      ],
    },
    {
      key: 'showSource',
      type: 'select',
      label: 'Show which source sent each notice',
      default: false,
      options: [
        { value: true, label: 'Yes' },
        { value: false, label: 'No' },
      ],
    },
  ],
  /** "Add widget" must produce something that works immediately. */
  getStubConfig: () => ({ maxItems: 8, minSeverity: 'info', showSource: false }),
  /** How the host turns a config into a request. */
  dataSource: () => ({ key: NOTICES_FETCH_KEY, url: NOTICES_ENDPOINT }),
};
