/**
 * Registration entry for the torrents widget.
 *
 * Mirrors the clock's entry point: the module exports a definition and a
 * `register(registry)` that also defines the custom element. Defining the
 * element there rather than at import time lets a test import the definition
 * without touching a custom-element registry.
 */

import { defineTorrentsWidget, torrentsWidgetDefinition } from './torrents-widget.js';

export const TAG = 'haven-widget-torrents';

/** Everything the host needs to list, insert and build a torrents tile. */
export const definition = torrentsWidgetDefinition;

/** Registers the widget and defines its custom element. */
export function register(registry) {
  return defineTorrentsWidget(registry);
}

export {
  TorrentsWidget,
  TORRENTS_WIDGET_TAG,
  DEFAULT_MAX_ROWS,
  NARROW_COLUMNS,
  torrentsWidgetDefinition,
  defineTorrentsWidget,
} from './torrents-widget.js';

export * from './format.js';
