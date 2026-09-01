/**
 * The seed-file schema — one declarative document describing a whole dashboard.
 *
 * ── Why one file with three sections ─────────────────────────────────────
 * Haven's state that a human actually arranges lives behind exactly three
 * endpoints: `/api/apps` (the registry), `/api/instances` (the widget roster)
 * and `/api/layout` (geometry per breakpoint). The seed file has one section
 * per endpoint and no more, so there is nothing to invent when reading it:
 * a section maps to an API, an entry maps to a request.
 *
 * Deliberately NOT included: `visitCount` (server-owned, and `apps-schema.js`
 * rejects it outright), `createdAt`/`updatedAt` (server clocks), and settings
 * or `.env` values (they are a different lifecycle, and `config/settings.json`
 * already owns them).
 *
 * ── The two shapes of `apps` ─────────────────────────────────────────────
 * `apps` accepts EITHER the current Haven shape (an ordered `urls` array) or
 * the OLD dashboard's shape (`url`/`localUrl`/`localIpUrl`/`remoteUrl`/
 * `tailscaleUrl`/`releasesUrl`). The old shape is not a legacy courtesy — it
 * is the actual use case waiting for this tool, since the dashboard being
 * migrated is still in that format. Detection and mapping are NOT
 * reimplemented here: `migrateRegistry` from `scripts/migrate-apps.mjs` is the
 * one owner of that translation, and it already detects an already-migrated
 * entry by `Array.isArray(app.urls)` and passes it through untouched. So a
 * mixed file works, and so does exporting and re-applying.
 *
 * ── Icons ────────────────────────────────────────────────────────────────
 * Two distinct fields, because they are two distinct things:
 *
 *   `icon`     the bare filename already stored on the app (what the API
 *              returns, what `apps-schema.js` validates as separator-free)
 *   `iconFile` a path to a LOCAL image to upload, resolved relative to the
 *              seed file's own directory
 *
 * Only `iconFile` triggers an upload. It is absent from `export` output,
 * because a live Haven has no local file to point at — export writes `icon`.
 *
 * ── Secrets ──────────────────────────────────────────────────────────────
 * The instances API never returns a stored secret; it returns the sentinel
 * below. So a seed file produced by `export` can never contain a credential,
 * and `apply` must never send a blank where a sentinel was. See
 * `stripUntouchedSecrets` in `seed-client.mjs`.
 */

/** Mirrors `SECRET_SET` in `server/src/db/instances-store.js`. */
export const SECRET_SET = '__haven_secret_set__';

/** The breakpoints Haven persists — mirrors `BREAKPOINTS` in `server/src/db/layout.js`. */
export const BREAKPOINTS = ['desktop', 'mobile'];

/** The seed-file format version. Bumped only on a breaking shape change. */
export const SEED_VERSION = 1;

export class SeedValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SeedValidationError';
  }
}

export const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Is this app entry in the OLD dashboard's shape?
 *
 * The same test `migrate-apps.mjs` uses, and deliberately the same way round:
 * a `urls` array means already-migrated. Anything else goes through the
 * migration mapping, which is a no-op for an entry with nothing to map.
 */
export const isLegacyApp = (app) => !Array.isArray(app?.urls);

function firstDuplicate(ids) {
  const seen = new Set();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * Validates the ENVELOPE of a seed document — that the sections are the right
 * kind of thing and that they reference each other coherently.
 *
 * Deliberately does NOT re-validate app or instance CONTENT. The server owns
 * that (`apps-schema.js`, `validateInstance`, `validateLayout`), and a second
 * copy here would drift within a week — the same reasoning `instances-store.js`
 * gives for not validating widget config server-side. What this catches is the
 * class of error the server CANNOT catch, because the server only ever sees
 * one request at a time: duplicate ids within the file, and an unknown
 * breakpoint.
 *
 * @returns {{ apps: object[], instances: object[], layout: object }}
 */
export function validateSeed(doc) {
  if (!isPlainObject(doc)) {
    throw new SeedValidationError('Seed file must be a JSON object.');
  }

  if (doc.version !== undefined && doc.version !== SEED_VERSION) {
    throw new SeedValidationError(
      `Unsupported seed version ${JSON.stringify(doc.version)} — this CLI understands version ${SEED_VERSION}.`
    );
  }

  const apps = doc.apps ?? [];
  if (!Array.isArray(apps)) throw new SeedValidationError('`apps` must be an array.');

  const instances = doc.instances ?? [];
  if (!Array.isArray(instances)) throw new SeedValidationError('`instances` must be an array.');

  const layout = doc.layout ?? {};
  if (!isPlainObject(layout)) {
    throw new SeedValidationError('`layout` must be an object keyed by breakpoint.');
  }

  apps.forEach((app, i) => {
    if (!isPlainObject(app)) throw new SeedValidationError(`apps[${i}] must be an object.`);
    if (typeof app.id !== 'string' || !app.id.trim()) {
      throw new SeedValidationError(`apps[${i}].id is required.`);
    }
    if (app.iconFile !== undefined && typeof app.iconFile !== 'string') {
      throw new SeedValidationError(`apps[${i}].iconFile must be a string path when present.`);
    }
  });

  instances.forEach((instance, i) => {
    if (!isPlainObject(instance)) {
      throw new SeedValidationError(`instances[${i}] must be an object.`);
    }
    if (typeof instance.id !== 'string' || !instance.id.trim()) {
      throw new SeedValidationError(`instances[${i}].id is required.`);
    }
    if (typeof instance.type !== 'string' || !instance.type.trim()) {
      throw new SeedValidationError(`instances[${i}].type is required.`);
    }
  });

  const unknown = Object.keys(layout).filter((k) => !BREAKPOINTS.includes(k));
  if (unknown.length) {
    throw new SeedValidationError(
      `Unknown breakpoint(s) in \`layout\`: ${unknown.join(', ')}. Expected: ${BREAKPOINTS.join(', ')}.`
    );
  }

  for (const breakpoint of Object.keys(layout)) {
    if (!Array.isArray(layout[breakpoint])) {
      throw new SeedValidationError(`layout.${breakpoint} must be an array of nodes.`);
    }
  }

  const duplicateApp = firstDuplicate(apps.map((a) => a.id));
  if (duplicateApp) throw new SeedValidationError(`Duplicate app id "${duplicateApp}".`);

  const duplicateInstance = firstDuplicate(instances.map((i) => i.id));
  if (duplicateInstance) {
    throw new SeedValidationError(`Duplicate instance id "${duplicateInstance}".`);
  }

  return { apps, instances, layout };
}

/**
 * Every instance id a layout section refers to.
 *
 * A node points at an instance through `widgetId` if present, otherwise
 * through its own `id` — both spellings are live, exactly as
 * `pruneLayoutReferences` in `instances-store.js` has to sweep both.
 */
export function layoutReferences(layout) {
  const refs = new Set();
  for (const nodes of Object.values(layout ?? {})) {
    for (const node of nodes ?? []) {
      const ref = node?.widgetId ?? node?.id;
      if (typeof ref === 'string' && ref) refs.add(ref);
    }
  }
  return refs;
}

/**
 * Strips the keys the API refuses or ignores on write.
 *
 * `visitCount` is the one that matters: `apps-schema.js` REJECTS a payload
 * carrying it rather than ignoring it, so an export round trip would fail
 * validation on every app if it were left in. The timestamps are server clocks
 * and are dropped for the same reason.
 */
const SERVER_OWNED = ['visitCount', 'createdAt', 'updatedAt'];

export function stripServerOwned(entry) {
  const rest = { ...entry };
  for (const key of SERVER_OWNED) delete rest[key];
  return rest;
}
