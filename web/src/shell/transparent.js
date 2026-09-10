/**
 * The per-widget "transparent background" option.
 *
 * ── What it is ───────────────────────────────────────────────────────────
 * A widget tile normally reads as a card: a surface a step above the page,
 * a 1px border, a radius and a shadow. That is right for a clock or a
 * torrents list, which need an edge to say where they stop.
 *
 * It is wrong for the two widgets that ARE the page. On the dashboard Haven
 * replaces, the hero banner and the apps grid have no card chrome at all —
 * no border, no panel background — and sit directly on the page. Wrapping
 * them in a box is what makes Haven look boxed-in by comparison: a bordered
 * rectangle around a full-bleed banner, and a second bordered rectangle
 * around a grid of cards that already have their own borders.
 *
 * ── Why it is an OPTION and not two hardcoded exceptions ─────────────────
 * "The hero and the apps widget look wrong in a box" is a fact about those
 * two widgets today. "Some widgets are the page rather than a card on it" is
 * the general shape, and it is equally true of a future full-bleed map or a
 * background video. Hardcoding the two type names in the stylesheet would
 * mean the third such widget needs a code change in the shell rather than a
 * line in its own definition.
 *
 * So it is a real config field: any widget can declare it, the settings form
 * renders it for free (the form is generated from `configSchema`), and it is
 * persisted per instance — one apps widget can be transparent while another
 * is not.
 *
 * ── Why `select` and not `boolean` ───────────────────────────────────────
 * `FIELD_TYPES` allows url | number | text | select | secret. There is no
 * boolean type, and adding one is a change to the widget contract that this
 * option does not justify. The repo's established idiom for a boolean is a
 * `select` whose option VALUES are real booleans — see the hero's
 * `showTagline`. This follows it exactly, so the stored config holds `true`
 * and `false` rather than the strings `'yes'` and `'no'`.
 *
 * ── View mode only ───────────────────────────────────────────────────────
 * The class is applied in view mode and dropped in edit mode. In edit mode
 * the tile needs its visible bounds: you cannot drag or resize a rectangle
 * you cannot see, and a transparent hero next to a transparent apps grid
 * would be two invisible drop targets. The stylesheet does that half — see
 * `.haven-grid--edit-mode .haven-widget-tile--transparent` in main.css —
 * which keeps the mode switch instant and free of a re-render.
 */

/** The config key. One spelling, imported by everything that reads it. */
export const TRANSPARENT_KEY = 'transparent';

/** The class the stylesheet keys off. */
export const TRANSPARENT_CLASS = 'haven-widget-tile--transparent';

/**
 * The schema descriptor, for a widget's `configSchema`.
 *
 * @param {boolean} [defaultValue] true for widgets that are the page rather
 *   than a card on it (hero, apps); false everywhere else.
 */
export function transparentField(defaultValue = false) {
  return {
    key: TRANSPARENT_KEY,
    type: 'select',
    label: 'Background',
    default: defaultValue,
    options: [
      { value: false, label: 'Card — bordered panel' },
      { value: true, label: 'Transparent — sits directly on the page' },
    ],
    help: 'Transparent removes the tile border, background and shadow in view mode. Edit mode always shows the bounds so the tile can be dragged.',
  };
}

/**
 * Is this config asking for a transparent tile?
 *
 * Strict `=== true` rather than truthiness, deliberately. A config that has
 * been round-tripped through a form or a database can hold the STRING
 * `'false'`, which is truthy and would turn the option on when it was
 * explicitly switched off. The stored value is a real boolean; anything else
 * is treated as "not transparent" rather than guessed at.
 */
export function isTransparent(config) {
  return config?.[TRANSPARENT_KEY] === true;
}

/**
 * Apply the option to a tile element.
 *
 * `add`/`remove` rather than `classList.toggle(name, force)`: this runs on
 * every settings save as well as at mount, so it must be able to turn the
 * option back OFF, and it must be idempotent.
 */
export function applyTransparent(tile, config) {
  if (!tile?.classList) return false;
  const on = isTransparent(config);
  if (on) tile.classList.add(TRANSPARENT_CLASS);
  else tile.classList.remove(TRANSPARENT_CLASS);
  return on;
}
