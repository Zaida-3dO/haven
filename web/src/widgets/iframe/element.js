/**
 * The iframe / embed widget.
 *
 * First use: the 3D home preview, deployed standalone and embedded
 * cross-origin, a scene that is already driven by a tablet dashboard too.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THIS WIDGET IS THE REASON THE DIFF-AND-PATCH RULE EXISTS
 *
 * Every other widget re-rendering its subtree on a data tick is wasteful.
 * This one re-rendering its subtree is *destructive*: replacing the `<iframe>`
 * element reloads the embedded document, which throws away the WebGL context,
 * the loaded geometry, the camera position, and any state the page held. A
 * once-a-minute refresh elsewhere on the dashboard would make the 3D house
 * flicker back to its start position forever.
 *
 * So the invariant, stated as bluntly as it can be: **the `<iframe>` element
 * is created exactly once per config, and every later update patches it.**
 * `iframe-element.test.js` holds a reference to the element across an
 * `onData` and asserts identity, because a comment cannot enforce this.
 *
 * The same reasoning forbids touching `src` or `sandbox` on an already-loaded
 * frame: assigning either reloads the document even if the value is unchanged.
 * Both are therefore written only when their value actually differs.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * The other two things this widget must get right, both documented at their
 * call sites below: it participates in the grid's pointer-events shim rather
 * than reimplementing it, and it forwards geometry into the frame on resize so
 * an embedded renderer can resize its drawing buffer.
 */

import { EmbedUrlError, defeatsSandbox, parseEmbedUrl, sandboxTokens } from './embed-url.js';
import { postGeometry } from './geometry.js';

/**
 * Resolved at module load, exactly as `clock.js` does it and for the same
 * reason: `extends HTMLElement` would throw at import time under `node --test`,
 * making the widget untestable without a DOM emulator.
 */
const ElementBase = globalThis.HTMLElement ?? class {};

const STYLES = `
  :host { display: block; height: 100%; }
  .embed { position: relative; height: 100%; display: flex; flex-direction: column; }
  .embed__frame { flex: 1 1 auto; width: 100%; height: 100%; border: 0; display: block; }
  .embed__frame[hidden] { display: none; }
  .embed__placeholder { flex: 1 1 auto; display: flex; align-items: center;
                        justify-content: center; font-size: 0.8rem; opacity: 0.6; }
  .embed__warning { font-size: 0.7rem; padding: 0.25rem 0.5rem; opacity: 0.85; }
  .embed__error { padding: 0.5rem; font-size: 0.8rem; }
  .embed__error pre { overflow: auto; font-size: 0.7rem; opacity: 0.8; }
`;

export class HavenIframe extends ElementBase {
  #config = null;
  #origConfig = null;
  #data = null;
  #shadow;
  #nodes = null;
  /** The `src` currently on the frame — the guard against a needless reload. */
  #currentSrc = null;
  #currentSandbox = null;
  #pendingSrc = null;
  #cells = { w: 4, h: 4 };
  #visible = false;
  #observer = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  /**
   * Validates and **throws** on bad config, per the contract.
   *
   * The host has already applied `configSchema`, so the only check left is the
   * one a flat schema cannot express: that the URL is one of the allowed
   * schemes. That check is a security boundary, not a nicety — see
   * `embed-url.js`.
   */
  setConfig(config) {
    this.#origConfig = config;

    // Throws EmbedUrlError on javascript:, data:, or anything unparseable.
    // The host catches it and renders the fallback tile with this config
    // preserved, so a mistyped URL can be fixed rather than only deleted.
    this.#pendingSrc = parseEmbedUrl(config?.url);

    this.#config = config;
    this.render();
    return this.#config;
  }

  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  /** The live frame, for tests asserting it is not re-created. */
  get frame() {
    return this.#nodes?.frame ?? null;
  }

  /** Whether a document has actually been pointed at yet (lazy-load state). */
  get loaded() {
    return this.#currentSrc !== null;
  }

  /**
   * Data from the host.
   *
   * The iframe declares no `dataSource`, so in normal operation this is never
   * called. It is implemented anyway, and implemented so that it **cannot**
   * rebuild the frame, because the identity invariant has to hold even if a
   * future config gives this widget a data source — and because that is
   * exactly the regression the test suite pins.
   */
  onData(data) {
    this.#data = data;
    // Deliberately does NOT rebuild. `render()` patches; it never replaces the
    // frame. See the header comment.
    this.render();
  }

  /**
   * Grid cells changed — the hook the whole WebGL story hangs off.
   *
   * `grid.js` fires this from `resizestop` with the final geometry, so the
   * message goes out once per resize rather than on every drag tick. Inside
   * the frame, a scene listens for `haven:resize` and calls
   * `renderer.setSize()` + `camera.updateProjectionMatrix()`. Without this the
   * canvas keeps its load-time buffer and renders stretched.
   */
  onResize(w, h) {
    this.#cells = { w, h };
    this.render();
    // After render, so a frame that has just become visible is addressed with
    // the src it now carries rather than the one it had a moment ago.
    this.#forwardGeometry();
  }

  #forwardGeometry() {
    const frame = this.#nodes?.frame;
    if (!frame) return false;

    // Real pixels where the DOM can give them; the cell count always rides
    // along so a frame can respond even in a layout that reports zero.
    const rect = frame.getBoundingClientRect?.();
    return postGeometry(frame, {
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      cells: this.#cells,
    });
  }

  /**
   * Called when the widget scrolls into view.
   *
   * Lazy loading is the point: a dashboard with three embeds should not load
   * three documents (and, for the 3D home, three WebGL contexts — browsers cap
   * those at around 16 and start discarding the oldest) before you have looked
   * at any of them.
   *
   * Observing visibility is not a timer and not a poll, so it does not run
   * foul of the contract's ban on widget-owned `setInterval`.
   */
  show() {
    if (this.#visible) return false;
    this.#visible = true;
    this.render();
    return true;
  }

  connectedCallback() {
    this.#observe();
  }

  disconnectedCallback() {
    this.#observer?.disconnect?.();
    this.#observer = null;
  }

  #observe() {
    const Observer = globalThis.IntersectionObserver;
    if (!Observer || this.#observer) return;
    this.#observer = new Observer((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        this.show();
        this.#observer?.disconnect?.();
        this.#observer = null;
      }
    });
    this.#observer.observe(this);
  }

  render() {
    if (!this.#config) return;

    if (this.#data?.state === 'error') {
      this.#renderError(this.#data.errors?.[0]?.message ?? 'Embed unavailable');
      return;
    }

    const nodes = this.#ensureScaffold();

    // The sandbox warning is visible, not buried in a doc: a user who opted
    // into allow-same-origin alongside allow-scripts has turned the sandbox
    // off, and should be able to see that from the tile.
    const unsandboxed = defeatsSandbox(this.#config);
    nodes.warning.hidden = !unsandboxed;
    if (unsandboxed) {
      setText(nodes.warning, 'Sandbox off: this embed runs with the dashboard permissions.');
    }

    // Lazy: the frame exists but carries no `src` until the widget is visible,
    // so no document is fetched and no WebGL context is created.
    if (!this.#visible) {
      nodes.frame.hidden = true;
      nodes.placeholder.hidden = false;
      setText(nodes.placeholder, this.#config.title || 'Embed');
      return;
    }

    nodes.placeholder.hidden = true;
    nodes.frame.hidden = false;

    // ── The identity invariant in code ──────────────────────────────────
    // Both of these reload the frame when assigned, so both are written only
    // when the value actually differs. An unconditional assignment here would
    // reload the 3D scene on every render, which is the exact bug this whole
    // widget is written around.
    const sandbox = sandboxTokens(this.#config);
    if (sandbox !== this.#currentSandbox) {
      nodes.frame.setAttribute('sandbox', sandbox);
      this.#currentSandbox = sandbox;
    }

    if (this.#pendingSrc !== this.#currentSrc) {
      nodes.frame.setAttribute('src', this.#pendingSrc);
      this.#currentSrc = this.#pendingSrc;
    }
    // ────────────────────────────────────────────────────────────────────

    const scrolling = this.#config.scroll === 'no' ? 'hidden' : 'auto';
    if (nodes.frame.style.overflow !== scrolling) nodes.frame.style.overflow = scrolling;

    const title = this.#config.title || 'Embedded page';
    if (nodes.frame.getAttribute('title') !== title) nodes.frame.setAttribute('title', title);
  }

  /**
   * Builds the DOM once. Every later render patches it.
   *
   * The `<iframe>` created here is the element whose identity the test suite
   * pins: it is created on the first render with a config and never again.
   */
  #ensureScaffold() {
    if (this.#nodes) return this.#nodes;

    const style = document.createElement('style');
    style.textContent = STYLES;

    const embed = document.createElement('div');
    embed.className = 'embed';

    const warning = document.createElement('p');
    warning.className = 'embed__warning';
    warning.hidden = true;

    const placeholder = document.createElement('div');
    placeholder.className = 'embed__placeholder';

    const frame = document.createElement('iframe');
    frame.className = 'embed__frame';
    // Belt and braces with the observer: a browser that supports it will not
    // fetch an offscreen frame even if the observer never fires.
    frame.setAttribute('loading', 'lazy');
    // No referrer to a third-party embed; it would leak the dashboard URL.
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.hidden = true;
    // The shim in `grid.js` finds frames with `root.querySelectorAll('iframe')`
    // and sets `pointer-events: none` for the duration of a drag or resize,
    // restoring whatever was there before. This widget therefore does NOT
    // manage pointer events itself — dragging over an iframe otherwise stops
    // mid-drag, and reimplementing the fix per widget is how it drifts.
    frame.addEventListener?.('load', () => this.#forwardGeometry());

    embed.append(warning, placeholder, frame);
    this.#shadow.replaceChildren(style, embed);

    this.#nodes = { embed, warning, placeholder, frame };
    return this.#nodes;
  }

  #renderError(message) {
    const box = document.createElement('div');
    box.className = 'embed__error';

    const heading = document.createElement('strong');
    heading.textContent = 'Embed unavailable';

    const detail = document.createElement('p');
    // textContent, never innerHTML — the message quotes a config value.
    detail.textContent = message;

    const dump = document.createElement('pre');
    dump.textContent = JSON.stringify(this.#origConfig ?? {}, null, 2);

    box.append(heading, detail, dump);

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.#shadow.replaceChildren(style, box);

    // The frame is gone, so the next good render rebuilds it — and must
    // therefore re-apply src and sandbox.
    this.#nodes = null;
    this.#currentSrc = null;
    this.#currentSandbox = null;
  }

  /** The embed's title, so an embedded page is findable by name. */
  getSearchEntries() {
    if (!this.#config?.title) return [];
    return [
      {
        id: `iframe:${this.id || this.#config.title}`,
        title: this.#config.title,
        subtitle: 'Embedded page',
        url: this.id ? `#${this.id}` : '',
        keywords: ['embed', 'iframe'],
      },
    ];
  }

  destroy() {
    this.#observer?.disconnect?.();
    this.#observer = null;
    this.#config = null;
    this.#data = null;
    this.#nodes = null;
    this.#currentSrc = null;
    this.#currentSandbox = null;
  }
}

function setText(node, value) {
  const next = value ?? '';
  if (node.textContent !== next) node.textContent = next;
}

export function defineIframeWidget(tag = 'haven-widget-iframe') {
  if (!globalThis.customElements?.get(tag)) {
    globalThis.customElements?.define(tag, HavenIframe);
  }
  return tag;
}

export { EmbedUrlError };
