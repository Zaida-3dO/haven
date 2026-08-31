/**
 * The notices widget — anything needing attention, from any source.
 *
 * It FETCHES NOTHING on a schedule. The list arrives through `onData()` from
 * the host, which owns the poll, and every credential that produced the list
 * lives behind `/api/widgets/notices` where the browser never sees one
 * (docs/WIDGET-CONTRACT.md, docs/SECURITY.md).
 *
 * Importing this module is what puts the widget on the board: it defines the
 * custom element and registers the definition. Anything that only needs the
 * definition — a test, the "Add widget" catalogue — should import
 * `./definition.js` instead, which touches no DOM.
 */

import { HavenNoticesWidget } from './element.js';
import { NOTICES_WIDGET_TAG, noticesWidget } from './definition.js';

export { HavenNoticesWidget } from './element.js';
export {
  NOTICES_ENDPOINT,
  NOTICES_FETCH_KEY,
  NOTICES_REFRESH_MS,
  NOTICES_WIDGET_TAG,
  NOTICES_WIDGET_TYPE,
  noticesWidget,
} from './definition.js';
export {
  SEVERITY_PRESENTATION,
  absoluteDue,
  isOverdue,
  presentation,
  relativeDue,
  sortNotices,
  visibleNotices,
} from './format.js';

/**
 * Define the element and register the widget.
 *
 * Both are guarded, so importing this module twice — or registering after the
 * shell has already booted — is harmless. Late registration is handled by the
 * host, so load order does not matter.
 */
export function defineNoticesWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(NOTICES_WIDGET_TAG)) {
    ce.define(NOTICES_WIDGET_TAG, HavenNoticesWidget);
  }
  if (registry && !registry.has(noticesWidget.type)) {
    registry.register(noticesWidget);
  }
  return noticesWidget;
}
