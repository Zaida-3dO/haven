/**
 * The hero widget's custom element.
 *
 * A rotating banner for the top of the dashboard (DESIGN §6.1). Slides are
 * APP-LINKED by default — click one and it opens the app — with a free-form
 * `image` slide type alongside. DESIGN §6.1 left that as an open question and
 * recommended app-linked; clicking through to something is more useful than a
 * decorative carousel, so that is what this builds.
 *
 * Three rules from docs/WIDGET-CONTRACT.md shape the whole file:
 *
 *   THIS WIDGET OWNS NO TIMER. A carousel is the second most tempting
 *   `setInterval` in a dashboard after a clock. It subscribes to a shared
 *   ticker instead — see `rotation.js` for why the host's data path cannot
 *   drive a rotation on its own.
 *
 *   IT FETCHES NOTHING. The slide list arrives through `onData` from the
 *   host's fetcher, under a key shared by every hero on the board.
 *
 *   IT DIFFS AND PATCHES. The slide image is the expensive node here:
 *   rebuilding the subtree on every rotation would re-request the image and
 *   flash the banner. The scaffold is built once and each rotation swaps
 *   attributes.
 *
 * And one that is not from the contract but matters just as much:
 * `prefers-reduced-motion` disables BOTH the auto-rotation and the crossfade.
 * That setting is a request not to be shown moving content, and an auto-playing
 * banner is the clearest possible case of it. Manual navigation still works —
 * reduced motion means "do not move on your own", not "do not function".
 */

import { slidesFrom, step, shouldAutoRotate, APP_SLIDE } from './slides.js';
import { subscribeRotation } from './rotation.js';
import { DEFAULT_ROTATE_SECONDS, MAX_ROTATE_SECONDS, MIN_ROTATE_SECONDS } from './definition.js';

const ElementBase = globalThis.HTMLElement ?? class {};

const STYLES = `
  :host { display: block; height: 100%; container-type: inline-size; }
  .hero { position: relative; height: 100%; overflow: hidden; border-radius: 0.5rem;
          background: #1b1d21; color: #fff; }
  .hero__slide { position: absolute; inset: 0; display: flex; flex-direction: column;
                 justify-content: flex-end; gap: 0.25rem; padding: 1rem 1.25rem;
                 text-decoration: none; color: inherit;
                 transition: opacity 400ms ease; }
  .hero__img { position: absolute; inset: 0; width: 100%; height: 100%;
               object-fit: cover; z-index: 0; }
  .hero__scrim { position: absolute; inset: 0; z-index: 1;
                 background: linear-gradient(transparent 30%, rgba(0, 0, 0, 0.75)); }
  .hero__text { position: relative; z-index: 2; }
  .hero__title { font-size: clamp(1.1rem, 4cqw, 2rem); font-weight: 600; line-height: 1.15; }
  .hero__tagline { font-size: clamp(0.8rem, 2cqw, 1rem); opacity: 0.85; }
  .hero__nav { position: absolute; z-index: 3; bottom: 0.6rem; right: 0.9rem;
               display: flex; gap: 0.35rem; }
  .hero__dot { width: 0.5rem; height: 0.5rem; padding: 0; border: 0; border-radius: 50%;
               background: rgba(255, 255, 255, 0.4); cursor: pointer; }
  .hero__dot[aria-current='true'] { background: #fff; }
  .hero__empty { display: flex; align-items: center; justify-content: center;
                 height: 100%; opacity: 0.7; font-size: 0.9rem; }
  .hero__error { padding: 0.75rem; font-size: 0.85rem; }
  .hero__error pre { overflow: auto; font-size: 0.7rem; opacity: 0.8; }

  /*
   * The transition is removed rather than shortened. A 1ms fade is still a
   * fade, and this setting is a request for none.
   */
  @media (prefers-reduced-motion: reduce) {
    .hero__slide { transition: none; }
  }
`;

/** How the element asks about reduced motion. Injectable, so a test can lie. */
function defaultReducedMotion() {
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return () => Boolean(query?.matches);
}

export class HavenHeroWidget extends ElementBase {
  #config = {};
  #origConfig = null;
  #data = null;
  #slides = [];
  #index = 0;

  /** Hover or keyboard focus. Either one stops the rotation. */
  #paused = false;

  #root;
  #nodes = null;
  #untick = null;

  /** Injectable seams — a test drives the rotation without waiting in real time. */
  reducedMotion = defaultReducedMotion();
  subscribeRotation = subscribeRotation;

  /** Touch-swipe bookkeeping. */
  #touchStartX = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    this.#untick ??= this.subscribeRotation({
      intervalMs: () => this.rotateMs,
      shouldRotate: () => this.autoRotates,
      onRotate: () => this.next(),
    });
    this.render();
  }

  disconnectedCallback() {
    this.#untick?.();
    this.#untick = null;
  }

  /**
   * The rotation period in ms.
   *
   * Clamped rather than trusted: the host validates `rotateSeconds` against the
   * schema's min/max before `setConfig`, but this element is also driven
   * directly by tests and could in principle be handed a config the host never
   * saw. A zero here would mean a rotation every tick.
   */
  get rotateMs() {
    const seconds = Number(this.#config.rotateSeconds ?? DEFAULT_ROTATE_SECONDS);
    if (!Number.isFinite(seconds)) return DEFAULT_ROTATE_SECONDS * 1000;
    return Math.min(Math.max(seconds, MIN_ROTATE_SECONDS), MAX_ROTATE_SECONDS) * 1000;
  }

  /** Whether the hero should currently be advancing on its own. */
  get autoRotates() {
    return shouldAutoRotate({
      count: this.#slides.length,
      paused: this.#paused,
      reducedMotion: this.reducedMotion(),
    });
  }

  get slides() {
    return this.#slides;
  }

  get index() {
    return this.#index;
  }

  get paused() {
    return this.#paused;
  }

  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  /**
   * Validates eagerly and throws — the contract, not a suggestion.
   *
   * The host has already validated against `configSchema`, so the only check
   * left is the one the schema cannot express: `showTagline` is a select over
   * booleans, and a select's options are checked by value, but a config that
   * reached here by another route could still carry a string.
   */
  setConfig(config = {}) {
    this.#origConfig = config;

    if (config.showTagline !== undefined && typeof config.showTagline !== 'boolean') {
      throw new Error('hero: showTagline must be a boolean');
    }

    this.#config = config;
    this.render();
    return this.#config;
  }

  /**
   * The slide list from the host's fetcher.
   *
   * The index is CLAMPED rather than reset: a refetch that returns the same
   * slides plus one should not throw you back to slide one mid-read. It only
   * moves if the list shrank past where you were.
   */
  onData(data) {
    this.#data = data;
    this.#slides = slidesFrom(data);
    if (this.#index >= this.#slides.length) this.#index = 0;
    this.render();
  }

  onResize() {
    this.render();
  }

  /** Advance, wrapping. Used by the ticker, the arrow keys and a swipe. */
  next() {
    this.goTo(step(this.#index, this.#slides.length, 1));
  }

  previous() {
    this.goTo(step(this.#index, this.#slides.length, -1));
  }

  goTo(index) {
    if (!this.#slides.length) return;
    this.#index = step(index, this.#slides.length, 0);
    this.render();
  }

  render() {
    if (this.#data?.state === 'error') {
      this.#renderError();
      return;
    }

    if (!this.#slides.length) {
      this.#renderEmpty();
      return;
    }

    const nodes = this.#ensureScaffold();
    const slide = this.#slides[this.#index];

    // Patch in place — never rebuild. Rebuilding would re-request the image on
    // every rotation and flash the banner.
    setAttr(nodes.img, 'src', slide.image ?? '');
    nodes.img.hidden = !slide.image;
    // The image is decorative: the title beside it says the same thing, and a
    // screen reader announcing a filename twice is worse than silence.
    setAttr(nodes.img, 'alt', '');

    setText(nodes.title, slide.title);

    const showTagline = this.#config.showTagline !== false;
    nodes.tagline.hidden = !showTagline || !slide.tagline;
    setText(nodes.tagline, showTagline ? slide.tagline : '');

    // An `app` slide is a link; an `image` slide without a URL is not. An
    // anchor with no href is not focusable and is announced as plain text,
    // which is exactly right for a non-clickable slide.
    if (slide.url) {
      setAttr(nodes.slide, 'href', slide.url);
      setAttr(nodes.slide, 'rel', 'noopener noreferrer');
      setAttr(
        nodes.slide,
        'aria-label',
        slide.type === APP_SLIDE ? `Open ${slide.title}` : slide.title
      );
    } else {
      nodes.slide.removeAttribute('href');
      nodes.slide.removeAttribute('rel');
      nodes.slide.removeAttribute('aria-label');
    }

    this.#renderDots(nodes);
  }

  /**
   * The dot navigation, rebuilt only when the slide COUNT changes.
   *
   * Rebuilding these on every rotation would discard the button the user is
   * currently focused on, which loses keyboard focus mid-interaction.
   */
  #renderDots(nodes) {
    if (nodes.dots.children.length !== this.#slides.length) {
      const dots = this.#slides.map((slide, i) => {
        const dot = document.createElement('button');
        dot.className = 'hero__dot';
        dot.setAttribute('type', 'button');
        dot.setAttribute('aria-label', `Show slide ${i + 1}: ${slide.title || 'image'}`);
        dot.addEventListener('click', () => this.goTo(i));
        return dot;
      });
      nodes.dots.replaceChildren(...dots);
    }

    // More than one slide, or there is nothing to navigate between.
    nodes.dots.hidden = this.#slides.length <= 1;

    for (const [i, dot] of nodes.dots.children.entries()) {
      setAttr(dot, 'aria-current', String(i === this.#index));
    }
  }

  #ensureScaffold() {
    if (this.#nodes) return this.#nodes;

    const style = document.createElement('style');
    style.textContent = STYLES;

    const hero = document.createElement('div');
    hero.className = 'hero';
    // The region is announced as a group, and `aria-roledescription` tells a
    // screen-reader user this is a carousel rather than a static banner.
    hero.setAttribute('role', 'group');
    hero.setAttribute('aria-roledescription', 'carousel');
    hero.setAttribute('aria-label', 'Featured');

    const slide = document.createElement('a');
    slide.className = 'hero__slide';

    const img = document.createElement('img');
    img.className = 'hero__img';
    // A hero is the easiest place in a dashboard to ship a 4MB JPEG. Lazy so an
    // offscreen hero costs nothing, async-decoded so a large image cannot block
    // the first paint of the rest of the grid.
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');

    const scrim = document.createElement('div');
    scrim.className = 'hero__scrim';

    const text = document.createElement('div');
    text.className = 'hero__text';

    const title = document.createElement('div');
    title.className = 'hero__title';

    const tagline = document.createElement('div');
    tagline.className = 'hero__tagline';

    text.append(title, tagline);
    slide.append(img, scrim, text);

    const dots = document.createElement('div');
    dots.className = 'hero__nav';

    hero.append(slide, dots);
    this.#root.replaceChildren(style, hero);

    this.#nodes = { hero, slide, img, title, tagline, dots };
    this.#bindInteraction(hero);
    return this.#nodes;
  }

  /**
   * Pause-on-hover, pause-on-focus, arrow keys and touch swipe.
   *
   * Bound once on the container rather than per slide, because the scaffold is
   * built once and patched. `focusin`/`focusout` rather than `focus`/`blur` so
   * focus landing on the link or a dot INSIDE the hero counts — the point is
   * that a keyboard user tabbing through the slide's link does not have it
   * change under them.
   */
  #bindInteraction(hero) {
    hero.addEventListener('mouseenter', () => this.#setPaused(true));
    hero.addEventListener('mouseleave', () => this.#setPaused(false));
    hero.addEventListener('focusin', () => this.#setPaused(true));
    hero.addEventListener('focusout', () => this.#setPaused(false));

    hero.setAttribute('tabindex', '0');
    hero.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') {
        event.preventDefault?.();
        this.next();
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault?.();
        this.previous();
      }
    });

    hero.addEventListener('touchstart', (event) => {
      this.#touchStartX = event.touches?.[0]?.clientX ?? null;
    });

    hero.addEventListener('touchend', (event) => {
      if (this.#touchStartX === null) return;
      const endX = event.changedTouches?.[0]?.clientX ?? null;
      this.#touchStartX = handleSwipe(this.#touchStartX, endX, this);
    });
  }

  #setPaused(paused) {
    this.#paused = paused;
  }

  #renderEmpty() {
    const style = document.createElement('style');
    style.textContent = STYLES;

    const box = document.createElement('div');
    box.className = 'hero__empty';
    // Loading and "genuinely nothing featured" are different states, and a
    // permanent "Nothing featured yet" flashing before the first payload lands
    // would be a lie.
    box.textContent = this.#data ? 'Nothing featured yet.' : 'Loading…';

    this.#root.replaceChildren(style, box);
    this.#nodes = null;
  }

  #renderError() {
    const message = this.#data?.errors?.[0]?.message ?? 'Hero data unavailable';

    const box = document.createElement('div');
    box.className = 'hero__error';

    const heading = document.createElement('strong');
    heading.textContent = 'Hero unavailable';

    const detail = document.createElement('p');
    // textContent, never innerHTML — the message may quote a config value.
    detail.textContent = message;

    // The preserved config, so the widget can be fixed rather than deleted.
    const dump = document.createElement('pre');
    dump.textContent = JSON.stringify(this.#origConfig ?? {}, null, 2);

    box.append(heading, detail, dump);

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.#root.replaceChildren(style, box);
    this.#nodes = null;
  }

  /** Documents for the global search index — one per app-linked slide. */
  getSearchEntries() {
    return this.#slides
      .filter((slide) => slide.type === APP_SLIDE && slide.title)
      .map((slide) => ({
        id: `hero:${slide.id}`,
        title: slide.title,
        subtitle: slide.tagline,
        url: slide.url ?? '',
        keywords: ['featured', 'hero'],
      }));
  }

  destroy() {
    this.#untick?.();
    this.#untick = null;
    this.#nodes = null;
    this.#slides = [];
    this.#data = null;
    this.#root.replaceChildren();
  }
}

/** How far a touch must travel before it counts as a swipe rather than a tap. */
export const SWIPE_THRESHOLD_PX = 40;

/**
 * Turns a touch start/end pair into a navigation, if it was far enough.
 *
 * Extracted and exported so the threshold is testable without synthesising
 * touch events. Returns the new start position — always null, since a
 * completed touch ends the gesture either way.
 */
export function handleSwipe(startX, endX, target) {
  if (typeof endX !== 'number') return null;
  const delta = endX - startX;
  if (Math.abs(delta) < SWIPE_THRESHOLD_PX) return null;
  // Swiping left (negative delta) moves forward, matching every native pager.
  if (delta < 0) target.next();
  else target.previous();
  return null;
}

/** Writes text only when it differs, so an unchanged node is left alone. */
function setText(node, value) {
  const next = value ?? '';
  if (node.textContent !== next) node.textContent = next;
}

/** Writes an attribute only when it differs — re-setting `src` refetches. */
function setAttr(node, name, value) {
  if (node.getAttribute(name) !== value) node.setAttribute(name, value);
}
