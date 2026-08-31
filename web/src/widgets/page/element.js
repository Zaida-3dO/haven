/**
 * The custom-page widget.
 *
 * Renders a registered page (see `pages/registry.js`) into a grid tile —
 * either as a summary that links through to the page's own route, or inline in
 * full. The page definition is shared with the subpage router, so a page is
 * authored once and placed twice.
 *
 * The page's own `render(target, ctx)` builds real DOM nodes. Nothing here
 * parses a string into markup, so there is no `innerHTML` and nothing to
 * sanitise — see the note in `pages/registry.js` for why that is the design
 * rather than an omission.
 */

import { pageRegistry, routeFor } from '../../pages/registry.js';
import { MODES } from './definition.js';

const ElementBase = globalThis.HTMLElement ?? class {};

const STYLES = `
  :host { display: block; height: 100%; }
  .page-tile { display: flex; flex-direction: column; height: 100%; padding: 0.5rem; gap: 0.25rem; }
  .page-tile__title { font-size: 0.95rem; font-weight: 600; }
  .page-tile__summary { font-size: 0.8rem; opacity: 0.8; flex: 1 1 auto; }
  .page-tile__link { font-size: 0.75rem; }
  .page-tile__body { flex: 1 1 auto; overflow: auto; }
  .page-tile__error { padding: 0.5rem; font-size: 0.8rem; }
  .page-tile__error pre { overflow: auto; font-size: 0.7rem; opacity: 0.8; }
`;

/** Thrown by `setConfig` when the config names a page that is not registered. */
export class PageWidgetError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PageWidgetError';
  }
}

export class HavenPageWidget extends ElementBase {
  #config = null;
  #origConfig = null;
  #page = null;
  #data = null;
  #shadow;
  #nodes = null;
  /** Which page the body currently shows, so a re-render can be skipped. */
  #renderedPage = null;
  #pages;

  constructor({ pages = pageRegistry } = {}) {
    super();
    this.#pages = pages;
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  /**
   * Validates and **throws** when the page does not exist.
   *
   * The schema can check that `pageId` is a non-empty string; it cannot check
   * that a page by that id was registered. So this is the one check left, and
   * it throws so the host renders the fallback tile with the bad config
   * preserved — a widget pointing at a deleted page can then be repointed
   * rather than only deleted.
   */
  setConfig(config) {
    this.#origConfig = config;

    const page = this.#pages.get(config?.pageId);
    if (!page) {
      throw new PageWidgetError(`No page is registered as "${config?.pageId ?? ''}".`);
    }

    this.#config = config;
    this.#page = page;
    this.render();
    return this.#config;
  }

  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  get page() {
    return this.#page;
  }

  /**
   * The widget declares no `dataSource`, so this is not called in normal
   * operation. As with the iframe widget it patches rather than rebuilding,
   * so a future data source cannot make a page's DOM churn.
   */
  onData(data) {
    this.#data = data;
    this.render();
  }

  onResize() {
    // Nothing size-dependent: the page's own CSS handles its layout, and
    // re-running a page's render on every resize would throw away any DOM
    // state it holds.
  }

  render() {
    if (!this.#config || !this.#page) return;

    if (this.#data?.state === 'error') {
      this.#renderError(this.#data.errors?.[0]?.message ?? 'Page unavailable');
      return;
    }

    const nodes = this.#ensureScaffold();
    const full = this.#config.mode === MODES.FULL;

    setText(nodes.title, this.#page.title);

    nodes.summary.hidden = full;
    nodes.link.hidden = full;
    nodes.body.hidden = !full;

    if (!full) {
      setText(nodes.summary, this.#page.summary);
      setText(nodes.link, 'Open the page');
      const href = routeFor(this.#page.id);
      if (nodes.link.getAttribute('href') !== href) nodes.link.setAttribute('href', href);
      return;
    }

    // Render the page body once per page. Re-running it on every render would
    // discard whatever DOM state the page holds — the same diff-and-patch rule
    // the iframe widget exists to demonstrate, applied to authored content.
    if (this.#renderedPage === this.#page.id) return;

    const target = document.createElement('div');
    target.className = 'page-tile__inner';
    try {
      this.#page.render(target, { documentRef: document, inWidget: true });
    } catch (error) {
      // A page that throws renders a fallback and never blanks the dashboard.
      this.#renderError(error instanceof Error ? error.message : String(error));
      return;
    }
    nodes.body.replaceChildren(target);
    this.#renderedPage = this.#page.id;
  }

  #ensureScaffold() {
    if (this.#nodes) return this.#nodes;

    const style = document.createElement('style');
    style.textContent = STYLES;

    const tile = document.createElement('div');
    tile.className = 'page-tile';

    const title = document.createElement('span');
    title.className = 'page-tile__title';

    const summary = document.createElement('p');
    summary.className = 'page-tile__summary';

    const link = document.createElement('a');
    link.className = 'page-tile__link';

    const body = document.createElement('div');
    body.className = 'page-tile__body';
    body.hidden = true;

    tile.append(title, summary, link, body);
    this.#shadow.replaceChildren(style, tile);

    this.#nodes = { tile, title, summary, link, body };
    return this.#nodes;
  }

  #renderError(message) {
    const box = document.createElement('div');
    box.className = 'page-tile__error';

    const heading = document.createElement('strong');
    heading.textContent = 'Page unavailable';

    const detail = document.createElement('p');
    // textContent, never innerHTML.
    detail.textContent = message;

    const dump = document.createElement('pre');
    dump.textContent = JSON.stringify(this.#origConfig ?? {}, null, 2);

    box.append(heading, detail, dump);

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.#shadow.replaceChildren(style, box);

    this.#nodes = null;
    this.#renderedPage = null;
  }

  /**
   * The page's title, for the global index.
   *
   * DESIGN §5: "Custom HTML pages contribute their title". Because this widget
   * declares no `dataSource` it never reaches `Dashboard#push`, so this is
   * read by `Dashboard#add` at insertion time instead — which is the whole
   * reason that branch exists.
   *
   * The entry's `url` is the page's ROUTE, not `#widget-id`: a search result
   * for "Library Analytics" should open the page, not scroll to the tile that
   * links to it.
   */
  getSearchEntries() {
    if (!this.#page) return [];
    return [
      {
        id: `page:${this.#page.id}`,
        title: this.#page.title,
        subtitle: this.#page.summary,
        url: routeFor(this.#page.id),
        keywords: ['page', ...this.#page.keywords],
      },
    ];
  }

  destroy() {
    this.#config = null;
    this.#page = null;
    this.#data = null;
    this.#nodes = null;
    this.#renderedPage = null;
  }
}

function setText(node, value) {
  const next = value ?? '';
  if (node.textContent !== next) node.textContent = next;
}

export function definePageWidget(tag = 'haven-widget-page') {
  if (!globalThis.customElements?.get(tag)) {
    globalThis.customElements?.define(tag, HavenPageWidget);
  }
  return tag;
}
