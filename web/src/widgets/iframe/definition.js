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
 * An **absolute, public HTTPS URL**, which is a reversal worth explaining
 * because the previous comment here argued the opposite.
 *
 * This used to be the relative path `/home3d.html?preview=true`, on the
 * reasoning that the 3D home was served from Haven's own origin and that any
 * absolute form would be an internal hostname — which must never be committed
 * to a public repo. Both halves of that have stopped being true: Haven does
 * not serve `home3d.html` at all (the tile rendered an empty frame), and the
 * 3D home is now deployed standalone at a **public** hostname. A public host
 * carries no network topology, so committing it is not the thing the rule
 * forbids.
 *
 * The consequence is that this is now a genuine **cross-origin** embed. That
 * is fine here, and deliberately so: the frame keeps the default
 * `allow-scripts`-only sandbox, and the 3D scene is self-contained WebGL that
 * needs no storage, so it works under an opaque origin. See `embed-url.js`.
 */
export const HOME_3D_URL = 'https://3dhome.3dojoda.com/';

/**
 * The same 3D home, in its **non-interactive preview mode** — what the sidebar
 * tile embeds.
 *
 * `?preview=true` is a route the 3D home already implements, not something
 * Haven asks it for by convention. On that flag it builds the scene with
 * `interactive: false` and `autoRotate: true`, passes no `onRoomClick`, and
 * hides its own chrome — the back button, the title overlay, the room tooltip,
 * the panel, and `.top-right-btns`, which is the **controls button**. It also
 * tunes itself for a tile: 15fps, `pixelRatio` 1, low shadows, no antialiasing.
 *
 * **Why this is a separate constant rather than a `?preview=true` on
 * `HOME_3D_URL`.** `HOME_3D_URL` is also the `default` of the iframe widget's
 * `url` config field below, i.e. the starting value for a widget a *user* adds
 * by hand. There, interactivity is the right default — someone who deliberately
 * embeds the 3D home on the board wants to click a room. Only the sidebar
 * instance is an ambient readout, so only the sidebar instance is pinned to
 * preview.
 *
 * Historical note: the pre-hosting relative default was
 * `/home3d.html?preview=true`. The `?preview=true` was dropped when the URL
 * became absolute, which is why the sidebar tile has been showing the full
 * interactive app — including the controls button — ever since.
 */
export const HOME_3D_PREVIEW_URL = `${HOME_3D_URL}?preview=true`;

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
       * base**, so it accepts only absolute URLs. The default is now absolute
       * and would pass that check — but a relative path is still a supported
       * and documented value for this field (any page Haven serves itself),
       * and declaring `url` here would reject every one of them as "must be a
       * valid URL".
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
