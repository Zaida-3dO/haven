/**
 * No path outside a temp directory is touched. See docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
