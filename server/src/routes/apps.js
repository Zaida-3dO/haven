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
  listFeaturedApps,
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

/**
 * Hero covers. A cover is a full-bleed background image rather than a 48px
 * icon, so it gets its own, larger cap — but the same allow-list discipline,
 * minus SVG.
 *
 * SVG is deliberately excluded here even though icons allow it: an SVG is a
 * document that can carry script, and a cover is rendered full-bleed behind
 * content rather than as a small decorative mark. The icon endpoint's existing
 * behaviour is left alone; this is the stricter of the two on purpose.
 */
const MAX_COVER_BYTES = 4 * 1024 * 1024;
const ALLOWED_COVER_TYPES = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
  ['image/avif', '.avif'],
]);

/**
 * Streams an upload to disk, enforcing `maxBytes` on the way through.
 *
 * The per-route cap is counted HERE rather than relying on the multipart
 * plugin's `fileSize` limit, because that limit is configured once for the
 * whole plugin and there are now two routes with different ceilings. Leaning on
 * the plugin's `truncated` flag alone would silently raise the icon cap to the
 * cover's 4MB the moment the shared limit went up — a weakening with no visible
 * symptom, which is the kind that survives review.
 *
 * The partial file is always removed on rejection, so a too-large upload never
 * leaves a corrupt image on the volume.
 *
 * @returns {{ ok: true } | { ok: false, reason: 'too-large' }}
 */
async function writeUpload(file, destination, maxBytes) {
  let written = 0;
  const count = async function* (source) {
    for await (const chunk of source) {
      written += chunk.length;
      if (written > maxBytes) throw new TooLargeError();
      yield chunk;
    }
  };

  try {
    await pipeline(file.file, count, createWriteStream(destination));
  } catch (err) {
    await unlink(destination).catch(() => {});
    if (err instanceof TooLargeError) return { ok: false, reason: 'too-large' };
    throw err;
  }

  // Belt and braces: the plugin's own limit may have cut the stream short
  // before our counter ever saw the overage.
  if (file.file.truncated) {
    await unlink(destination).catch(() => {});
    return { ok: false, reason: 'too-large' };
  }

  return { ok: true };
}

class TooLargeError extends Error {}

const badRequest = (reply, errors) =>
  reply.code(400).send({ error: 'INVALID_APP', message: 'Validation failed.', details: errors });

const notFound = (reply, id) =>
  reply.code(404).send({ error: 'NOT_FOUND', message: `No app with id "${id}".` });

export async function registerAppRoutes(app, { db, iconDir = config.iconDir } = {}) {
  if (!db) throw new Error('registerAppRoutes requires a database handle.');

  await app.register(import('@fastify/multipart'), {
    // The larger of the two caps; each route then enforces its OWN limit on
    // the stream it received, so a 4MB upload to /icon is still rejected.
    limits: { fileSize: Math.max(MAX_ICON_BYTES, MAX_COVER_BYTES), files: 1 },
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
        .send({ error: 'DUPLICATE_ID', message: `An app with id "${result.value.id}" exists.` });
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
      return reply.code(400).send({ error: 'NO_FILE', message: 'Expected a file upload.' });
    }

    const ext = ALLOWED_ICON_TYPES.get(file.mimetype);
    if (!ext) {
      return reply.code(415).send({
        error: 'UNSUPPORTED_TYPE',
        message: `Icon must be one of: ${[...ALLOWED_ICON_TYPES.keys()].join(', ')}.`,
      });
    }

    // The stored name is derived from the app id, never from the uploaded
    // filename — a client-supplied name is a path-traversal waiting to happen.
    const filename = `${id}${ext}`;
    const destination = join(resolve(iconDir), filename);

    await mkdir(resolve(iconDir), { recursive: true });

    const written = await writeUpload(file, destination, MAX_ICON_BYTES);
    if (!written.ok) {
      return reply.code(413).send({
        error: 'FILE_TOO_LARGE',
        message: `Icon must be ${MAX_ICON_BYTES / 1024}KB or smaller.`,
      });
    }

    const updated = updateApp(db, id, { ...existing, icon: filename });
    return { id, icon: filename, app: updated };
  });

  /**
   * Cover upload for an app's hero slide.
   *
   * Writes to the same data volume as icons, under a `hero-` prefix so a cover
   * and an icon for the same app cannot collide on one filename.
   */
  app.post('/api/apps/:id/cover', async (request, reply) => {
    const { id } = request.params;
    const existing = getApp(db, id);
    if (!existing) return notFound(reply, id);

    if (!existing.featured) {
      return reply.code(409).send({
        error: 'NOT_FEATURED',
        message: `App "${id}" has no featured block to attach a cover to.`,
      });
    }

    const file = await request.file();
    if (!file) {
      return reply.code(400).send({ error: 'NO_FILE', message: 'Expected a file upload.' });
    }

    const ext = ALLOWED_COVER_TYPES.get(file.mimetype);
    if (!ext) {
      return reply.code(415).send({
        error: 'UNSUPPORTED_TYPE',
        message: `Cover must be one of: ${[...ALLOWED_COVER_TYPES.keys()].join(', ')}.`,
      });
    }

    // Derived from the app id, never from the uploaded filename.
    const filename = `hero-${id}${ext}`;
    const destination = join(resolve(iconDir), filename);

    await mkdir(resolve(iconDir), { recursive: true });

    const written = await writeUpload(file, destination, MAX_COVER_BYTES);
    if (!written.ok) {
      return reply.code(413).send({
        error: 'FILE_TOO_LARGE',
        message: `Cover must be ${MAX_COVER_BYTES / (1024 * 1024)}MB or smaller.`,
      });
    }

    const updated = updateApp(db, id, {
      ...existing,
      featured: { ...existing.featured, cover: filename },
    });
    return { id, cover: filename, app: updated };
  });

  /**
   * GET /api/widgets/hero — the app-linked slides.
   *
   * Lives on the apps route rather than in `widgets.js` because it is a
   * registry query, and the registry's data access is here. It returns only
   * what a slide needs: an id, a title, the tagline, the cover filename and the
   * click target. Notably it does NOT return the full `urls` array — the hero
   * links to the primary address, and shipping every internal alias to the
   * browser for a decorative banner would be handing out a map of the network
   * for no benefit.
   */
  app.get('/api/widgets/hero', async (request, reply) => {
    const slides = listFeaturedApps(db).map((entry) => ({
      id: entry.id,
      type: 'app',
      title: entry.name,
      tagline: entry.featured.tagline,
      cover: entry.featured.cover ?? null,
      url: (entry.urls.find((u) => u.primary) ?? entry.urls[0])?.url ?? null,
    }));

    // Never cached: featuring something is an editorial act and should show up
    // on the next load, not in half an hour.
    reply.header('cache-control', 'no-store');
    return { slides };
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

export { MAX_ICON_BYTES, ALLOWED_ICON_TYPES, MAX_COVER_BYTES, ALLOWED_COVER_TYPES };
