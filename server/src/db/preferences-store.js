/**
 * Preference storage — singleton dashboard preferences.
 *
 * ⚠️ NOT to be confused with `server/src/settings.js`, which is an entirely
 * separate concept that happens to share the English word. That one reads
 * `config/settings.json` — a human-edited file holding weather units and
 * coordinates, absent on most installs and never written by the app. THIS is
 * database-backed state the USER changes from the UI by dragging. Different
 * lifetimes, different writers, different failure modes — so they deliberately
 * get different nouns: a reader who meets `loadSettings()` and
 * `createPreferenceStore()` should not have to work out which is which.
 *
 * A key/value table for the handful of things that belong to the DASHBOARD
 * rather than to a widget, an app or a breakpoint. Today that is exactly one
 * key: the sidebar's width.
 *
 * ── Why a key/value table rather than a column per preference ───────────────
 * The alternative is a one-row `dashboard` table gaining a column per
 * preference, which means a migration for every new toggle. For preferences that
 * are genuinely independent scalars with no relationships, key/value is the
 * shape that stops the schema churning. The cost — no per-key type checking
 * from SQLite — is paid back by validating in one place here, which is where
 * the range checks have to live anyway.
 *
 * Values are stored as TEXT and parsed on read. SQLite is dynamically typed so
 * an INTEGER column would not have saved a bad write either; the validator is
 * the guard, not the column type.
 */

/** The preferences this build understands. Anything else is refused, not stored. */
export const PREFERENCE_KEYS = Object.freeze(['sidebarWidth']);

/**
 * The sidebar's width, in pixels.
 *
 * ── Why there is a floor AND a ceiling ───────────────────────────────────
 * Both bounds are load-bearing rather than tidiness. The sidebar is a fixed
 * track in `grid-template-columns: 1fr var(--haven-sidebar-width)`, so its
 * width comes directly out of the main grid's share:
 *
 *  - Below the floor the cards are narrower than their own content — the
 *    status card's rows and the weather forecast stop being readable — and
 *    the drag handle itself becomes hard to grab back.
 *  - Above the ceiling the `1fr` grid column is squeezed toward zero. That is
 *    the worse direction: the sidebar is a column of ambient readouts and the
 *    grid is the dashboard, so a width that eats the board makes the app
 *    unusable while looking deliberate.
 *
 * 240/720 brackets the shipped 320px generously in both directions while
 * leaving a 1280px viewport at least 560px of grid. Clamped rather than
 * refused: a drag naturally overshoots, and refusing a drag that went 3px too
 * far would make the handle feel broken. A non-numeric width IS refused,
 * because that is a caller bug rather than a gesture.
 */
export const SIDEBAR_WIDTH = Object.freeze({ min: 240, max: 720, default: 320 });

export class PreferenceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreferenceValidationError';
    this.code = 'INVALID_PREFERENCE';
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Clamps to the allowed range. Exported so the client can apply the same rule. */
export const clampSidebarWidth = (value) =>
  Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value)));

/**
 * Validates a preferences patch, returning the normalised copy.
 *
 * A PATCH, not a replace: a payload naming one key leaves every other setting
 * alone. That matters even with one key today, because it is what lets a
 * second setting be added without every writer having to send both.
 *
 * Unknown keys are REFUSED rather than dropped — the same rule `validateInstance`
 * applies to `zone`, and for the same reason. A silently ignored setting is a
 * preference the user set that never took effect, with nothing anywhere saying
 * why.
 */
export function validatePreferences(payload) {
  if (!isPlainObject(payload)) {
    throw new PreferenceValidationError('Preferences payload must be an object.');
  }

  const keys = Object.keys(payload);
  if (keys.length === 0) {
    throw new PreferenceValidationError(
      `Preferences payload is empty — expected at least one of: ${PREFERENCE_KEYS.join(', ')}.`
    );
  }

  const unknown = keys.filter((key) => !PREFERENCE_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new PreferenceValidationError(
      `Unknown preference(s): ${unknown.join(', ')}. Expected: ${PREFERENCE_KEYS.join(', ')}.`
    );
  }

  const clean = {};

  if (payload.sidebarWidth !== undefined) {
    const width = payload.sidebarWidth;
    // Refused, not coerced. `Number('320px')` is NaN and `Number(null)` is 0,
    // so accepting a non-number here would store a width that silently reads
    // back as the minimum.
    if (typeof width !== 'number' || !Number.isFinite(width)) {
      throw new PreferenceValidationError(
        `sidebarWidth must be a finite number — received ${JSON.stringify(width)}.`
      );
    }
    clean.sidebarWidth = clampSidebarWidth(width);
  }

  return clean;
}

export function createPreferenceStore(db) {
  const upsert = db.prepare(`
    INSERT INTO preferences (key, value)
    VALUES (@key, @value)
    ON CONFLICT (key) DO UPDATE SET
      value      = excluded.value,
      updated_at = datetime('now')
  `);

  const selectAll = db.prepare('SELECT key, value FROM preferences');

  return {
    /**
     * Every preference, with its default filled in for any never saved.
     *
     * A fresh install returns a complete, usable object rather than `{}` the
     * client has to special-case — the same contract `layout.getAll()` offers
     * with its empty arrays.
     *
     * A stored value that will not parse degrades to the default rather than
     * throwing, matching how `instances-store` treats a corrupted config blob:
     * one bad row must not take down the dashboard.
     */
    getAll() {
      const rows = new Map(selectAll.all().map((row) => [row.key, row.value]));

      const width = Number(rows.get('sidebarWidth'));
      return {
        sidebarWidth: Number.isFinite(width) ? clampSidebarWidth(width) : SIDEBAR_WIDTH.default,
      };
    },

    /**
     * Writes a validated patch in one transaction.
     *
     * @param {object} validated output of {@link validatePreferences}
     */
    save(validated) {
      const write = db.transaction((entries) => {
        for (const [key, value] of entries) upsert.run({ key, value: String(value) });
      });

      write(Object.entries(validated));
      return this.getAll();
    },
  };
}
