/**
 * Data access for widget instances — the `widgets` table.
 *
 * The table has existed since `001-initial.sql` and until now had no reader
 * and no writer: which widget *type* an instance was, and its config, lived in
 * a hardcoded `DEFAULT_INSTANCES` array in `web/src/shell/boot.js`. So the
 * settings panel's saves ran the whole migrate-and-validate path, updated the
 * live widget, and then died on refresh, because there was nowhere to put
 * them. This module is that missing half.
 *
 * Like `apps-store.js` this is deliberately thin and deliberately the ONLY
 * place that knows how an instance is stored: routes speak the API shape
 * (camelCase `configVersion`), SQLite stores `config_version` and a JSON blob.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * SECRETS — the reason this file is longer than `apps-store.js`
 *
 * A widget config may contain `secret`-typed fields (docs/WIDGET-CONTRACT.md;
 * `FIELD_TYPES` in `web/src/shell/schema.js`). Those must not sit in the
 * `widgets.config` blob in the clear, and they must never be returned to the
 * browser.
 *
 * There is already exactly one place in Haven that stores a secret, and it
 * encrypts at rest with AES-256-GCM: `credentials.js`. So a secret field's
 * VALUE is written there under a derived name, and what lands in the config
 * blob is a sentinel (`SECRET_SET`) that records only that a value exists.
 * There is no second storage path and no plaintext fallback — if
 * `HAVEN_SECRET_KEY` is absent, `credentialStore.set` throws and the write is
 * refused rather than degrading.
 *
 * Reading is the mirror image: `getInstance`/`listInstances` return the
 * sentinel, never the plaintext. Nothing in this module has a code path that
 * decrypts a widget secret for an HTTP response. The only reader is
 * `readSecret`, which exists for a future server-side connector and is not
 * reachable from any route.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { readFileSync } from 'node:fs';
import { createCredentialStore } from './credentials.js';

/**
 * What a stored secret looks like from the outside.
 *
 * The settings panel already distinguishes "a value is saved" from "no value
 * saved" (`SECRET_SET_HINT` / `SECRET_UNSET_HINT`) using a presence test on
 * the config it holds. A non-empty sentinel makes that test answer "set"
 * without the panel ever seeing a credential — which is exactly the contract
 * it was written against, from the other side.
 */
export const SECRET_SET = '__haven_secret_set__';

/** Credential name for one instance's secret field. */
export const secretName = (instanceId, key) => `widget:${instanceId}:${key}`;

const COLUMNS = 'id, type, config, config_version, sort_order, created_at, updated_at';

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

export class InstanceValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InstanceValidationError';
    this.code = 'INVALID_INSTANCE';
  }
}

/**
 * Row → API shape.
 *
 * A corrupted config blob degrades to `{}` rather than throwing, for the same
 * reason `apps-store.js` degrades `urls`: one bad row must not take down the
 * whole dashboard. An instance with an empty config renders with its schema
 * defaults, which is a far better outcome than a blank page.
 */
function toInstance(row) {
  if (!row) return null;

  let config = {};
  try {
    const parsed = JSON.parse(row.config ?? '{}');
    if (isPlainObject(parsed)) config = parsed;
  } catch {
    config = {};
  }

  return {
    id: row.id,
    type: row.type,
    config,
    configVersion: row.config_version ?? 1,
    sortOrder: row.sort_order ?? 0,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

/**
 * Validates the writable shape of an instance.
 *
 * Deliberately does NOT validate the config against a widget's `configSchema`:
 * the schema lives in the browser with the widget definition, and the server
 * has no copy. Duplicating it here would create the second source of truth
 * that `schema.js` exists to prevent. The server's job is that the envelope is
 * well-formed and the secrets are handled; the shell's `parseConfig` remains
 * the one validator of config *content*.
 *
 * @param {object} payload
 * @param {object} [options]
 * @param {boolean} [options.requireId] false for PUT, where the path owns the id
 */
export function validateInstance(payload, { requireId = true } = {}) {
  if (!isPlainObject(payload)) {
    throw new InstanceValidationError('Instance payload must be an object.');
  }

  if (requireId) {
    if (typeof payload.id !== 'string' || payload.id.trim() === '') {
      throw new InstanceValidationError('id must be a non-empty string.');
    }
  } else if (payload.id !== undefined) {
    // A PUT addresses a row by path. Letting the body carry a different id
    // would make the endpoint a rename in disguise, exactly as `apps.js`
    // refuses to allow.
    if (typeof payload.id !== 'string' || payload.id.trim() === '') {
      throw new InstanceValidationError('id must be a non-empty string.');
    }
  }

  if (typeof payload.type !== 'string' || payload.type.trim() === '') {
    throw new InstanceValidationError('type must be a non-empty string.');
  }

  if (payload.config !== undefined && !isPlainObject(payload.config)) {
    throw new InstanceValidationError('config must be an object.');
  }

  const version = payload.configVersion;
  if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
    throw new InstanceValidationError('configVersion must be an integer >= 1.');
  }

  if (payload.secretKeys !== undefined) {
    if (!Array.isArray(payload.secretKeys)) {
      throw new InstanceValidationError('secretKeys must be an array of field names.');
    }
    for (const key of payload.secretKeys) {
      if (typeof key !== 'string' || key.trim() === '') {
        throw new InstanceValidationError('secretKeys entries must be non-empty strings.');
      }
    }
  }

  const sortOrder = payload.sortOrder;
  if (sortOrder !== undefined && !Number.isInteger(sortOrder)) {
    throw new InstanceValidationError('sortOrder must be an integer.');
  }

  const clean = {
    type: payload.type,
    config: payload.config ?? {},
    configVersion: version ?? 1,
    secretKeys: payload.secretKeys ?? [],
  };
  if (sortOrder !== undefined) clean.sortOrder = sortOrder;
  if (typeof payload.id === 'string') clean.id = payload.id;

  return clean;
}

export function createInstanceStore(db, { credentials } = {}) {
  // The credential store is injected in tests so a suite can run without
  // HAVEN_SECRET_KEY; in production it is the real, encrypting one.
  const credentialStore = credentials ?? createCredentialStore(db);

  const insert = db.prepare(`
    INSERT INTO widgets (id, type, config, config_version, sort_order)
    VALUES (@id, @type, @config, @config_version, @sort_order)
  `);

  const update = db.prepare(`
    UPDATE widgets SET
      type = @type, config = @config, config_version = @config_version,
      sort_order = @sort_order, updated_at = datetime('now')
    WHERE id = @id
  `);

  // `sort_order` first, and NOT `created_at`: a seed writes every row inside
  // one `datetime('now')` second, so ordering by it collapses to the id
  // tiebreaker and silently alphabetises the dashboard. See migration 004.
  const selectAll = db.prepare(
    `SELECT ${COLUMNS} FROM widgets ORDER BY sort_order ASC, created_at ASC, id ASC`
  );
  const nextSort = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM widgets');
  const selectOne = db.prepare(`SELECT ${COLUMNS} FROM widgets WHERE id = ?`);
  const deleteOne = db.prepare('DELETE FROM widgets WHERE id = ?');
  const countRows = db.prepare('SELECT COUNT(*) AS n FROM widgets');

  /**
   * Splits an incoming config into the blob to store and the secrets to
   * encrypt.
   *
   * Three cases per declared secret key, and the middle one is the whole
   * reason this is not a one-liner:
   *
   *  - a new plaintext value  → encrypt it, store the sentinel
   *  - the sentinel echoed back, or the key absent → the user did not touch
   *    it. Keep whatever is already stored and DO NOT re-encrypt. This is the
   *    server-side half of the settings panel's rule 2: it omits an untouched
   *    secret from its patch, and the server must not read that omission as
   *    "delete the credential".
   *  - an explicit empty string → the value is being cleared, so drop the
   *    credential and the sentinel together.
   */
  function splitSecrets(id, config, secretKeys, previous) {
    const stored = { ...config };
    const writes = [];
    const deletes = [];

    for (const key of secretKeys ?? []) {
      const incoming = config[key];

      if (incoming === undefined || incoming === SECRET_SET) {
        // Untouched. Preserve the previous sentinel state exactly.
        if (previous?.config?.[key] === SECRET_SET) stored[key] = SECRET_SET;
        else delete stored[key];
        continue;
      }

      if (typeof incoming === 'string' && incoming === '') {
        delete stored[key];
        deletes.push(key);
        continue;
      }

      writes.push([key, String(incoming)]);
      stored[key] = SECRET_SET;
    }

    return { stored, writes, deletes };
  }

  /** Applies the credential side-effects for one instance write. */
  function persistSecrets(id, { writes, deletes }) {
    for (const [key, value] of writes) credentialStore.set(secretName(id, key), value);
    for (const key of deletes) credentialStore.delete(secretName(id, key));
  }

  return {
    /** Every instance, oldest first, so the roster order is stable. */
    list() {
      return selectAll.all().map(toInstance);
    },

    get(id) {
      return toInstance(selectOne.get(id));
    },

    has(id) {
      return selectOne.get(id) !== undefined;
    },

    count() {
      return countRows.get().n;
    },

    /**
     * Creates an instance.
     *
     * Secrets are encrypted BEFORE the row is written, inside the same
     * transaction, so a key-less server cannot leave a half-created instance
     * whose credential write threw.
     */
    create(validated) {
      const { stored, writes, deletes } = splitSecrets(
        validated.id,
        validated.config,
        validated.secretKeys,
        null
      );

      // A new widget goes to the end of the roster unless told otherwise, so
      // adding one never reshuffles what is already there.
      const sortOrder = validated.sortOrder ?? nextSort.get().next;

      const write = db.transaction(() => {
        persistSecrets(validated.id, { writes, deletes });
        insert.run({
          id: validated.id,
          type: validated.type,
          config: JSON.stringify(stored),
          config_version: validated.configVersion ?? 1,
          sort_order: sortOrder,
        });
      });

      write();
      return this.get(validated.id);
    },

    /**
     * Full replace of an instance's mutable fields.
     *
     * @returns the updated instance, or null when there is no such row.
     */
    update(id, validated) {
      const previous = this.get(id);
      if (!previous) return null;

      const { stored, writes, deletes } = splitSecrets(
        id,
        validated.config,
        validated.secretKeys,
        previous
      );

      const write = db.transaction(() => {
        persistSecrets(id, { writes, deletes });
        update.run({
          id,
          type: validated.type,
          config: JSON.stringify(stored),
          config_version: validated.configVersion ?? 1,
          // An update that says nothing about placement keeps its place.
          sort_order: validated.sortOrder ?? previous.sortOrder,
        });
      });

      write();
      return this.get(id);
    },

    /**
     * Deletes an instance and everything that pointed at it.
     *
     * The layout node goes too. A layout node whose `widgetId` names an
     * instance that no longer exists is a dangling reference, and while the
     * shell is written to skip one rather than blank the dashboard, leaving
     * them behind means the geometry slowly fills with ghosts. Its
     * credentials go as well — an orphaned encrypted secret is a secret
     * nobody will ever notice they are still storing.
     *
     * Search-index entries need no work here: the index is in-memory only and
     * keyed by widget id (`SearchIndex.remove`), so dropping the host drops
     * the bucket. See `web/src/shell/search-index.js` — persisting it is
     * explicitly forbidden by DESIGN §5.
     *
     * @returns {boolean} whether a row was removed.
     */
    delete(id) {
      const existing = this.get(id);
      if (!existing) return false;

      // Any config key holding the sentinel had a credential written for it.
      const secretKeys = Object.entries(existing.config ?? {})
        .filter(([, value]) => value === SECRET_SET)
        .map(([key]) => key);

      const remove = db.transaction(() => {
        for (const key of secretKeys) credentialStore.delete(secretName(id, key));
        pruneLayoutReferences(db, id);
        deleteOne.run(id);
      });

      remove();
      return true;
    },

    /**
     * The plaintext of one secret field.
     *
     * NOT reachable from any route, and must not become so — it exists for a
     * future server-side connector that needs the credential to call an
     * upstream service, which is the only legitimate reader.
     */
    readSecret(id, key) {
      return credentialStore.get(secretName(id, key));
    },
  };
}

/**
 * Strips every layout node pointing at `instanceId`, across all breakpoints.
 *
 * Written against the `layout` table directly rather than through
 * `createLayoutStore`, because it must run inside the caller's transaction.
 */
export function pruneLayoutReferences(db, instanceId) {
  const rows = db.prepare('SELECT breakpoint, nodes FROM layout').all();
  const write = db.prepare(
    "UPDATE layout SET nodes = @nodes, updated_at = datetime('now') WHERE breakpoint = @breakpoint"
  );

  let pruned = 0;

  for (const row of rows) {
    let nodes;
    try {
      nodes = JSON.parse(row.nodes ?? '[]');
    } catch {
      continue;
    }
    if (!Array.isArray(nodes)) continue;

    // A node matches by its own id OR by `widgetId` — the shell writes the
    // instance id into `id` and the layout validator additionally allows an
    // explicit `widgetId`, so both spellings have to be swept.
    const kept = nodes.filter((node) => node?.id !== instanceId && node?.widgetId !== instanceId);

    if (kept.length !== nodes.length) {
      write.run({ breakpoint: row.breakpoint, nodes: JSON.stringify(kept) });
      pruned += nodes.length - kept.length;
    }
  }

  return pruned;
}

/**
 * Seeds the roster from `config/instances.json` if — and only if — the table
 * is empty.
 *
 * Same asymmetry as `seedApps`: the file is the SEED, the database is the
 * source of truth afterwards, so a widget removed in the UI is not silently
 * resurrected on the next restart.
 *
 * A missing file is not an error, but it IS the case that matters most: a
 * fresh install with no seed file would otherwise boot to a completely blank
 * dashboard, which reads as "broken" rather than "empty". So the built-in
 * `DEFAULT_INSTANCES` is the fallback, and the file only overrides it.
 *
 * @returns {{ seeded: number, reason: string }}
 */
export function seedInstances(db, { path, logger, defaults = DEFAULT_INSTANCES } = {}) {
  const store = createInstanceStore(db, {
    // Seeding must never need HAVEN_SECRET_KEY: the built-in defaults carry
    // no secrets, and a seed file that does is refused by `create` anyway.
    credentials: { set: () => {}, get: () => null, delete: () => false },
  });

  if (store.count() > 0) {
    return { seeded: 0, reason: 'roster not empty' };
  }

  let entries = defaults;
  let reason = 'seeded from defaults';

  if (path) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8'));
      if (Array.isArray(parsed?.instances)) {
        entries = parsed.instances;
        reason = 'seeded from file';
      }
    } catch (err) {
      // ENOENT is the normal case on a fresh install — fall through to the
      // built-in defaults rather than shipping a blank dashboard.
      if (err.code !== 'ENOENT') {
        logger?.info?.(`Widget roster seed file unreadable (${err.message}); using defaults.`);
      }
    }
  }

  let seeded = 0;
  try {
    const insertAll = db.transaction((rows) => {
      rows.forEach((entry, index) => {
        // The declaration order IS the roster order — hero as a banner, then
        // the apps grid. Stamped explicitly rather than left to insertion
        // order, which `created_at` cannot express at seed speed.
        store.create(validateInstance({ sortOrder: index, ...entry }));
        seeded += 1;
      });
    });
    insertAll(entries);
  } catch (err) {
    logger?.error?.(`Widget roster seed failed: ${err.message}`);
    return { seeded: 0, reason: `seed failed: ${err.message}` };
  }

  logger?.info?.(`Seeded ${seeded} widget instance(s) — ${reason}.`);
  return { seeded, reason };
}

/**
 * The default roster.
 *
 * Moved here verbatim from `web/src/shell/boot.js`, where it lived as
 * `DEFAULT_INSTANCES` with a comment saying "there is no instances endpoint
 * yet". There is one now, so the roster belongs on the side that persists it —
 * and a fresh install gets a dashboard with something on it rather than a
 * blank page.
 */
export const DEFAULT_INSTANCES = Object.freeze([
  // The hero is a banner across the top, so it comes before the apps grid.
  { id: 'hero-main', type: 'hero', config: { rotateSeconds: 8, showTagline: true } },
  // The apps widget replaces the old dashboard's whole front page, so it leads.
  { id: 'apps-main', type: 'apps', config: {} },
  { id: 'clock-local', type: 'clock', config: { label: 'Local time', source: 'local' } },
  { id: 'torrents', type: 'torrents', config: { maxRows: 6 } },
  { id: 'calendar', type: 'calendar', config: { title: 'Calendar', maxEvents: 25 } },
  {
    id: 'clock-tokyo',
    type: 'clock',
    config: { label: 'Tokyo', source: 'timezone', timezone: 'Asia/Tokyo', showSeconds: 'yes' },
  },
]);
