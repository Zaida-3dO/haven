/**
 * The HTTP client the seeder drives Haven through.
 *
 * Deliberately a thin wrapper over `fetch` and nothing more: this tool talks
 * to the SAME public API a browser does, rather than opening the SQLite file.
 * That is the whole reason it is trustworthy — every write goes through
 * `apps-schema.js`, `validateInstance` and `validateLayout`, so the CLI cannot
 * put a shape into the database that the running server would reject. A
 * seeder that wrote SQLite directly would be a second, weaker validator.
 *
 * `fetchImpl` is injectable so the tests can run against an in-process Fastify
 * instance rather than a listening port — the same pattern the qBittorrent
 * connector tests use.
 */

import { basename, extname } from 'node:path';

/** An API call that came back non-2xx, carrying enough to report it usefully. */
export class HavenApiError extends Error {
  constructor(method, path, status, body) {
    const detail =
      body && typeof body === 'object'
        ? (body.message ?? body.error ?? JSON.stringify(body))
        : String(body ?? '').slice(0, 200);
    super(`${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'HavenApiError';
    this.status = status;
    this.body = body;
  }
}

/** Icon content types, mirroring `ALLOWED_ICON_TYPES` in `routes/apps.js`. */
const ICON_TYPES = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

export function createClient({ baseUrl, fetchImpl = globalThis.fetch } = {}) {
  if (!baseUrl) throw new Error('createClient requires a baseUrl.');
  const root = baseUrl.replace(/\/+$/, '');

  async function request(method, path, body) {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const response = await fetchImpl(`${root}${path}`, init);

    // 204 has no body, and a JSON parse of an empty string throws.
    const text = response.status === 204 ? '' : await response.text();
    let parsed = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!response.ok) throw new HavenApiError(method, path, response.status, parsed);
    return parsed;
  }

  return {
    async listApps() {
      return (await request('GET', '/api/apps')).apps ?? [];
    },

    createApp: (app) => request('POST', '/api/apps', app),
    updateApp: (id, app) => request('PUT', `/api/apps/${encodeURIComponent(id)}`, app),

    async listInstances() {
      return (await request('GET', '/api/instances')).instances ?? [];
    },

    createInstance: (instance) => request('POST', '/api/instances', instance),
    updateInstance: (id, instance) =>
      request('PUT', `/api/instances/${encodeURIComponent(id)}`, instance),

    async getLayout() {
      return (await request('GET', '/api/layout')).layout ?? {};
    },

    saveLayout: (layout) => request('PUT', '/api/layout', layout),

    /**
     * Uploads one icon as multipart/form-data.
     *
     * The content type is derived from the file EXTENSION rather than sniffed,
     * because the server's allow-list is a `mimetype` check and an unknown
     * type is a 415 the caller should see as a clear failure rather than a
     * mystery. The stored filename is the server's business — it derives it
     * from the app id and ignores the name sent here (`routes/apps.js` calls a
     * client-supplied name "a path-traversal waiting to happen").
     */
    async uploadIcon(id, filename, bytes) {
      const type = ICON_TYPES.get(extname(filename).toLowerCase());
      if (!type) {
        throw new Error(
          `Unsupported icon type "${extname(filename) || filename}" — expected one of: ${[...ICON_TYPES.keys()].join(', ')}.`
        );
      }

      const form = new FormData();
      form.append('file', new Blob([bytes], { type }), basename(filename));

      const path = `/api/apps/${encodeURIComponent(id)}/icon`;
      const response = await fetchImpl(`${root}${path}`, { method: 'POST', body: form });

      const text = response.status === 204 ? '' : await response.text();
      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }

      if (!response.ok) throw new HavenApiError('POST', path, response.status, parsed);
      return parsed;
    },
  };
}
