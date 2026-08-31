import Fastify from 'fastify';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { seedApps } from './db/apps-store.js';
import { seedInstances } from './db/instances-store.js';
import { registerAppRoutes } from './routes/apps.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerInstanceRoutes } from './routes/instances.js';
import { registerLayoutRoutes } from './routes/layout.js';
import { registerNoticeRoutes } from './routes/notices.js';
import { registerVersionRoutes } from './routes/versions.js';
import { registerWidgetRoutes } from './routes/widgets.js';

/**
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` rather than binding a port.
 *
 * @param {object} [opts] Fastify options, plus:
 *   - `dbPath`: overrides `config.dbPath`. Tests pass `':memory:'`.
 *   - `db`: an already-open database to use instead of opening one. When
 *     given, the caller owns its lifetime and `app.close()` leaves it open.
 *   - `seedPath`: where to read the app-registry seed from.
 *   - `instancesSeedPath`: where to read the widget-roster seed from.
 *   - `credentials`: credential store override for the instance routes, so a
 *     suite can exercise secret handling without HAVEN_SECRET_KEY.
 *   - `iconDir`: where uploaded icons are written.
 *   - `widgets`: connector overrides for the widget routes. Tests inject
 *     stubbed connectors here so no test needs a key or the network.
 *   - `notices`: the same for the notice routes — a stubbed Home Assistant
 *     connector, so no test needs a token or a Home Assistant.
 */
export async function buildServer(opts = {}) {
  const {
    dbPath,
    db: providedDb,
    seedPath = config.appsConfigPath,
    instancesSeedPath = config.instancesConfigPath,
    iconDir = config.iconDir,
    credentials,
    widgets,
    notices,
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

  // Same rule for the widget roster, with one difference: an empty app
  // registry is a fine state, but an empty roster is a blank dashboard. So
  // `seedInstances` falls back to a built-in default roster when no seed file
  // exists, rather than leaving a fresh install with nothing on screen.
  seedInstances(db, { path: instancesSeedPath, logger: app.log });

  await registerHealthRoutes(app);
  await registerLayoutRoutes(app);
  // The roster: which widgets exist and how each is configured. Geometry is
  // the layout routes above; the two are joined by instance id in the shell.
  await registerInstanceRoutes(app, { db, credentials });
  await registerAppRoutes(app, { db, iconDir });
  // The version connector holds the GitHub token and the shared release cache;
  // the browser asks this server, never api.github.com directly.
  await registerVersionRoutes(app, { db });
  await registerWidgetRoutes(app, widgets);
  await registerNoticeRoutes(app, { db, ...notices });

  return app;
}
