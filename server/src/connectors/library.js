/**
 * Library analytics — a media-library snapshot, read from a file at request
 * time and aggregated before it leaves the server.
 *
 * ## Why a file, and why read per request
 *
 * The same reasoning as `container-versions.js`, for the same reasons. A
 * generator elsewhere (`build-media-library.js` on the NAS) walks the media
 * library and writes a JSON snapshot; Haven reads it. Haven does not talk to
 * Plex, Radarr or Sonarr itself — it has no credentials for them and does not
 * want any, and the snapshot already exists.
 *
 * The read is at REQUEST time behind a short TTL, not at boot. A boot read
 * would freeze the numbers for the life of the process, so every regeneration
 * would need a container restart to become visible — which is precisely the
 * drift the versions file was built to escape.
 *
 * ## Why the timestamp is not optional
 *
 * The failure mode of this design is a **dead generator**: the file stops
 * being rewritten and Haven serves months-old figures with total confidence.
 * That is not hypothetical here — the snapshot in the deployment is dated
 * 2026-07-02 and no schedule for the generator could be found. So every
 * response carries `generatedAt` and an `ageDays`, and the page renders them.
 * A library page that cannot be checked for staleness is worse than no page.
 *
 * ## Why aggregation happens HERE and not in the browser
 *
 * The old dashboard shipped the entire 385KB snapshot to the client and did
 * everything there. This does not, for two reasons:
 *
 *  1. **It is personal data.** The snapshot lists every film and series in the
 *     household, with Plex keys. The quality-and-size breakdowns the page
 *     draws need counts and totals, not titles — so titles never cross the
 *     wire and never enter a browser cache.
 *  2. It is a fraction of the bytes: a few dozen aggregate rows rather than
 *     thousands of records, on a page that is mostly big numbers anyway.
 *
 * ## Failure is always quiet
 *
 * Missing file, unreadable file, malformed JSON, wrong shape, or a snapshot
 * whose arrays are not arrays: every one degrades to a `status` the page
 * renders as a message. Nothing here throws into a request handler, and
 * nothing here can stop the server booting — the same discipline as
 * `loadSettings()` and the versions reader.
 */

import { readFileSync, statSync } from 'node:fs';

/**
 * How long a read is reused before the file is consulted again.
 *
 * Short on purpose, and for the same reason as the versions file: this
 * de-duplicates the fan-out of one page load (the subpage and a summary tile
 * can both ask at once), it is NOT a "this data is fresh for an hour" cache.
 * A newly written snapshot becomes visible within a minute with no restart.
 */
export const LIBRARY_FILE_TTL_MS = 60_000;

/** Response statuses. `ok` is the only one carrying figures. */
export const LIBRARY_STATUS = Object.freeze({
  OK: 'ok',
  UNAVAILABLE: 'unavailable',
});

/**
 * A snapshot older than this is called out in the payload.
 *
 * Not an error — a stale snapshot is still the truth about what the library
 * looked like then, and the page draws it. It is a soft notice, exactly the
 * distinction docs/WIDGET-CONTRACT.md draws between a notice and an error.
 */
export const STALE_AFTER_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** A finite, positive number, or 0. Sizes from a file are untrusted. */
function safeSize(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** A non-empty trimmed string, or the fallback. */
function safeName(value, fallback = 'Unknown') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

/**
 * Reads and parses the snapshot file.
 *
 * @returns {{snapshot: object, mtime: string|null}|null} null when the file
 *   gave us nothing usable.
 */
function readSnapshotFile(path, logger) {
  let text;
  let mtime;

  try {
    text = readFileSync(path, 'utf8');
    try {
      mtime = statSync(path).mtime.toISOString();
    } catch {
      // An unreadable stat on a readable file is not worth failing over; the
      // snapshot carries its own `generatedAt` anyway.
      mtime = null;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      // Bad permissions, or a directory where a file was expected. Say so.
      logger?.warn?.({ path, err: error }, 'could not read media library snapshot');
    }
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    logger?.warn?.({ path, err: error }, 'media library snapshot is not valid JSON — ignoring');
    return null;
  }

  if (!isPlainObject(parsed)) {
    logger?.warn?.({ path }, 'media library snapshot is not an object — ignoring');
    return null;
  }

  return { snapshot: parsed, mtime };
}

/**
 * Roll a list of `{ quality, size }` records up into per-quality rows.
 *
 * Exported because it is the whole arithmetic of the page and deserves to be
 * tested without a file or a server. Rows come back ordered by `qualityOrder`
 * when the snapshot supplies one — that array is the generator's own
 * best-to-worst ranking, and honouring it is what makes the table read as a
 * quality ladder rather than an arbitrary list. Anything not in the ranking
 * sorts last, by descending count, so an unrecognised quality is still shown.
 */
export function summariseByQuality(records, qualityOrder = []) {
  const rank = new Map(qualityOrder.map((name, index) => [name, index]));
  const byQuality = new Map();

  let count = 0;
  let bytes = 0;

  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const quality = safeName(record.quality);
    const size = safeSize(record.size);

    count += 1;
    bytes += size;

    const row = byQuality.get(quality) ?? { quality, count: 0, bytes: 0 };
    row.count += 1;
    row.bytes += size;
    byQuality.set(quality, row);
  }

  const qualities = [...byQuality.values()].sort((a, b) => {
    const ra = rank.has(a.quality) ? rank.get(a.quality) : Number.POSITIVE_INFINITY;
    const rb = rank.has(b.quality) ? rank.get(b.quality) : Number.POSITIVE_INFINITY;
    if (ra !== rb) return ra - rb;
    if (b.count !== a.count) return b.count - a.count;
    return a.quality.localeCompare(b.quality);
  });

  return { count, bytes, qualities };
}

/**
 * Size-distribution band edges, in GB.
 *
 * Fixed boundaries rather than the old page's data-driven quantile buckets.
 * The quantile version existed to make a 20-bar histogram look good at any
 * scale; this page draws a short table, where fixed, nameable bands ("4–8 GB")
 * are more legible and — unlike quantiles — comparable between two snapshots
 * and between movies and episodes. The last band is open-ended.
 */
export const SIZE_BUCKETS_GB = Object.freeze([0, 1, 2, 4, 8, 16, 32]);

const GB = 1024 * 1024 * 1024;

/**
 * Bucket a list of `{ size }` records by size.
 *
 * Returns one row per band, including empty ones: a gap in the middle of a
 * distribution is information, and a table that silently omits it reads as if
 * the bands were different.
 */
export function summariseBySize(records, edges = SIZE_BUCKETS_GB) {
  const rows = edges.map((lo, index) => ({
    label: index === edges.length - 1 ? `${lo} GB+` : `${lo}–${edges[index + 1]} GB`,
    from: lo,
    to: index === edges.length - 1 ? null : edges[index + 1],
    count: 0,
    bytes: 0,
  }));

  for (const record of records) {
    if (!isPlainObject(record)) continue;
    const size = safeSize(record.size);
    const gb = size / GB;

    // Walk down from the top band so the open-ended last one catches
    // everything above its lower edge; comparing against `from` makes the
    // bands half-open and gapless.
    let index = rows.length - 1;
    while (index > 0 && gb < rows[index].from) index -= 1;

    rows[index].count += 1;
    rows[index].bytes += size;
  }

  return rows;
}

/**
 * Flatten a `series` array into a list of episode records.
 *
 * The snapshot nests episodes under each series; every size and quality figure
 * on the TV side is per-episode, so this is the list the summaries want. A
 * series with a missing or non-array `episodes` contributes nothing rather
 * than throwing.
 */
export function flattenEpisodes(series) {
  const episodes = [];
  for (const show of series) {
    if (!isPlainObject(show) || !Array.isArray(show.episodes)) continue;
    for (const episode of show.episodes) {
      if (isPlainObject(episode)) episodes.push(episode);
    }
  }
  return episodes;
}

/**
 * Turn a raw snapshot into the payload the page draws.
 *
 * Exported for tests, and pure: no file, no clock beyond the one passed in.
 * Titles, years, slugs and Plex keys are all dropped here — this function is
 * the boundary at which personal data stops travelling.
 */
export function summariseSnapshot(snapshot, { mtime = null, now = Date.now } = {}) {
  const movies = Array.isArray(snapshot.movies) ? snapshot.movies : [];
  const series = Array.isArray(snapshot.series) ? snapshot.series : [];
  const qualityOrder = Array.isArray(snapshot.qualityOrder)
    ? snapshot.qualityOrder.filter((q) => typeof q === 'string')
    : [];

  const episodes = flattenEpisodes(series);

  const generatedAt =
    typeof snapshot.generatedAt === 'string' && snapshot.generatedAt ? snapshot.generatedAt : mtime;

  // Age is computed from the timestamp we are about to publish, so the two can
  // never disagree. An unparseable timestamp yields a null age rather than NaN.
  const generatedMs = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  const ageDays = Number.isFinite(generatedMs)
    ? Math.max(0, Math.floor((now() - generatedMs) / MS_PER_DAY))
    : null;

  const movieSummary = summariseByQuality(movies, qualityOrder);
  const episodeSummary = summariseByQuality(episodes, qualityOrder);

  return {
    status: LIBRARY_STATUS.OK,
    generatedAt: generatedAt ?? null,
    ageDays,
    // A soft notice, not an error: the figures are still drawn.
    stale: ageDays === null || ageDays >= STALE_AFTER_DAYS,
    movies: {
      count: movieSummary.count,
      bytes: movieSummary.bytes,
      qualities: movieSummary.qualities,
      sizes: summariseBySize(movies),
    },
    tv: {
      // Series count is the number of shows; every other TV figure is per
      // episode. Conflating the two is the easiest way to make this page lie.
      seriesCount: series.filter(isPlainObject).length,
      count: episodeSummary.count,
      bytes: episodeSummary.bytes,
      qualities: episodeSummary.qualities,
      sizes: summariseBySize(episodes),
    },
  };
}

/** The payload served when there is no usable snapshot. */
export function unavailable(reason = 'No media library snapshot is available.') {
  return {
    status: LIBRARY_STATUS.UNAVAILABLE,
    reason,
    generatedAt: null,
    ageDays: null,
    stale: false,
    movies: null,
    tv: null,
  };
}

/**
 * A request-time reader for the snapshot, with its own TTL and cache.
 *
 * An object rather than module-level state, so tests can hold several
 * independent readers with an injected clock and the server owns one
 * explicitly instead of sharing a hidden global — the same shape as
 * `createContainerVersionsReader`.
 *
 * @param {object} [opts]
 * @param {string} [opts.path] file to read
 * @param {number} [opts.ttlMs] reuse window
 * @param {object} [opts.logger] Fastify-style logger
 * @param {() => number} [opts.now] injectable clock, for tests
 */
export function createLibraryConnector({
  path,
  ttlMs = LIBRARY_FILE_TTL_MS,
  logger,
  now = Date.now,
} = {}) {
  let cached = null;
  let readAt = -Infinity;

  /**
   * Whether we have already complained about this file.
   *
   * The read is per request and a broken file stays broken, so without this
   * one bad snapshot writes a warning line on every page load forever. Reset
   * on a successful read, so a file that breaks again later is reported again.
   */
  let warned = false;

  const quietLogger = logger && {
    warn: (...args) => {
      if (warned) return;
      warned = true;
      logger.warn?.(...args);
    },
  };

  return {
    /**
     * The current summary, re-read when the TTL has expired.
     *
     * Always returns a payload — never throws, never null.
     */
    read() {
      if (!path) return unavailable('No snapshot path is configured.');

      const at = now();
      if (cached !== null && at - readAt < ttlMs) return cached;

      const file = readSnapshotFile(path, quietLogger);
      if (file) warned = false;

      cached = file ? summariseSnapshot(file.snapshot, { mtime: file.mtime, now }) : unavailable();
      readAt = at;
      return cached;
    },
  };
}
