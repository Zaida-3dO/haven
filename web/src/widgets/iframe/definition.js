/**
 * The iframe widget's registry entry.
 *
 * Separate from `element.js` for the reason `weather/definition.js` is: this
 * module touches no DOM and extends no `HTMLElement`, so the schema, the
 * sizes and the version can be asserted in a plain Node test.
 */

import { DEFAULT_SANDBOX } from './embed-url.js';

export const IFRAME_WIDGET_TYPE = 'iframe';
export const IFRAME_WIDGET_TAG = 'haven-widget-iframe';

/**
 * The 3D home preview, the first consumer.
 *
 * A **relative path** on purpose. The 3D home is served from Haven's own
 * origin, so a relative URL is what actually works — and, just as important,
 * an absolute one would be an internal hostname, which must never be committed
 * to a public repo (CLAUDE.md, "no network topology").
 */
export const HOME_3D_URL = '/home3d.html?preview=true';

export const iframeWidget = {
  type: IFRAME_WIDGET_TYPE,
  name: 'Embed',
  tag: IFRAME_WIDGET_TAG,
  defaultSize: { w: 6, h: 5 },
  minSize: { w: 2, h: 2 },
  mobileSize: { w: 4, h: 4 },
  /**
   * No `dataSource` and `refreshMs: null` — an embed has nothing to fetch on
   * the dashboard's behalf; the framed document does its own loading. This is
   * also the strongest possible statement of the identity invariant: a widget
   * the host never pushes data to is a widget the host cannot make reload.
   */
  refreshMs: null,
  searchable: true,
  configVersion: 1,
  configSchema: [
    {
      /**
       * `text`, not `url`, and that needs justifying because it looks like the
       * wrong type.
       *
       * The shell's `url` field validates with `new URL(value)` and **no
       * base**, so it accepts only absolute URLs. A relative path — which is
       * what the first consumer uses, and the only form an internal address
       * can take in a public repo — would be rejected as "must be a valid
       * URL". Declaring `url` here would make the default config invalid.
       *
       * So the field is `text` and the real validation is `parseEmbedUrl` in
       * `setConfig`, which is *stricter* than the schema's check anyway: it
       * enforces an http/https/relative allowlist, where `new URL` happily
       * accepts `javascript:`. Widening the shell's `url` type to take a base
       * would be the tidier fix, but it is another crew's file and a change
       * every existing `url` field would have to be re-checked against.
       */
      key: 'url',
      type: 'text',
      label: 'Page URL',
      required: true,
      default: HOME_3D_URL,
    },
    {
      key: 'title',
      type: 'text',
      label: 'Title',
      default: 'Embed',
    },
    {
      key: 'scroll',
      type: 'select',
      label: 'Allow scrolling',
      default: 'yes',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      key: 'allowForms',
      type: 'select',
      label: 'Allow forms',
      default: 'no',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      key: 'allowPopups',
      type: 'select',
      label: 'Allow pop-ups',
      default: 'no',
      options: [
        { value: 'yes', label: 'Yes' },
        { value: 'no', label: 'No' },
      ],
    },
    {
      /**
       * The dangerous one, and the label says so.
       *
       * `allow-same-origin` together with the default `allow-scripts` is
       * equivalent to no sandbox at all for a same-origin page: the framed
       * document keeps its real origin and its scripts can reach the
       * dashboard's DOM and storage. It is off by default and offered as an
       * explicit opt-in — see the long note in `embed-url.js`.
       */
      key: 'allowSameOrigin',
      type: 'select',
      label: 'Allow same-origin access (turns the sandbox off)',
      default: 'no',
      options: [
        { value: 'no', label: 'No — keep the embed sandboxed' },
        { value: 'yes', label: 'Yes — the embed can read this dashboard' },
      ],
    },
  ],
  /** "Add widget" must produce something that works immediately. */
  getStubConfig: () => ({
    url: HOME_3D_URL,
    title: '3D home',
    scroll: 'no',
    allowForms: 'no',
    allowPopups: 'no',
    allowSameOrigin: 'no',
  }),
};

export { DEFAULT_SANDBOX };
