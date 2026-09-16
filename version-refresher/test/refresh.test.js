/**
 * Every fixture here is invented: container ids are `example-*`, never a
 * real service name from anyone's stack, and no `docker` binary is ever
 * actually invoked — `isRunningFn`/`inspectLabelFn` are faked. See
 * docs/SECURITY.md.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LABEL_SCHEMES } from '../lib/labels.mjs';
import { parseRoster, runPass } from '../lib/refresh.mjs';

describe('parseRoster', () => {
  test('parses a comma-separated name:scheme list', () => {
    const roster = parseRoster('example-a:linuxserver,example-b:oci');
    assert.deepEqual(roster, [
      { name: 'example-a', scheme: LABEL_SCHEMES.LINUXSERVER },
      { name: 'example-b', scheme: LABEL_SCHEMES.OCI },
    ]);
  });

  test('is case-insensitive on the scheme token', () => {
    const roster = parseRoster('example-a:LinuxServer');
    assert.deepEqual(roster, [{ name: 'example-a', scheme: LABEL_SCHEMES.LINUXSERVER }]);
  });

  test('empty or missing spec yields an empty roster', () => {
    assert.deepEqual(parseRoster(''), []);
    assert.deepEqual(parseRoster(undefined), []);
    assert.deepEqual(parseRoster(null), []);
  });

  test('skips a malformed entry (missing scheme) and warns once for it', () => {
    const warnings = [];
    const roster = parseRoster('example-a:oci,example-bad,example-c:linuxserver', {
      warn: (msg) => warnings.push(msg),
    });
    assert.deepEqual(roster, [
      { name: 'example-a', scheme: LABEL_SCHEMES.OCI },
      { name: 'example-c', scheme: LABEL_SCHEMES.LINUXSERVER },
    ]);
    assert.equal(warnings.length, 1);
  });

  test('skips an entry with an unrecognised scheme', () => {
    const warnings = [];
    const roster = parseRoster('example-a:not-a-real-scheme', { warn: (m) => warnings.push(m) });
    assert.deepEqual(roster, []);
    assert.equal(warnings.length, 1);
  });

  test('tolerates stray whitespace around entries', () => {
    const roster = parseRoster(' example-a:oci , example-b:linuxserver ');
    assert.deepEqual(roster, [
      { name: 'example-a', scheme: LABEL_SCHEMES.OCI },
      { name: 'example-b', scheme: LABEL_SCHEMES.LINUXSERVER },
    ]);
  });
});

describe('runPass', () => {
  const roster = [
    { name: 'example-running-oci', scheme: LABEL_SCHEMES.OCI },
    { name: 'example-running-ls', scheme: LABEL_SCHEMES.LINUXSERVER },
    { name: 'example-stopped', scheme: LABEL_SCHEMES.OCI },
    { name: 'example-no-label', scheme: LABEL_SCHEMES.OCI },
  ];

  const fakeRunning = new Set(['example-running-oci', 'example-running-ls', 'example-no-label']);
  const fakeLabels = {
    'example-running-oci': '3.2.1',
    'example-running-ls': 'Linuxserver.io version:- 9.9.9 Build-date:- 2026-01-01',
    'example-no-label': '',
  };

  function deps() {
    return {
      isRunningFn: async (name) => fakeRunning.has(name),
      inspectLabelFn: async (name) => fakeLabels[name] ?? null,
      now: () => '2026-09-16T12:00:00.000Z',
    };
  }

  test('produces the envelope shape the read half expects', async () => {
    const envelope = await runPass(roster, deps());
    assert.deepEqual(envelope, {
      generatedAt: '2026-09-16T12:00:00.000Z',
      versions: {
        'example-running-oci': '3.2.1',
        'example-running-ls': '9.9.9',
      },
    });
  });

  test('skips a container that is not running, without calling inspect', async () => {
    let inspectCalls = 0;
    const envelope = await runPass([{ name: 'example-stopped', scheme: LABEL_SCHEMES.OCI }], {
      isRunningFn: async () => false,
      inspectLabelFn: async () => {
        inspectCalls += 1;
        return '1.0.0';
      },
      now: () => '2026-09-16T12:00:00.000Z',
    });
    assert.deepEqual(envelope.versions, {});
    assert.equal(inspectCalls, 0);
  });

  test('a running container with no usable label is omitted, not an error', async () => {
    const envelope = await runPass(
      [{ name: 'example-no-label', scheme: LABEL_SCHEMES.OCI }],
      deps()
    );
    assert.deepEqual(envelope.versions, {});
  });

  test('an empty roster produces an empty-but-valid envelope', async () => {
    const envelope = await runPass([], deps());
    assert.deepEqual(envelope, { generatedAt: '2026-09-16T12:00:00.000Z', versions: {} });
  });
});
