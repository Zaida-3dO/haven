/**
 * Config versioning and the migration hook.
 *
 * Every widget config carries a `configVersion`, and every widget may ship a
 * `migrateConfig(config, fromVersion)` hook. Only Grafana does this
 * (`setMigrationHandler`); everyone else breaks saved dashboards on a schema
 * change. It is trivial now and impossible to retrofit, which is why it exists
 * on day one even though there is nothing to migrate yet.
 *
 * The host runs this on load, before `setConfig`, so a widget's `setConfig`
 * only ever sees a config at the current version.
 */

export const VERSION_KEY = 'configVersion';

export class MigrationError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'MigrationError';
    this.cause = cause;
  }
}

/**
 * Migrate a stored config up to the widget's current `configVersion`.
 *
 * @param {object} definition Widget definition — may carry `configVersion`
 *   (defaults to 1) and `migrateConfig(config, fromVersion) -> config`.
 * @param {object} stored The config as loaded from the saved layout.
 * @returns {{ config: object, migrated: boolean, from: number, to: number }}
 */
export function migrateConfig(definition, stored = {}) {
  const target = definition?.configVersion ?? 1;
  const from = Number.isFinite(stored?.[VERSION_KEY]) ? stored[VERSION_KEY] : 1;

  if (from === target) {
    return { config: { ...stored, [VERSION_KEY]: target }, migrated: false, from, to: target };
  }

  // A config from a NEWER version than this build understands. Downgrading is
  // not something a migration hook can be assumed to do, so refuse rather than
  // feed a widget a shape it has never seen.
  if (from > target) {
    throw new MigrationError(
      `Config is version ${from} but this build of "${definition?.type ?? 'widget'}" ` +
        `only understands version ${target}. It was probably saved by a newer Haven.`
    );
  }

  const hook = definition?.migrateConfig;
  if (typeof hook !== 'function') {
    throw new MigrationError(
      `Config for "${definition?.type ?? 'widget'}" is version ${from} and needs migrating ` +
        `to ${target}, but the widget ships no migrateConfig hook.`
    );
  }

  let config;
  try {
    config = hook({ ...stored }, from, target);
  } catch (cause) {
    throw new MigrationError(
      `migrateConfig for "${definition?.type ?? 'widget'}" threw while migrating ` +
        `v${from} to v${target}: ${cause?.message ?? cause}`,
      cause
    );
  }

  if (!config || typeof config !== 'object') {
    throw new MigrationError(
      `migrateConfig for "${definition?.type ?? 'widget'}" returned ${typeof config}, ` +
        'expected a config object.'
    );
  }

  return { config: { ...config, [VERSION_KEY]: target }, migrated: true, from, to: target };
}
