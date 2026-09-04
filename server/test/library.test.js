/**
 * The media-library snapshot connector.
 *
 * Every fixture here is invented. Titles are `Example …`, never a real film or
 * series from anyone's library, and no path outside a temp directory is
 * touched — the production snapshot is a list of everything the household
 * owns, and it has no business in a test repository. See docs/SECURITY.md.
 *
 * The behaviours that matter, each with a test that fails when it breaks:
 *
 *   1. **A missing snapshot degrades to an honest empty state.** The deployment
 *      may not have the file at all; that must render as "no snapshot yet",
 *      never as an error and never as a throw. `read()` returning `unavailable`
 *      rather than throwing is the whole degradation contract.
 *   2. **The read is at request time, behind a TTL.** A boot-time read would
 *      freeze the figures until the container restarts — the exact drift the
 *      versions file was built to escape.
 *   3. **Staleness is surfaced.** The failure mode of this design is a dead
 *      generator serving months-old numbers with confidence, so `generatedAt`,
 *      `ageDays` and `stale` must be derived and must agree with each other.
 *   4. **Aggregation is correct and total.** Per-quality and per-band counts
 *      must sum to the overall count, or the page silently loses records.
 *   5. **Titles never leave the server.** The connector is the boundary at
 *      which personal data stops; a summary containing a title is a leak.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import {
  LIBRARY_FILE_TTL_MS,
  LIBRARY_STATUS,
  SIZE_BUCKETS_GB,
  STALE_AFTER_DAYS,
  createLibraryConnector,
  flattenEpisodes,
  summariseByQuality,
  summariseBySize,
  summariseSnapshot,
  unavailable,
} from '../src/connectors/library.js';

const GB = 1024 * 1024 * 1024;

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'haven-library-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a fixture snapshot and returns its path. */
function writeFixture(name, contents) {
  const path = join(dir, name);
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8');
  return path;
}

/** A logger that records rather than prints, so warnings can be asserted on. */
function recordingLogger() {
  const warnings = [];
  return { warnings, warn: (...args) => warnings.push(args) };
}

/**
 * A small, entirely invented snapshot.
 *
 * Deliberately not uniform: two qualities on the movie side with a known
 * count/byte split, one series with episodes across two qualities, and one
 * quality (`SDTV`) absent from `qualityOrder` so the unranked-sorts-last rule
 * has something to act on.
 */
function sampleSnapshot(overrides = {}) {
  return {
    generatedAt: '2026-09-01T00:00:00.000Z',
    qualityOrder: ['Bluray-1080p', 'WEBDL-720p'],
    movies: [
      { title: 'Example Alpha', year: 2001, size: 5 * GB, quality: 'Bluray-1080p' },
      { title: 'Example Beta', year: 2002, size: 3 * GB, quality: 'Bluray-1080p' },
      { title: 'Example Gamma', year: 2003, size: 1.5 * GB, quality: 'WEBDL-720p' },
      { title: 'Example Delta', year: 2004, size: 0.5 * GB, quality: 'SDTV' },
    ],
    series: [
      {
        title: 'Example Series One',
        seasons: 1,
        episodes: [
          { season: 1, size: 2 * GB, quality: 'Bluray-1080p' },
          { season: 1, size: 1 * GB, quality: 'WEBDL-720p' },
        ],
      },
      {
        title: 'Example Series Two',
        seasons: 1,
        episodes: [{ season: 1, size: 6 * GB, quality: 'Bluray-1080p' }],
      },
    ],
    ...overrides,
  };
}

/** A clock fixed just after the sample snapshot was generated. */
const justAfterSample = () => Date.parse('2026-09-02T00:00:00.000Z');

describe('library connector — a missing snapshot degrades honestly', () => {
  test('a missing file yields an unavailable payload rather than throwing', () => {
    // THE degradation test. A deployment that has never run the generator is a
    // normal state, not a broken one: the page must be able to render "no
    // snapshot yet". An implementation that throws, or returns null, or
    // fabricates zeroes that look like an empty library, fails here.
    const logger = recordingLogger();
    const reader = createLibraryConnector({ path: join(dir, 'absent.json'), logger });

    const result = reader.read();

    assert.equal(result.status, LIBRARY_STATUS.UNAVAILABLE);
    assert.equal(result.movies, null);
    assert.equal(result.tv, null);
    assert.equal(result.generatedAt, null);
    assert.equal(result.ageDays, null);
    // Absent is not stale: there is nothing to be out of date.
    assert.equal(result.stale, false);
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0, 'an unavailable payload must say why');
  });

  test('a missing file is not warned about', () => {
    // ENOENT is the normal state of a deployment that has not adopted the
    // file. Warning would train operators to ignore the log.
    const logger = recordingLogger();
    createLibraryConnector({ path: join(dir, 'absent-quiet.json'), logger }).read();

    assert.equal(logger.warnings.length, 0);
  });

  test('zero counts are distinguishable from no snapshot at all', () => {
    // The distinction this asserts is the reason `unavailable` exists as a
    // separate status: an empty library and an absent file are different
    // facts, and a page that renders them identically is lying about one.
    const empty = summariseSnapshot(
      { generatedAt: '2026-09-01T00:00:00.000Z', movies: [], series: [] },
      { now: justAfterSample }
    );

    assert.equal(empty.status, LIBRARY_STATUS.OK);
    assert.equal(empty.movies.count, 0);
    assert.notEqual(empty.status, unavailable().status);
  });

  test('an unset path yields unavailable without touching the disk', () => {
    const result = createLibraryConnector({ path: null }).read();
    assert.equal(result.status, LIBRARY_STATUS.UNAVAILABLE);
  });

  test('malformed JSON degrades to unavailable and warns', () => {
    const path = writeFixture('malformed.json', '{ "movies": [');
    const logger = recordingLogger();

    const result = createLibraryConnector({ path, logger }).read();

    assert.equal(result.status, LIBRARY_STATUS.UNAVAILABLE);
    assert.equal(logger.warnings.length, 1);
  });

  test('a JSON array degrades to unavailable', () => {
    // The snapshot is an object. An array parses as valid JSON but has no
    // `movies`, and must not be walked as though it did.
    const path = writeFixture('array.json', [{ title: 'Example Alpha' }]);
    assert.equal(createLibraryConnector({ path }).read().status, LIBRARY_STATUS.UNAVAILABLE);
  });

  test('a snapshot whose arrays are not arrays still summarises', () => {
    // Wrong-shaped but present: the file exists and parsed, so this is `ok`
    // with nothing in it rather than `unavailable`. Notably it must not throw
    // trying to iterate a string.
    const path = writeFixture('wrong-shape.json', {
      generatedAt: '2026-09-01T00:00:00.000Z',
      movies: 'not an array',
      series: { nope: true },
    });

    const result = createLibraryConnector({ path, now: justAfterSample }).read();

    assert.equal(result.status, LIBRARY_STATUS.OK);
    assert.equal(result.movies.count, 0);
    assert.equal(result.tv.count, 0);
    assert.equal(result.tv.seriesCount, 0);
  });

  test('warns once for a broken file, not once per read', () => {
    // The read is per request. Without the once-guard, one bad snapshot writes
    // a log line on every page load, forever.
    const path = writeFixture('malformed-repeat.json', 'not json at all');
    const logger = recordingLogger();
    let clock = 0;
    const reader = createLibraryConnector({ path, logger, now: () => clock });

    reader.read();
    clock += LIBRARY_FILE_TTL_MS * 5;
    reader.read();
    clock += LIBRARY_FILE_TTL_MS * 5;
    reader.read();

    assert.equal(logger.warnings.length, 1);
  });

  test('warns again after a broken file recovered and broke once more', () => {
    const path = writeFixture('recovering.json', 'not json');
    const logger = recordingLogger();
    let clock = 0;
    const reader = createLibraryConnector({ path, logger, now: () => clock });

    reader.read();
    assert.equal(logger.warnings.length, 1);

    writeFixture('recovering.json', sampleSnapshot());
    clock += LIBRARY_FILE_TTL_MS + 1;
    assert.equal(reader.read().status, LIBRARY_STATUS.OK);

    writeFixture('recovering.json', 'broken again');
    clock += LIBRARY_FILE_TTL_MS + 1;
    reader.read();
    assert.equal(logger.warnings.length, 2);
  });
});

describe('library connector — the read is at request time', () => {
  test('re-reads the file after the ttl expires', () => {
    // THE freshness test. A snapshot read once at boot would be frozen until
    // the container restarts, so a regenerated file would never appear. An
    // implementation that caches forever passes everything else and fails this.
    const path = writeFixture('ttl.json', sampleSnapshot());
    let clock = Date.parse('2026-09-02T00:00:00.000Z');
    const reader = createLibraryConnector({ path, now: () => clock });

    assert.equal(reader.read().movies.count, 4);

    writeFixture('ttl.json', sampleSnapshot({ movies: [] }));
    clock += LIBRARY_FILE_TTL_MS + 1;

    assert.equal(reader.read().movies.count, 0);
  });

  test('serves the cached read inside the ttl', () => {
    const path = writeFixture('ttl-hold.json', sampleSnapshot());
    let clock = Date.parse('2026-09-02T00:00:00.000Z');
    const reader = createLibraryConnector({ path, now: () => clock });

    assert.equal(reader.read().movies.count, 4);

    writeFixture('ttl-hold.json', sampleSnapshot({ movies: [] }));
    clock += LIBRARY_FILE_TTL_MS - 1;

    // Still 4: inside the window the file is not consulted. This is the
    // de-duplication that stops one page load stat-ing the file repeatedly.
    assert.equal(reader.read().movies.count, 4);
  });

  test('picks up a snapshot that appears after the reader was created', () => {
    // The generator may well run for the first time after Haven starts. A
    // boot-time read would never see this file at all.
    const path = join(dir, 'appears-later.json');
    let clock = Date.parse('2026-09-02T00:00:00.000Z');
    const reader = createLibraryConnector({ path, now: () => clock });

    assert.equal(reader.read().status, LIBRARY_STATUS.UNAVAILABLE);

    writeFixture('appears-later.json', sampleSnapshot());
    clock += LIBRARY_FILE_TTL_MS + 1;

    assert.equal(reader.read().status, LIBRARY_STATUS.OK);
  });

  test('the default ttl is short enough to be a de-duplication window', () => {
    // A long ttl would quietly recreate the boot-read problem.
    assert.ok(LIBRARY_FILE_TTL_MS <= 5 * 60_000, 'ttl should be minutes, not hours');
  });
});

describe('library connector — staleness is surfaced', () => {
  test('derives ageDays from generatedAt', () => {
    const result = summariseSnapshot(sampleSnapshot(), {
      now: () => Date.parse('2026-09-11T00:00:00.000Z'),
    });

    assert.equal(result.generatedAt, '2026-09-01T00:00:00.000Z');
    assert.equal(result.ageDays, 10);
  });

  test('flags a snapshot older than the threshold as stale', () => {
    // The real deployment's snapshot was 62 days old. This is the assertion
    // that makes that visible instead of presenting it as today's figures.
    const result = summariseSnapshot(sampleSnapshot(), {
      now: () => Date.parse('2026-09-01T00:00:00.000Z') + (STALE_AFTER_DAYS + 1) * 86_400_000,
    });

    assert.equal(result.stale, true);
  });

  test('does not flag a fresh snapshot as stale', () => {
    // The negative half — without it, `stale: true` hard-coded would pass the
    // test above and the banner would cry wolf on every fresh snapshot.
    const result = summariseSnapshot(sampleSnapshot(), {
      now: () => Date.parse('2026-09-01T00:00:00.000Z') + 86_400_000,
    });

    assert.equal(result.stale, false);
    assert.equal(result.ageDays, 1);
  });

  test('falls back to the file mtime when the snapshot carries no generatedAt', () => {
    const path = writeFixture('no-timestamp.json', sampleSnapshot({ generatedAt: undefined }));
    const when = new Date('2026-08-20T12:00:00.000Z');
    utimesSync(path, when, when);

    const result = createLibraryConnector({
      path,
      now: () => Date.parse('2026-08-21T12:00:00.000Z'),
    }).read();

    assert.equal(result.generatedAt, when.toISOString());
    assert.equal(result.ageDays, 1);
  });

  test('an unparseable timestamp yields a null age and counts as stale', () => {
    // Null rather than NaN: the page renders "age unknown", and an unknown age
    // is treated as stale because it cannot be shown to be fresh.
    const result = summariseSnapshot(sampleSnapshot({ generatedAt: 'not a date' }), {
      now: justAfterSample,
    });

    assert.equal(result.ageDays, null);
    assert.equal(result.stale, true);
  });

  test('age is never negative for a snapshot dated in the future', () => {
    // A clock skew between the generator and Haven must not render as
    // "updated -3 days ago".
    const result = summariseSnapshot(sampleSnapshot(), {
      now: () => Date.parse('2026-08-01T00:00:00.000Z'),
    });

    assert.equal(result.ageDays, 0);
  });
});

describe('library connector — aggregation', () => {
  test('per-quality counts sum to the total count', () => {
    // The invariant that catches a dropped record: if a movie fails to land in
    // any quality bucket, these two stop agreeing.
    const result = summariseSnapshot(sampleSnapshot(), { now: justAfterSample });

    const summed = result.movies.qualities.reduce((n, q) => n + q.count, 0);
    assert.equal(summed, result.movies.count);
    assert.equal(result.movies.count, 4);
  });

  test('per-quality bytes sum to the total bytes', () => {
    const result = summariseSnapshot(sampleSnapshot(), { now: justAfterSample });

    const summed = result.movies.qualities.reduce((n, q) => n + q.bytes, 0);
    assert.equal(summed, result.movies.bytes);
    assert.equal(result.movies.bytes, 10 * GB);
  });

  test('size bands sum to the total count', () => {
    const result = summariseSnapshot(sampleSnapshot(), { now: justAfterSample });

    const summed = result.movies.sizes.reduce((n, band) => n + band.count, 0);
    assert.equal(summed, result.movies.count);
  });

  test('groups movies by quality with the right counts and bytes', () => {
    const { qualities } = summariseByQuality(sampleSnapshot().movies, [
      'Bluray-1080p',
      'WEBDL-720p',
    ]);
    const bluray = qualities.find((q) => q.quality === 'Bluray-1080p');

    assert.equal(bluray.count, 2);
    assert.equal(bluray.bytes, 8 * GB);
  });

  test('orders qualities by the snapshot own ranking, unranked last', () => {
    // `SDTV` is absent from qualityOrder. It must still be shown — dropping an
    // unrecognised quality would silently lose records — but it sorts last.
    const { qualities } = summariseByQuality(sampleSnapshot().movies, [
      'Bluray-1080p',
      'WEBDL-720p',
    ]);

    assert.deepEqual(
      qualities.map((q) => q.quality),
      ['Bluray-1080p', 'WEBDL-720p', 'SDTV']
    );
  });

  test('counts series and episodes separately', () => {
    // The easiest way for this page to lie is to conflate a series count with
    // an episode count. Two series, three episodes.
    const result = summariseSnapshot(sampleSnapshot(), { now: justAfterSample });

    assert.equal(result.tv.seriesCount, 2);
    assert.equal(result.tv.count, 3);
    assert.equal(result.tv.bytes, 9 * GB);
  });

  test('flattens episodes across series', () => {
    assert.equal(flattenEpisodes(sampleSnapshot().series).length, 3);
  });

  test('a series with no episodes array contributes nothing rather than throwing', () => {
    const episodes = flattenEpisodes([
      { title: 'Example Broken', seasons: 1 },
      { title: 'Example Also Broken', episodes: 'not an array' },
      null,
      { title: 'Example Fine', episodes: [{ season: 1, size: GB, quality: 'WEBDL-720p' }] },
    ]);

    assert.equal(episodes.length, 1);
  });

  test('places a file in the band whose lower edge it meets', () => {
    // Bands are half-open and gapless: exactly 4 GB belongs to "4–8", not
    // "2–4". An off-by-one here shifts every boundary file.
    const rows = summariseBySize([{ size: 4 * GB }]);
    const populated = rows.filter((r) => r.count > 0);

    assert.equal(populated.length, 1);
    assert.equal(populated[0].from, 4);
  });

  test('the last band is open-ended and catches very large files', () => {
    const rows = summariseBySize([{ size: 500 * GB }]);
    const last = rows[rows.length - 1];

    assert.equal(last.count, 1);
    assert.equal(last.to, null);
  });

  test('keeps empty bands rather than dropping them', () => {
    // A gap in a distribution is information. Filtering empty bands would make
    // the remaining ones look contiguous when they are not.
    const rows = summariseBySize([{ size: 5 * GB }]);

    assert.equal(rows.length, SIZE_BUCKETS_GB.length);
    assert.ok(rows.some((r) => r.count === 0));
  });

  test('treats a missing or nonsense size as zero rather than NaN', () => {
    // One bad record must not poison the total for every other one.
    const { bytes, count } = summariseByQuality([
      { quality: 'WEBDL-720p', size: GB },
      { quality: 'WEBDL-720p' },
      { quality: 'WEBDL-720p', size: 'huge' },
      { quality: 'WEBDL-720p', size: -5 },
    ]);

    assert.equal(count, 4);
    assert.equal(bytes, GB);
  });

  test('names a record with no quality rather than dropping it', () => {
    const { qualities, count } = summariseByQuality([{ size: GB }]);

    assert.equal(count, 1);
    assert.equal(qualities.length, 1);
    assert.equal(qualities[0].quality, 'Unknown');
  });
});

describe('library connector — personal data stops here', () => {
  test('no title, year, slug or plex key survives aggregation', () => {
    // The snapshot lists every film and series the household owns. The page
    // draws counts and totals, so titles have no reason to cross the wire —
    // and a serialised summary is the exact thing that would carry them.
    const result = summariseSnapshot(sampleSnapshot(), { now: justAfterSample });
    const serialised = JSON.stringify(result);

    for (const leak of [
      'Example Alpha',
      'Example Beta',
      'Example Gamma',
      'Example Delta',
      'Example Series One',
      'Example Series Two',
    ]) {
      assert.ok(!serialised.includes(leak), `summary leaked "${leak}"`);
    }

    assert.ok(!serialised.includes('plexKey'));
    assert.ok(!serialised.includes('slug'));
  });

  test('the payload is small regardless of how large the library is', () => {
    // A thousand movies must not produce a thousand-record payload — the whole
    // point of aggregating server-side rather than shipping the snapshot.
    const movies = Array.from({ length: 1000 }, (_, i) => ({
      title: `Example Movie ${i}`,
      year: 2000,
      size: GB,
      quality: i % 2 ? 'Bluray-1080p' : 'WEBDL-720p',
    }));

    const result = summariseSnapshot(sampleSnapshot({ movies }), { now: justAfterSample });

    assert.equal(result.movies.count, 1000);
    assert.equal(result.movies.qualities.length, 2);
    assert.ok(
      JSON.stringify(result).length < 4000,
      'an aggregated payload should not grow with the library'
    );
  });
});
