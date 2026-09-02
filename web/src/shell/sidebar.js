/**
 * The sidebar — a fixed 320px column on the right of the main grid.
 *
 * ## Why this is not just more widgets on the grid
 *
 * Everything here could technically be a GridStack tile. It should not be.
 * The dashboard Haven replaces has a genuine two-part layout: a main area you
 * arrange, and a column of ambient readouts you do not. Weather, the calendar
 * and the server status are glanceable context — you want them in the same
 * place every time you look, and you do not want to be able to drag them into
 * the middle of the app grid by accident.
 *
 * So the sidebar is plain layout, outside the grid entirely. It is not
 * editable, it is not draggable, and its contents are fixed in code. That is a
 * deliberate limitation, not an oversight: a "customisable" sidebar would be
 * the same thing as the grid, and then there would be no reason for it to
 * exist.
 *
 * ## The one asymmetry worth naming
 *
 * Sidebar cards KEEP their titles ("Weather", "Calendar", "Server Status")
 * while main-grid tiles lost theirs. That is not a contradiction. A grid tile's
 * title bar was widget chrome — it named the widget TYPE and carried the drag
 * and settings controls, which are only meaningful while editing. A sidebar
 * card's title is a content heading: it names what the card is showing, in a
 * narrow column where three unlabelled readouts stacked on each other would be
 * genuinely ambiguous. The live dashboard makes exactly the same distinction,
 * titles in the sidebar and none on the grid.
 *
 * ## Why status is pinned to the bottom
 *
 * `margin-top: auto` on the last card, matching the live dashboard. It is the
 * summary of everything above it, and it is the one card whose height does not
 * depend on its content, so it is the only one that can sit against the bottom
 * edge without leaving a ragged gap.
 */

/**
 * An 18px inline SVG icon for a sidebar title.
 *
 * Built with `innerHTML` on a container we construct ourselves from a fixed
 * string constant — never from anything a user or a server supplied. The paths
 * are literals in this file; there is no path by which caller data reaches
 * here.
 */
function createIcon(paths, doc) {
  const svg = doc.createElementNS
    ? doc.createElementNS('http://www.w3.org/2000/svg', 'svg')
    : doc.createElement('svg');

  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  // Decorative: the title text right beside it is the accessible name.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  for (const d of paths) {
    const path = doc.createElementNS
      ? doc.createElementNS('http://www.w3.org/2000/svg', 'path')
      : doc.createElement('path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

/** The three icons, as path data. Traced to match the live dashboard's set. */
export const SIDEBAR_ICONS = Object.freeze({
  weather: ['M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 2A3.5 3.5 0 0 0 6.5 19z'],
  calendar: [
    'M8 2v4M16 2v4',
    'M3 10h18',
    'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  ],
  status: [
    'M4 2h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z',
    'M4 14h16a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2z',
    'M6 6h.01M6 18h.01',
  ],
});

/**
 * Builds one titled sidebar card.
 *
 * The title is a real `<h2>`, not a styled span: these are the only headings
 * on the page below the header's `<h1>`, now that the grid tiles no longer
 * carry one, so they are what heading navigation lands on.
 *
 * @returns {{el, body, title}}
 */
export function createSidebarCard({
  title,
  icon = null,
  pinned = false,
  document: doc = globalThis.document,
} = {}) {
  const el = doc.createElement('section');
  el.className = `haven-sidebar__card${pinned ? ' haven-sidebar__card--pinned' : ''}`;

  const heading = doc.createElement('h2');
  heading.className = 'haven-sidebar__title';

  if (icon && SIDEBAR_ICONS[icon]) {
    heading.appendChild(createIcon(SIDEBAR_ICONS[icon], doc));
  }

  const label = doc.createElement('span');
  label.textContent = title;
  heading.appendChild(label);

  const body = doc.createElement('div');
  body.className = 'haven-sidebar__body';

  el.append(heading, body);
  return { el, body, title: heading };
}

/**
 * Builds the sidebar shell and its cards.
 *
 * Widgets are NOT mounted here — this returns the card bodies and lets the
 * caller (`boot.js`) mount hosts into them, because mounting is the
 * dashboard's job and the sidebar has no business knowing what a widget host
 * is. The order of `cards` is the order they appear, and the last card with
 * `pinned: true` is pushed to the bottom.
 *
 * @param {object} [deps]
 * @param {Array<{id: string, title: string, icon?: string, pinned?: boolean}>} [deps.cards]
 * @returns {{el, bodies: Map<string, HTMLElement>, cards: Map<string, object>}}
 */
export function createSidebar({ cards = [], document: doc = globalThis.document } = {}) {
  const el = doc.createElement('aside');
  el.className = 'haven-sidebar';
  // Named, so a screen reader's landmark list distinguishes it from the main
  // grid rather than offering two anonymous regions.
  el.setAttribute('aria-label', 'Dashboard sidebar');

  const bodies = new Map();
  const built = new Map();

  for (const spec of cards) {
    const card = createSidebarCard({
      title: spec.title,
      icon: spec.icon,
      pinned: spec.pinned,
      document: doc,
    });
    el.appendChild(card.el);
    bodies.set(spec.id, card.body);
    built.set(spec.id, card);
  }

  return { el, bodies, cards: built };
}

export default { createSidebar, createSidebarCard, SIDEBAR_ICONS };
