/**
 * Library Analytics — the first custom page (DESIGN §6.9).
 *
 * A standalone screen with its own header and nav, which is exactly why it is
 * a **subpage** rather than a widget: squeezing quality and size breakdowns
 * for two media types into a few grid cells would be worse than a tile that
 * links to it. The `page` widget's `summary` mode provides that tile.
 *
 * ## Where the data comes from
 *
 * `GET /api/widgets/library`, via the page's `load()`. The router calls it and
 * re-renders with the result (see `shell/router.js`); this module never calls
 * `fetch` at render time, because the shell owns fetching — a page reaching
 * for the network mid-render would be the same mistake as a widget owning a
 * timer.
 *
 * The server aggregates before responding, so what arrives here is a few dozen
 * summary rows and no titles. That is deliberate: the underlying snapshot
 * lists every film and series the household owns, and none of it needs to be
 * in a browser to draw a bar chart of file sizes.
 *
 * ## Staleness is rendered, not hidden
 *
 * The snapshot is written by a generator elsewhere, on a schedule nothing in
 * this repo controls — and the one in the deployment was two months old when
 * this page was built. So the age of the data is drawn at the top of the page,
 * not buried in a tooltip. A dashboard that presents a two-month-old figure as
 * today's is worse than one that shows nothing.
 */

import { el, section, stat, table } from './page-dom.js';

export const LIBRARY_ANALYTICS_ID = 'library-analytics';

/** Where the page gets its figures. */
export const LIBRARY_ENDPOINT = '/api/widgets/library';

/** Past this age the page says so in words, not just a date. */
export const STALE_AFTER_DAYS = 7;

/**
 * Format a count.
 *
 * A missing figure renders as an em dash rather than "undefined" or "0" — "we
 * do not know" and "there are none" are different facts, and a dashboard that
 * conflates them is lying.
 */
export function formatCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-GB').format(value);
}

/**
 * Format a byte count in binary units.
 *
 * Matches the old dashboard's `fmtSize`: more precision for small values,
 * none for large ones, because "1.4 GB" is useful and "1,503.27 GB" is not.
 */
export function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '—';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i += 1;
  }

  // A decimal is only worth showing while the mantissa is small: "1.5 GB" says
  // something "1.5 TB"-style precision does not, but "512.3 GB" is noise. Raw
  // byte counts get no decimal at all, since a fraction of a byte is nonsense.
  const rendered = i === 0 || n >= 100 ? Math.round(n) : n.toFixed(1);
  return `${rendered} ${units[i]}`;
}

/** A percentage of a total, for the share column. Guards divide-by-zero. */
export function formatShare(part, total) {
  if (typeof part !== 'number' || typeof total !== 'number') return '—';
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return '—';
  return `${((part / total) * 100).toFixed(1)}%`;
}

/**
 * A human phrase for the age of the snapshot.
 *
 * Exported so the wording is testable without a DOM — this is the sentence
 * that decides whether someone trusts the numbers below it.
 */
export function describeAge(ageDays) {
  if (typeof ageDays !== 'number' || !Number.isFinite(ageDays)) return 'age unknown';
  if (ageDays <= 0) return 'updated today';
  if (ageDays === 1) return 'updated yesterday';
  return `updated ${formatCount(ageDays)} days ago`;
}

/** Rows for a quality table, richest first as the connector ordered them. */
export function qualityRows(qualities = [], totalBytes = 0) {
  return qualities.map((q) => [
    q.quality,
    formatCount(q.count),
    formatBytes(q.bytes),
    formatShare(q.bytes, totalBytes),
  ]);
}

/**
 * Rows for a size-distribution table.
 *
 * Empty bands are kept rather than filtered: a gap in the middle of a
 * distribution is a fact about the library, and dropping it would make the
 * remaining bands look contiguous when they are not.
 */
export function sizeRows(sizes = []) {
  return sizes.map((band) => [band.label, formatCount(band.count), formatBytes(band.bytes)]);
}

/** The staleness banner, or null when the data is fresh enough to pass without comment. */
function freshnessNote(data, doc) {
  const stale = data.stale || (typeof data.ageDays === 'number' && data.ageDays >= STALE_AFTER_DAYS);

  const when = data.generatedAt
    ? new Date(data.generatedAt).toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
      })
    : 'an unknown date';

  const text = `Snapshot from ${when} — ${describeAge(data.ageDays)}.`;

  return el(
    'p',
    {
      // The class carries the severity so CSS can colour it; the sentence
      // carries the fact so it is legible without the CSS.
      class: stale ? 'page__notice page__notice--stale' : 'page__notice',
      text: stale
        ? `${text} The generator that writes it may no longer be running — these figures are not current.`
        : text,
    },
    doc
  );
}

/** One media type's block: headline figures, quality table, size table. */
function mediaSection(title, summary, doc, { itemNoun, extraStat = null }) {
  const stats = [
    ...(extraStat ? [stat(extraStat.label, extraStat.value, doc)] : []),
    stat(itemNoun, formatCount(summary.count), doc),
    stat('Total size', formatBytes(summary.bytes), doc),
    stat('Qualities', formatCount(summary.qualities?.length), doc),
  ];

  const children = [el('div', { class: 'page__stats', children: stats }, doc)];

  if (summary.qualities?.length) {
    children.push(
      el('h3', { class: 'page__subheading', text: 'By quality' }, doc),
      table(['Quality', itemNoun, 'Size', 'Share'], qualityRows(summary.qualities, summary.bytes), doc)
    );
  }

  if (summary.sizes?.length) {
    children.push(
      el('h3', { class: 'page__subheading', text: 'By file size' }, doc),
      table(['Size band', itemNoun, 'Total'], sizeRows(summary.sizes), doc)
    );
  }

  return section(title, children, doc);
}

/**
 * Render the page.
 *
 * Called twice per visit: once immediately with no data (the loading state),
 * then again when `load()` resolves. Both are first-class renders — a page
 * that shows nothing while fetching looks broken.
 *
 * @param {HTMLElement} target where to build
 * @param {{ data?: object, error?: Error, loading?: boolean, documentRef?: Document }} [ctx]
 */
export function render(target, ctx = {}) {
  const doc = ctx.documentRef ?? globalThis.document;
  const { data, error } = ctx;

  if (error) {
    target.replaceChildren(
      el(
        'p',
        {
          class: 'page__empty',
          text: `Library statistics could not be loaded: ${error.message ?? String(error)}`,
        },
        doc
      )
    );
    return target;
  }

  if (!data) {
    // The loading state. Also what a caller with no loader at all sees, which
    // is why it reads as "not yet" rather than "never".
    target.replaceChildren(
      el('p', { class: 'page__empty', text: 'Loading library statistics…' }, doc)
    );
    return target;
  }

  if (data.status !== 'ok' || !data.movies || !data.tv) {
    // No snapshot on disk. This is a configuration state, not a failure, so it
    // says what is missing rather than showing an error box.
    target.replaceChildren(
      el(
        'p',
        {
          class: 'page__empty',
          text:
            data.reason ??
            'No media library snapshot is available yet — once the generator writes one, its breakdowns appear here.',
        },
        doc
      )
    );
    return target;
  }

  const totalBytes = (data.movies.bytes ?? 0) + (data.tv.bytes ?? 0);

  const overview = section(
    'At a glance',
    [
      el(
        'div',
        {
          class: 'page__stats',
          children: [
            stat('Movies', formatCount(data.movies.count), doc),
            stat('Series', formatCount(data.tv.seriesCount), doc),
            stat('Episodes', formatCount(data.tv.count), doc),
            stat('Total size', formatBytes(totalBytes), doc),
          ],
        },
        doc
      ),
    ],
    doc
  );

  target.replaceChildren(
    freshnessNote(data, doc),
    overview,
    mediaSection('Movies', data.movies, doc, { itemNoun: 'Movies' }),
    mediaSection('TV', data.tv, doc, {
      itemNoun: 'Episodes',
      // Series count belongs beside the episode figures, because every other
      // number in this block is per-episode and the two are easy to confuse.
      extraStat: { label: 'Series', value: formatCount(data.tv.seriesCount) },
    })
  );

  return target;
}

/**
 * Fetch the page's figures.
 *
 * A non-OK response throws, so the router hands the page an `error` to render.
 * The one exception is a 200 carrying `status: "unavailable"`, which is not an
 * error at all — it is the server saying the snapshot is absent, and `render`
 * has a state for exactly that.
 */
export async function load({ fetchImpl = globalThis.fetch } = {}) {
  const response = await fetchImpl(LIBRARY_ENDPOINT, { headers: { accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`The library endpoint answered ${response.status}.`);
  }
  return response.json();
}

/** The page definition, for `pages/registry.js`. */
export const libraryAnalyticsPage = {
  id: LIBRARY_ANALYTICS_ID,
  title: 'Library Analytics',
  summary: 'Quality and size breakdowns across the movie and TV library.',
  keywords: ['library', 'analytics', 'stats', 'media', 'plex', 'movies', 'tv'],
  render,
  load,
};
