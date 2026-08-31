/**
 * The greeting and clock widget.
 *
 * Time, date, and a greeting that adapts to the time of day AND the weather —
 * "Morning — it's grim out, working from home?" (DESIGN §6.8). The old version
 * was time-only with random phrasing per band; folding the weather in is the
 * new part.
 *
 * Importing this module defines the element and registers the widget. Anything
 * that only needs the definition should import `./definition.js`, which
 * touches no DOM; the phrasing table is in `./phrases.js` and the shared tick
 * in `./clock.js`.
 */

import { HavenGreetingWidget } from './element.js';
import { GREETING_WIDGET_TAG, greetingWidget } from './definition.js';

export { HavenGreetingWidget } from './element.js';
export { clockTicker, ClockTicker } from './clock.js';
export {
  GREETING_REFRESH_MS,
  GREETING_WIDGET_TAG,
  GREETING_WIDGET_TYPE,
  greetingWidget,
} from './definition.js';
export { BANDS, MOODS, PHRASES, bandFor, greetingFor, moodFor } from './phrases.js';

export function defineGreetingWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(GREETING_WIDGET_TAG)) {
    ce.define(GREETING_WIDGET_TAG, HavenGreetingWidget);
  }
  if (registry && !registry.has(greetingWidget.type)) {
    registry.register(greetingWidget);
  }
  return greetingWidget;
}
