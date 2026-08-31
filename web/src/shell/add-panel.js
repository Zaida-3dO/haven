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
export function buildInsertion(registry, type, breakpoint = 'desktop') {
  const definition = registry.get(type);
  if (!definition) return null;

  // A widget declaring a `mobileSize` gets it on the mobile breakpoint; the
  // registry defaults it to `defaultSize` when the widget declares none.
  const size = breakpoint === 'mobile' ? definition.mobileSize : definition.defaultSize;

  return {
    type,
    name: definition.name,
    tag: definition.tag,
    config: registry.stubConfig(type),
    size: { w: size.w, h: size.h },
    // `minSize` maps to GridStack's minW/minH, which is what stops a widget
    // being resized below the size it can actually render at.
    minSize: { w: definition.minSize.w, h: definition.minSize.h },
  };
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

  const list = doc.createElement('ul');
  list.className = 'haven-add-panel__list';

  el.appendChild(heading);
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

  /** Inserts a widget at its default size with a working stub config. */
  function add(type) {
    const insertion = buildInsertion(registry, type, breakpoint());
    if (!insertion) return null;
    onAdd(insertion);
    return insertion;
  }

  return {
    el,
    refresh,
    add,

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
