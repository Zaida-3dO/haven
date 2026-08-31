/**
 * Notice endpoints — `/api/widgets/notices`.
 *
 * Four routes, and the shape of them is the security argument:
 *
 *   GET    /api/widgets/notices                       what to show
 *   POST   /api/widgets/notices                       a source ingests
 *   POST   /api/widgets/notices/:id/dismiss           the user dismisses
 *   POST   /api/widgets/notices/:id/actions/:actionId the user acts
 *
 * The last one is the one that matters. A notice's action carries a *target* —
 * for Home Assistant, a service call made with a long-lived token. The browser
 * sends only the opaque action id and the backend resolves what it means, so
 * the target never appears in front-end JSON and the token never leaves this
 * process (docs/SECURITY.md). An action that called out from the browser would
 * mean shipping the token to the browser, which is the whole reason there is a
 * backend at all.
 */

import { createHomeAssistantConnector, HA_STATUS } from '../connectors/home-assistant.js';
import {
  dismissNotice,
  getNotice,
  getNoticeAction,
  listLiveNotices,
  purgeExpiredNotices,
  upsertNotices,
} from '../db/notices-store.js';
import { parseNotices } from '../notices/envelope.js';
import { loadSettings } from '../settings.js';

/** Cap on one ingest batch — a source is a script, not a firehose. */
export const MAX_BATCH = 100;

export const NOTICES_STATUS = Object.freeze({
  OK: 'ok',
  NOT_CONFIGURED: 'not_configured',
});

export async function registerNoticeRoutes(app, opts = {}) {
  const db = opts.db ?? app.db;

  // Read once at boot, like the widget routes: the file is hand-edited, so a
  // read per request would be a syscall per dashboard poll.
  const settings = opts.settings ?? loadSettings({ logger: app.log });

  const homeAssistant =
    opts.homeAssistantConnector ??
    createHomeAssistantConnector({
      entities: () => settings.notices?.haEntities ?? [],
      logger: app.log,
      ...opts.ha,
    });

  const now = opts.now ?? (() => Date.now());

  /**
   * Pull the current Home Assistant notices into storage.
   *
   * Ingesting on read rather than on a timer is deliberate: the connector
   * caches for a minute, so a dashboard polling every 30s costs HA one call a
   * minute, and there is no background job to supervise. If a second source
   * ever needs a schedule, that is when a scheduler earns its place.
   *
   * A failure here is never fatal to the read — stored notices from every
   * other source still render.
   */
  async function ingestFromHomeAssistant() {
    const result = await homeAssistant.get();

    if (result.status !== HA_STATUS.OK) return result;

    const { notices, errors } = parseNotices(result.notices ?? [], { defaultSource: 'unknown' });

    if (errors.length > 0) {
      // Our own mapper produced these, so a rejection is a bug on our side,
      // not a misbehaving caller. Log it rather than failing the read.
      app.log.warn({ errors }, 'home assistant notices failed validation');
    }

    if (notices.length > 0) upsertNotices(db, notices, { now: now() });

    return result;
  }

  /**
   * GET /api/widgets/notices — everything worth showing, soonest first.
   *
   * Always 200. "Not configured" is a first-run state to render, not a
   * failure, exactly as it is for weather.
   */
  app.get('/api/widgets/notices', async (request, reply) => {
    let upstream = null;
    try {
      upstream = await ingestFromHomeAssistant();
    } catch (error) {
      // The connector is not supposed to throw; if it does, stored notices are
      // still worth serving.
      app.log.error({ err: error }, 'notice ingest failed');
    }

    // Cheap and bounded, and it keeps the table from growing without a cron.
    purgeExpiredNotices(db, { now: now() });

    const notices = listLiveNotices(db, { now: now() });

    // The hint tile is only right when there is genuinely nothing to show.
    // With notices from another source on the board, "not configured" would be
    // noise about a source the user may not even want.
    if (upstream?.status === HA_STATUS.NOT_CONFIGURED && notices.length === 0) {
      reply.header('cache-control', 'no-store');
      return {
        status: NOTICES_STATUS.NOT_CONFIGURED,
        reason: upstream.reason,
        hint: upstream.hint,
        notices: [],
      };
    }

    // Never cached: a dismissal must take effect on the next poll, and a
    // cached notice list is a notice you already dealt with coming back.
    reply.header('cache-control', 'no-store');

    const payload = { status: NOTICES_STATUS.OK, notices, fetchedAt: now() };

    // A soft notice, not an error: the data still draws, with a marker.
    if (upstream?.stale && upstream.notice) payload.notice = upstream.notice;

    return payload;
  });

  /**
   * POST /api/widgets/notices — a source ingests one notice or a batch.
   *
   * Validated here and rejected on failure. The response names every bad
   * entry, not just the first, because a source posting twenty notices should
   * learn about all three broken ones in one round trip.
   */
  app.post('/api/widgets/notices', async (request, reply) => {
    const body = request.body;

    if (body === undefined || body === null) {
      return reply.code(400).send({
        error: 'INVALID_NOTICE',
        message: 'Send a notice object or an array of them.',
      });
    }

    const list = Array.isArray(body) ? body : [body];

    if (list.length === 0) {
      return reply.code(400).send({
        error: 'INVALID_NOTICE',
        message: 'Send at least one notice.',
      });
    }

    if (list.length > MAX_BATCH) {
      return reply.code(413).send({
        error: 'BATCH_TOO_LARGE',
        message: `At most ${MAX_BATCH} notices per request (got ${list.length}).`,
      });
    }

    const { notices, errors } = parseNotices(list);

    if (errors.length > 0) {
      // All-or-nothing: a partial write leaves the sender unsure what landed.
      return reply.code(400).send({
        error: 'INVALID_NOTICE',
        message: `${errors.length} of ${list.length} notices were rejected; nothing was stored.`,
        errors,
      });
    }

    const { written, ids } = upsertNotices(db, notices, { now: now() });

    return reply.code(201).send({ status: NOTICES_STATUS.OK, written, ids });
  });

  /** POST /api/widgets/notices/:id/dismiss — idempotent. */
  app.post('/api/widgets/notices/:id/dismiss', async (request, reply) => {
    const dismissed = dismissNotice(db, request.params.id, { now: now() });

    if (!dismissed) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such notice.' });
    }

    return { status: NOTICES_STATUS.OK, id: request.params.id, dismissed: true };
  });

  /**
   * POST /api/widgets/notices/:id/actions/:actionId
   *
   * The browser knows an action's id and label and nothing else. Everything
   * about what it *does* — which service, on which host, with which token —
   * is resolved here.
   */
  app.post('/api/widgets/notices/:id/actions/:actionId', async (request, reply) => {
    const { id, actionId } = request.params;

    const notice = getNotice(db, id);
    if (!notice) {
      return reply.code(404).send({ error: 'NOT_FOUND', message: 'No such notice.' });
    }

    const action = getNoticeAction(db, id, actionId);
    if (!action) {
      return reply
        .code(404)
        .send({ error: 'NOT_FOUND', message: 'No such action on this notice.' });
    }

    let performed = { status: NOTICES_STATUS.OK };

    // An action with no target is a "Done" button: recording it and dismissing
    // the notice is the whole behaviour, and it needs no upstream at all.
    if (action.service || action.target) {
      if (notice.source !== 'home-assistant') {
        // Only Home Assistant actions are executable so far. A stored target
        // from an arbitrary source is not something to fetch on demand — that
        // would make the ingest endpoint a request forwarder.
        return reply.code(501).send({
          error: 'UNSUPPORTED_SOURCE',
          message: `Actions are not yet supported for notices from "${notice.source}".`,
        });
      }

      const result = await homeAssistant.perform(action);

      if (result.status === HA_STATUS.NOT_CONFIGURED) {
        return reply.code(503).send({
          error: 'NOT_CONFIGURED',
          message: result.hint,
        });
      }

      if (result.status === HA_STATUS.ERROR) {
        // 502: the action was well-formed, the upstream failed. The widget
        // shows this rather than pretending the button worked.
        return reply.code(502).send({
          error: result.error,
          message: result.message ?? 'The action could not be completed.',
        });
      }

      performed = result;
    }

    if (action.dismisses !== false) dismissNotice(db, id, { now: now() });

    return {
      status: NOTICES_STATUS.OK,
      id,
      actionId,
      dismissed: action.dismisses !== false,
      performed: performed.status === NOTICES_STATUS.OK,
    };
  });
}
