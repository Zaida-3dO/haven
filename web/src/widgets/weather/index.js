/**
 * The weather widget — current conditions and a 4-day forecast.
 *
 * It FETCHES NOTHING. Data arrives through `onData()` from the host, which
 * owns the schedule, and the API key lives behind `/api/widgets/weather` where
 * the browser never sees it (docs/WIDGET-CONTRACT.md, docs/SECURITY.md).
 *
 * Importing this module is what puts the widget on the board: it defines the
 * custom element and registers the definition. Anything that only needs the
 * definition — a test, the "Add widget" catalogue — should import
 * `./definition.js` instead, which touches no DOM.
 */

import { HavenWeatherWidget } from './element.js';
import { WEATHER_WIDGET_TAG, weatherWidget } from './definition.js';

export { HavenWeatherWidget } from './element.js';
export {
  WEATHER_ENDPOINT,
  WEATHER_FETCH_KEY,
  WEATHER_REFRESH_MS,
  WEATHER_WIDGET_TAG,
  WEATHER_WIDGET_TYPE,
  weatherWidget,
} from './definition.js';

/**
 * Define the element and register the widget.
 *
 * Both are guarded, so importing this module twice — or registering after the
 * shell has already booted — is harmless. Late registration is handled by the
 * host, so load order does not matter.
 */
export function defineWeatherWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(WEATHER_WIDGET_TAG)) {
    ce.define(WEATHER_WIDGET_TAG, HavenWeatherWidget);
  }
  if (registry && !registry.has(weatherWidget.type)) {
    registry.register(weatherWidget);
  }
  return weatherWidget;
}
