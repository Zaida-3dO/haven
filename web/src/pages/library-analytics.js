/**
 * Library Analytics — the first custom page (DESIGN §6.9).
 *
 * Today this is a standalone page with its own header, nav and refresh, which
 * is exactly why it becomes a **subpage** rather than a widget: it is a whole
 * screen, and squeezing it into a few grid cells would be worse than a tile
 * that links to it. The `page` widget's `summary` mode provides that tile.
 *
 * ## What this page does and does not do
 *
 * It renders whatever `ctx.stats` it is given, and renders an empty state when
 * it is given nothing. It does **not** fetch: the shell owns fetching, and a
 * page reaching for `fetch` would be the same mistake as a widget owning a
 * timer. When a real `/api/widgets/library` connector lands, the shell passes
 * its payload in through `ctx.stats` and nothing here changes.
 *
 * The numbers below are therefore structure, not data. There is no fixture
 * with real library contents in this repo, deliberately — the media a
 * household owns is personal, and CLAUDE.md is explicit that it does not go in
 * a public repo, not even as a test fixture.
 */

import { el, section, stat, table } from './page-dom.js';

export const LIBRARY_ANALYTICS_ID = 'library-analytics';

/**
 * Format a count for a stat tile.
 *
 * A missing figure renders as an em dash rather than "undefined" or "0" — "we
 * do not know" and "there are none" are different facts and a dashboard that
 * conflates them is lying.
 */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-GB').format(value);
}

/** Hours, from a duration in minutes. Same unknown-vs-zero rule. */
export function formatHours(minutes) {
  if (typeof minutes !== 'number' || !Number.isFinite(minutes)) return '—';
  const hours = Math.round(minutes / 60);
  return `${new Intl.NumberFormat('en-GB').format(hours)} h`;
}

/**
 * Rows for the "largest collections" table, sorted and capped.
 *
 * Pure and exported so the sort and the cap are testable without a DOM.
 */
export function topCollections(collections = [], limit = 5) {
  return [...collections]
    .filter((c) => c && typeof c.name === 'string')
    .sort((a, b) => (b.items ?? 0) - (a.items ?? 0))
    .slice(0, limit)
    .map((c) => [c.name, formatCount(c.items), formatHours(c.minutes)]);
}

/**
 * Render the page.
 *
 * @param {HTMLElement} target where to build
 * @param {{ stats?: object, documentRef?: Document }} [ctx]
 */
export function render(target, ctx = {}) {
  const doc = ctx.documentRef ?? globalThis.document;
  const stats = ctx.stats ?? null;

  if (!stats) {
    // The empty state is a first-class render, not a blank screen: a page with
    // no connector yet should say so rather than looking broken.
    target.replaceChildren(
      el(
        'p',
        {
          class: 'page__empty',
          text: 'No library statistics yet — connect a library source to populate this page.',
        },
        doc
      )
    );
    return target;
  }

  const summary = section(
    'At a glance',
    [
      el(
        'div',
        {
          class: 'page__stats',
          children: [
            stat('Items', formatCount(stats.items), doc),
            stat('Collections', formatCount(stats.collections?.length), doc),
            stat('Watch time', formatHours(stats.minutes), doc),
            stat('Added this month', formatCount(stats.addedThisMonth), doc),
          ],
        },
        doc
      ),
    ],
    doc
  );

  const rows = topCollections(stats.collections);
  const collections = section(
    'Largest collections',
    [
      rows.length
        ? table(['Collection', 'Items', 'Watch time'], rows, doc)
        : el('p', { class: 'page__empty', text: 'No collections yet.' }, doc),
    ],
    doc
  );

  target.replaceChildren(summary, collections);
  return target;
}

/** The page definition, for `pages/registry.js`. */
export const libraryAnalyticsPage = {
  id: LIBRARY_ANALYTICS_ID,
  title: 'Library Analytics',
  summary: 'Items, collections and watch time across the library.',
  keywords: ['library', 'analytics', 'stats', 'media'],
  render,
};
