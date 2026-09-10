/**
 * Subpage routing.
 *
 * Haven is one page with a grid on it. A custom page (DESIGN §6.9) needs a
 * second view — its own route, with the shell's chrome still around it — and
 * this is the smallest thing that provides one.
 *
 * ## Hash routes, and why not paths
 *
 * A path route (`/page/library`) requires every unknown path to fall through
 * to `index.html`, in Fastify *and* in the reverse proxy in front of it. Get
 * either wrong and a refresh on a subpage 404s. A hash route needs no server
 * cooperation at all, cannot 404, and survives a static preview. The front end
 * is a static bundle; the fragment is the right tool.
 *
 * ## Sharing the fragment with `#widget-id` deep links
 *
 * `grid.js` already owns `#widget-id`, which scrolls to a widget and
 * highlights it. Both live in `location.hash`, so `parseRoute` decides which
 * is which by a single rule: **a route starts `#/`, a deep link does not.**
 * That is why `routeFor` emits `#/page/x` rather than `#page/x` — the leading
 * slash is what keeps a page called "torrents" from being mistaken for a
 * widget with that id, and vice versa.
 */

export const ROUTE = Object.freeze({
  DASHBOARD: 'dashboard',
  PAGE: 'page',
});

/**
 * Parse a `location.hash` into a route.
 *
 * Anything that is not a recognised `#/…` route — including an empty hash and
 * a bare `#widget-id` deep link — is the dashboard, so an unknown route never
 * strands the user on a blank screen.
 *
 * @returns {{ name: string, pageId?: string }}
 */
export function parseRoute(hash) {
  const value = typeof hash === 'string' ? hash : '';

  // Not a route: either empty, or a `#widget-id` deep link, which grid.js owns.
  if (!value.startsWith('#/')) return { name: ROUTE.DASHBOARD };

  const segments = value
    .slice(2)
    .split('/')
    .filter((segment) => segment !== '');

  if (segments[0] === 'page' && segments[1]) {
    // Decoded because the id came out of a URL; a page id is restricted to
    // alphanumerics and dashes at registration, so this can only ever undo an
    // encoding a browser applied.
    return { name: ROUTE.PAGE, pageId: safeDecode(segments[1]) };
  }

  return { name: ROUTE.DASHBOARD };
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether a hash change is a route change or just a deep link.
 *
 * Used so that clicking a search result for a widget does not tear the
 * dashboard down and rebuild it.
 */
export function isRouteChange(before, after) {
  const a = parseRoute(before);
  const b = parseRoute(after);
  return a.name !== b.name || a.pageId !== b.pageId;
}

/**
 * Drive a view from the URL fragment.
 *
 * The router owns *which* view is showing and nothing else: it shows or hides
 * the grid, and it asks the page registry to render into a container. It never
 * touches widgets, and the dashboard is deliberately left mounted underneath a
 * subpage rather than destroyed — tearing down every widget to look at an
 * analytics page, then rebuilding them all on the way back, would reload every
 * iframe on the board. Which is, precisely, the thing the iframe widget exists
 * to avoid.
 *
 * @returns {{ current: () => object, go: (hash: string) => void, destroy: () => void }}
 */
export function createRouter({
  pages,
  gridRoot,
  pageRoot,
  target = globalThis,
  documentRef = globalThis.document,
  onRoute = null,
} = {}) {
  if (!pages) throw new Error('createRouter: a page registry is required');
  if (!pageRoot) throw new Error('createRouter: a page container is required');

  let route = { name: ROUTE.DASHBOARD };
  let rendered = null;

  /**
   * Bumped on every view change, so an in-flight page load can tell whether
   * its result is still wanted. See `loadInto`.
   */
  let renderToken = 0;

  const showDashboard = () => {
    // Invalidate any pending load before detaching the body it would write to.
    renderToken += 1;
    pageRoot.hidden = true;
    pageRoot.replaceChildren?.();
    rendered = null;
    if (gridRoot) gridRoot.hidden = false;
  };

  const showPage = (pageId) => {
    const page = pages.get(pageId);

    if (!page) {
      // An unknown page is a stale bookmark or a removed page, not a crash.
      // It renders a legible fallback rather than silently bouncing to the
      // dashboard, so the URL that failed is still visible in the bar.
      renderMissing(pageId);
      return;
    }

    if (gridRoot) gridRoot.hidden = true;
    pageRoot.hidden = false;

    const body = documentRef.createElement('div');
    body.className = 'page__body';

    const ctx = { documentRef, route: { name: ROUTE.PAGE, pageId } };

    // A page that throws must not blank the shell — the same error-boundary
    // rule `WidgetHost` applies to widgets, applied to pages.
    try {
      page.render(body, ctx);
    } catch (error) {
      body.replaceChildren?.(errorBox(error, documentRef));
    }

    pageRoot.replaceChildren?.(header(page, documentRef), body);
    rendered = page.id;

    // A page that needs data declares a `load()`; the router fetches it and
    // re-renders. This is the page equivalent of a widget's `dataSource`, and
    // it lives here for the same reason that lives in the host: the shell
    // fetches, the view renders. A page calling `fetch` itself would be the
    // mistake `pages/registry.js` and the widget contract both warn about.
    //
    // The first render above already happened, so a page with a `load()`
    // paints its loading state immediately rather than showing nothing until
    // the request lands.
    if (typeof page.load === 'function') loadInto(page, body, ctx);
  };

  /**
   * Run a page's loader and re-render with the result.
   *
   * The `token` guard is what stops a slow response from painting over a page
   * the user has since navigated away from: by the time a request resolves the
   * route may have changed twice, and writing into a detached (or worse, a
   * reused) body would resurrect a stale view. Every render bumps the token;
   * a resolution whose token no longer matches is dropped on the floor.
   */
  const loadInto = (page, body, ctx) => {
    const token = (renderToken += 1);

    Promise.resolve()
      .then(() => page.load(ctx))
      .then(
        (data) => ({ data }),
        // A failed load is the page's problem to render, not an exception to
        // throw at the console: it gets an `error` in ctx and decides what to
        // say. This is the notice-vs-error split from docs/WIDGET-CONTRACT.md.
        (error) => ({ error })
      )
      .then((result) => {
        if (token !== renderToken) return;
        try {
          page.render(body, { ...ctx, ...result, loading: false });
        } catch (error) {
          body.replaceChildren?.(errorBox(error, documentRef));
        }
      });
  };

  const header = (page, doc) => {
    const el = doc.createElement('header');
    el.className = 'page__header';

    const title = doc.createElement('h1');
    title.className = 'page__title';
    title.textContent = page.title;

    const back = doc.createElement('a');
    back.className = 'page__back';
    back.textContent = 'Back to the dashboard';
    // An anchor, not a button: it is a navigation, so it should be
    // middle-clickable and copyable like one.
    back.setAttribute('href', '#');

    el.append?.(back, title) ?? el.appendChild(back);
    if (page.summary) {
      const summary = doc.createElement('p');
      summary.className = 'page__summary';
      summary.textContent = page.summary;
      el.appendChild(summary);
    }
    return el;
  };

  const renderMissing = (pageId) => {
    // Same invalidation as the dashboard: whatever was loading is not wanted.
    renderToken += 1;
    if (gridRoot) gridRoot.hidden = true;
    pageRoot.hidden = false;

    const box = documentRef.createElement('div');
    box.className = 'page__missing';

    const heading = documentRef.createElement('strong');
    heading.textContent = 'No such page';

    const detail = documentRef.createElement('p');
    // textContent, never innerHTML — this string came out of the URL bar.
    detail.textContent = `"${pageId}" is not a page on this dashboard.`;

    box.append?.(heading, detail);
    pageRoot.replaceChildren?.(box);
    rendered = null;
  };

  const apply = () => {
    route = parseRoute(target.location?.hash);
    if (route.name === ROUTE.PAGE) showPage(route.pageId);
    else showDashboard();
    onRoute?.(route);
  };

  const onHashChange = () => apply();
  target.addEventListener?.('hashchange', onHashChange);
  apply();

  return {
    current: () => route,
    /** The page currently rendered, or null on the dashboard. */
    renderedPage: () => rendered,
    go(hash) {
      if (target.location) target.location.hash = hash;
      apply();
    },
    refresh: apply,
    destroy() {
      // Nothing in flight should render into a torn-down router.
      renderToken += 1;
      target.removeEventListener?.('hashchange', onHashChange);
      pageRoot.replaceChildren?.();
    },
  };
}

function errorBox(error, doc) {
  const box = doc.createElement('div');
  box.className = 'page__error';

  const heading = doc.createElement('strong');
  heading.textContent = 'This page failed to render';

  const detail = doc.createElement('p');
  detail.textContent = error instanceof Error ? error.message : String(error);

  box.append?.(heading, detail);
  return box;
}
