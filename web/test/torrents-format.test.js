import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capTorrents,
  compareTorrents,
  formatEta,
  formatPercent,
  formatSize,
  formatSpeed,
  sortTorrents,
  stateLabel,
  truncateName,
} from '../src/widgets/torrents/format.js';

const torrent = (overrides = {}) => ({
  hash: 'h',
  name: 'a',
  progress: 0.5,
  state: 'downloading',
  dlspeed: 0,
  upspeed: 0,
  size: 0,
  eta: null,
  category: '',
  ...overrides,
});

test('formatSpeed reads like a speed, not a byte count', () => {
  assert.equal(formatSpeed(0), '0 B/s');
  assert.equal(formatSpeed(999), '999 B/s');
  assert.equal(formatSpeed(1_000), '1.0 kB/s');
  assert.equal(formatSpeed(250_000), '250 kB/s');
  assert.equal(formatSpeed(1_500_000), '1.5 MB/s');
  assert.equal(formatSpeed(24_000_000), '24 MB/s');
  // A missing or nonsense value must not render "NaN B/s" in a tile.
  assert.equal(formatSpeed(undefined), '0 B/s');
  assert.equal(formatSpeed(-5), '0 B/s');
});

test('formatSize scales the same way', () => {
  assert.equal(formatSize(0), '0 B');
  assert.equal(formatSize(6_000_000_000), '6.0 GB');
  assert.equal(formatSize(512), '512 B');
});

test('formatEta collapses to the two coarsest useful units', () => {
  assert.equal(formatEta(45), '45s');
  assert.equal(formatEta(90), '1m');
  assert.equal(formatEta(2_400), '40m');
  assert.equal(formatEta(3_600), '1h');
  assert.equal(formatEta(5_400), '1h 30m');
  assert.equal(formatEta(90_000), '1d 1h');
  assert.equal(formatEta(172_800), '2d');
});

test('an unknown ETA is a dash, never a confident zero', () => {
  assert.equal(formatEta(null), '—');
  assert.equal(formatEta(undefined), '—');
  assert.equal(formatEta(0), '—');
  // Rounds up, so a download with 4 seconds left never reads "0s".
  assert.equal(formatEta(3.2), '4s');
});

test('formatPercent never rounds an unfinished torrent up to 100%', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(0.42), '42%');
  assert.equal(formatPercent(1), '100%');
  // The one that matters: 99.97% is still downloading and must not claim 100%.
  assert.equal(formatPercent(0.9997), '99.9%');
  assert.equal(formatPercent(0.999), '99.9%');
});

test('stateLabel humanises the normalised states', () => {
  assert.equal(stateLabel('downloading'), 'Downloading');
  assert.equal(stateLabel('seeding'), 'Seeding');
  assert.equal(stateLabel('completed'), 'Done');
  assert.equal(stateLabel('nonsense'), 'Unknown');
});

test('truncateName keeps both ends of a long release name', () => {
  const name = 'some.very.long.release.name.2160p.WEB-DL.DDP5.1.Atmos.HEVC-GROUP.mkv';
  const short = truncateName(name, 30);

  assert.equal(short.length, 30);
  assert.ok(short.includes('…'));
  // The tail is where the distinguishing part lives — a plain CSS ellipsis
  // would cut exactly that off.
  assert.ok(short.endsWith('GROUP.mkv'), `expected the tail to survive, got ${short}`);
  assert.ok(short.startsWith('some.very'));
});

test('truncateName leaves a name that already fits alone', () => {
  assert.equal(truncateName('short.iso', 42), 'short.iso');
  assert.equal(truncateName('', 42), '');
});

test('active torrents sort first, fastest first', () => {
  const sorted = sortTorrents([
    torrent({ hash: 'done', name: 'z', state: 'completed' }),
    torrent({ hash: 'slow', name: 'b', state: 'downloading', dlspeed: 1_000 }),
    torrent({ hash: 'seed', name: 'c', state: 'seeding' }),
    torrent({ hash: 'fast', name: 'a', state: 'downloading', dlspeed: 900_000 }),
    torrent({ hash: 'stall', name: 'd', state: 'stalled' }),
  ]);

  assert.deepEqual(
    sorted.map((t) => t.hash),
    ['fast', 'slow', 'stall', 'seed', 'done']
  );
});

test('the order is stable, so the tile does not twitch between ticks', () => {
  // Two identical-looking torrents must always come back in the same order,
  // or diff-and-patch would reorder rows on every refresh for no reason.
  const a = torrent({ hash: '1', name: 'alpha', state: 'seeding' });
  const b = torrent({ hash: '2', name: 'beta', state: 'seeding' });

  assert.ok(compareTorrents(a, b) < 0);
  assert.deepEqual(
    sortTorrents([b, a]).map((t) => t.hash),
    ['1', '2']
  );
});

test('capTorrents shows the top N and counts the rest', () => {
  const many = Array.from({ length: 200 }, (_, i) =>
    torrent({ hash: String(i), name: `t${String(i).padStart(3, '0')}`, state: 'seeding' })
  );

  const { shown, hidden } = capTorrents(many, 6);

  // A tile with 200 torrents in it is not a tile.
  assert.equal(shown.length, 6);
  assert.equal(hidden, 194);
});

test('capTorrents hides nothing when everything fits', () => {
  const { shown, hidden } = capTorrents([torrent({ hash: '1' })], 6);
  assert.equal(shown.length, 1);
  assert.equal(hidden, 0);
});

test('the cap applies AFTER sorting, so the shown rows are the active ones', () => {
  const list = [
    torrent({ hash: 'done1', state: 'completed', name: 'a' }),
    torrent({ hash: 'done2', state: 'completed', name: 'b' }),
    torrent({ hash: 'active', state: 'downloading', dlspeed: 500, name: 'z' }),
  ];

  const { shown } = capTorrents(list, 1);

  assert.equal(shown[0].hash, 'active');
});
