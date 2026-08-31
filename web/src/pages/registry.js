/**
 * The custom-page registry.
 *
 * A custom page is authored once and can then be placed two ways (DESIGN
 * §6.9): as a **widget** on the grid, or as its own **subpage** with the
 * shell's chrome around it — or both, from the same definition. Library
 * Analytics is the first consumer: today a standalone page with its own
 * header, nav and refresh, so it becomes a subpage with an optional
 * summary-tile widget linking through.
 *
 * A page definition is deliberately much smaller than a widget definition:
 *
 *   {
 *     id:       stable identity, used in the route and saved configs
 *     title:    what the nav and the search index show
 *     summary:  one line, shown on the tile and as the search subtitle
 *     render:   (target, ctx) => void — builds the page's DOM
 *     nav:      whether it appears in the shell's page nav (default true)
 *   }
 *
 * ## `render`, not `html`
 *
 * The obvious design is a page carrying an HTML string that the shell drops in
 * with `innerHTML`. It is rejected here, and it is worth saying why at length
 * because it is what a later change will reach for.
 *
 * `web/test/widget-definitions.test.js` asserts that no widget source sets
 * `innerHTML`, and that assertion is not bureaucratic: an authored page is
 * *authored*, but the moment pages are storable — from a settings form, from
 * the database, from an import — "authored" becomes "whatever was in the
 * config", and an `innerHTML` sink turns a stored string into script
 * execution in the dashboard's origin. Building DOM through
 * `document.createElement` and `textContent` has no such sink at all, so
 * there is nothing to sanitise and nothing to get wrong later.
 *
 * The cost is that a page author writes DOM calls rather than markup. For the
 * pages Haven actually has — a header, a nav, some figures, a table — that is
 * a small cost, and `page-dom.js` provides the handful of helpers that make it
 * read like markup anyway.
 */

/** Thrown when a page definition is unusable. */
export class PageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageError';
  }
}

/** Normalise and freeze a page definition, failing loudly on a bad one. */
export function normalisePage(definition) {
  if (!definition || typeof definition !== 'object') {
    throw new PageError('A page definition is required.');
  }

  const id = typeof definition.id === 'string' ? definition.id.trim() : '';
  if (!id) throw new PageError('A page needs a string `id`.');
  // The id goes in a URL fragment, so keep it to something that survives one
  // unencoded rather than discovering the problem at link time.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(id)) {
    throw new PageError(`Page id "${id}" must be alphanumeric with dashes.`);
  }

  const title = typeof definition.title === 'string' ? definition.title.trim() : '';
  if (!title) throw new PageError(`Page "${id}" needs a title.`);

  if (typeof definition.render !== 'function') {
    throw new PageError(`Page "${id}" needs a \`render(target, ctx)\` function.`);
  }

  return Object.freeze({
    id,
    title,
    summary: typeof definition.summary === 'string' ? definition.summary : '',
    keywords: Object.freeze(
      Array.isArray(definition.keywords)
        ? definition.keywords.filter((k) => typeof k === 'string' && k !== '')
        : []
    ),
    render: definition.render,
    // A page can exist as a widget target without cluttering the nav.
    nav: definition.nav !== false,
  });
}

export class PageRegistry {
  #byId = new Map();

  register(definition) {
    const page = normalisePage(definition);
    if (this.#byId.has(page.id)) {
      throw new PageError(`Page "${page.id}" is already registered.`);
    }
    this.#byId.set(page.id, page);
    return page;
  }

  get(id) {
    return this.#byId.get(id) ?? null;
  }

  has(id) {
    return this.#byId.has(id);
  }

  list() {
    return [...this.#byId.values()];
  }

  /** The pages the shell's nav offers, in registration order. */
  navPages() {
    return this.list().filter((page) => page.nav);
  }

  /**
   * The pages' contribution to the global search index.
   *
   * DESIGN §5 lists "Custom HTML pages contribute their title" alongside apps,
   * calendar events and alerts. A page is reachable by name from the palette
   * whether or not it is placed on the grid.
   */
  searchEntries() {
    return this.list().map((page) => ({
      id: `page:${page.id}`,
      title: page.title,
      subtitle: page.summary,
      url: routeFor(page.id),
      keywords: ['page', ...page.keywords],
    }));
  }

  /** Test seam — the module-level singleton is shared process-wide. */
  clear() {
    this.#byId.clear();
  }
}

/**
 * The route a page lives at.
 *
 * A hash route, not a path, and that is a deliberate constraint rather than a
 * shortcut. Haven's front end is a static bundle served by Fastify; a path
 * route would need every unknown path to fall through to `index.html` on the
 * server *and* in the reverse proxy in front of it. A hash route needs
 * neither, works on a `file://` preview, and cannot 404. `#widget-id` deep
 * links already use the fragment, and `parseRoute` keeps the two apart.
 */
export function routeFor(pageId) {
  return `#/page/${pageId}`;
}

export const pageRegistry = new PageRegistry();
