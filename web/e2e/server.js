/**
 * Boots Haven for the browser tests: the real Fastify server, a temp database,
 * no connector credentials, and the built web shell served from the same
 * origin.
 *
 * ── Why this file exists at all ──────────────────────────────────────────
 * `server/src/index.js` serves `/api/*` and nothing else — it registers no
 * static handler for `web/dist`. In development that is fine, because Vite
 * serves the shell and proxies `/api` to the backend (see `web/vite.config.js`).
 * There is therefore no single command in the repo that serves the whole app
 * on one origin, so the browser tests assemble one here: `buildServer()` for
 * the API, plus `@fastify/static` for the Vite build output.
 *
 * That is a test harness, not a fix. The same gap appears to affect the
 * production image — the Dockerfile copies `web/dist` in and the runtime never
 * serves it — which is written up in the PR rather than fixed here, because
 * changing what the container serves is a bigger decision than a test file
 * should make on its own.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Everything is set up so a run cannot touch real state:
 *
 *  - the database is a fresh file in the OS temp directory, deleted on exit
 *  - the icon directory is a fresh temp directory
 *  - `HAVEN_APPS_CONFIG` points at a path that does not exist, so the app
 *    registry seeds empty rather than from an operator's real `apps.json`
 *  - no connector credential is set, so every connector reports "not
 *    configured" — the state a fresh deployment actually shows
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const distDir = join(repoRoot, 'web', 'dist');

// 8171 rather than anything in the 8080/8123 range: those collide with common
// self-hosted services (Haven's own default, and Home Assistant's), and a test
// server that silently talks to somebody else's app is a confusing failure.
const port = Number(process.argv[2] ?? process.env.HAVEN_E2E_PORT ?? 8171);

if (!existsSync(join(distDir, 'index.html'))) {
  console.error(
    `No web build at ${distDir}. Run \`npm run build --workspace=web\` before the browser tests.`
  );
  process.exit(1);
}

// A scratch directory per run, so nothing here can read or write real data.
const scratch = mkdtempSync(join(tmpdir(), 'haven-e2e-'));

// Set before `config.js` is imported — it reads the environment once, at
// module load, so this has to happen before the dynamic import below.
process.env.HAVEN_DB_PATH = join(scratch, 'haven-e2e.db');
// The static plugin serving icons refuses a root that does not exist, so the
// directory is created rather than merely named.
const iconDir = join(scratch, 'icons');
mkdirSync(iconDir, { recursive: true });
process.env.HAVEN_ICON_DIR = iconDir;
process.env.HAVEN_APPS_CONFIG = join(scratch, 'no-apps-seed.json');
process.env.HAVEN_LOG_LEVEL = process.env.HAVEN_E2E_LOG_LEVEL ?? 'warn';
process.env.HAVEN_VERSION = 'e2e';

// Explicitly blank, not merely absent: this asserts the "not configured" state
// even if the developer running the suite has a populated `.env` exported into
// their shell. Pinning that state is one of the things the suite is for.
for (const key of [
  'HAVEN_OPENWEATHER_API_KEY',
  'HAVEN_QBITTORRENT_URL',
  'HAVEN_QBITTORRENT_USER',
  'HAVEN_QBITTORRENT_PASS',
  'HAVEN_HA_URL',
  'HAVEN_HA_TOKEN',
  'HAVEN_CALENDAR_ICS_URL',
  'HAVEN_GITHUB_TOKEN',
  'HAVEN_CONTAINER_VERSIONS',
  'HAVEN_SECRET_KEY',
]) {
  delete process.env[key];
}

const { buildServer } = await import('../../server/src/server.js');

const app = await buildServer();

// Serve the built shell alongside the API. Registered after the API routes so
// it can never shadow one, and with an SPA-style fallback so a deep link like
// `/#widget-id` resolves to `index.html`.
await app.register(import('@fastify/static'), {
  root: distDir,
  prefix: '/',
  index: ['index.html'],
});

app.setNotFoundHandler((request, reply) => {
  if (request.url.startsWith('/api/')) {
    return reply.code(404).send({ error: 'NOT_FOUND' });
  }
  return reply.sendFile('index.html');
});

const cleanup = () => {
  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // A leftover temp directory is not worth failing a test run over.
  }
};

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await app.close().catch(() => {});
    cleanup();
    process.exit(0);
  });
}
process.on('exit', cleanup);

try {
  // Loopback only. The suite is the only client, and binding a wildcard would
  // put an unauthenticated dashboard on the network of whoever runs the tests.
  await app.listen({ host: '127.0.0.1', port });
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
