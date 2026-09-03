/**
 * The local calendar-event envelope — the shape every write must match.
 *
 * This is the calendar counterpart to `server/src/notices/envelope.js`, and
 * it is deliberately the same shape of module for the same reason: writes
 * arrive from outside (an agent, a script, a curl), so there is exactly one
 * place where an outside value becomes a stored value, and it validates
 * rather than repairs.
 *
 *   { id, title, start, end, allDay, description, location, source }
 *
 * Three rules, all inherited from the notices envelope because they were
 * already right:
 *
 *   1. A MALFORMED EVENT IS REJECTED, NOT REPAIRED. Guessing that
 *      `start: "next tuesday"` meant a particular instant is how a calendar
 *      silently shows the wrong day. The caller is a program; it can be told.
 *   2. THE ERROR NAMES THE FIELD AND WHAT WAS WRONG WITH IT. `start must be
 *      an ISO-8601 timestamp (got "next tuesday")` is fixable by the agent
 *      that sent it without a human reading a server log.
 *   3. EVERY BAD ENTRY IN A BATCH IS REPORTED, not just the first — see
 *      `parseCalendarEvents`.
 *
 * Unknown keys are dropped rather than rejected on create, so a caller
 * sending extra metadata does not fail, and nothing unvetted reaches SQLite
 * or the browser. On PATCH they are refused — see `parseEventPatch`.
 */

/** Cheap ceilings, so one caller cannot fill the disk or blow out the tile. */
export const LIMITS = Object.freeze({
  id: 200,
  title: 300,
  description: 2000,
  location: 300,
});

/**
 * How far apart start and end may be.
 *
 * A local event is a diary entry, not a geological era. Without a ceiling a
 * single event with `end: "9999-12-31"` sits in every range query forever and
 * is indistinguishable from a bug in the caller.
 */
export const MAX_DURATION_MS = 366 * 24 * 60 * 60 * 1000;

/** The `source` value every locally-stored event carries. Reserved. */
export const LOCAL_SOURCE = 'local';

/** Thrown for anything a caller could fix by sending different JSON. */
export class CalendarValidationError extends Error {
  /**
   * @param {string} field the offending field
   * @param {string} message what was wrong, in words the sender can act on
   */
  constructor(field, message) {
    super(message);
    this.name = 'CalendarValidationError';
    this.field = field;
  }
}

const fail = (field, message) => {
  throw new CalendarValidationError(field, message);
};

/** A required, non-empty, length-capped string. */
function requireString(value, field, max) {
  if (typeof value !== 'string') fail(field, `${field} is required and must be a string.`);
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

/** `YYYY-MM-DD`. Shape only — `2026-02-31` matches and is rejected below. */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** ISO-8601 with a time component. A zone is optional; absent means UTC. */
const DATE_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * A calendar date, kept as a DATE and never turned into an instant.
 *
 * This is the same rule `ics-parse.js` enforces for all-day ICS events, and
 * it exists for the same reason: `new Date('2026-06-12')` is UTC midnight,
 * which is the ELEVENTH for any viewer west of UTC. An all-day event is "the
 * 12th" everywhere, so it is stored and returned as the string `2026-06-12`
 * and never round-tripped through a `Date` for display.
 */
export function parseDateOnly(value, field) {
  if (typeof value !== 'string') fail(field, `${field} must be a "YYYY-MM-DD" date string.`);
  const raw = value.trim();
  if (!DATE_ONLY.test(raw)) {
    fail(field, `${field} must be a "YYYY-MM-DD" date for an all-day event (got "${raw}").`);
  }
  // Round-trip through UTC purely to reject dates that match the shape but do
  // not exist. Nothing derived from this Date is kept.
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    fail(field, `${field} is not a real date (got "${raw}").`);
  }
  return raw;
}

/**
 * An ISO-8601 instant, normalised to UTC.
 *
 * Normalising on ingest is what makes a range query in SQL correct: one
 * caller sends `+01:00`, another sends `Z`, and comparing the raw strings
 * would order them wrongly. `Date.parse` alone is too lenient — it accepts
 * "March 2 2026", which is not ISO-8601 and is ambiguous across locales — so
 * the shape is checked too.
 */
export function parseInstant(value, field) {
  if (typeof value !== 'string') fail(field, `${field} must be an ISO-8601 timestamp string.`);
  const raw = value.trim();

  if (!DATE_TIME.test(raw)) {
    fail(
      field,
      `${field} must be an ISO-8601 timestamp such as "2026-06-12T09:00:00Z" (got "${raw}").`
    );
  }

  const timestamp = Date.parse(raw);
  if (!Number.isFinite(timestamp)) {
    fail(field, `${field} must be an ISO-8601 timestamp (got "${raw}").`);
  }
  return new Date(timestamp).toISOString();
}

/**
 * Validate and normalise one local event.
 *
 * `allDay` decides which pair of fields is authoritative, and the two are
 * mutually exclusive by construction — an all-day event carries
 * `startDate`/`endDate` and NO instant, a timed one carries `start`/`end` and
 * no date. That is exactly the shape `ics-parse.js` produces, so the merged
 * view is one shape rather than two the widget has to branch on.
 *
 * @param {unknown} input the raw event as posted
 * @returns {object} a frozen, normalised event (without an id)
 * @throws {CalendarValidationError}
 */
export function parseCalendarEvent(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('event', 'An event must be a JSON object.');
  }

  if (input.allDay !== undefined && typeof input.allDay !== 'boolean') {
    fail(
      'allDay',
      `allDay must be true or false when present (got ${JSON.stringify(input.allDay)}).`
    );
  }

  /**
   * `source` is what tells a caller — and the PATCH/DELETE routes — whether
   * an event can be written to. It is NOT a caller-supplied value: a POST
   * claiming `source: "feed-1"` would otherwise mint an event that looks like
   * it came from a read-only ICS feed. The store stamps it instead, and it is
   * named here only so the refusal is loud rather than a silent key-drop.
   */
  if (input.source !== undefined && input.source !== null && input.source !== LOCAL_SOURCE) {
    fail(
      'source',
      `source is assigned by Haven and cannot be set (got ${JSON.stringify(input.source)}). ` +
        `Events created here are always "${LOCAL_SOURCE}"; events from an ICS feed ` +
        'are read-only and cannot be created through this API.'
    );
  }

  const allDay = input.allDay === true;
  const title = requireString(input.title, 'title', LIMITS.title);
  const description = optionalString(input.description, 'description', LIMITS.description);
  const location = optionalString(input.location, 'location', LIMITS.location);

  if (allDay) {
    const startField = input.startDate === undefined ? 'start' : 'startDate';
    const startDate = parseDateOnly(input.startDate ?? input.start, startField);

    // An absent end means a single-day event. Note this is the INCLUSIVE last
    // day, not the exclusive DTEND an ICS feed uses — `ics-parse.js` already
    // converts feed events to the inclusive form, so both sources agree.
    const endField = input.endDate === undefined ? 'end' : 'endDate';
    const rawEnd = input.endDate ?? input.end;
    const endDate =
      rawEnd === undefined || rawEnd === null ? startDate : parseDateOnly(rawEnd, endField);

    if (endDate < startDate) {
      fail(endField, `${endField} ("${endDate}") is before start ("${startDate}").`);
    }

    return Object.freeze({
      title,
      allDay: true,
      start: null,
      end: null,
      startDate,
      endDate,
      description,
      location,
    });
  }

  if (input.startDate !== undefined || input.endDate !== undefined) {
    fail(
      'startDate',
      'startDate/endDate describe an all-day event — set allDay: true, or use start/end for a timed one.'
    );
  }

  const start = parseInstant(input.start, 'start');
  // An absent end means a zero-length event (a point in time). That is a real
  // thing people put in calendars ("call at 3"), so it is not an error.
  const end =
    input.end === undefined || input.end === null ? start : parseInstant(input.end, 'end');

  if (Date.parse(end) < Date.parse(start)) {
    fail('end', `end ("${end}") is before start ("${start}").`);
  }
  if (Date.parse(end) - Date.parse(start) > MAX_DURATION_MS) {
    fail(
      'end',
      `An event may not span more than ${Math.round(MAX_DURATION_MS / 86_400_000)} days.`
    );
  }

  return Object.freeze({
    title,
    allDay: false,
    start,
    end,
    startDate: null,
    endDate: null,
    description,
    location,
  });
}

/**
 * Validate a PATCH body against an existing event.
 *
 * A patch is merged onto the stored event and the RESULT is validated as a
 * whole, rather than each field being checked in isolation. That is the only
 * way to catch the interesting failure: `PATCH {"end": "..."}` alone can put
 * the end before a start it never mentions.
 *
 * @param {object} existing the stored event, in envelope shape
 * @param {unknown} patch the request body
 */
export function parseEventPatch(existing, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('event', 'A patch must be a JSON object.');
  }
  if (Object.keys(patch).length === 0) {
    fail('event', 'A patch must change at least one field.');
  }

  const known = new Set([
    'title',
    'start',
    'end',
    'startDate',
    'endDate',
    'allDay',
    'description',
    'location',
    'source',
  ]);
  const unknown = Object.keys(patch).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    // Unknown keys are DROPPED on create (a caller sending extra metadata
    // should not fail) but REFUSED on patch, because a patch is a statement
    // about what should change: silently ignoring `{"titel": "..."}` means
    // answering 200 to a request that changed nothing.
    fail(unknown[0], `Unknown field "${unknown[0]}" — nothing was changed.`);
  }

  const allDay = patch.allDay === undefined ? existing.allDay : patch.allDay;

  // Merge onto the existing event in whichever representation the RESULT is
  // in, so a patch that flips `allDay` must supply the fields the new
  // representation needs rather than inheriting meaningless ones.
  const base = allDay
    ? {
        title: existing.title,
        allDay: true,
        startDate: existing.startDate,
        endDate: existing.endDate,
        description: existing.description,
        location: existing.location,
      }
    : {
        title: existing.title,
        allDay: false,
        start: existing.start,
        end: existing.end,
        description: existing.description,
        location: existing.location,
      };

  return parseCalendarEvent({ ...base, ...patch, allDay });
}

/**
 * Validate a batch, reporting EVERY bad entry rather than only the first.
 *
 * A caller posting twenty events should learn about all three malformed ones
 * in one round trip; failing on the first turns fixing a script into a loop
 * of post-fix-post. The batch stays all-or-nothing — a partial write leaves
 * the sender unsure what landed.
 *
 * @returns {{ events: object[], errors: {index: number, field: string, message: string}[] }}
 */
export function parseCalendarEvents(input) {
  const list = Array.isArray(input) ? input : [input];
  const events = [];
  const errors = [];

  list.forEach((entry, index) => {
    try {
      events.push(parseCalendarEvent(entry));
    } catch (error) {
      if (!(error instanceof CalendarValidationError)) throw error;
      errors.push({ index, field: error.field, message: error.message });
    }
  });

  return { events, errors };
}
