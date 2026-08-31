/**
 * Pure formatting and ordering for the torrents widget.
 *
 * Kept separate from the element so the fiddly parts — the ones that are
 * actually easy to get subtly wrong, like an ETA that reads "0m" or a speed
 * that reads "0.9765625 KB/s" — can be tested as plain functions with no DOM
 * at all.
 */

/**
 * A speed, in the units a human reads at a glance.
 *
 * Decimal units (kB = 1000), matching what qBittorrent itself displays, so the
 * tile and the app it mirrors do not disagree about the same number.
 */
const SPEED_UNITS = ['B/s', 'kB/s', 'MB/s', 'GB/s'];

export function formatSpeed(bytesPerSecond) {
  const n = Number(bytesPerSecond);
  if (!Number.isFinite(n) || n <= 0) return '0 B/s';

  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < SPEED_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  // One decimal below 10 (2.4 MB/s reads better than 2 MB/s), none above it —
  // nobody needs to know it is 247.3 kB/s rather than 247.
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${SPEED_UNITS[unit]}`;
}

const SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';

  let value = n;
  let unit = 0;
  while (value >= 1000 && unit < SIZE_UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = unit === 0 || value >= 10 ? 0 : 1;
  return `${value.toFixed(digits)} ${SIZE_UNITS[unit]}`;
}

/**
 * An ETA in seconds, as the coarsest useful two units.
 *
 * `null` (qBittorrent's "unknown", or a torrent that is not moving) is an em
 * dash rather than "0s" — a confident zero is worse than an honest blank.
 * Rounding is deliberately *up* at the bottom end so a download that has 4
 * seconds left never reads "0s" while it is still going.
 */
export function formatEta(seconds) {
  const n = Number(seconds);
  if (seconds === null || seconds === undefined || !Number.isFinite(n) || n <= 0) return '—';

  if (n < 60) return `${Math.ceil(n)}s`;

  const minutes = Math.floor(n / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const restMinutes = minutes % 60;
    return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
}

export function formatPercent(progress) {
  const n = Number(progress);
  if (!Number.isFinite(n)) return '0%';
  const pct = Math.min(Math.max(n, 0), 1) * 100;
  // Never round 99.7% up to "100%" — a torrent that says 100% but is still
  // downloading is the single most confusing thing this tile could show.
  const shown = pct >= 100 ? 100 : Math.min(Math.floor(pct * 10) / 10, 99.9);
  return `${Number.isInteger(shown) ? shown : shown.toFixed(1)}%`;
}

/** Human labels for the normalised states the connector emits. */
const STATE_LABELS = new Map([
  ['downloading', 'Downloading'],
  ['seeding', 'Seeding'],
  ['stalled', 'Stalled'],
  ['paused', 'Paused'],
  ['completed', 'Done'],
  ['queued', 'Queued'],
  ['checking', 'Checking'],
  ['moving', 'Moving'],
  ['error', 'Error'],
  ['unknown', 'Unknown'],
]);

export function stateLabel(state) {
  return STATE_LABELS.get(state) ?? 'Unknown';
}

/**
 * Sort order: what you actually want to see in a small tile.
 *
 * Anything moving comes first, ordered by how fast it is moving, because that
 * is the thing you opened the dashboard to check. Then stalled and queued,
 * then everything finished. Ties break on name so the list does not shuffle
 * between ticks — an unstable order would defeat diff-and-patch and make the
 * tile visibly twitch.
 */
const STATE_RANK = new Map([
  ['downloading', 0],
  ['moving', 1],
  ['checking', 1],
  ['stalled', 2],
  ['queued', 3],
  ['error', 4],
  ['seeding', 5],
  ['paused', 6],
  ['completed', 7],
  ['unknown', 8],
]);

export function compareTorrents(a, b) {
  const rank = (STATE_RANK.get(a.state) ?? 9) - (STATE_RANK.get(b.state) ?? 9);
  if (rank !== 0) return rank;

  // Within "downloading", the fastest first.
  if (a.state === 'downloading') {
    const speed = (b.dlspeed ?? 0) - (a.dlspeed ?? 0);
    if (speed !== 0) return speed;
  }

  return String(a.name).localeCompare(String(b.name));
}

export function sortTorrents(torrents = []) {
  return [...torrents].sort(compareTorrents);
}

/**
 * Take the top `limit`, and report how many were left out.
 *
 * A tile with 200 torrents in it is not a tile. The overflow count is not
 * decoration — without it the widget would silently lie about how much is
 * going on.
 */
export function capTorrents(torrents = [], limit = 6) {
  const sorted = sortTorrents(torrents);
  if (sorted.length <= limit) return { shown: sorted, hidden: 0 };
  return { shown: sorted.slice(0, limit), hidden: sorted.length - limit };
}

/**
 * Shorten a name for a narrow tile, keeping the end.
 *
 * The end is where the distinguishing part of a release name lives (the
 * resolution, the edition, the disc number), so a middle ellipsis keeps far
 * more information than a trailing one. CSS truncation alone cannot do this —
 * `text-overflow: ellipsis` only ever cuts the tail.
 */
export function truncateName(name, max = 42) {
  const text = String(name ?? '');
  if (text.length <= max || max < 8) return text;

  // Leave a little more at the front than the back: the title reads first.
  const head = Math.ceil((max - 1) * 0.6);
  const tail = max - 1 - head;
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
