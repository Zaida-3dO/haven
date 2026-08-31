-- Migration 001 — the initial Haven schema.
--
-- Four tables, matching docs/DESIGN.md §2: layout (one row per breakpoint),
-- apps (the registry), widgets (instances and their config), and credentials
-- (encrypted at rest, never plaintext).

-- ── layout ───────────────────────────────────────────────────────────────
-- One row per breakpoint, NOT one row per widget placement. DESIGN §3 is
-- explicit that desktop and mobile are arranged separately and neither is
-- derived from the other, so the natural unit is "the whole layout for this
-- breakpoint" — which is also what GridStack's save()/load() round-trips.
CREATE TABLE layout (
  breakpoint  TEXT    PRIMARY KEY,
  nodes       TEXT    NOT NULL,          -- JSON array of GridStack nodes
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ── apps ─────────────────────────────────────────────────────────────────
-- The app registry. `urls` is a JSON array kept in priority order, because
-- reachability probing walks it in order and stops at the first responder
-- (DESIGN §6.2) — order is data, not incidental.
CREATE TABLE apps (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL,
  description   TEXT    NOT NULL DEFAULT '',
  category      TEXT    NOT NULL DEFAULT 'tools',
  icon          TEXT,
  urls          TEXT    NOT NULL DEFAULT '[]',
  version_info  TEXT,                    -- JSON: { latestUrl, currentContainerId }
  visit_count   INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_apps_category ON apps (category);

-- ── widgets ──────────────────────────────────────────────────────────────
-- One row per widget *instance*. `config_version` is stored alongside the
-- config deliberately: DESIGN §4 says version the config and run it through a
-- migration hook from day one, because it is trivial now and impossible to
-- retrofit once saved dashboards exist in the wild.
CREATE TABLE widgets (
  id              TEXT    PRIMARY KEY,
  type            TEXT    NOT NULL,
  config          TEXT    NOT NULL DEFAULT '{}',
  config_version  INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_widgets_type ON widgets (type);

-- ── credentials ──────────────────────────────────────────────────────────
-- Encrypted at rest with HAVEN_SECRET_KEY (AES-256-GCM). The ciphertext, the
-- per-record IV and the auth tag are stored as separate BLOB columns rather
-- than one packed string, so a decrypt cannot silently succeed on a truncated
-- record. There is deliberately no plaintext column: the storage layer refuses
-- to write when no key is configured rather than degrading to plaintext.
CREATE TABLE credentials (
  name        TEXT    PRIMARY KEY,       -- e.g. 'qbittorrent.password'
  ciphertext  BLOB    NOT NULL,
  iv          BLOB    NOT NULL,
  auth_tag    BLOB    NOT NULL,
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
);
