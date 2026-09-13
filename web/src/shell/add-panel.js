/**
 * The add-widget panel.
 *
 * Lists every registered widget by its `name` and inserts the chosen one at
 * its `defaultSize` with a stub config applied — which is the whole point of
 * `getStubConfig` existing. A newly added widget must *work immediately*
 * rather than landing as an error card the user has to go and fix before they
 * can see what they just added.
 *
 * Both of those come straight off the registry: `catalogue()` is exactly the
 * add-panel's list (name, defaultSize, minSize), and `stubConfig(type)` folds
 * the widget's own `getStubConfig()` over the schema defaults and stamps
 * `configVersion`, so a widget that ships no stub still gets a usable config
 * rather than a blank one.
 */

/**
 * Builds the descriptor for a widget about to be inserted.
 *
 * Kept separate from the DOM so the insertion contract — type, geometry,
 * starting config — can be tested without a document.
 *
 * @param {import('./registry.js').WidgetRegistry} registry
 * @param {string} type
 * @param {string} [breakpoint] which breakpoint's default size to use
 */
export function buildInsertion(registry, type, breakpoint = 'desktop', zone = 'grid') {
  const definition = registry.get(type);
  if (!definition) return null;

  const insertion = {
    type,
    zone,
    name: definition.name,
    tag: definition.tag,
    config: registry.stubConfig(type),
  };

  // A SIDEBAR insertion carries no geometry, deliberately.
  //
  // The sidebar is a one-column stack of intrinsically-sized cards: there is
  // no x, y, width or height to place, and `size`/`minSize` map onto
  // GridStack's `w/h/minW/minH`, which nothing in that zone reads. Computing
  // them anyway and handing them to a caller that discards them is the kind of
  // meaningless field that later reads as a missing feature — someone
  // eventually tries to honour it. See `docs/DESIGN.md` §3.1.
  if (zone === 'sidebar') return insertion;

  // A widget declaring a `mobileSize` gets it on the mobile breakpoint; the
  // registry defaults it to `defaultSize` when the widget declares none.
  const size = breakpoint === 'mobile' ? definition.mobileSize : definition.defaultSize;

  insertion.size = { w: size.w, h: size.h };
  // `minSize` maps to GridStack's minW/minH, which is what stops a widget
  // being resized below the size it can actually render at.
  insertion.minSize = { w: definition.minSize.w, h: definition.minSize.h };

  return insertion;
}

/**
 * Creates the add-widget panel.
 *
 * @param {object} deps
 * @param {import('./registry.js').WidgetRegistry} deps.registry
 * @param {(insertion: object) => void} deps.onAdd called with the insertion spec
 * @param {() => string} [deps.breakpoint] the breakpoint being edited
 */
export function createAddPanel({
  registry,
  onAdd = () => {},
  breakpoint = () => 'desktop',
  document: doc = globalThis.document,
} = {}) {
  if (!registry) throw new Error('createAddPanel: a registry is required');

  const el = doc.createElement('aside');
  el.className = 'haven-add-panel';
  el.hidden = true;
  // Roled and labelled so it is announced as a dialog rather than as an
  // anonymous region when edit mode opens it.
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Add widget');

  const heading = doc.createElement('h2');
  heading.className = 'haven-add-panel__heading';
  heading.textContent = 'Add widget';

  /**
   * Where the widget goes: the main grid, or the sidebar.
   *
   * ONE control at the top of the panel, not a pair of buttons on every
   * widget. Two buttons per row doubles the width of a list whose whole job is
   * to be scanned quickly, and it asks the destination question N times when
   * the answer is the same for the whole visit. A radio group also states the
   * default — "Main grid" — which a pair of equal buttons cannot.
   */
  const destination = doc.createElement('fieldset');
  destination.className = 'haven-add-panel__destination';

  const legend = doc.createElement('legend');
  legend.className = 'haven-add-panel__destination-legend';
  legend.textContent = 'Add to';
  destination.appendChild(legend);

  const zoneInputs = new Map();
  for (const [zone, label] of [
    ['grid', 'Main grid'],
    ['sidebar', 'Sidebar'],
  ]) {
    const wrap = doc.createElement('label');
    wrap.className = 'haven-add-panel__destination-option';

    const input = doc.createElement('input');
    input.type = 'radio';
    // A shared name is what makes the two mutually exclusive; without it a
    // user can select both and the panel silently reads the first.
    input.name = 'haven-add-destination';
    input.value = zone;
    input.checked = zone === 'grid';
    input.dataset.zone = zone;

    const text = doc.createElement('span');
    text.textContent = label;

    wrap.append(input, text);
    destination.appendChild(wrap);
    zoneInputs.set(zone, input);
  }

  /** The chosen destination, defaulting to the grid. */
  const chosenZone = () => {
    for (const [zone, input] of zoneInputs) if (input.checked) return zone;
    return 'grid';
  };

  const list = doc.createElement('ul');
  list.className = 'haven-add-panel__list';

  el.appendChild(heading);
  el.appendChild(destination);
  el.appendChild(list);

  /** Re-renders the list from the registry. Cheap; called on every open. */
  function refresh() {
    const entries = registry.catalogue();

    const children = [];

    if (entries.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'haven-add-panel__empty';
      empty.textContent = 'No widgets registered.';
      children.push(empty);
    }

    for (const entry of entries) {
      const item = doc.createElement('li');
      item.className = 'haven-add-panel__item';

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'haven-add-panel__add';
      button.dataset.widgetType = entry.type;
      // Listed by `name` — the human label — never by `type`, which is a
      // registry identity nobody should have to read.
      button.textContent = entry.name;
      button.setAttribute?.('aria-label', `Add ${entry.name}`);
      button.addEventListener?.('click', () => add(entry.type));

      item.appendChild(button);
      children.push(item);
    }

    list.replaceChildren(...children);
  }

  /**
   * Inserts a widget at its default size with a working stub config.
   *
   * `zone` is explicit rather than read from the DOM inside `buildInsertion`,
   * so the insertion contract stays testable without a document.
   */
  function add(type, zone = chosenZone()) {
    const insertion = buildInsertion(registry, type, breakpoint(), zone);
    if (!insertion) return null;
    onAdd(insertion);
    return insertion;
  }

  return {
    el,
    refresh,
    add,
    /** The destination currently selected. Exposed for tests and for boot. */
    zone: chosenZone,

    open() {
      refresh();
      el.hidden = false;
    },

    close() {
      el.hidden = true;
    },

    get isOpen() {
      return !el.hidden;
    },
  };
}
