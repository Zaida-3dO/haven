/**
 * The data payload the host pushes into every widget, modelled on Grafana's
 * `PanelData` — the best-designed part of any of the prior-art APIs.
 *
 *   { state: 'loading' | 'done' | 'error', value, errors, revision }
 *
 * The `revision` counter is the point. It lets a widget tell "the data
 * changed" from "the same data arrived again" without a deep compare, which is
 * what makes "never re-render on every data tick — diff and patch" cheap to
 * obey. A widget stores the last revision it drew and returns early otherwise;
 * that is what keeps a data update from blowing away a WebGL canvas.
 *
 * Revisions are monotonic per source, and are only bumped when the value
 * actually differs — see `nextRevision`.
 */

export const LOADING = 'loading';
export const DONE = 'done';
export const ERROR = 'error';

/**
 * A soft notice is NOT a hard error.
 *
 * Glance distinguishes `Notice` (stale cache, still usable) from `Error`.
 * Stale data rendered with a marker beats an error box, so a payload carrying
 * `notices` stays in state `done` — the widget draws its data and the host
 * draws the marker.
 */
function freeze(payload) {
  return Object.freeze({
    ...payload,
    errors: Object.freeze(payload.errors ?? []),
    notices: Object.freeze(payload.notices ?? []),
  });
}

export function loadingData(previous = null) {
  return freeze({
    state: LOADING,
    // Keep the last good value visible while a refresh is in flight, so a
    // periodic refetch does not flash every tile back to a spinner.
    value: previous?.value ?? null,
    errors: [],
    notices: previous?.notices ?? [],
    revision: previous?.revision ?? 0,
    receivedAt: previous?.receivedAt ?? null,
  });
}

export function doneData(value, { previous = null, notices = [], receivedAt = Date.now() } = {}) {
  return freeze({
    state: DONE,
    value,
    errors: [],
    notices,
    revision: nextRevision(previous, value),
    receivedAt,
  });
}

/**
 * A hard error. The last known value is deliberately retained: a widget that
 * can show stale data plus an error marker is more useful than an empty tile,
 * and the host decides which to draw.
 */
export function errorData(error, { previous = null, receivedAt = Date.now() } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  return freeze({
    state: ERROR,
    value: previous?.value ?? null,
    errors: [{ message }],
    notices: previous?.notices ?? [],
    revision: previous?.revision ?? 0,
    receivedAt,
  });
}

/**
 * Stale-but-usable cached data: state `done`, plus a notice explaining why.
 * This is the soft-notice path, and it is what a failed refresh over a warm
 * cache produces.
 */
export function staleData(value, { previous = null, reason = 'Showing cached data' } = {}) {
  return doneData(value, { previous, notices: [{ message: reason, stale: true }] });
}

/**
 * Bump the revision only when the value actually changed.
 *
 * A shallow JSON comparison is enough and is the cheap half of the deal: the
 * host pays one serialisation per fetch so that every widget can skip a deep
 * compare per tick.
 */
export function nextRevision(previous, value) {
  const prevRevision = previous?.revision ?? 0;
  if (!previous || previous.state === LOADING) return prevRevision + 1;
  return sameValue(previous.value, value) ? prevRevision : prevRevision + 1;
}

function sameValue(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Circular or otherwise unserialisable: assume it changed rather than
    // silently withholding an update.
    return false;
  }
}
