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

import {
  EmbedUrlError,
  SANDBOX_NOTICE,
  defeatsSandbox,
  parseEmbedUrl,
  sandboxTokens,
} from './embed-url.js';
import { postGeometry } from './geometry.js';

/**
 * Resolved at module load, exactly as `clock.js` does it and for the same
 * reason: `extends HTMLElement` would throw at import time under `node --test`,
 * making the widget untestable without a DOM emulator.
 */
const ElementBase = globalThis.HTMLElement ?? class {};

const STYLES = `
  :host { display: block; height: 100%; }
  /* "position: relative" here is load-bearing for ".embed__warning" below:
   * that badge is "position: absolute", so it needs SOME positioned ancestor
   * to anchor to, and this is the only candidate in the shadow tree. Drop this
   * declaration while tidying and the badge falls back to the initial
   * containing block and clips silently under the host card's
   * "overflow: hidden" instead of sitting on the tile. See
   * "iframe-element.test.js" — "the badge's offset parent is the embed
   * container, not the initial containing block" pins this and is asserted to
   * fail if this rule is removed. */
  .embed { position: relative; height: 100%; display: flex; flex-direction: column; }
  .embed__frame { flex: 1 1 auto; width: 100%; height: 100%; border: 0; display: block; }
  .embed__frame[hidden] { display: none; }
  .embed__placeholder { flex: 1 1 auto; display: flex; align-items: center;
                        justify-content: center; font-size: 0.8rem; opacity: 0.6; }
  /* The sandbox disclosure is a corner badge, not a line of body text.
   *
   * It is positioned OUT of the flex flow deliberately. As body text it was a
   * 24.8px paragraph inside a 200px card body — 12% of the embed's height,
   * spent on a notice — which both squeezed the frame and read as content the
   * user had chosen to put on their dashboard. Absolute positioning means the
   * frame gets the whole card and the disclosure still sits on the tile. */
  .embed__warning {
    position: absolute;
    top: 0.25rem;
    right: 0.25rem;
    z-index: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 1.15rem;
    height: 1.15rem;
    padding: 0;
    border: 0;
    border-radius: 50%;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    font: inherit;
    font-size: 0.7rem;
    font-weight: 700;
    line-height: 1;
    cursor: pointer;
  }
  /* The button itself is the positioned ancestor for ".embed__warning-text"
   * below (its own "position: absolute" sits relative to this, the same
   * dependency ".embed" has on ".embed__warning" — see the comment on
   * ".embed" above). */
  .embed__warning[hidden] { display: none; }
  /* dfdf5e42 — the sentence was "title"-only, so it existed only on hover,
   * which is unreachable by keyboard and by touch. It is now a real
   * <button>, reachable by Tab like any other control, and its text is a
   * sibling revealed on hover OR focus, not just hover — and toggled by
   * click, which is what actually gets a touch user to it (a title tooltip
   * never fires on a touchscreen at all). "title"/"aria-label" stay as the
   * accessible name so nothing regresses for a screen reader. */
  .embed__warning:focus-visible {
    outline: 2px solid #fff;
    outline-offset: 2px;
  }
  .embed__warning-glyph {
    pointer-events: none;
  }
  .embed__warning-text {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 0.35rem;
    z-index: 1;
    max-width: 14rem;
    padding: 0.4rem 0.55rem;
    border-radius: 0.35rem;
    background: rgba(0, 0, 0, 0.85);
    color: #fff;
    font-size: 0.7rem;
    line-height: 1.35;
    white-space: normal;
    pointer-events: none;
  }
  .embed__warning-text[hidden] { display: none; }
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
  /** Whether the sandbox disclosure's text sibling is currently shown. */
  #warningRevealed = false;

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

    // ── The sandbox disclosure ──────────────────────────────────────────
    //
    // Still SURFACED, deliberately relocated. A user who opted into
    // allow-same-origin alongside allow-scripts has turned the sandbox off,
    // and "I ticked a box and silently lost all isolation" is not an
    // acceptable outcome — so this must never become invisible.
    //
    // What changed is WHERE, not WHETHER. It was a paragraph of body text
    // inside the card, which put a security notice on the dashboard as though
    // it were content and cost 24.8px of a 200px card body. It is now a badge
    // in the tile's corner whose accessible name carries the full sentence,
    // and the same disclosure is repeated as help text on the
    // `allowSameOrigin` field in the widget's settings panel — next to the
    // control that grants it, which is where someone deciding about the grant
    // is actually looking.
    //
    // The accessible name is the full sentence, not the glyph: a screen
    // reader must get the disclosure, not the word "exclamation mark".
    //
    // dfdf5e42: it used to be `title`-only, which is hover-only — unreachable
    // by keyboard and by touch (a title tooltip never fires on a
    // touchscreen). It is now a real `<button>`, so Tab reaches it like any
    // other control, and clicking or pressing it toggles a visible text
    // sibling rather than relying on a tooltip. Click-to-reveal was chosen
    // over hover/focus-only reveal because it is the one mechanism that also
    // works for a touch user, who has no hover and no keyboard.
    const unsandboxed = defeatsSandbox(this.#config);
    nodes.warning.hidden = !unsandboxed;
    if (!unsandboxed) {
      this.#warningRevealed = false;
      nodes.warningText.hidden = true;
    }
    if (unsandboxed) {
      setText(nodes.warningGlyph, '!');
      if (nodes.warning.getAttribute('title') !== SANDBOX_NOTICE) {
        nodes.warning.setAttribute('title', SANDBOX_NOTICE);
        nodes.warning.setAttribute('aria-label', SANDBOX_NOTICE);
      }
      setText(nodes.warningText, SANDBOX_NOTICE);
      nodes.warningText.hidden = !this.#warningRevealed;
      nodes.warning.setAttribute('aria-expanded', String(this.#warningRevealed));
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

  /** Click handler: flips the revealed text sibling, for touch and mouse alike. */
  #toggleWarning() {
    this.#setWarningRevealed(!this.#warningRevealed);
  }

  /**
   * Shows or hides the sandbox disclosure's text sibling and keeps
   * `aria-expanded` in sync. Called on click (toggle) and on focus/blur
   * (always-reveal-while-focused), so a keyboard user tabbing to the badge
   * sees the same sentence a mouse user gets by clicking.
   */
  #setWarningRevealed(revealed) {
    this.#warningRevealed = revealed;
    if (this.#nodes?.warningText) this.#nodes.warningText.hidden = !revealed;
    this.#nodes?.warning?.setAttribute('aria-expanded', String(revealed));
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

    // A real `<button>`, not a `<span role="note">`: the badge must be
    // reachable by Tab and activatable by Enter/Space, which only a
    // genuinely focusable, genuinely interactive element gets for free. The
    // accessible name is still the full sentence (via `title`/`aria-label`
    // below), so a screen reader gets the disclosure whether or not it is
    // visually revealed — `aria-expanded` additionally tells it whether the
    // visible-text sibling is currently shown.
    const warning = document.createElement('button');
    warning.type = 'button';
    warning.className = 'embed__warning';
    warning.setAttribute('aria-expanded', 'false');
    warning.hidden = true;
    warning.addEventListener('click', () => this.#toggleWarning());
    // Keyboard reveal without a click: focusing the badge (Tab) reveals the
    // text too, so a keyboard user does not additionally have to press
    // Enter just to read a sentence that is already the accessible name —
    // this only affects the VISIBLE text sibling, not activation.
    warning.addEventListener('focus', () => this.#setWarningRevealed(true));
    warning.addEventListener('blur', () => this.#setWarningRevealed(false));

    const warningGlyph = document.createElement('span');
    warningGlyph.className = 'embed__warning-glyph';
    warningGlyph.setAttribute('aria-hidden', 'true');
    warning.appendChild(warningGlyph);

    // The revealed sentence. A sibling rather than the button's own text
    // content so the glyph can stay the compact corner badge while this
    // renders as a full-width tooltip-like panel beneath it when shown.
    const warningText = document.createElement('span');
    warningText.className = 'embed__warning-text';
    warningText.hidden = true;
    warning.appendChild(warningText);

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

    this.#nodes = { embed, warning, warningGlyph, warningText, placeholder, frame };
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
    this.#warningRevealed = false;
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

export { EmbedUrlError, STYLES };
