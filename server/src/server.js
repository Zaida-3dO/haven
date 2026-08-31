import Fastify from 'fastify';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerLayoutRoutes } from './routes/layout.js';
import { registerWidgetRoutes } from './routes/widgets.js';

/**
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` rather than binding a port.
 *
 * @param {object} [opts] Fastify options, plus:
 *   - `dbPath`: overrides `config.dbPath`. Tests pass `':memory:'`.
 *   - `db`: an already-open database to use instead of opening one. When
 *     given, the caller owns its lifetime and `app.close()` leaves it open.
 *   - `widgets`: connector overrides for the widget routes. Tests inject a
 *     stubbed weather connector here so no test needs a key or the network.
 */
export async function buildServer(opts = {}) {
  const { dbPath, db: providedDb, widgets, ...fastifyOpts } = opts;

  const app = Fastify({
    logger: { level: config.logLevel },
    ...fastifyOpts,
  });

  const db = providedDb ?? openDatabase({ path: dbPath ?? config.dbPath, logger: app.log });
  app.decorate('db', db);

  if (!providedDb) {
    app.addHook('onClose', async () => db.close());
  }

  await registerHealthRoutes(app);
  await registerLayoutRoutes(app);
  await registerWidgetRoutes(app, widgets);

  return app;
}
