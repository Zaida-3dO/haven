/**
 * The notice envelope — the fixed shape every source produces.
 *
 * This module is the whole point of the notices feature. DESIGN §6.6 settles
 * that the widget renders anything matching ONE shape, so Home Assistant, a
 * future chores app and anything else feed the same widget instead of a new
 * widget being built per source. That only holds if the shape is enforced at
 * the single point everything enters through — here, on ingest.
 *
 *   { id, severity: "info|warn|urgent", title, body, due (ISO-8601),
 *     source, url, actions[] }
 *
 * Two rules follow from "validated on ingest", and both are deliberate:
 *
 *   1. A MALFORMED NOTICE IS REJECTED, NOT STORED. Storing it and coping in
 *      the widget would mean every future renderer re-implements the same
 *      defensive parsing, which is exactly the per-source divergence the
 *      envelope exists to prevent.
 *   2. THE ERROR NAMES THE FIELD AND WHAT WAS WRONG WITH IT. A source is
 *      usually a script someone wrote at 1am; "severity must be one of info,
 *      warn, urgent (got \"critical\")" is fixable, "400 Bad Request" is not.
 *
 * Unknown keys are dropped rather than rejected. A source that sends extra
 * metadata should not fail, but nothing unvetted reaches the database or the
 * browser either — only the fields below cross this boundary.
 */

/** Ordered least to most urgent, so the index doubles as a sort weight. */
export const SEVERITIES = Object.freeze(['info', 'warn', 'urgent']);

/** Cheap ceilings, so one bad source cannot fill the disk or the tile. */
export const LIMITS = Object.freeze({
  id: 200,
  title: 300,
  body: 2000,
  source: 100,
  url: 2000,
  actionId: 100,
  actionLabel: 60,
  actions: 6,
});

/** Only these schemes may appear in a notice `url` or an action target. */
const SAFE_URL_SCHEMES = Object.freeze(['http:', 'https:']);

/** Thrown for anything a source could fix by sending different JSON. */
export class NoticeValidationError extends Error {
  /**
   * @param {string} field the offending field, dotted for nested ones
   * @param {string} message what was wrong, in words the sender can act on
   */
  constructor(field, message) {
    super(message);
    this.name = 'NoticeValidationError';
    this.field = field;
  }
}

const fail = (field, message) => {
  throw new NoticeValidationError(field, message);
};

/**
 * A required, non-empty, length-capped string.
 *
 * Whitespace-only is treated as absent rather than as a value: a title of
 * "   " renders as an empty tile, which is a bug that arrives silently.
 */
function requireString(value, field, max) {
  if (typeof value !== 'string') {
    fail(field, `${field} is required and must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed === '') fail(field, `${field} must not be empty.`);
  if (trimmed.length > max) {
    fail(field, `${field} must be ${max} characters or fewer (got ${trimmed.length}).`);
  }
  return trimmed;
}

/** The same, but absent/null is allowed and normalises to `null`. */
function optionalString(value, field, max) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') fail(field, `${field} must be a string when present.`);
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > max) {
    fail(field, `${field} must be ${max} characters or fewer (got ${trimmed.length}).`);
  }
  return trimmed;
}

/**
 * An absolute http(s) URL, or null.
 *
 * Scheme-checked rather than merely parsed: `javascript:alert(1)` is a valid
 * URL as far as `new URL` is concerned, and the widget renders `url` as a
 * link. Rejecting it here means the widget never has to think about it.
 */
function optionalUrl(value, field) {
  const raw = optionalString(value, field, LIMITS.url);
  if (raw === null) return null;

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    fail(field, `${field} must be an absolute http(s) URL.`);
  }
  if (!SAFE_URL_SCHEMES.includes(parsed.protocol)) {
    fail(field, `${field} must use http or https (got "${parsed.protocol}").`);
  }
  return parsed.toString();
}

/**
 * An ISO-8601 instant, normalised to UTC.
 *
 * Normalising on ingest rather than on read is what makes `due` sortable in
 * SQL and comparable across sources: one source sends `+01:00`, another sends
 * `Z`, and ordering by the raw string would interleave them wrongly.
 *
 * A date-only value (`2026-09-01`) is accepted and read as midnight UTC —
 * chores and reminders are routinely day-granular, and rejecting the most
 * natural thing to send would push the workaround into every source.
 */
export function parseDue(value, field = 'due') {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') fail(field, `${field} must be an ISO-8601 string when present.`);

  const raw = value.trim();
  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    fail(field, `${field} must be an ISO-8601 timestamp (got "${raw}").`);
  }

  // Date.parse is lenient enough to accept "March 2 2026", which is not
  // ISO-8601 and is ambiguous across locales. Require the ISO shape too.
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/.test(raw)) {
    fail(field, `${field} must be an ISO-8601 timestamp (got "${raw}").`);
  }

  return new Date(timestamp).toISOString();
}

/**
 * One action button.
 *
 * `id` is what the browser sends back to `POST /api/widgets/notices/:id/actions/:actionId`,
 * and it is deliberately an opaque identifier rather than anything executable:
 * the browser must never learn what an action *does*, because doing it means
 * calling Home Assistant with a long-lived token. See docs/SECURITY.md.
 */
function parseAction(value, index) {
  const at = `actions[${index}]`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(at, `${at} must be an object.`);
  }

  const id = requireString(value.id, `${at}.id`, LIMITS.actionId);
  const label = requireString(value.label, `${at}.label`, LIMITS.actionLabel);

  return Object.freeze({
    id,
    label,
    /**
     * Where the backend sends the action, resolved server-side. Optional:
     * without it the action is recorded and the notice dismissed, which is
     * what a "Done" button on a chore means.
     */
    target: optionalUrl(value.target, `${at}.target`),
    method: parseMethod(value.method, `${at}.method`),
    /** Whether performing it also dismisses the notice. Defaults to true. */
    dismisses: value.dismisses === undefined ? true : Boolean(value.dismisses),
  });
}

function parseMethod(value, field) {
  if (value === undefined || value === null) return 'POST';
  if (typeof value !== 'string') fail(field, `${field} must be a string when present.`);
  const method = value.trim().toUpperCase();
  if (!['GET', 'POST'].includes(method)) {
    fail(field, `${field} must be GET or POST (got "${value}").`);
  }
  return method;
}

/**
 * Validate and normalise one notice.
 *
 * @param {unknown} input the raw envelope as posted
 * @param {object} [options]
 * @param {string} [options.defaultSource] source to use when the sender omits
 *   one — the HA connector stamps its own rather than trusting the payload
 * @returns {object} a frozen, normalised notice
 * @throws {NoticeValidationError}
 */
export function parseNotice(input, { defaultSource = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('notice', 'A notice must be a JSON object.');
  }

  const severity = input.severity ?? 'info';
  if (!SEVERITIES.includes(severity)) {
    fail(
      'severity',
      `severity must be one of ${SEVERITIES.join(', ')} (got ${JSON.stringify(input.severity)}).`
    );
  }

  if (input.actions !== undefined && input.actions !== null && !Array.isArray(input.actions)) {
    fail('actions', 'actions must be an array when present.');
  }
  const rawActions = input.actions ?? [];
  if (rawActions.length > LIMITS.actions) {
    fail('actions', `A notice may carry at most ${LIMITS.actions} actions.`);
  }

  const actions = rawActions.map(parseAction);

  // Two buttons with the same id make the callback ambiguous, and the widget
  // would render two tiles that do the same thing.
  const ids = new Set();
  for (const action of actions) {
    if (ids.has(action.id)) fail('actions', `Duplicate action id "${action.id}".`);
    ids.add(action.id);
  }

  const source = optionalString(input.source, 'source', LIMITS.source) ?? defaultSource;
  if (source === null) fail('source', 'source is required and must be a string.');

  return Object.freeze({
    id: requireString(input.id, 'id', LIMITS.id),
    severity,
    title: requireString(input.title, 'title', LIMITS.title),
    body: optionalString(input.body, 'body', LIMITS.body),
    due: parseDue(input.due),
    source,
    url: optionalUrl(input.url, 'url'),
    actions: Object.freeze(actions),
  });
}

/**
 * Validate a batch, reporting EVERY bad entry rather than only the first.
 *
 * A source posting twenty notices should learn about all three malformed ones
 * in one round trip; failing on the first turns fixing a feed into a loop of
 * post-fix-post. The batch is still all-or-nothing — a partial write would
 * leave the sender unsure what landed.
 *
 * @returns {{ notices: object[], errors: {index: number, field: string, message: string}[] }}
 */
export function parseNotices(input, options = {}) {
  const list = Array.isArray(input) ? input : [input];
  const notices = [];
  const errors = [];

  list.forEach((entry, index) => {
    try {
      notices.push(parseNotice(entry, options));
    } catch (error) {
      if (!(error instanceof NoticeValidationError)) throw error;
      errors.push({ index, field: error.field, message: error.message });
    }
  });

  // Two notices with the same id in one batch: the second would overwrite the
  // first, so the sender would silently lose one.
  const seen = new Map();
  notices.forEach((notice, index) => {
    if (seen.has(notice.id)) {
      errors.push({
        index,
        field: 'id',
        message: `Duplicate notice id "${notice.id}" in the same batch.`,
      });
    }
    seen.set(notice.id, index);
  });

  return { notices, errors };
}
