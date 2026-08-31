import Fastify from 'fastify';
import { config } from './config.js';
import { registerHealthRoutes } from './routes/health.js';

/**
 * Builds the Fastify instance without starting it, so tests can drive it
 * through `app.inject()` rather than binding a port.
 */
export async function buildServer(opts = {}) {
  const app = Fastify({
    logger: { level: config.logLevel },
    ...opts,
  });

  await registerHealthRoutes(app);

  return app;
}
