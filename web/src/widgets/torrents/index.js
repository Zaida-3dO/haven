/**
 * The torrents widget's public entry point.
 *
 * Importing this module for its side effect registers the custom element and
 * the widget definition; the host handles late registration either way, so
 * import order does not matter.
 */

export {
  TorrentsWidget,
  TORRENTS_WIDGET_TAG,
  DEFAULT_MAX_ROWS,
  NARROW_COLUMNS,
  torrentsWidgetDefinition,
  defineTorrentsWidget,
} from './torrents-widget.js';

export * from './format.js';
