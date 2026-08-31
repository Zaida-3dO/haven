/**
 * Registration entry for the apps widget.
 *
 * Mirrors `widgets/clock/index.js`: the module exports the definition as data
 * and a `register(registry)` that defines the custom element and registers it.
 * Defining the element here rather than at import time is what lets a test
 * import the definition without touching a custom-element registry.
 *
 * Unlike the clock, this widget DOES declare a `dataSource` and a `refreshMs`
 * — it has a real endpoint (`/api/apps/dashboard`) and the host is what polls
 * it. The clock declares neither because its time is pushed in by a host-owned
 * ticker; the apps widget's data genuinely comes over HTTP.
 */

import { AppsWidget, WIDGET_TAG, appsWidgetDefinition } from './apps-widget.js';

export const TAG = WIDGET_TAG;

/** Everything the host needs to list, insert, migrate and build the widget. */
export const definition = appsWidgetDefinition;

/**
 * Registers the apps widget and defines its custom element.
 *
 * Both steps are guarded so a second call is harmless — the host tolerates a
 * late registration but not a duplicate one.
 */
export function register(registry) {
  if (typeof customElements !== 'undefined' && !customElements.get(TAG)) {
    customElements.define(TAG, AppsWidget);
  }
  return registry.has(definition.type)
    ? registry.get(definition.type)
    : registry.register(definition);
}

export { AppsWidget };
