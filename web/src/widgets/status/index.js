/**
 * The status widget — registration.
 *
 * Importing this module is what puts the widget on the board: it defines the
 * custom element and registers the definition. Anything that only needs the
 * definition (a test, the "Add widget" catalogue) should import
 * `./definition.js` instead, which touches no DOM.
 */

import { HavenStatusWidget } from './element.js';
import { STATUS_WIDGET_TAG, statusWidget } from './definition.js';

export { HavenStatusWidget } from './element.js';
export { countStatuses } from './count.js';
export {
  STATUS_ENDPOINT,
  STATUS_FETCH_KEY,
  STATUS_REFRESH_MS,
  STATUS_WIDGET_TAG,
  STATUS_WIDGET_TYPE,
  statusWidget,
} from './definition.js';

/**
 * Define the element and register the widget.
 *
 * Both guarded, so importing twice — or registering after the shell has
 * booted — is harmless. The host tolerates late registration, so load order
 * does not matter.
 */
export function defineStatusWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(STATUS_WIDGET_TAG)) {
    ce.define(STATUS_WIDGET_TAG, HavenStatusWidget);
  }
  if (registry && !registry.has(statusWidget.type)) {
    registry.register(statusWidget);
  }
  return statusWidget;
}
