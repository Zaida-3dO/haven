/**
 * Every fixture here is invented: container ids are `example-*`, never a
 * real service name from anyone's stack. See docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  LABEL_SCHEMES,
  buildEnvelope,
  extractVersion,
  stripLinuxServerPrefix,
} from '../lib/labels.mjs';

describe('stripLinuxServerPrefix', () => {
  test('strips the version prefix and build-date suffix', () => {
    assert.equal(
      stripLinuxServerPrefix('Linuxserver.io version:- 1.2.3 Build-date:- 2026-08-01T00:00:00Z'),
      '1.2.3'
    );
  });

  test('leaves a bare version untouched', () => {
    assert.equal(stripLinuxServerPrefix('1.2.3'), '1.2.3');
  });

  test('passes non-strings through unchanged', () => {
    assert.equal(stripLinuxServerPrefix(null), null);
    assert.equal(stripLinuxServerPrefix(undefined), undefined);
  });
});

describe('extractVersion', () => {
  test('reads and strips a LinuxServer.io label', () => {
    const labels = { build_version: 'Linuxserver.io version:- 4.5.6 Build-date:- 2026-01-01' };
    assert.equal(extractVersion(labels, LABEL_SCHEMES.LINUXSERVER), '4.5.6');
  });

  test('reads an OCI label as-is', () => {
    const labels = { 'org.opencontainers.image.version': '2.0.0' };
    assert.equal(extractVersion(labels, LABEL_SCHEMES.OCI), '2.0.0');
  });

  test('returns null when the label is absent', () => {
    assert.equal(extractVersion({}, LABEL_SCHEMES.OCI), null);
  });

  test('returns null when the label is present but empty', () => {
    assert.equal(extractVersion({ build_version: '' }, LABEL_SCHEMES.LINUXSERVER), null);
    assert.equal(extractVersion({ build_version: '   ' }, LABEL_SCHEMES.LINUXSERVER), null);
  });

  test('returns null when labels is missing or not an object', () => {
    assert.equal(extractVersion(null, LABEL_SCHEMES.OCI), null);
    assert.equal(extractVersion(undefined, LABEL_SCHEMES.OCI), null);
  });

  test('returns null when the label value is not a string', () => {
    assert.equal(extractVersion({ build_version: 42 }, LABEL_SCHEMES.LINUXSERVER), null);
  });
});

describe('buildEnvelope', () => {
  test('wraps versions with generatedAt in the envelope shape', () => {
    const envelope = buildEnvelope({ 'example-a': '1.0.0' }, '2026-09-16T00:00:00.000Z');
    assert.deepEqual(envelope, {
      generatedAt: '2026-09-16T00:00:00.000Z',
      versions: { 'example-a': '1.0.0' },
    });
  });

  test('drops empty, null and non-string values', () => {
    const envelope = buildEnvelope(
      { 'example-a': '1.0.0', 'example-b': null, 'example-c': '', 'example-d': 42 },
      '2026-09-16T00:00:00.000Z'
    );
    assert.deepEqual(envelope.versions, { 'example-a': '1.0.0' });
  });

  test('trims whitespace on the way in', () => {
    const envelope = buildEnvelope({ 'example-a': '  1.0.0  ' }, '2026-09-16T00:00:00.000Z');
    assert.deepEqual(envelope.versions, { 'example-a': '1.0.0' });
  });

  test('an empty input still produces the envelope shape with an empty map', () => {
    const envelope = buildEnvelope({}, '2026-09-16T00:00:00.000Z');
    assert.deepEqual(envelope, { generatedAt: '2026-09-16T00:00:00.000Z', versions: {} });
  });
});
