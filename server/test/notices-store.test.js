import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { test } from 'node:test';
import { migrate } from '../src/db/migrate.js';
import { parseNotice } from '../src/notices/envelope.js';
import {
  DEFAULT_TTL_MS,
  DUE_GRACE_MS,
  deleteNoticesFrom,
  dismissNotice,
  expiryFor,
  getNotice,
  getNoticeAction,
  listLiveNotices,
  noticeKey,
  purgeExpiredNotices,
  restoreNotice,
  upsertNotices,
} from '../src/db/notices-store.js';

/**
 * Storage is where "sensible expiry" and "dismissal, persisted" actually live,
 * so these tests are mostly about time passing and about a source re-posting
 * its feed — the two things a dashboard running for a year does constantly.
 */

const NOW = Date.parse('2026-09-01T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

function freshDb(t) {
  const db = new Database(':memory:');
  migrate(db);
  t.after(() => db.close());
  return db;
}

const notice = (overrides = {}) =>
  parseNotice({
    id: 'bin-day',
    severity: 'warn',
    title: 'Recycling goes out tonight',
    source: 'chores',
    ...overrides,
  });

const put = (db, notices, options = {}) =>
  upsertNotices(db, Array.isArray(notices) ? notices : [notices], { now: NOW, ...options });

// ── Expiry ────────────────────────────────────────────────────────────────

test('a notice with a due date expires a grace period after it', (t) => {
  // A bin day is still worth showing on the evening of the bin day.
  const due = new Date(NOW + DAY).toISOString();
  assert.equal(
    expiryFor(notice({ due }), { now: NOW }),
    new Date(NOW + DAY + DUE_GRACE_MS).toISOString()
  );
  t.diagnostic('grace is measured from the due date, not from ingest');
});

test('a notice with no due date expires on the default TTL', () => {
  // A source that goes away must not leave notices on the board forever.
  assert.equal(expiryFor(notice(), { now: NOW }), new Date(NOW + DEFAULT_TTL_MS).toISOString());
});

test('an already-overdue notice still gets a full grace window from now', () => {
  // A source catching up after a restart should not post notices that are
  // invisible the moment they arrive.
  const due = new Date(NOW - 30 * DAY).toISOString();
  assert.equal(
    expiryFor(notice({ due }), { now: NOW }),
    new Date(NOW + DUE_GRACE_MS).toISOString()
  );
});

test('an explicit expiry from the source wins over both rules', () => {
  // Only the source knows a delivery window closes at 18:00.
  const expiresAt = new Date(NOW + 3600_000).toISOString();
  assert.equal(
    expiryFor(notice({ due: new Date(NOW + DAY).toISOString() }), { expiresAt }),
    expiresAt
  );
});

test('an expired notice disappears from the live list', (t) => {
  const db = freshDb(t);
  put(db, notice());

  assert.equal(listLiveNotices(db, { now: NOW }).length, 1);
  assert.equal(listLiveNotices(db, { now: NOW + DEFAULT_TTL_MS + 1000 }).length, 0);
});

// ── Ordering ──────────────────────────────────────────────────────────────

test('due drives the ordering — soonest first', (t) => {
  const db = freshDb(t);
  put(db, [
    notice({ id: 'later', title: 'Later', due: new Date(NOW + 5 * DAY).toISOString() }),
    notice({ id: 'sooner', title: 'Sooner', due: new Date(NOW + 1 * DAY).toISOString() }),
    notice({ id: 'middle', title: 'Middle', due: new Date(NOW + 3 * DAY).toISOString() }),
  ]);

  assert.deepEqual(
    listLiveNotices(db, { now: NOW }).map((n) => n.title),
    ['Sooner', 'Middle', 'Later']
  );
});

test('notices with no due date sort last, whatever their severity', (t) => {
  const db = freshDb(t);
  put(db, [
    notice({ id: 'someday', title: 'Someday', severity: 'urgent' }),
    notice({
      id: 'today',
      title: 'Today',
      severity: 'info',
      due: new Date(NOW + 3600_000).toISOString(),
    }),
  ]);

  // Putting "service the boiler eventually" above something due in an hour
  // would be actively misleading.
  assert.deepEqual(
    listLiveNotices(db, { now: NOW }).map((n) => n.title),
    ['Today', 'Someday']
  );
});

test('severity breaks a tie on due date, most urgent first', (t) => {
  const db = freshDb(t);
  const due = new Date(NOW + DAY).toISOString();
  put(db, [
    notice({ id: 'c', title: 'Info thing', severity: 'info', due }),
    notice({ id: 'a', title: 'Urgent thing', severity: 'urgent', due }),
    notice({ id: 'b', title: 'Warn thing', severity: 'warn', due }),
  ]);

  assert.deepEqual(
    listLiveNotices(db, { now: NOW }).map((n) => n.severity),
    ['urgent', 'warn', 'info']
  );
});

// ── Re-ingest ─────────────────────────────────────────────────────────────

test('re-posting the same notice updates in place rather than duplicating', (t) => {
  const db = freshDb(t);
  put(db, notice());
  put(db, notice({ title: 'Recycling goes out tonight (updated)' }), { now: NOW + 60_000 });

  const live = listLiveNotices(db, { now: NOW });
  assert.equal(live.length, 1, 'a source polling every five minutes must not accumulate rows');
  assert.equal(live[0].title, 'Recycling goes out tonight (updated)');
});

test('two sources may use the same id without colliding', (t) => {
  const db = freshDb(t);
  put(db, [
    notice({ id: 'reminder', title: 'From chores', source: 'chores' }),
    notice({ id: 'reminder', title: 'From HA', source: 'home-assistant' }),
  ]);

  assert.equal(listLiveNotices(db, { now: NOW }).length, 2);
});

test('the surrogate id is namespaced by source', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice());
  assert.equal(ids[0], noticeKey('chores', 'bin-day'));
});

// ── Dismissal ─────────────────────────────────────────────────────────────

test('a dismissed notice leaves the live list but keeps its row', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice());

  assert.equal(dismissNotice(db, ids[0], { now: NOW }), true);
  assert.equal(listLiveNotices(db, { now: NOW }).length, 0);
  // The row is the tombstone — see the next test for why that matters.
  assert.ok(getNotice(db, ids[0]));
});

test('dismissal SURVIVES a re-post of identical content', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice());
  dismissNotice(db, ids[0], { now: NOW });

  // The source polls again five minutes later and re-sends the same thing.
  put(db, notice(), { now: NOW + 300_000 });

  assert.equal(
    listLiveNotices(db, { now: NOW + 300_000 }).length,
    0,
    'otherwise the user dismisses the same notice every five minutes'
  );
});

test('a dismissal is CLEARED when the content actually changes', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice({ due: new Date(NOW + DAY).toISOString() }));
  dismissNotice(db, ids[0], { now: NOW });

  // A rescheduled appointment is new information and deserves to be seen.
  put(db, notice({ due: new Date(NOW + 3 * DAY).toISOString() }), { now: NOW + 300_000 });

  assert.equal(listLiveNotices(db, { now: NOW + 300_000 }).length, 1);
});

test('dismissing twice is not an error and does not move the timestamp', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice());

  assert.equal(dismissNotice(db, ids[0], { now: NOW }), true);
  const first = getNotice(db, ids[0]).dismissedAt;

  // Two tabs each sending a dismissal is normal, not exceptional.
  assert.equal(dismissNotice(db, ids[0], { now: NOW + 60_000 }), true);
  assert.equal(getNotice(db, ids[0]).dismissedAt, first);
});

test('dismissing something that does not exist reports no match', (t) => {
  const db = freshDb(t);
  assert.equal(dismissNotice(db, 'chores:nothing', { now: NOW }), false);
});

test('a dismissal can be undone', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice());
  dismissNotice(db, ids[0], { now: NOW });

  assert.equal(restoreNotice(db, ids[0], { now: NOW }), true);
  assert.equal(listLiveNotices(db, { now: NOW }).length, 1);
});

// ── Purge ─────────────────────────────────────────────────────────────────

test('purge deletes rows only well after they expired', (t) => {
  const db = freshDb(t);
  put(db, notice());

  const justExpired = NOW + DEFAULT_TTL_MS + 1000;
  assert.equal(purgeExpiredNotices(db, { now: justExpired }), 0, 'the tombstone is still needed');

  // Long enough that a daily source has re-posted and been deduped anyway.
  assert.equal(purgeExpiredNotices(db, { now: justExpired + 2 * DAY }), 1);
  assert.equal(getNotice(db, noticeKey('chores', 'bin-day')), null);
});

test('purge leaves live notices alone', (t) => {
  const db = freshDb(t);
  put(db, notice({ due: new Date(NOW + 30 * DAY).toISOString() }));

  assert.equal(purgeExpiredNotices(db, { now: NOW }), 0);
  assert.equal(listLiveNotices(db, { now: NOW }).length, 1);
});

test('a source can be cleared entirely when it is reconfigured', (t) => {
  const db = freshDb(t);
  put(db, [notice({ id: 'a', source: 'chores' }), notice({ id: 'b', source: 'home-assistant' })]);

  assert.equal(deleteNoticesFrom(db, 'chores'), 1);
  assert.deepEqual(
    listLiveNotices(db, { now: NOW }).map((n) => n.source),
    ['home-assistant']
  );
});

// ── What crosses to the browser ───────────────────────────────────────────

test('an action target NEVER reaches the browser payload', (t) => {
  const db = freshDb(t);
  const { ids } = put(
    db,
    parseNotice({
      id: 'alarm',
      title: 'Front door unlocked',
      source: 'home-assistant',
      actions: [
        { id: 'lock', label: 'Lock it', target: 'https://ha.invalid/api/services/lock/lock' },
      ],
    })
  );

  const [action] = getNotice(db, ids[0]).actions;

  // The browser sends back an opaque id; the backend resolves what it means.
  // Shipping the target would put an internal URL in front-end JSON.
  assert.deepEqual(Object.keys(action).sort(), ['dismisses', 'id', 'label']);
  assert.equal(action.target, undefined);

  // But the server can still look it up.
  assert.equal(
    getNoticeAction(db, ids[0], 'lock').target,
    'https://ha.invalid/api/services/lock/lock'
  );
});

test('an unknown action id resolves to null rather than a partial match', (t) => {
  const db = freshDb(t);
  const { ids } = put(db, notice({ actions: [{ id: 'done', label: 'Done' }] }));

  assert.equal(getNoticeAction(db, ids[0], 'don'), null);
  assert.equal(getNoticeAction(db, 'chores:nothing', 'done'), null);
});

test('the severity CHECK constraint rejects a value the validator would have caught', (t) => {
  // Belt and braces: the envelope is the gate, but the column refuses too, so
  // a future writer that skips validation cannot store a level the widget has
  // no styling for.
  const db = freshDb(t);
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO notices (id, external_id, source, severity, title, expires_at)
           VALUES ('x:y', 'y', 'x', 'catastrophic', 'T', '2099-01-01T00:00:00.000Z')`
        )
        .run(),
    /CHECK constraint failed/
  );
});
