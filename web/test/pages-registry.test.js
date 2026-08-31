/**
 * The custom-page registry, the DOM helpers, and the Library Analytics page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDocument } from './helpers/fake-dom.js';
import { PageError, PageRegistry, normalisePage, routeFor } from '../src/pages/registry.js';
import { el, link, section, stat, table } from '../src/pages/page-dom.js';
import {
  formatCount,
  formatHours,
  libraryAnalyticsPage,
  render,
  topCollections,
} from '../src/pages/library-analytics.js';

const doc = createFakeDocument();

const PAGE = {
  id: 'library-analytics',
  title: 'Library Analytics',
  summary: 'Items and watch time.',
  render: () => {},
};

// ── the registry ─────────────────────────────────────────────────────────

test('a page registers and can be looked up', () => {
  const pages = new PageRegistry();
  pages.register(PAGE);

  assert.equal(pages.get('library-analytics').title, 'Library Analytics');
  assert.equal(pages.has('library-analytics'), true);
  assert.equal(pages.get('nope'), null);
});

test('a page needs an id, a title and a render function', () => {
  assert.throws(() => normalisePage({ title: 'x', render: () => {} }), PageError);
  assert.throws(() => normalisePage({ id: 'x', render: () => {} }), PageError);
  assert.throws(() => normalisePage({ id: 'x', title: 'x' }), PageError);
});

test('a page id must survive being put in a URL', () => {
  // The id goes straight into the route, so a bad one is caught at
  // registration rather than producing a link that does not work.
  assert.throws(() => normalisePage({ ...PAGE, id: 'library/analytics' }), PageError);
  assert.throws(() => normalisePage({ ...PAGE, id: 'a b' }), PageError);
  assert.throws(() => normalisePage({ ...PAGE, id: '#library' }), PageError);
});

test('registering the same id twice is refused', () => {
  const pages = new PageRegistry();
  pages.register(PAGE);
  assert.throws(() => pages.register(PAGE), PageError);
});

test('a page can be hidden from the nav while still being placeable', () => {
  const pages = new PageRegistry();
  pages.register(PAGE);
  pages.register({ ...PAGE, id: 'hidden', title: 'Hidden', nav: false });

  assert.deepEqual(
    pages.navPages().map((p) => p.id),
    ['library-analytics']
  );
  assert.equal(pages.has('hidden'), true);
});

test('pages contribute their title to the search index', () => {
  // DESIGN §5: "Custom HTML pages contribute their title".
  const pages = new PageRegistry();
  pages.register(PAGE);

  const [entry] = pages.searchEntries();
  assert.equal(entry.title, 'Library Analytics');
  assert.equal(entry.subtitle, 'Items and watch time.');
  // The route, so a hit opens the page rather than scrolling to a tile.
  assert.equal(entry.url, '#/page/library-analytics');
});

test('routeFor builds a hash route', () => {
  assert.equal(routeFor('library-analytics'), '#/page/library-analytics');
});

// ── the DOM helpers ──────────────────────────────────────────────────────

test('el sets text as textContent and never parses markup', () => {
  const node = el('p', { text: '<script>alert(1)</script>', class: 'x' }, doc);

  // The literal characters, because it went through textContent. If a future
  // change routed this through innerHTML, the text would be gone and there
  // would be a child element instead.
  assert.equal(node.textContent, '<script>alert(1)</script>');
  assert.equal(node.children.length, 0);
  assert.equal(node.className, 'x');
});

test('table renders every cell as text', () => {
  const node = table(['Name'], [['<img onerror=alert(1)>']], doc);
  const cell = node.querySelector('.page__td');

  assert.equal(cell.textContent, '<img onerror=alert(1)>');
  assert.equal(cell.children.length, 0);
});

test('an external link cannot reach back through window.opener', () => {
  const node = link('Docs', 'https://example.invalid', { external: true }, doc);
  assert.equal(node.getAttribute('target'), '_blank');
  assert.equal(node.getAttribute('rel'), 'noopener noreferrer');
});

test('an internal link gets no target or rel', () => {
  const node = link('Page', '#/page/x', {}, doc);
  assert.equal(node.getAttribute('target'), null);
  assert.equal(node.getAttribute('rel'), null);
});

test('section and stat build labelled structure', () => {
  const node = section('At a glance', [stat('Items', '12', doc)], doc);
  assert.equal(node.querySelector('.page__section-title').textContent, 'At a glance');
  assert.equal(node.querySelector('.page__stat-value').textContent, '12');
  assert.equal(node.querySelector('.page__stat-label').textContent, 'Items');
});

// ── Library Analytics ────────────────────────────────────────────────────

test('a missing figure renders as a dash, not as zero', () => {
  // "We do not know" and "there are none" are different facts; a dashboard
  // that conflates them is lying.
  assert.equal(formatCount(undefined), '—');
  assert.equal(formatCount(0), '0');
  assert.equal(formatCount(1234), '1,234');
  assert.equal(formatHours(undefined), '—');
  assert.equal(formatHours(120), '2 h');
});

test('collections are ranked by size and capped', () => {
  const rows = topCollections(
    [
      { name: 'Small', items: 2, minutes: 60 },
      { name: 'Big', items: 90, minutes: 600 },
      { name: 'Middle', items: 40, minutes: 300 },
    ],
    2
  );

  assert.deepEqual(
    rows.map((r) => r[0]),
    ['Big', 'Middle']
  );
});

test('the page renders an empty state rather than a blank screen', () => {
  const target = doc.createElement('div');
  render(target, { documentRef: doc });

  assert.match(target.querySelector('.page__empty').textContent, /No library statistics yet/);
});

test('the page renders stats when it is given them', () => {
  const target = doc.createElement('div');
  render(target, {
    documentRef: doc,
    stats: {
      items: 1200,
      minutes: 6000,
      addedThisMonth: 14,
      collections: [{ name: 'Films', items: 800, minutes: 5000 }],
    },
  });

  assert.match(target.textContent, /1,200/);
  assert.match(target.textContent, /Films/);
  assert.match(target.textContent, /At a glance/);
});

test('the page definition is registrable as-is', () => {
  const pages = new PageRegistry();
  assert.doesNotThrow(() => pages.register(libraryAnalyticsPage));
  assert.equal(pages.get('library-analytics').title, 'Library Analytics');
});
