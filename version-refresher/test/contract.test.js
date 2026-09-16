/**
 * Cross-checks the refresher's output against the ACTUAL read half
 * (`server/src/container-versions.js`), not a re-description of its shape.
 * This is the test that would fail if the two sides of this feature drifted
 * apart — e.g. if the read half's envelope-detection key ever changed from
 * `versions` to something else, or if the refresher started emitting a
 * differently-shaped object.
 *
 * Every fixture here is invented: container ids are `example-*`. See
 * docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { createContainerVersionsReader } from '../../server/src/container-versions.js';
import { LABEL_SCHEMES } from '../lib/labels.mjs';
import { runPass } from '../lib/refresh.mjs';
import { writeEnvelope } from '../lib/write.mjs';

let dir;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'haven-refresher-contract-'));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('a file written by the refresher is read back correctly by the read half', () => {
  const path = join(dir, 'container-versions.json');
  const roster = [
    { name: 'example-oci', scheme: LABEL_SCHEMES.OCI },
    { name: 'example-ls', scheme: LABEL_SCHEMES.LINUXSERVER },
  ];
  const fakeLabels = {
    'example-oci': '3.2.1',
    'example-ls': 'Linuxserver.io version:- 9.9.9 Build-date:- 2026-01-01',
  };

  return runPass(roster, {
    isRunningFn: async () => true,
    inspectLabelFn: async (name) => fakeLabels[name],
    now: () => '2026-09-16T12:00:00.000Z',
  }).then((envelope) => {
    writeEnvelope(path, envelope);

    const reader = createContainerVersionsReader({ path });
    const { versions, generatedAt } = reader.read();

    assert.deepEqual(versions, { 'example-oci': '3.2.1', 'example-ls': '9.9.9' });
    assert.equal(generatedAt, '2026-09-16T12:00:00.000Z');
  });
});

test('an empty pass still produces a file the read half parses cleanly', () => {
  const path = join(dir, 'empty.json');

  return runPass([], { now: () => '2026-09-16T12:00:00.000Z' }).then((envelope) => {
    writeEnvelope(path, envelope);

    const reader = createContainerVersionsReader({ path });
    const { versions, generatedAt } = reader.read();

    assert.deepEqual(versions, {});
    assert.equal(generatedAt, '2026-09-16T12:00:00.000Z');
  });
});
