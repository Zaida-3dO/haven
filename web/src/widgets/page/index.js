/**
 * The custom-page widget — registration entry.
 *
 * Defines the element and registers the widget. Anything needing only the
 * definition should import `./definition.js`, which touches no DOM.
 */

import { HavenPageWidget } from './element.js';
import { PAGE_WIDGET_TAG, pageWidget } from './definition.js';

export { HavenPageWidget, PageWidgetError } from './element.js';
export { MODES, PAGE_WIDGET_TAG, PAGE_WIDGET_TYPE, pageWidget } from './definition.js';

export function definePageWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(PAGE_WIDGET_TAG)) {
    ce.define(PAGE_WIDGET_TAG, HavenPageWidget);
  }
  if (registry && !registry.has(pageWidget.type)) {
    registry.register(pageWidget);
  }
  return pageWidget;
}
