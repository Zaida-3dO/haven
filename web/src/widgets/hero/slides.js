/**
 * Slide normalisation and rotation arithmetic — the hero's pure core.
 *
 * Everything here is a plain function over plain data, which is the point: the
 * awkward parts of a carousel are the ordering, the wrap-around and the
 * "should this rotate at all?" decision, and none of them need a DOM to be
 * asserted. The element in `element.js` does nothing but turn the output of
 * these functions into nodes.
 */

/** Slide kinds. `app` links into the registry; `image` is free-form. */
export const APP_SLIDE = 'app';
export const IMAGE_SLIDE = 'image';

/** Where uploaded covers are served from. Never the repo — the data volume. */
export const COVER_BASE = '/api/apps/icons/';

/**
 * Only these schemes may become an `href`.
 *
 * `javascript:` in a link is an XSS, and a hero slide's URL arrives from stored
 * config, which is exactly the kind of input that gets trusted by accident.
 * Mirrors `ALLOWED_PROTOCOLS` in the server's apps-schema.
 */
const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * A URL safe to put in an href, or null.
 *
 * Relative URLs are resolved against a dummy base purely to parse them; only
 * the protocol decision is taken from the result, so a relative link keeps its
 * original form rather than being rewritten to an absolute one.
 */
export function safeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  try {
    const parsed = new URL(value, 'https://haven.invalid');
    return ALLOWED_PROTOCOLS.has(parsed.protocol) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The image source for a slide, or null.
 *
 * A cover is stored as a BARE FILENAME (the server rejects anything with a path
 * separator) and is resolved against the icons route here. An `image` slide may
 * instead carry an absolute `src`, which goes through the same protocol check
 * as a link — an `image` slide is the free-form type, so its src is user input.
 */
export function coverSrc(slide) {
  if (slide?.src) return safeUrl(slide.src);
  if (typeof slide?.cover !== 'string' || !slide.cover.trim()) return null;
  const name = slide.cover.trim();
  // Defence in depth: the server already refuses to store one of these, but a
  // slide can also come from widget config, which the server never saw.
  if (name.includes('/') || name.includes('\') || name.includes('..')) return null;
  return COVER_BASE + encodeURIComponent(name);
}

/**
 * Normalises one raw slide into the shape the element renders.
 *
 * Returns null for anything unrenderable, so a single malformed slide is
 * dropped rather than blanking the hero — the same tolerance `apps-store` shows
 * a corrupt JSON blob.
 */
export function normaliseSlide(raw, index = 0) {
  if (!raw || typeof raw !== 'object') return null;

  const type = raw.type === IMAGE_SLIDE ? IMAGE_SLIDE : APP_SLIDE;
  const title = typeof raw.title === 'string' ? raw.title.trim() : '';
  const tagline = typeof raw.tagline === 'string' ? raw.tagline.trim() : '';
  const image = coverSrc(raw);
  const url = safeUrl(raw.url);

  // An app slide with no title is not a slide — there is nothing to click
  // through to and nothing to read. An image slide may legitimately have no
  // text at all, but it must at least have an image.
  if (type === APP_SLIDE && !title) return null;
  if (type === IMAGE_SLIDE && !image) return null;

  return Object.freeze({
    id: typeof raw.id === 'string' && raw.id ? raw.id : `slide-${index}`,
    type,
    title,
    tagline,
    image,
    url,
  });
}

/** Normalises a payload's slide list, dropping the unrenderable ones. */
export function normaliseSlides(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map(normaliseSlide).filter(Boolean);
}

/** Reads the slide list out of a PanelData payload, whatever shape it carries. */
export function slidesFrom(data) {
  const value = data?.value;
  if (!value) return [];
  if (Array.isArray(value)) return normaliseSlides(value);
  return normaliseSlides(value.slides);
}

/**
 * The next index, wrapping.
 *
 * `step` may be negative for the previous slide. Written as one function rather
 * than a next/previous pair because the wrap-around is the only interesting
 * part and it should exist once.
 */
export function step(index, count, by = 1) {
  if (!Number.isFinite(count) || count <= 0) return 0;
  return (((index + by) % count) + count) % count;
}

/**
 * Should the hero rotate on its own?
 *
 * Three ways to say no, and all three are real:
 *
 *  - REDUCED MOTION. `prefers-reduced-motion` is an accessibility setting, not
 *    a preference to weigh against the design. It stops auto-rotation outright
 *    — a moving banner is exactly what that setting is asking not to see.
 *  - PAUSED. Hover or focus. A slide that changes while you are reading it, or
 *    while you are tabbing through its link, is a bug.
 *  - NOTHING TO ROTATE. One slide is not a carousel.
 */
export function shouldAutoRotate({ count, paused, reducedMotion } = {}) {
  return Boolean(count > 1 && !paused && !reducedMotion);
}
