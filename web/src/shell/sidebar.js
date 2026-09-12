/**
 * The sidebar — a fixed 320px column on the right of the main grid.
 *
 * ## The sidebar is a ZONE, not a second grid
 *
 * Haven has two zones a widget can live in: `grid` and `sidebar`. They are not
 * "the editable one and the fixed one" — they are two different LAYOUT MODELS,
 * and which one a widget wants is a real design choice rather than a
 * limitation.
 *
 * - The **grid** is two-dimensional free placement: you choose x, y, width and
 *   height, tiles collide and reflow, and geometry is remembered per
 *   breakpoint. GridStack owns it.
 * - The **sidebar** is a one-column, intrinsically-sized, non-overlapping
 *   stack. A card is as tall as its content and as wide as the column; the
 *   only thing you choose is ORDER. There is no x, no y, no width, no height,
 *   and so nothing per-breakpoint to remember — the same order applies
 *   everywhere.
 *
 * That is why the sidebar is not GridStack at `column: 1`. A one-column grid is
 * a list with cell-height arithmetic bolted on: you would compute geometry only
 * to collapse it straight back to an index, and a uniform cellHeight would crop
 * a card (the forecast) whose whole point is that it sizes to its content.
 *
 * The zone is a property of the widget INSTANCE, not of the layout — see
 * `docs/DESIGN.md` §3.1.
 *
 * ## What the user gets to do (design decision — Ope, 2026-09-09)
 *
 * A widget's zone and its position within the sidebar are the user's, not the
 * code's:
 *
 * - choose grid-or-sidebar when adding a widget,
 * - reorder cards within the sidebar,
 * - remove a card from the sidebar.
 *
 * Dragging a tile from the grid into the sidebar is a nice-to-have on top of
 * that, not part of the requirement.
 *
 * **NOT BUILT YET.** As of 2026-09-10 this file still builds the sidebar from a
 * hardcoded card list (`boot.js`), and none of the above is wired up. This
 * block describes the model the code is being built TOWARD so the next reader
 * is not misled about the destination; check the code, not this comment, for
 * what ships today.
 *
 * A previous version of this comment asserted the opposite — that a fixed,
 * non-editable sidebar was "a deliberate limitation, not an oversight" and that
 * a customisable sidebar "would be the same thing as the grid". That was an
 * agent's inference written as though it were settled design. It was not Ope's,
 * he has explicitly disowned it, and it had already been quoted back to him as
 * a constraint by two readers who took it at face value. Hence the attribution
 * lines in this file: **if a paragraph here states a design decision, it names
 * the person who made it and the date.** Anything unattributed is an
 * observation about the code, not a ruling about the product.
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
 *
 * ## Why the unpinned cards live in their own scrollport
 *
 * The pin only guarantees "visible without scrolling" while the cards ABOVE it
 * fit. They stopped fitting: with a real forecast the weather card is 282px
 * rather than the 92px "not configured" stub, and weather + calendar + 3D home
 * + status + gaps came to 960px in an 830px column at 1440x900. The sidebar was
 * `overflow: hidden`, so the surplus was not scrolled but CLIPPED — Server
 * Status rendered at y=915 in a 900px viewport and was unreachable by any
 * means. Strictly worse than the scrolling page it replaced.
 *
 * So the unpinned cards go inside `.haven-sidebar__scroll`, which is the flex
 * child that gets to shrink, and the pinned card stays its sibling — outside
 * the scrollport, so it holds the bottom edge no matter how tall the cards
 * above it get. Overflow becomes reachable instead of clipped, and the one
 * card the column exists to show is the one that never moves.
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

/** The sidebar icons, as path data. Traced to match the live dashboard's set. */
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
  // A house outline, for the 3D home card. The live dashboard uses the same
  // shape for its own "3D Home" sidebar card.
  home3d: ['M3 10.5 12 3l9 7.5', 'M5 9.5V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V9.5'],
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
  id = null,
  type = null,
  title,
  icon = null,
  pinned = false,
  controls = false,
  onMoveUp = () => {},
  onMoveDown = () => {},
  onRemove = () => {},
  document: doc = globalThis.document,
} = {}) {
  const el = doc.createElement('section');
  // Two modifiers, and the TYPE one is what the stylesheet should target.
  //
  // The id modifier came first, back when the four card ids were literals in
  // `boot.js` ('weather', 'calendar', 'home3d', 'status') and a rule could
  // safely say `.haven-sidebar__card--home3d`. Sidebar cards are now built
  // from real widget instances whose ids are minted (`iframe-3f9a2c71`), so an
  // id-based rule matches nothing the moment a user adds a card — and the
  // failure is invisible: the 3D home's iframe sizes to its container, so
  // losing its height rule renders the scene into a 0px box with no error.
  //
  // The type modifier is stable across instances and is the honest carrier of
  // "a widget of this KIND needs particular treatment", which is what the
  // height rule actually means. Both are emitted: the id class stays useful
  // for targeting one specific seeded card, and dropping it would be a
  // behaviour change this commit does not need to make.
  const idClass = id ? ` haven-sidebar__card--${id}` : '';
  const typeClass = type ? ` haven-sidebar__card--type-${type}` : '';
  el.className =
    `haven-sidebar__card${idClass}${typeClass}` + (pinned ? ' haven-sidebar__card--pinned' : '');

  const heading = doc.createElement('h2');
  heading.className = 'haven-sidebar__title';

  if (icon && SIDEBAR_ICONS[icon]) {
    heading.appendChild(createIcon(SIDEBAR_ICONS[icon], doc));
  }

  const label = doc.createElement('span');
  label.textContent = title;
  heading.appendChild(label);

  // Edit-mode controls, on the heading so they sit beside the card title.
  //
  // Built DISABLED with `tabIndex: -1`, exactly like the grid's per-widget
  // controls (`createWidgetControls`): they are only reachable in edit mode,
  // and hiding them with CSS alone would leave them in the tab order for a
  // keyboard user in view mode. `setEditable` on the sidebar handle is what
  // turns them on — see the note there about why the grid's own sweep cannot.
  //
  // The pinned card gets no MOVE controls: it is the sidebar's own child
  // rather than a child of the scrollport, so it holds the bottom edge and is
  // not part of the order. It keeps Remove — a user must still be able to get
  // rid of it.
  let controlsEl = null;
  if (controls) {
    controlsEl = doc.createElement('div');
    controlsEl.className = 'haven-sidebar__controls';

    const button = (kind, label, handler) => {
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = `haven-sidebar__control haven-sidebar__control--${kind}`;
      btn.setAttribute('aria-label', `${label} ${title}`);
      btn.dataset.sidebarControl = kind;
      btn.textContent = { up: '↑', down: '↓', remove: '×' }[kind];
      btn.disabled = true;
      btn.tabIndex = -1;
      btn.addEventListener?.('click', () => handler(id));
      return btn;
    };

    if (!pinned) {
      controlsEl.append(button('up', 'Move up', onMoveUp), button('down', 'Move down', onMoveDown));
    }
    controlsEl.appendChild(button('remove', 'Remove', onRemove));
    heading.appendChild(controlsEl);
  }

  const body = doc.createElement('div');
  body.className = 'haven-sidebar__body';

  el.append(heading, body);
  // `pinned` is reported back, not just baked into the class string. The
  // reorder path has to SKIP the pinned card — it is the sidebar's own child
  // rather than a child of the scrollport — and re-deriving that by parsing
  // the className would be one string change away from silently pulling the
  // pinned card into the scrollport, where it can scroll out of view.
  return { el, body, title: heading, pinned: Boolean(pinned), controls: controlsEl };
}

/**
 * Builds the sidebar shell and its cards.
 *
 * Widgets are NOT mounted here — this returns the card bodies and lets the
 * caller (`boot.js`) mount hosts into them, because mounting is the
 * dashboard's job and the sidebar has no business knowing what a widget host
 * is. The order of `cards` is the order they appear, and a card with
 * `pinned: true` is held against the bottom.
 *
 * Unpinned cards are appended to a `.haven-sidebar__scroll` wrapper and pinned
 * cards are appended to the sidebar itself, so the pin is a SIBLING of the
 * scrollport rather than a child of it. That is the whole mechanism: a child
 * of the scrollport can be scrolled out of view, and the pinned card must not
 * be. See the note at the top of this file.
 *
 * The wrapper is created unconditionally, not lazily on the first unpinned
 * card, so the stylesheet's `flex: 1 1 auto; min-height: 0` always has an
 * element to land on and the DOM shape does not depend on card order.
 *
 * @param {object} [deps]
 * @param {Array<{id: string, title: string, icon?: string, pinned?: boolean}>} [deps.cards]
 *   `id` becomes a `haven-sidebar__card--<id>` modifier class and `type` a
 *   `haven-sidebar__card--type-<type>` one. Stylesheet rules should use the
 *   TYPE class: instance ids are minted, so an id rule silently matches
 *   nothing for a user-added card.
 * @returns {{el, scroll, bodies: Map<string, HTMLElement>,
 *   cards: Map<string, object>, addCard: (spec) => object|null}}
 *   `addCard` attaches a card built AFTER the initial render, through the
 *   same path, so the scrollport invariant holds for it too.
 */
export function createSidebar({
  cards = [],
  controls = false,
  onMoveUp = () => {},
  onMoveDown = () => {},
  onRemove = () => {},
  document: doc = globalThis.document,
} = {}) {
  const el = doc.createElement('aside');
  el.className = 'haven-sidebar';
  // Named, so a screen reader's landmark list distinguishes it from the main
  // grid rather than offering two anonymous regions.
  el.setAttribute('aria-label', 'Dashboard sidebar');

  // The scrollport for everything that is not pinned. It is a plain <div> and
  // carries no landmark role: it is a layout box, and announcing it as a
  // region would put a second, meaningless landmark inside the sidebar's own.
  const scroll = doc.createElement('div');
  scroll.className = 'haven-sidebar__scroll';
  el.appendChild(scroll);

  const bodies = new Map();
  const built = new Map();

  /**
   * Builds one card and puts it in the right container.
   *
   * THE one place a card is attached, used both for the initial build and for
   * a card added later. That is the point: "an unpinned card goes inside the
   * scrollport" is an invariant, and an invariant with two implementations is
   * one refactor away from having one.
   *
   * The failure it prevents is measured, not theoretical. A card appended to
   * the sidebar itself becomes a SIBLING of the pinned card and competes with
   * it for height: at 1440x900, three such siblings drive the scrollport's
   * `clientHeight` to 0px, and `.haven-sidebar { overflow: hidden }` then
   * leaves those cards unreachable with no scrollbar — persisted, invisible,
   * and unrecoverable from the UI.
   *
   * @returns the card, or null if a card with that id already exists.
   */
  function addCard(spec) {
    if (!spec?.id || built.has(spec.id)) return null;

    const card = createSidebarCard({
      id: spec.id,
      type: spec.type,
      title: spec.title,
      icon: spec.icon,
      pinned: spec.pinned,
      controls,
      onMoveUp,
      onMoveDown,
      onRemove,
      document: doc,
    });

    // The pinned card is the sidebar's own child; everything else goes in the
    // scrollport. Appending a pinned card to `scroll` would let it scroll out
    // of view, which is the exact bug this structure exists to prevent.
    (spec.pinned ? el : scroll).appendChild(card.el);
    bodies.set(spec.id, card.body);
    built.set(spec.id, card);
    return card;
  }

  for (const spec of cards) addCard(spec);

  /**
   * Turns the card controls on or off.
   *
   * ── Why the sidebar needs its own sweep ──────────────────────────────
   * `edit-mode.js` enables per-widget controls with
   * `gridHandle.root.querySelectorAll('.haven-widget__control')` — scoped to
   * the GRID's root. The sidebar is mounted as a SIBLING of the grid chrome
   * inside `.haven-layout`, so it is not under that root and that sweep can
   * never reach it. A sidebar control relying on it would be built disabled
   * and stay disabled forever: no error, no failing test, just three buttons
   * that do nothing.
   *
   * So the sidebar exposes this and `boot.js` drives it from edit mode's
   * `onModeChange`. Disabled AND untabbable, not merely hidden, so a keyboard
   * user cannot tab into a control that does nothing in view mode.
   */
  function setEditable(editing) {
    for (const card of built.values()) {
      for (const control of card.controls?.children ?? []) {
        control.disabled = !editing;
        control.tabIndex = editing ? 0 : -1;
      }
    }
  }

  return { el, scroll, bodies, cards: built, addCard, setEditable };
}

export default { createSidebar, createSidebarCard, SIDEBAR_ICONS };
