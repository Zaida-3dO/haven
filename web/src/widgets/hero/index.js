/**
 * The hero widget — a rotating banner of app-linked and free-form slides.
 *
 * Importing this module defines the element and registers the widget. Anything
 * that only needs the definition should import `./definition.js`, which touches
 * no DOM; the slide normalisation is in `./slides.js` and the shared rotation
 * tick in `./rotation.js`.
 */

import { HavenHeroWidget } from './element.js';
import { HERO_WIDGET_TAG, heroWidget } from './definition.js';

export { HavenHeroWidget, handleSwipe, SWIPE_THRESHOLD_PX } from './element.js';
export { heroTicker, subscribeRotation, HERO_TICK_MS } from './rotation.js';
export {
  APP_SLIDE,
  COVER_BASE,
  IMAGE_SLIDE,
  coverSrc,
  normaliseSlide,
  normaliseSlides,
  safeUrl,
  shouldAutoRotate,
  slidesFrom,
  step,
} from './slides.js';
export {
  DEFAULT_ROTATE_SECONDS,
  HERO_ENDPOINT,
  HERO_FETCH_KEY,
  HERO_REFRESH_MS,
  HERO_WIDGET_TAG,
  HERO_WIDGET_TYPE,
  MAX_ROTATE_SECONDS,
  MIN_ROTATE_SECONDS,
  heroWidget,
} from './definition.js';

export function defineHeroWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(HERO_WIDGET_TAG)) {
    ce.define(HERO_WIDGET_TAG, HavenHeroWidget);
  }
  if (registry && !registry.has(heroWidget.type)) {
    registry.register(heroWidget);
  }
  return heroWidget;
}
