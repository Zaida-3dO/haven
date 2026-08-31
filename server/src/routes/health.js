import { config } from '../config.js';

export async function registerHealthRoutes(app) {
  app.get('/api/health', async () => ({
    status: 'ok',
    version: config.version,
    uptime: Math.round(process.uptime()),
  }));
}
