/**
 * Client for the dashboard preferences API (`server/src/routes/preferences.js`).
 *
 * Singleton state that belongs to the dashboard rather than to any widget —
 * today, the sidebar's width.
 *
 * ⚠️ Not related to `server/src/settings.js` (`config/settings.json`, weather
 * units, human-edited) nor to `settings-panel.js` (one widget's config). Three
 * things in this codebase are called some form of "settings"; this is the one
 * the user changes by dragging, and it is deliberately spelled differently.
 *
 * ── Why PATCH rather than PUT ────────────────────────────────────────────
 * Preferences are independent scalars, so omitting one must mean "leave it"
 * rather than "clear it". `save()` therefore sends only the keys it was given,
 * and the server leaves the rest alone.
 */

/** Mirrors `SIDEBAR_WIDTH` in `server/src/db/preferences-store.js`. */
export const SIDEBAR_WIDTH = Object.freeze({ min: 240, max: 720, default: 320 });

/**
 * Clamps a width to the allowed range.
 *
 * Duplicated from the server deliberately, and the duplication is the point:
 * the drag must stop where the validator would refuse, so the user cannot
 * drag to a value that silently snaps back on the next load. The server stays
 * the authority — it clamps whatever arrives — but a UI that lets you place a
 * handle somewhere the server will move is a UI that feels broken.
 *
 * `web/test/sidebar-size.test.js` asserts the two ranges agree, so they cannot
 * drift apart silently.
 */
export const clampSidebarWidth = (value) =>
  Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value)));

export function createPreferencesClient({ fetchImpl = globalThis.fetch, baseUrl = '/api' } = {}) {
  const request = async (path, init) => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.message || body?.error || '';
      } catch {
        // A non-JSON error body is not worth failing twice over.
      }
      throw new Error(`Preferences request failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  };

  return {
    /**
     * @returns {Promise<{sidebarWidth: number}>} every preference, defaults
     *   filled in — so a fresh install needs no special-casing here.
     */
    async load() {
      const body = await request('/preferences', { headers: { Accept: 'application/json' } });
      const width = Number(body?.preferences?.sidebarWidth);
      return {
        sidebarWidth: Number.isFinite(width) ? width : SIDEBAR_WIDTH.default,
      };
    },

    /**
     * Writes one or more preferences.
     *
     * Refuses an empty patch rather than sending one: the server answers 400,
     * and a silent no-op would hide a caller that built nothing — the same
     * rule `layout-client.save` applies.
     */
    async save(patch) {
      const payload = {};
      if (patch?.sidebarWidth !== undefined) {
        payload.sidebarWidth = clampSidebarWidth(patch.sidebarWidth);
      }
      if (Object.keys(payload).length === 0) {
        throw new Error('save: nothing to save — expected at least one preference.');
      }

      return request('/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    },
  };
}

export default { createPreferencesClient, clampSidebarWidth, SIDEBAR_WIDTH };
