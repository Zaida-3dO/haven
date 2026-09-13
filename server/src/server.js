import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import Fastify from 'fastify';
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { seedApps } from './db/apps-store.js';
import { SIDEBAR_DEFAULTS, seedInstances } from './db/instances-store.js';
import { createContainerVersionsReader } from './container-versions.js';
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
    webDir = config.webDir,
    credentials,
    containerVersionsPath = config.containerVersionsFile,
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

  // The SIDEBAR roster, seeded the same way and guarded the same way — but
  // separately, because the guard is per zone.
  //
  // That is the whole reason `seedInstances` takes a zone at all. The guard
  // used to ask "is the widgets table empty?"; with two zones to seed, the
  // first call would then populate the table and suppress the second, so a
  // fresh install would boot with a sidebar and a completely empty main board
  // (or vice versa, depending on call order). It now asks "is THIS zone
  // empty?", which keeps the seed-once asymmetry per zone: a user who removes
  // every sidebar widget still gets an empty sidebar on the next restart
  // rather than having the four defaults grow back.
  //
  // `path: null` deliberately — there is no sidebar seed FILE. The grid roster
  // supports one for operators who want to ship a custom dashboard; the
  // sidebar's four cards are a built-in default that has never been
  // file-configurable, and inventing a config surface nobody asked for is not
  // this change's job.
  seedInstances(db, {
    path: null,
    zone: 'sidebar',
    defaults: SIDEBAR_DEFAULTS,
    logger: app.log,
  });

  await registerHealthRoutes(app);
  await registerLayoutRoutes(app);
  // The roster: which widgets exist and how each is configured. Geometry is
  // the layout routes above; the two are joined by instance id in the shell.
  await registerInstanceRoutes(app, { db, credentials });
  await registerAppRoutes(app, { db, iconDir });
  // The version connector holds the GitHub token and the shared release cache;
  // the browser asks this server, never api.github.com directly.
  await registerVersionRoutes(app, {
    db,
    versionsReader: createContainerVersionsReader({
      path: containerVersionsPath,
      logger: app.log,
    }),
  });
  // The database and the credential store go through as well: the torrents
  // route reads per-widget connector config from the roster, and its secret
  // from the encrypted credential store. A test that injects a credential
  // double gets the same one here as the instance routes above.
  await registerWidgetRoutes(app, { db, credentials, ...widgets });
  await registerNoticeRoutes(app, { db, ...notices });

  // Serve the built shell. Registered LAST so it can never shadow an /api
  // route, and in its own scope so the static root does not leak.
  //
  // Without this the container has no UI at all: the Dockerfile copies
  // `web/dist` into the image, but nothing ever served it, so `/` answered
  // 404 while every /api route worked. That is invisible to a test suite
  // driving `app.inject()` against the API, and invisible to a health check
  // that only asks for /api/health — it shows up the moment a browser opens
  // the page, which is exactly what found it.
  //
  // A missing directory is a warning, not a crash: running the API without
  // having built the shell is a legitimate dev state, and `serve-web.test.js`
  // pins that it stays one.
  if (existsSync(resolve(webDir))) {
    await app.register(import('@fastify/static'), {
      root: resolve(webDir),
      prefix: '/',
    });

    // The shell owns its own routes, so anything that is not a file and not
    // an API call resolves to the shell rather than 404ing.
    //
    // Registered on the ROOT instance, not inside a plugin scope: a
    // not-found handler set in a scope only covers that scope, so a scoped
    // one never saw `/some/deep/link` at all. The test for this failed in
    // exactly that way before the handler moved out here.
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such endpoint.' });
      }
      return reply.sendFile('index.html', resolve(webDir));
    });
  } else {
    app.log.warn(
      `Web shell not found at "${resolve(webDir)}" — serving the API only. ` +
        'Run `npm run build` to build it.'
    );
  }

  return app;
}
