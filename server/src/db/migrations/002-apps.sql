-- Migration 002 — the app registry.
--
-- Split out from the initial schema deliberately: this landed on a branch of
-- its own while the data layer was still in flight, and a migration is
-- immutable once applied, so appending is the only safe way to add a table.
--
-- `urls` is a JSON array kept in PRIORITY ORDER, because reachability probing
-- walks it in order and stops at the first responder (docs/DESIGN.md §6.2).
-- The order is data, not presentation — a migration that reorders it changes
-- which URL a click lands on.
CREATE TABLE IF NOT EXISTS apps (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  category      TEXT    NOT NULL DEFAULT 'tools',
  icon          TEXT,
  urls          TEXT    NOT NULL DEFAULT '[]',   -- JSON: [{ title, url, primary }]
  version_info  TEXT,                            -- JSON: { latestUrl, currentContainerId }
  visit_count   INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_apps_category ON apps (category);
