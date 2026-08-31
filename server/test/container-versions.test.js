/**
 * The container-versions file reader.
 *
 * Every fixture here is invented: container ids are `example-*`, never a real
 * service name from anyone's stack, and no path outside a temp directory is
 * touched. See docs/SECURITY.md.
 *
 * The behaviours that matter, and which each have a test that fails when they
 * break:
 *
 *   1. The file is re-read after the TTL. A read-once-at-boot implementation
 *      passes every other test in this file and fails `re-reads the file after
 *      the ttl expires` — that is the test standing between this feature and
 *      the drift it exists to remove.
 *   2. A missing file changes nothing.
 *   3. Both accepted shapes parse, and a bad one degrades quietly.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { VERSIONS_FILE_TTL_MS, createContainerVersionsReader } from '../src/container-versions.js';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'haven-versions-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Writes a fixture file and returns its path. */
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

describe('createContainerVersionsReader — file shapes', () => {
  test('reads the envelope shape, keeping generatedAt', () => {
    const path = writeFixture('envelope.json', {
      generatedAt: '2026-08-30T09:00:00.000Z',
      versions: { 'example-container': '1.4.2', 'example-other': 'v2.0.0' },
    });

    const { versions, generatedAt } = createContainerVersionsReader({ path }).read();

    assert.deepEqual(versions, { 'example-container': '1.4.2', 'example-other': 'v2.0.0' });
    assert.equal(generatedAt, '2026-08-30T09:00:00.000Z');
  });

  test('reads a bare flat map and dates it from the file mtime', () => {
    const path = writeFixture('flat.json', { 'example-container': '3.1.0' });
    // A known mtime, so the assertion is about the value and not about "now".
    const when = new Date('2026-08-20T12:00:00.000Z');
    utimesSync(path, when, when);

    const { versions, generatedAt } = createContainerVersionsReader({ path }).read();

    assert.deepEqual(versions, { 'example-container': '3.1.0' });
    assert.equal(generatedAt, when.toISOString());
  });

  test('an envelope without generatedAt falls back to the mtime', () => {
    const path = writeFixture('no-timestamp.json', { versions: { 'example-container': '1.0.0' } });
    const when = new Date('2026-08-21T08:30:00.000Z');
    utimesSync(path, when, when);

    assert.equal(createContainerVersionsReader({ path }).read().generatedAt, when.toISOString());
  });

  test('a container literally named "versions" still reads as a flat map', () => {
    // The envelope is detected by `versions` being an OBJECT, so a flat map
    // whose key happens to be that word must not be mistaken for one.
    const path = writeFixture('collision.json', {
      versions: '9.9.9',
      'example-container': '1.0.0',
    });

    assert.deepEqual(createContainerVersionsReader({ path }).read().versions, {
      versions: '9.9.9',
      'example-container': '1.0.0',
    });
  });

  test('drops non-string and blank values rather than rendering them', () => {
    const path = writeFixture('mixed.json', {
      versions: {
        'example-good': '1.0.0',
        'example-number': 42,
        'example-nested': { version: '2.0.0' },
        'example-blank': '   ',
        'example-null': null,
      },
    });

    assert.deepEqual(createContainerVersionsReader({ path }).read().versions, {
      'example-good': '1.0.0',
    });
  });

  test('trims whitespace around a version', () => {
    const path = writeFixture('untrimmed.json', { 'example-container': '  1.2.3  ' });
    assert.equal(
      createContainerVersionsReader({ path }).read().versions['example-container'],
      '1.2.3'
    );
  });
});

describe('createContainerVersionsReader — quiet degradation', () => {
  test('a missing file yields nothing and logs nothing', () => {
    const logger = recordingLogger();
    const reader = createContainerVersionsReader({ path: join(dir, 'absent.json'), logger });

    assert.deepEqual(reader.read(), { versions: {}, generatedAt: null });
    // ENOENT is the normal state of a deployment that has not adopted the
    // file. Warning about it would train operators to ignore the log.
    assert.equal(logger.warnings.length, 0);
  });

  test('an unset path yields nothing', () => {
    assert.deepEqual(createContainerVersionsReader({ path: null }).read(), {
      versions: {},
      generatedAt: null,
    });
  });

  test('malformed JSON degrades to nothing and does not throw', () => {
    const path = writeFixture('malformed.json', '{ "example-container": ');
    const logger = recordingLogger();

    assert.deepEqual(createContainerVersionsReader({ path, logger }).read(), {
      versions: {},
      generatedAt: null,
    });
    assert.equal(logger.warnings.length, 1);
  });

  test('a JSON array degrades to nothing', () => {
    const path = writeFixture('array.json', ['example-container', '1.0.0']);
    assert.deepEqual(createContainerVersionsReader({ path }).read().versions, {});
  });

  test('warns once for a malformed file, not once per read', () => {
    // The read is per request. Without the once-guard, one bad file writes a
    // log line for every card on every dashboard refresh, forever.
    const path = writeFixture('malformed-repeat.json', 'not json at all');
    const logger = recordingLogger();
    let clock = 0;
    const reader = createContainerVersionsReader({ path, logger, now: () => clock });

    reader.read();
    clock += VERSIONS_FILE_TTL_MS * 5;
    reader.read();
    clock += VERSIONS_FILE_TTL_MS * 5;
    reader.read();

    assert.equal(logger.warnings.length, 1);
  });

  test('warns again after a broken file has recovered and broken once more', () => {
    const path = writeFixture('recovering.json', 'not json');
    const logger = recordingLogger();
    let clock = 0;
    const reader = createContainerVersionsReader({ path, logger, now: () => clock });

    reader.read();
    assert.equal(logger.warnings.length, 1);

    writeFixture('recovering.json', { 'example-container': '1.0.0' });
    clock += VERSIONS_FILE_TTL_MS;
    assert.equal(reader.read().versions['example-container'], '1.0.0');

    writeFixture('recovering.json', 'broken again');
    clock += VERSIONS_FILE_TTL_MS;
    reader.read();
    assert.equal(logger.warnings.length, 2);
  });
});

describe('createContainerVersionsReader — the read is at request time', () => {
  test('re-reads the file after the ttl expires', () => {
    // THE test for this feature. `config.js` is evaluated once at import, so a
    // version map read at boot would be frozen until the container restarts —
    // which is exactly the drift the file replaces. An implementation that
    // reads once and caches forever passes everything else here and fails
    // this.
    const path = writeFixture('ttl.json', { 'example-container': '1.0.0' });
    let clock = 0;
    const reader = createContainerVersionsReader({ path, now: () => clock });

    assert.equal(reader.read().versions['example-container'], '1.0.0');

    writeFixture('ttl.json', { 'example-container': '2.0.0' });
    clock += VERSIONS_FILE_TTL_MS + 1;

    assert.equal(reader.read().versions['example-container'], '2.0.0');
  });

  test('serves the cached read inside the ttl', () => {
    const path = writeFixture('ttl-hold.json', { 'example-container': '1.0.0' });
    let clock = 0;
    const reader = createContainerVersionsReader({ path, now: () => clock });

    assert.equal(reader.read().versions['example-container'], '1.0.0');

    writeFixture('ttl-hold.json', { 'example-container': '2.0.0' });
    clock += VERSIONS_FILE_TTL_MS - 1;

    // Still the old value: within the window the file is not consulted. This
    // is the de-duplication that keeps one dashboard refresh from stat-ing the
    // file once per card.
    assert.equal(reader.read().versions['example-container'], '1.0.0');
  });

  test('picks up a file that appears after the reader was created', () => {
    // The refresher may well start after Haven does. A boot-time read would
    // never see this file at all.
    const path = join(dir, 'appears-later.json');
    let clock = 0;
    const reader = createContainerVersionsReader({ path, now: () => clock });

    assert.deepEqual(reader.read().versions, {});

    writeFixture('appears-later.json', { 'example-container': '5.0.0' });
    clock += VERSIONS_FILE_TTL_MS + 1;

    assert.equal(reader.read().versions['example-container'], '5.0.0');
  });

  test('the default ttl is short enough to be a de-duplication window', () => {
    // A long ttl here would quietly recreate the boot-read problem. Minutes,
    // not hours.
    assert.ok(VERSIONS_FILE_TTL_MS <= 5 * 60_000, 'ttl should be minutes, not hours');
  });
});
