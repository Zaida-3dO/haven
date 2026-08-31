/**
 * Subpage routing.
 *
 * The rule most worth pinning is the one that keeps routes and `#widget-id`
 * deep links apart, since they share `location.hash` and `grid.js` already
 * owns the deep-link half.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';
import { ROUTE, createRouter, isRouteChange, parseRoute } from '../src/shell/router.js';
import { PageRegistry, routeFor } from '../src/pages/registry.js';

// ── parsing ──────────────────────────────────────────────────────────────

test('a #/page/ route resolves to that page', () => {
  assert.deepEqual(parseRoute('#/page/library-analytics'), {
    name: ROUTE.PAGE,
    pageId: 'library-analytics',
  });
});

test('an empty hash is the dashboard', () => {
  assert.equal(parseRoute('').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute('#').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute(undefined).name, ROUTE.DASHBOARD);
});

test('a #widget-id deep link is NOT a route', () => {
  // Both live in location.hash. A route starts `#/`; a deep link does not.
  assert.equal(parseRoute('#torrents').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute('#clock-local').name, ROUTE.DASHBOARD);
});

test('a widget whose id collides with the route grammar is still a deep link', () => {
  // The case that actually pins the rule. A widget with the id `page` — or
  // `page/library-analytics`, which a hand-written link could produce — must
  // not be parsed as a route just because it shares the first word. The
  // leading slash is the ONLY thing separating the two namespaces, so this is
  // the test that fails if `#/` is ever loosened to `#`.
  assert.equal(parseRoute('#page').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute('#page/library-analytics').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute('#page/library-analytics').pageId, undefined);
});

test('an unknown route falls back to the dashboard rather than a blank screen', () => {
  assert.equal(parseRoute('#/nonsense/thing').name, ROUTE.DASHBOARD);
  assert.equal(parseRoute('#/page').name, ROUTE.DASHBOARD);
});

test('routeFor and parseRoute round-trip', () => {
  const route = parseRoute(routeFor('library-analytics'));
  assert.equal(route.name, ROUTE.PAGE);
  assert.equal(route.pageId, 'library-analytics');
});

test('isRouteChange ignores a deep-link change', () => {
  // Clicking a widget search result must not tear the dashboard down.
  assert.equal(isRouteChange('#clock-local', '#torrents'), false);
  assert.equal(isRouteChange('', '#/page/library-analytics'), true);
  assert.equal(isRouteChange('#/page/a', '#/page/b'), true);
});

// ── rendering ────────────────────────────────────────────────────────────

function harness({ hash = '', pages: definitions = [] } = {}) {
  const documentRef = createFakeDocument();
  const pages = new PageRegistry();
  for (const definition of definitions) pages.register(definition);

  const gridRoot = new FakeElement('div');
  const pageRoot = new FakeElement('div');

  const listeners = new Map();
  const target = {
    location: { hash },
    addEventListener: (type, handler) => listeners.set(type, handler),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type) => listeners.get(type)?.(),
  };

  const router = createRouter({ pages, gridRoot, pageRoot, target, documentRef });
  return { router, gridRoot, pageRoot, target, pages };
}

const LIBRARY = {
  id: 'library-analytics',
  title: 'Library Analytics',
  summary: 'Items and watch time.',
  render: (target, ctx) => {
    const doc = ctx.documentRef;
    const p = doc.createElement('p');
    p.className = 'built-by-page';
    p.textContent = 'page content';
    target.replaceChildren(p);
  },
};

test('the dashboard route shows the grid and hides the page container', () => {
  const { gridRoot, pageRoot } = harness({ pages: [LIBRARY] });
  assert.equal(gridRoot.hidden, false);
  assert.equal(pageRoot.hidden, true);
});

test('a page route hides the grid and renders the page with the shell chrome', () => {
  const { router, gridRoot, pageRoot } = harness({
    hash: '#/page/library-analytics',
    pages: [LIBRARY],
  });

  assert.equal(gridRoot.hidden, true, 'the grid should be hidden behind a subpage');
  assert.equal(pageRoot.hidden, false);
  assert.equal(router.renderedPage(), 'library-analytics');

  // Chrome: the page's own title and a way back.
  assert.equal(pageRoot.querySelector('.page__title').textContent, 'Library Analytics');
  assert.ok(pageRoot.querySelector('.page__back'), 'expected a back link');
  // The page's own content, built by its render function.
  assert.equal(pageRoot.querySelector('.built-by-page').textContent, 'page content');
});

test('navigating back to the dashboard restores the grid', () => {
  const { router, gridRoot, pageRoot } = harness({
    hash: '#/page/library-analytics',
    pages: [LIBRARY],
  });

  router.go('');

  assert.equal(gridRoot.hidden, false);
  assert.equal(pageRoot.hidden, true);
  assert.equal(router.renderedPage(), null);
});

test('a hashchange re-applies the route', () => {
  const { router, target, gridRoot } = harness({ pages: [LIBRARY] });

  target.location.hash = '#/page/library-analytics';
  target.fire('hashchange');

  assert.equal(router.current().name, ROUTE.PAGE);
  assert.equal(gridRoot.hidden, true);
});

test('an unknown page renders a legible fallback, not a crash', () => {
  const { pageRoot, router } = harness({ hash: '#/page/gone', pages: [LIBRARY] });

  const missing = pageRoot.querySelector('.page__missing');
  assert.ok(missing, 'expected a fallback for a stale bookmark');
  assert.match(missing.textContent, /gone/);
  assert.equal(router.renderedPage(), null);
});

test('a page that throws renders an error box instead of blanking the shell', () => {
  const exploding = {
    id: 'broken',
    title: 'Broken',
    render: () => {
      throw new Error('page blew up');
    },
  };
  const { pageRoot } = harness({ hash: '#/page/broken', pages: [exploding] });

  const box = pageRoot.querySelector('.page__error');
  assert.ok(box, 'a throwing page must not take the shell down');
  assert.match(box.textContent, /page blew up/);
  // The chrome is still there, so there is still a way back.
  assert.ok(pageRoot.querySelector('.page__back'));
});

test('destroy removes the listener and clears the container', () => {
  const { router, target, pageRoot } = harness({
    hash: '#/page/library-analytics',
    pages: [LIBRARY],
  });

  router.destroy();

  assert.equal(pageRoot.children.length, 0);
  // A fired event after destroy must do nothing.
  target.location.hash = '#/page/library-analytics';
  target.fire('hashchange');
  assert.equal(pageRoot.children.length, 0);
});
