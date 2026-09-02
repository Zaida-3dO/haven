import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import { countStatuses } from '../src/widgets/status/count.js';
import { statusWidget, STATUS_FETCH_KEY } from '../src/widgets/status/definition.js';
import { STATUS } from '../src/lib/status.js';
import { dataSource as appsDataSource } from '../src/widgets/apps/apps-widget.js';

/** A statuses Map keyed by app id, the shape `StatusTracker.snapshot()` returns. */
const statuses = (entries) =>
  new Map(Object.entries(entries).map(([id, s]) => [id, { status: s }]));

const APPS = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

describe('countStatuses', () => {
  test('counts reachable and unreachable separately', () => {
    const result = countStatuses(
      APPS,
      statuses({ a: STATUS.REACHABLE, b: STATUS.REACHABLE, c: STATUS.UNREACHABLE })
    );

    assert.equal(result.online, 2);
    assert.equal(result.offline, 1);
    assert.equal(result.total, 3);
  });

  test('a probe still running is PENDING, not offline', () => {
    // This is the whole reason `pending` exists as its own bucket. Folding
    // CHECKING into offline is how a dashboard comes to flash
    // "0 Online / 23 Offline" for a second on every load — a genuinely
    // alarming thing to show someone whose network is entirely fine.
    const result = countStatuses(APPS, statuses({ a: STATUS.REACHABLE, b: STATUS.CHECKING }));

    assert.equal(result.online, 1);
    assert.equal(result.offline, 0, 'a probe in flight must NOT be counted as offline');
    assert.equal(result.pending, 2, 'the checking one and the one with no entry at all');
  });

  test('UNKNOWN is pending too — "cannot ask" is not an answer either', () => {
    const result = countStatuses(
      APPS,
      statuses({ a: STATUS.UNKNOWN, b: STATUS.UNKNOWN, c: STATUS.UNKNOWN })
    );

    assert.equal(result.online, 0);
    assert.equal(result.offline, 0);
    assert.equal(result.pending, 3);
  });

  test('settled is false until every app has a definite answer', () => {
    // The caller uses this to avoid presenting a partial count as if it were
    // the final one.
    const partial = countStatuses(APPS, statuses({ a: STATUS.REACHABLE }));
    assert.equal(partial.settled, false);

    const complete = countStatuses(
      APPS,
      statuses({ a: STATUS.REACHABLE, b: STATUS.UNREACHABLE, c: STATUS.REACHABLE })
    );
    assert.equal(complete.settled, true);
  });

  test('an empty registry is not "settled" — there is nothing to have settled', () => {
    const result = countStatuses([], statuses({}));

    assert.equal(result.total, 0);
    assert.equal(result.settled, false);
  });

  test('online + offline + pending always equals total', () => {
    // The invariant the caller relies on to know whether it has a complete
    // picture. If these three ever stop summing, a count is being lost or
    // double-counted somewhere.
    const result = countStatuses(APPS, statuses({ a: STATUS.REACHABLE, b: STATUS.CHECKING }));

    assert.equal(result.online + result.offline + result.pending, result.total);
  });

  test('reads a plain object as readily as a Map', () => {
    // The tracker hands out a Map; a fixture is more readable as an object.
    const result = countStatuses(APPS, { a: { status: STATUS.REACHABLE } });

    assert.equal(result.online, 1);
    assert.equal(result.pending, 2);
  });

  test('missing and malformed input does not throw', () => {
    // The host pushes whatever the endpoint returned. A widget that throws
    // here becomes an error card on the sidebar.
    assert.deepEqual(countStatuses(), {
      total: 0,
      online: 0,
      offline: 0,
      pending: 0,
      settled: false,
    });
    assert.equal(countStatuses(null, null).total, 0);
    assert.equal(countStatuses('not an array', null).total, 0);
  });

  test('an app with no id is skipped rather than counted as pending', () => {
    // A registry row with no id cannot be probed and cannot be keyed, so
    // counting it would permanently hold `settled` at false.
    const result = countStatuses([{ id: 'a' }, {}, null], statuses({ a: STATUS.REACHABLE }));

    assert.equal(result.total, 1);
    assert.equal(result.settled, true);
  });
});

describe('the status widget definition', () => {
  test('shares the apps widget fetch key, so both cost ONE request', () => {
    // The status card and the apps grid read the same registry. If these keys
    // ever diverge the fetcher stops collapsing them and every refresh makes
    // two calls for identical data.
    const apps = appsDataSource({ showVersions: 'off' });

    assert.equal(statusWidget.dataSource().key, STATUS_FETCH_KEY);
    assert.equal(
      statusWidget.dataSource().key,
      apps.key,
      'the status widget must share the apps widget key or the fetcher cannot dedupe them'
    );
  });

  test('does not ask for versions — it counts reachability', () => {
    assert.match(statusWidget.dataSource().url, /versions=false/);
  });

  test('is not searchable', () => {
    // The apps widget already indexes every app; indexing "23 Online" would
    // only add noise to the palette.
    assert.equal(statusWidget.searchable, false);
  });

  test('refreshes on the host schedule, not a per-second poll', () => {
    assert.ok(statusWidget.refreshMs >= 60_000, 'the registry does not change second to second');
  });
});
