-- Migration 005 — the Haven-local calendar.
--
-- A secret-ICS feed is READ-ONLY: there is no way to write back to Google
-- through it, and OAuth (which could) is a much larger job with real
-- credential risk. So events created through the API live here instead, and
-- are merged into the same view as the feeds at read time. Nothing in this
-- table ever came from an ICS feed, and nothing from an ICS feed is ever
-- written here — that separation is what makes "this event is read-only" a
-- fact about where a row lives rather than a flag that could be forged.
--
-- The stored shape mirrors what `ics-parse.js` produces, so the merged list
-- is ONE shape and the widget does not branch on origin to render.
CREATE TABLE calendar_events (
  -- Opaque, server-generated. Never derived from the title: an id ends up in
  -- a URL and in the DOM, and a title is personal data.
  id            TEXT    PRIMARY KEY,

  title         TEXT    NOT NULL,
  description   TEXT,
  location      TEXT,

  -- Exactly one pair is populated, enforced by the CHECK below.
  --
  -- A timed event is an INSTANT, normalised to UTC on ingest so that a
  -- lexical comparison is a chronological one and the range query below can
  -- use the index.
  start_at      TEXT,
  end_at        TEXT,

  -- An all-day event is a DATE, not an instant, and must stay one. Storing
  -- `2026-06-12` as a timestamp picks a timezone by accident and renders the
  -- event on the 11th for any viewer west of UTC — the same trap
  -- `ics-parse.js` documents at length. `end_date` is INCLUSIVE (the last day
  -- the event covers), unlike ICS's exclusive DTEND.
  start_date    TEXT,
  end_date      TEXT,

  all_day       INTEGER NOT NULL DEFAULT 0 CHECK (all_day IN (0, 1)),

  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),

  -- The invariant the whole timezone argument rests on, held in the schema
  -- rather than only in the validator: a row cannot carry both an instant and
  -- a date, and cannot carry neither. A future writer that bypasses the
  -- envelope still cannot create the ambiguous row.
  CHECK (
    (all_day = 1 AND start_date IS NOT NULL AND end_date IS NOT NULL
                 AND start_at IS NULL AND end_at IS NULL)
    OR
    (all_day = 0 AND start_at IS NOT NULL AND end_at IS NOT NULL
                 AND start_date IS NULL AND end_date IS NULL)
  ),

  -- An end before its start is a broken row whatever else is true of it.
  CHECK (all_day = 1 OR end_at >= start_at),
  CHECK (all_day = 0 OR end_date >= start_date)
);

-- The only read is "everything overlapping [from, to], soonest first", and it
-- has to work across both representations. COALESCE puts the two kinds on one
-- sortable column so a single index covers the range scan; the expression is
-- indexed rather than computed per row at query time.
CREATE INDEX idx_calendar_events_start
  ON calendar_events (COALESCE(start_at, start_date));

CREATE INDEX idx_calendar_events_end
  ON calendar_events (COALESCE(end_at, end_date));
