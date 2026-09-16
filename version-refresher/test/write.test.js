/**
 * No path outside a temp directory is touched. See docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { writeEnvelope } from '../lib/write.mjs';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'haven-refresher-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('writes valid JSON matching the given envelope, and leaves no .tmp file behind', () => {
  const path = join(dir, 'container-versions.json');
  const envelope = { generatedAt: '2026-09-16T00:00:00.000Z', versions: { 'example-a': '1.0.0' } };

  writeEnvelope(path, envelope);

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), envelope);
  assert.equal(existsSync(`${path}.tmp`), false);
});

test('a second write replaces the file contents (does not merge)', () => {
  const path = join(dir, 'overwrite.json');
  writeEnvelope(path, { generatedAt: 'a', versions: { x: '1' } });
  writeEnvelope(path, { generatedAt: 'b', versions: { y: '2' } });

  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
    generatedAt: 'b',
    versions: { y: '2' },
  });
});

/**
 * The regression this file exists for. Haven runs as `node` and this sidecar
 * runs as root; they share only the ./config bind mount. A file written under
 * a restrictive umask is group/other-unreadable, Haven's read half degrades
 * quietly exactly as it does for a missing file, and the dashboard shows no
 * current version while the refresher logs a successful write every pass.
 *
 * The umask is set deliberately here rather than trusting the ambient one:
 * 0027 is what produced the observed `rw-rw----` on the QNAP, and under it a
 * plain `writeFileSync(..., { mode: 0o644 })` yields 0640 — so this test
 * fails against the masked-mode implementation and passes only with the
 * explicit chmod. Skipped on Windows, where POSIX mode bits are not modelled.
 */
test(
  'the file is readable by other users, even under a restrictive umask',
  { skip: process.platform === 'win32' },
  () => {
    const path = join(dir, 'perms.json');
    const previousUmask = process.umask(0o027);
    try {
      writeEnvelope(path, { generatedAt: 'c', versions: { z: '3' } });
    } finally {
      process.umask(previousUmask);
    }

    const mode = statSync(path).mode & 0o777;
    assert.equal(
      mode,
      0o644,
      `expected 0644 so Haven's user can read it, got 0${mode.toString(8)}`
    );
  }
);
