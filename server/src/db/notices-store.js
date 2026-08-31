/**
 * Notice storage.
 *
 * Everything in this file exists to answer one question — "what needs the
 * user's attention right now?" — and to make sure the answer does not grow
 * without bound. A dashboard that has been running for a year must not be
 * carrying a year of bin-day reminders.
 *
 * ## Expiry, and why it is computed on ingest
 *
 * Every row carries an `expires_at`. It is derived once, when the notice
 * arrives, rather than being recomputed on every read:
 *
 *   - a notice WITH a `due` expires `DUE_GRACE_MS` after it (a bin day is
 *     still worth showing on the evening of the bin day, not at 00:01)
 *   - a notice WITHOUT a `due` expires `DEFAULT_TTL_MS` after ingest, so a
 *     source that goes away does not leave its notices on the board forever
 *   - an explicit `expiresAt` from the source always wins, because only the
 *     source knows that a delivery window closes at 18:00
 *
 * A dismissed notice keeps its row until it expires, and that is deliberate:
 * deleting it would let the next poll from the same source resurrect it
 * immediately, and the user would dismiss the same thing every five minutes.
 * The row is the tombstone.
 *
 * ## Re-ingest is an upsert
 *
 * A source polls; it re-sends the same notices. `(source, external_id)` is the
 * natural key, so a re-post updates in place. A dismissal SURVIVES a re-post
 * of identical content — see `upsertNotices` for the one case where it does
 * not, which is a notice whose content genuinely changed.
 */

/** How long a notice with a due date stays visible after it passes. */
export const DUE_GRACE_MS = 12 * 60 * 60 * 1000;

/** How long a notice with no due date lives if the source never repeats it. */
export const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows expired longer ago than this are deleted outright by `purge`. */
export const PURGE_AFTER_MS = 24 * 60 * 60 * 1000;

const iso = (ms) => new Date(ms).toISOString();

/**
 * When a notice should stop being shown.
 *
 * @param {object} notice a parsed envelope
 * @param {object} [options]
 * @param {string} [options.expiresAt] explicit expiry from the source
 * @param {number} [options.now]
 */
export function expiryFor(notice, { expiresAt = null, now = Date.now() } = {}) {
  if (expiresAt) return expiresAt;
  if (notice.due) {
    const due = Date.parse(notice.due);
    if (Number.isFinite(due)) {
      // An already-overdue notice still gets its full grace window from now,
      // rather than arriving pre-expired — a source catching up after a
      // restart should not post notices that are invisible on arrival.
      return iso(Math.max(due, now) + DUE_GRACE_MS);
    }
  }
  return iso(now + DEFAULT_TTL_MS);
}

/** The surrogate key. Opaque to the browser; stable across re-ingest. */
export const noticeKey = (source, externalId) => `${source}:${externalId}`;

/** DB row → the shape the widget receives. */
function toEnvelope(row) {
  return {
    id: row.id,
    severity: row.severity,
    title: row.title,
    body: row.body ?? null,
    due: row.due ?? null,
    source: row.source,
    url: row.url ?? null,
    // Only what the browser needs to draw a button. `target` and `method` are
    // deliberately NOT included: the browser calls back through the backend
    // with the action id, and the backend resolves what that means. Sending
    // the target would put an internal URL in front-end JSON — the exact thing
    // docs/SECURITY.md forbids.
    actions: JSON.parse(row.actions ?? '[]').map((action) => ({
      id: action.id,
      label: action.label,
      dismisses: action.dismisses !== false,
    })),
    dismissedAt: row.dismissed_at ?? null,
  };
}

/**
 * Insert or update a batch of notices, in one transaction.
 *
 * All-or-nothing: a batch that fails part-way would leave the sender unable
 * to tell what landed.
 *
 * @returns {{ written: number, ids: string[] }}
 */
export function upsertNotices(db, notices, { now = Date.now(), expiresAt = null } = {}) {
  const stamp = iso(now);

  const insert = db.prepare(`
    INSERT INTO notices (
      id, external_id, source, severity, title, body, due, url, actions,
      expires_at, created_at, updated_at
    ) VALUES (
      @id, @external_id, @source, @severity, @title, @body, @due, @url, @actions,
      @expires_at, @stamp, @stamp
    )
    ON CONFLICT (source, external_id) DO UPDATE SET
      severity     = excluded.severity,
      title        = excluded.title,
      body         = excluded.body,
      due          = excluded.due,
      url          = excluded.url,
      actions      = excluded.actions,
      expires_at   = excluded.expires_at,
      updated_at   = excluded.updated_at,
      -- A dismissal survives a re-post of the SAME notice, so a source
      -- polling every five minutes does not resurrect what the user just
      -- dismissed. It is cleared when the content actually changes: a
      -- rescheduled appointment is new information and deserves to be seen
      -- again.
      dismissed_at = CASE
        WHEN notices.title = excluded.title
         AND IFNULL(notices.body, '') = IFNULL(excluded.body, '')
         AND IFNULL(notices.due, '')  = IFNULL(excluded.due, '')
         AND notices.severity = excluded.severity
        THEN notices.dismissed_at
        ELSE NULL
      END
  `);

  const ids = [];

  const run = db.transaction(() => {
    for (const notice of notices) {
      const id = noticeKey(notice.source, notice.id);
      insert.run({
        id,
        external_id: notice.id,
        source: notice.source,
        severity: notice.severity,
        title: notice.title,
        body: notice.body,
        due: notice.due,
        url: notice.url,
        actions: JSON.stringify(notice.actions ?? []),
        expires_at: expiryFor(notice, { expiresAt, now }),
        stamp,
      });
      ids.push(id);
    }
  });

  run();
  return { written: ids.length, ids };
}

/**
 * Everything currently worth showing, soonest first.
 *
 * `due` drives the ordering (DESIGN §6.6). Notices with no due date sort
 * last — they are things to do eventually, and putting them above something
 * due in an hour would be actively misleading. Ties break on severity, then
 * on title, so the order is stable rather than depending on insertion order.
 */
export function listLiveNotices(db, { now = Date.now(), limit = 100, source = null } = {}) {
  const stamp = iso(now);

  const rows = db
    .prepare(
      `
      SELECT * FROM notices
       WHERE dismissed_at IS NULL
         AND expires_at > @stamp
         AND (@source IS NULL OR source = @source)
       ORDER BY (due IS NULL) ASC,
                due ASC,
                CASE severity WHEN 'urgent' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
                title ASC
       LIMIT @limit
    `
    )
    .all({ stamp, limit, source });

  return rows.map(toEnvelope);
}

/** One notice by its surrogate id, dismissed or not. `null` if unknown. */
export function getNotice(db, id) {
  const row = db.prepare('SELECT * FROM notices WHERE id = ?').get(id);
  return row ? toEnvelope(row) : null;
}

/**
 * The stored action definition, including the fields never sent to a browser.
 *
 * This is what the action route uses to work out what a button actually does,
 * and it is why the browser only ever sends an opaque action id.
 */
export function getNoticeAction(db, id, actionId) {
  const row = db.prepare('SELECT actions FROM notices WHERE id = ?').get(id);
  if (!row) return null;
  const actions = JSON.parse(row.actions ?? '[]');
  return actions.find((action) => action.id === actionId) ?? null;
}

/**
 * Dismiss a notice. Idempotent — dismissing twice is not an error, because
 * two tabs each sending a dismissal is normal, not exceptional.
 *
 * @returns {boolean} whether a row matched
 */
export function dismissNotice(db, id, { now = Date.now() } = {}) {
  const stamp = iso(now);
  const result = db
    .prepare(
      `UPDATE notices
          SET dismissed_at = COALESCE(dismissed_at, @stamp), updated_at = @stamp
        WHERE id = @id`
    )
    .run({ id, stamp });
  return result.changes > 0;
}

/** Undo a dismissal — the widget's undo, and a test seam. */
export function restoreNotice(db, id, { now = Date.now() } = {}) {
  const result = db
    .prepare('UPDATE notices SET dismissed_at = NULL, updated_at = ? WHERE id = ?')
    .run(iso(now), id);
  return result.changes > 0;
}

/**
 * Delete rows that expired long enough ago to be beyond resurrection.
 *
 * Not the same thing as hiding an expired notice: `listLiveNotices` already
 * hides it the moment it expires. This is the disk-space half, run on a
 * schedule, and it waits `PURGE_AFTER_MS` so that a source which re-posts
 * daily still finds its tombstone and does not resurrect a dismissal.
 *
 * @returns {number} rows deleted
 */
export function purgeExpiredNotices(db, { now = Date.now(), olderThanMs = PURGE_AFTER_MS } = {}) {
  const cutoff = iso(now - olderThanMs);
  return db.prepare('DELETE FROM notices WHERE expires_at <= ?').run(cutoff).changes;
}

/** Remove every notice from one source — used when a source is reconfigured. */
export function deleteNoticesFrom(db, source) {
  return db.prepare('DELETE FROM notices WHERE source = ?').run(source).changes;
}
