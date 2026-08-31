/**
 * The add-widget panel.
 *
 * Lists every registered widget by its `name` and inserts the chosen one at
 * its `defaultSize` with `getStubConfig()` applied — which is the whole point
 * of `getStubConfig` existing. A newly added widget must *work immediately*
 * rather than landing as an error card the user has to go and fix before they
 * can see what they just added (WIDGET-CONTRACT, "getStubConfig matters more
 * than it looks").
 *
 * ## Dependency on the widget host
 *
 * The registry itself is owned by `./registry.js`, built in parallel on
 * `feat/m1-widget-host` and not merged yet. This module deliberately does not
 * import it directly. Instead it takes a `registry` object with a small
 * documented surface (see {@link normaliseRegistry}), so that when the host
 * lands, reconciliation is a one-line adapter here rather than a rewrite —
 * and so this panel is testable today with a plain fake.
 */

/**
 * The registry surface this panel needs.
 *
 * @typedef {object} WidgetRegistryLike
 * @property {() => Array<object>} list  registered widget metadata
 */

/**
 * Adapts whatever `registry.js` ends up exposing to the two things this panel
 * uses: a list of widget metadata, and a lookup by type.
 *
 * Accepts a `list()`/`getAll()`/`entries()` style object, a bare array, or a
 * Map — because the host's exact accessor name is not settled yet and getting
 * it wrong should be a one-line fix, not a broken panel.
 */
export function normaliseRegistry(registry) {
  const list = () => {
    if (!registry) return [];
    if (Array.isArray(registry)) return registry;
    if (typeof registry.list === 'function') return registry.list();
    if (typeof registry.getAll === 'function') return registry.getAll();
    if (registry instanceof Map) return [...registry.values()];
    if (typeof registry.entries === 'function') return [...registry.entries()].map(([, v]) => v);
    return [];
  };

  return {
    list,
    get(type) {
      if (registry && typeof registry.get === 'function' && !(registry instanceof Map)) {
        return registry.get(type);
      }
      return list().find((meta) => meta?.type === type);
    },
  };
}

/**
 * Builds the config a newly inserted widget starts life with.
 *
 * `getStubConfig` is optional on a widget; a widget with no configurable
 * options legitimately has nothing to stub. The config version is stamped from
 * the widget's declared `configVersion` so the migration hook has something to
 * compare against from the very first save (WIDGET-CONTRACT, "Config
 * versioning").
 */
export function stubConfigFor(meta) {
  const stub = typeof meta?.getStubConfig === 'function' ? (meta.getStubConfig() ?? {}) : {};
  return { version: meta?.configVersion ?? 1, ...stub };
}

/**
 * Creates the add-widget panel.
 *
 * @param {object} deps
 * @param {WidgetRegistryLike} deps.registry
 * @param {(spec: {type: string, meta: object, config: object}) => void} deps.onAdd
 */
export function createAddPanel({
  registry,
  onAdd = () => {},
  document: doc = globalThis.document,
} = {}) {
  const reg = normaliseRegistry(registry);

  const el = doc.createElement('aside');
  el.className = 'haven-add-panel';
  el.hidden = true;
  // Labelled and roled so it is announced as a dialog rather than as an
  // anonymous region when edit mode opens it.
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Add widget');

  const heading = doc.createElement('h2');
  heading.className = 'haven-add-panel__heading';
  heading.textContent = 'Add widget';

  const list = doc.createElement('ul');
  list.className = 'haven-add-panel__list';

  el.append(heading, list);

  /** Re-renders the list from the registry. Cheap; called on every open. */
  function refresh() {
    list.replaceChildren();

    const widgets = reg.list();

    if (widgets.length === 0) {
      const empty = doc.createElement('li');
      empty.className = 'haven-add-panel__empty';
      empty.textContent = 'No widgets registered.';
      list.append(empty);
      return;
    }

    for (const meta of widgets) {
      const item = doc.createElement('li');
      item.className = 'haven-add-panel__item';

      const button = doc.createElement('button');
      button.type = 'button';
      button.className = 'haven-add-panel__add';
      button.dataset.widgetType = meta.type;
      // The panel lists widgets by `name` — the human label — not by `type`,
      // which is a registry identity nobody should have to read.
      button.textContent = meta.name ?? meta.type;
      button.setAttribute('aria-label', `Add ${meta.name ?? meta.type}`);
      button.addEventListener('click', () => add(meta.type));

      item.append(button);
      list.append(item);
    }
  }

  /** Inserts a widget at its default size with a working stub config. */
  function add(type) {
    const meta = reg.get(type);
    if (!meta) return null;

    const spec = { type, meta, config: stubConfigFor(meta) };
    onAdd(spec);
    return spec;
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
