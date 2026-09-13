-- Migration 006 — give the seeded 3D home embed a real origin.
--
-- `web/src/shell/boot.js` was fixed to set `allowSameOrigin: 'yes'` on this
-- embed (commit 422eebc): without a real origin the sandboxed frame sends
-- `Origin: null`, which 3dhome's allow-list cannot meaningfully accept, so
-- every `houses/<id>/geometry.json` fetch was CORS-blocked and the tile
-- rendered blank.
--
-- Then the sidebar roster moved out of that hardcoded array and into seeded
-- database rows, and the seed was written carrying the PRE-FIX value. From
-- that moment the data overrode the fixed code: v0.8.0 created the row with
-- `"allowSameOrigin":"no"` and the tile went blank again.
--
-- Fixing the seed alone is NOT enough, and this is the whole reason this file
-- exists. `seedInstances` is skip-if-the-zone-is-non-empty by design — the
-- file is the seed, the database is the source of truth afterwards, so a
-- widget the user removed is never resurrected. Any install that has already
-- booted v0.8.0 therefore has four sidebar rows, will never re-seed, and would
-- keep the broken value forever. This migration is what reaches those rows.
--
-- ── Why this is targeted rather than a blanket update ─────────────────────
-- Scoped to `id = 'sidebar-home3d'` and to rows that still say exactly 'no'.
-- The widget DEFAULT is 'no' and stays 'no' (`web/src/widgets/iframe/
-- definition.js`), because a relative-path embed added later would be
-- same-origin with Haven and could reach `parent.document`. This grant is safe
-- only because this specific URL is an absolute public host, so the frame is
-- cross-origin and never holds Haven's origin. Widening any other iframe row
-- would be a genuine security regression, so the WHERE clause is the security
-- boundary, not a tidiness measure.
--
-- `json_set` rather than string surgery on the blob: it rewrites exactly one
-- key and leaves url, title, scroll, allowForms and allowPopups untouched,
-- including any edit the user has since made to them. A REPLACE() over the raw
-- text would also corrupt a config that merely mentioned the string elsewhere.
--
-- Idempotent, and safe on every install that does not need it: on a fresh
-- database the widgets table is empty when migrations run (seeding happens
-- later, in `buildServer`, and already seeds 'yes'), so this updates 0 rows.
-- Re-running updates 0 rows because the value no longer matches 'no'. A user
-- who has deliberately set it back to 'no' by hand keeps that choice on any
-- subsequent run for the same reason.
UPDATE widgets
   SET config     = json_set(config, '$.allowSameOrigin', 'yes'),
       updated_at = datetime('now')
 WHERE id   = 'sidebar-home3d'
   AND type = 'iframe'
   AND json_extract(config, '$.allowSameOrigin') = 'no';
