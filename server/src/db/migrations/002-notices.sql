-- Migration 002 — notices.
--
-- One table holding the envelope from docs/DESIGN.md §6.6, plus the two
-- pieces of state the envelope itself does not carry: when the row was last
-- seen from its source, and whether it has been dismissed.
--
-- The natural key is (source, external_id), NOT the `id` a source sends. Two
-- sources are free to both call something "bin-day", and a source re-posting
-- its feed must UPDATE its own rows rather than accumulate a new copy every
-- poll. The surrogate `id` exists so the browser has one opaque handle to
-- dismiss or act on.
CREATE TABLE notices (
  id            TEXT    PRIMARY KEY,     -- surrogate: <source>:<external_id>
  external_id   TEXT    NOT NULL,        -- the `id` the source sent
  source        TEXT    NOT NULL,
  severity      TEXT    NOT NULL DEFAULT 'info'
                CHECK (severity IN ('info', 'warn', 'urgent')),
  title         TEXT    NOT NULL,
  body          TEXT,
  -- ISO-8601, normalised to UTC on ingest so a lexical sort is a chronological
  -- sort. Nullable: "the boiler needs servicing" has no due date.
  due           TEXT,
  url           TEXT,
  actions       TEXT    NOT NULL DEFAULT '[]',   -- JSON array of action objects
  -- When this row stops being shown. Set from the notice's own due date plus a
  -- grace window, or from an ingest-time TTL. Expiry is what stops a dashboard
  -- accreting every notice it has ever been told about.
  expires_at    TEXT    NOT NULL,
  dismissed_at  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (source, external_id)
);

-- The widget's only read is "everything live, soonest first", so the index
-- covers exactly that: filter on expiry and dismissal, order by due.
CREATE INDEX idx_notices_live ON notices (dismissed_at, expires_at, due);

CREATE INDEX idx_notices_source ON notices (source);
