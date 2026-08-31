import Fastify from 'fastify';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { seedApps } from './db/apps-store.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLayoutRoutes } from './routes/layout.js';
import { registerVersionRoutes } from './routes/versions.js';

/**
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` rather than binding a port.
 *
 * @param {object} [opts] Fastify options, plus:
 *   - `dbPath`: overrides `config.dbPath`. Tests pass `':memory:'`.
 *   - `db`: an already-open database to use instead of opening one. When
 *     given, the caller owns its lifetime and `app.close()` leaves it open.
 *   - `seedPath`: where to read the app-registry seed from.
 *   - `iconDir`: where uploaded icons are written.
 */
export async function buildServer(opts = {}) {
  const {
    dbPath,
    db: providedDb,
    seedPath = config.appsConfigPath,
    iconDir = config.iconDir,
    ...fastifyOpts
  } = opts;

  const app = Fastify({
    logger: { level: config.logLevel },
    ...fastifyOpts,
  });

  const db = providedDb ?? openDatabase({ path: dbPath ?? config.dbPath, logger: app.log });
  app.decorate('db', db);

  if (!providedDb) {
    app.addHook('onClose', async () => db.close());
  }

  // Seed from config/apps.json only when the registry is empty. The file is
  // the seed; the database is the source of truth afterwards, so edits made in
  // the UI are never silently reverted by a stale file on the next restart.
  seedApps(db, { path: seedPath, logger: app.log });

  await registerHealthRoutes(app);
  await registerLayoutRoutes(app);
  await registerAppRoutes(app, { db, iconDir });
  // The version connector holds the GitHub token and the shared release cache;
  // the browser asks this server, never api.github.com directly.
  await registerVersionRoutes(app, { db });

  return app;
}
