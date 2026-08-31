import Fastify from 'fastify';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { seedApps } from './db/apps-store.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` rather than binding a port.
 *
 * @param {object} [opts] Fastify options, plus:
 *   - `db`: an already-open database handle (tests pass `:memory:` ones).
 *   - `seedPath`: where to read the app-registry seed from.
 *   - `iconDir`: where uploaded icons are written.
 */
export async function buildServer(opts = {}) {
  const {
    db: providedDb,
    seedPath = config.appsConfigPath,
    iconDir = config.iconDir,
    ...fastifyOpts
  } = opts;

  const app = Fastify({
    logger: { level: config.logLevel },
    ...fastifyOpts,
  });

  const db = providedDb ?? openDatabase({ logger: app.log });

  // Seed from config/apps.json only when the registry is empty. The file is
  // the seed; the database is the source of truth afterwards, so edits made in
  // the UI are never silently reverted by a stale file on the next restart.
  seedApps(db, { path: seedPath, logger: app.log });

  // Close the handle we opened. A caller-provided one stays the caller's to
  // close, which is what lets a test reuse one across injections.
  if (!providedDb) {
    app.addHook('onClose', () => db.close());
  }

  app.decorate('db', db);

  await registerHealthRoutes(app);
  await registerAppRoutes(app, { db, iconDir });

  return app;
}
