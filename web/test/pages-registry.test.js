/**
 * The custom-page registry, the DOM helpers, and the Library Analytics page.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createFakeDocument } from './helpers/fake-dom.js';
import { PageError, PageRegistry, normalisePage, routeFor } from '../src/pages/registry.js';
import { el, link, section, stat, table } from '../src/pages/page-dom.js';
import {
  describeAge,
  formatBytes,
  formatCount,
  formatShare,
  libraryAnalyticsPage,
  qualityRows,
  render,
  sizeRows,
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

test('a declared load() survives registration', () => {
  // THE regression this pins, and it shipped: `normalisePage` returns an
  // allowlisted frozen object, and `load` was not on the list. So a page could
  // declare a loader, register cleanly, and have it silently dropped — the
  // router only calls it when `typeof page.load === 'function'`, so Library
  // Analytics rendered "Loading library statistics…" forever while its
  // connector was answering perfectly.
  //
  // Deleting the `...(definition.load ? ...)` spread in `normalisePage` fails
  // this test and nothing else in the unit suite, which is precisely why the
  // bug survived: every other test calls `render`/`load` directly instead of
  // going through the registry.
  const load = async () => ({ status: 'ok' });
  const page = normalisePage({ ...PAGE, load });

  assert.equal(typeof page.load, 'function');
  assert.equal(page.load, load);
});

test('a page without a load() simply has none', () => {
  // The optionality is real — a static page declares no loader, and the router
  // must not try to call one.
  const page = normalisePage(PAGE);
  assert.equal(page.load, undefined);
});

test('a load that is not a function is refused at registration', () => {
  // Fail at registration rather than at navigation: a truthy non-function
  // would otherwise be carried through and throw inside the router, far from
  // the definition that caused it.
  assert.throws(() => normalisePage({ ...PAGE, load: 'soon' }), PageError);
  assert.throws(() => normalisePage({ ...PAGE, load: {} }), PageError);
});

test('the real Library Analytics page reaches the registry with its loader', () => {
  // The end-to-end version of the above, against the ACTUAL exported
  // definition rather than a fixture — this is the pairing that was broken in
  // production, so it is asserted on the real object.
  const pages = new PageRegistry();
  pages.register(libraryAnalyticsPage);

  assert.equal(typeof pages.get('library-analytics').load, 'function');
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
  assert.equal(formatBytes(undefined), '—');
  assert.equal(formatBytes(0), '—');
});

test('byte sizes are binary and lose precision as they grow', () => {
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(4 * 1024 ** 3), '4.0 GB');
  // Past 100 in a unit the decimal is noise, so it is dropped.
  assert.equal(formatBytes(512 * 1024 ** 3), '512 GB');
  assert.equal(formatBytes(1024 ** 4), '1.0 TB');
});

test('a share is a percentage of the total, and never divides by zero', () => {
  assert.equal(formatShare(25, 100), '25.0%');
  // An empty library must not render NaN% or Infinity%.
  assert.equal(formatShare(0, 0), '—');
  assert.equal(formatShare(5, undefined), '—');
});

test('the age of the snapshot is described in words', () => {
  // This sentence is what decides whether someone trusts the figures below it.
  assert.equal(describeAge(0), 'updated today');
  assert.equal(describeAge(1), 'updated yesterday');
  assert.equal(describeAge(62), 'updated 62 days ago');
  assert.equal(describeAge(null), 'age unknown');
});

test('quality rows carry count, size and share', () => {
  const rows = qualityRows(
    [
      { quality: 'Bluray-1080p', count: 3, bytes: 75 },
      { quality: 'SDTV', count: 1, bytes: 25 },
    ],
    100
  );

  assert.deepEqual(rows[0], ['Bluray-1080p', '3', '75 B', '75.0%']);
  assert.equal(rows[1][3], '25.0%');
});

test('empty size bands are kept, because a gap is information', () => {
  const rows = sizeRows([
    { label: '0–1 GB', count: 4, bytes: 100 },
    { label: '1–2 GB', count: 0, bytes: 0 },
    { label: '2–4 GB', count: 2, bytes: 200 },
  ]);

  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ['1–2 GB', '0', '—']);
});

test('the page renders a loading state rather than a blank screen', () => {
  const target = doc.createElement('div');
  render(target, { documentRef: doc });

  assert.match(target.querySelector('.page__empty').textContent, /Loading library statistics/);
});

test('a failed load is rendered as a message, not thrown', () => {
  const target = doc.createElement('div');
  render(target, { documentRef: doc, error: new Error('the endpoint answered 503') });

  assert.match(target.querySelector('.page__empty').textContent, /503/);
});

test('an absent snapshot degrades to an explanation, not an error', () => {
  const target = doc.createElement('div');
  render(target, {
    documentRef: doc,
    data: { status: 'unavailable', reason: 'No media library snapshot is available.' },
  });

  assert.match(target.querySelector('.page__empty').textContent, /No media library snapshot/);
});

/** A small invented library — deliberately not real titles. */
const FIXTURE = {
  status: 'ok',
  generatedAt: '2026-07-02T19:35:13.573Z',
  ageDays: 62,
  stale: true,
  movies: {
    count: 2,
    bytes: 3000,
    qualities: [
      { quality: 'Bluray-1080p', count: 1, bytes: 2000 },
      { quality: 'SDTV', count: 1, bytes: 1000 },
    ],
    sizes: [{ label: '0–1 GB', from: 0, to: 1, count: 2, bytes: 3000 }],
  },
  tv: {
    seriesCount: 3,
    count: 12,
    bytes: 5000,
    qualities: [{ quality: 'WEBDL-1080p', count: 12, bytes: 5000 }],
    sizes: [{ label: '0–1 GB', from: 0, to: 1, count: 12, bytes: 5000 }],
  },
};

test('the page renders the real breakdowns when it is given them', () => {
  const target = doc.createElement('div');
  render(target, { documentRef: doc, data: FIXTURE });

  assert.match(target.textContent, /At a glance/);
  assert.match(target.textContent, /Movies/);
  assert.match(target.textContent, /Bluray-1080p/);
  assert.match(target.textContent, /WEBDL-1080p/);
  // Episodes, not series, is the TV item count.
  assert.match(target.textContent, /12/);
  assert.match(target.textContent, /By quality/);
  assert.match(target.textContent, /By file size/);
});

test('a stale snapshot is called out on the page, not hidden', () => {
  // The whole reason the connector publishes an age: the deployed snapshot was
  // two months old, and a page that draws it silently is worse than no page.
  const target = doc.createElement('div');
  render(target, { documentRef: doc, data: FIXTURE });

  const notice = target.querySelector('.page__notice');
  assert.ok(notice, 'a stale snapshot must render a notice');
  assert.match(notice.textContent, /62 days ago/);
  assert.match(notice.textContent, /not current/);
});

test('a fresh snapshot states its date without the alarming wording', () => {
  const target = doc.createElement('div');
  render(target, {
    documentRef: doc,
    data: { ...FIXTURE, ageDays: 1, stale: false },
  });

  const notice = target.querySelector('.page__notice');
  assert.match(notice.textContent, /updated yesterday/);
  assert.doesNotMatch(notice.textContent, /not current/);
});

test('the page definition is registrable as-is', () => {
  const pages = new PageRegistry();
  assert.doesNotThrow(() => pages.register(libraryAnalyticsPage));
  assert.equal(pages.get('library-analytics').title, 'Library Analytics');
});
