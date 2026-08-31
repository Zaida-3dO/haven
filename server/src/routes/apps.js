/**
 * App registry API.
 *
 * The registry is seeded from `config/apps.json` on first boot and is the
 * source of truth thereafter (docs/DESIGN.md §6.2). Reachability probing is
 * NOT here and must not move here: it runs in the browser, because a status
 * dot has to mean "reachable from where *you* are". See
 * `web/src/lib/reachability.js`.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import {
  createApp,
  deleteApp,
  getApp,
  listApps,
  recordVisit,
  updateApp,
} from '../db/apps-store.js';
import { validateApp } from './apps-schema.js';

/**
 * Icon uploads. Kept small and tightly typed: this endpoint writes a
 * browser-supplied file to the data volume, so the extension allow-list and
 * the size cap are the security boundary, not a nicety.
 */
const MAX_ICON_BYTES = 512 * 1024;
const ALLOWED_ICON_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/svg+xml', '.svg'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const badRequest = (reply, errors) =>
  reply.code(400).send({ error: 'invalid_app', message: 'Validation failed.', details: errors });

const notFound = (reply, id) =>
  reply.code(404).send({ error: 'not_found', message: `No app with id "${id}".` });

export async function registerAppRoutes(app, { db, iconDir = config.iconDir } = {}) {
  if (!db) throw new Error('registerAppRoutes requires a database handle.');

  await app.register(import('@fastify/multipart'), {
    limits: { fileSize: MAX_ICON_BYTES, files: 1 },
  });

  app.get('/api/apps', async (request) => {
    const { category } = request.query ?? {};
    return { apps: listApps(db, { category }) };
  });

  app.get('/api/apps/:id', async (request, reply) => {
    const found = getApp(db, request.params.id);
    return found ?? notFound(reply, request.params.id);
  });

  app.post('/api/apps', async (request, reply) => {
    const result = validateApp(request.body);
    if (!result.valid) return badRequest(reply, result.errors);

    if (getApp(db, result.value.id)) {
      return reply
        .code(409)
        .send({ error: 'duplicate_id', message: `An app with id "${result.value.id}" exists.` });
    }

    return reply.code(201).send(createApp(db, result.value));
  });

  app.put('/api/apps/:id', async (request, reply) => {
    const { id } = request.params;

    // The id is taken from the path, never the body — a PUT must not be able
    // to rename the row it is addressing.
    const result = validateApp(request.body, { requireId: false });
    if (!result.valid) return badRequest(reply, result.errors);

    const updated = updateApp(db, id, result.value);
    return updated ?? notFound(reply, id);
  });

  app.delete('/api/apps/:id', async (request, reply) => {
    if (!deleteApp(db, request.params.id)) return notFound(reply, request.params.id);
    return reply.code(204).send();
  });

  /** Visit counting is server-side so the count cannot be set by a client. */
  app.post('/api/apps/:id/visit', async (request, reply) => {
    const visitCount = recordVisit(db, request.params.id);
    if (visitCount === null) return notFound(reply, request.params.id);
    return { id: request.params.id, visitCount };
  });

  /**
   * Icon upload. Writes to the data volume — NEVER into the repo — and returns
   * the bare filename to store on the app.
   */
  app.post('/api/apps/:id/icon', async (request, reply) => {
    const { id } = request.params;
    const existing = getApp(db, id);
    if (!existing) return notFound(reply, id);

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'no_file', message: 'Expected a file upload.' });
    }

    const ext = ALLOWED_ICON_TYPES.get(file.mimetype);
    if (!ext) {
      return reply.code(415).send({
        error: 'unsupported_type',
        message: `Icon must be one of: ${[...ALLOWED_ICON_TYPES.keys()].join(', ')}.`,
      });
    }

    // The stored name is derived from the app id, never from the uploaded
    // filename — a client-supplied name is a path-traversal waiting to happen.
    const filename = `${id}${ext}`;
    const destination = join(resolve(iconDir), filename);

    await mkdir(resolve(iconDir), { recursive: true });

    try {
      await pipeline(file.file, createWriteStream(destination));
    } catch (err) {
      await unlink(destination).catch(() => {});
      throw err;
    }

    // `file.file.truncated` is set when the stream hit the limit. The partial
    // file is removed rather than left as a corrupt icon.
    if (file.file.truncated) {
      await unlink(destination).catch(() => {});
      return reply.code(413).send({
        error: 'file_too_large',
        message: `Icon must be ${MAX_ICON_BYTES / 1024}KB or smaller.`,
      });
    }

    const updated = updateApp(db, id, { ...existing, icon: filename });
    return { id, icon: filename, app: updated };
  });

  // Serve the uploaded icons back. Registered in its own scope so the static
  // plugin's root does not leak into the rest of the server.
  await app.register(async (scope) => {
    await scope.register(import('@fastify/static'), {
      root: resolve(iconDir),
      prefix: '/api/apps/icons/',
      decorateReply: false,
    });
  });
}

export { MAX_ICON_BYTES, ALLOWED_ICON_TYPES };
