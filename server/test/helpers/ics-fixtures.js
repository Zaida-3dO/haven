/**
 * Stubbed ICS payloads.
 *
 * Every event here is INVENTED and every host is `.invalid` (RFC 2606, can
 * never resolve). Nothing in this file is real calendar data and no test ever
 * fetches a live feed — see docs/SECURITY.md. Real event titles are personal
 * data and a real ICS URL is a bearer credential; neither belongs in a public
 * repo, including in a fixture.
 */

/** A feed URL that is structurally valid and provably unresolvable. */
export const FAKE_FEED_URL = 'https://calendar.invalid/ical/placeholder/basic.ics';
export const SECOND_FEED_URL = 'https://other-calendar.invalid/ical/placeholder/basic.ics';

const VTIMEZONE_LONDON = `BEGIN:VTIMEZONE
TZID:Europe/London
BEGIN:DAYLIGHT
TZOFFSETFROM:+0000
TZOFFSETTO:+0100
TZNAME:BST
DTSTART:19700329T010000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0100
TZOFFSETTO:+0000
TZNAME:GMT
DTSTART:19701025T020000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE`;

function wrap(body) {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Haven Test Fixture//EN',
    'CALSCALE:GREGORIAN',
    VTIMEZONE_LONDON,
    body,
    'END:VCALENDAR',
  ].join('\r\n');
}

/**
 * The main fixture: a timed event in a named zone, an all-day event, a
 * multi-day all-day event, and a weekly series with one date excluded.
 */
export const SAMPLE_ICS = wrap(
  [
    // Timed, 09:00 Europe/London on 2026-06-10 — which is 08:00Z, because
    // June is BST. A parser that ignores VTIMEZONE gets this an hour wrong.
    'BEGIN:VEVENT',
    'UID:timed-event@fixture.invalid',
    'SUMMARY:Dentist appointment',
    'LOCATION:High Street',
    'DTSTART;TZID=Europe/London:20260610T090000',
    'DTEND;TZID=Europe/London:20260610T094500',
    'END:VEVENT',

    // All-day, single day. DTEND is EXCLUSIVE per RFC 5545.
    'BEGIN:VEVENT',
    'UID:allday-event@fixture.invalid',
    'SUMMARY:Bank holiday',
    'DTSTART;VALUE=DATE:20260612',
    'DTEND;VALUE=DATE:20260613',
    'END:VEVENT',

    // All-day spanning three days (13th, 14th, 15th).
    'BEGIN:VEVENT',
    'UID:multiday-event@fixture.invalid',
    'SUMMARY:Trip away',
    'DTSTART;VALUE=DATE:20260613',
    'DTEND;VALUE=DATE:20260616',
    'END:VEVENT',

    // Weekly x5 from 2026-06-01, with 2026-06-15 excluded — so occurrences
    // land on the 1st, 8th, 22nd and 29th.
    'BEGIN:VEVENT',
    'UID:weekly-event@fixture.invalid',
    'SUMMARY:Team sync',
    'DTSTART;TZID=Europe/London:20260601T100000',
    'DTEND;TZID=Europe/London:20260601T101500',
    'RRULE:FREQ=WEEKLY;COUNT=5',
    'EXDATE;TZID=Europe/London:20260615T100000',
    'END:VEVENT',
  ].join('\r\n')
);

/** A recurring series with one occurrence moved by RECURRENCE-ID. */
export const OVERRIDE_ICS = wrap(
  [
    'BEGIN:VEVENT',
    'UID:override-event@fixture.invalid',
    'SUMMARY:Weekly review',
    'DTSTART;TZID=Europe/London:20260601T140000',
    'DTEND;TZID=Europe/London:20260601T150000',
    'RRULE:FREQ=WEEKLY;COUNT=3',
    'END:VEVENT',

    // The 8th moves to 16:30 and is renamed.
    'BEGIN:VEVENT',
    'UID:override-event@fixture.invalid',
    'RECURRENCE-ID;TZID=Europe/London:20260608T140000',
    'SUMMARY:Weekly review (moved)',
    'DTSTART;TZID=Europe/London:20260608T163000',
    'DTEND;TZID=Europe/London:20260608T173000',
    'END:VEVENT',
  ].join('\r\n')
);

/** One good event next to one that is structurally broken. */
export const PARTIALLY_BROKEN_ICS = wrap(
  [
    'BEGIN:VEVENT',
    'UID:no-start@fixture.invalid',
    'SUMMARY:Event with no start',
    'END:VEVENT',

    'BEGIN:VEVENT',
    'UID:good@fixture.invalid',
    'SUMMARY:Perfectly fine event',
    'DTSTART;TZID=Europe/London:20260610T110000',
    'DTEND;TZID=Europe/London:20260610T113000',
    'END:VEVENT',
  ].join('\r\n')
);

/** A valid calendar with no events at all. */
export const EMPTY_ICS = wrap('');

/** An unbounded daily rule — the thing the occurrence cap exists for. */
export const UNBOUNDED_ICS = wrap(
  [
    'BEGIN:VEVENT',
    'UID:forever@fixture.invalid',
    'SUMMARY:Daily habit',
    'DTSTART;TZID=Europe/London:20260601T070000',
    'DTEND;TZID=Europe/London:20260601T071500',
    'RRULE:FREQ=DAILY',
    'END:VEVENT',
  ].join('\r\n')
);

/**
 * A fake `fetch` over a canned route table.
 *
 * Records every call so a test can assert on conditional-request headers, and
 * supports 304 so the ETag path is exercisable without a server.
 */
export function createFakeFetch(routes = new Map()) {
  const calls = [];

  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, headers: options.headers ?? {} });
    const handler = routes.get(url);
    if (!handler) throw new Error(`fetch failed for ${url}`);
    return handler({ url, headers: options.headers ?? {}, callIndex: calls.length - 1 });
  };

  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Build a `Response`-alike without depending on the real one. */
export function icsResponse(body, { status = 200, etag = null, lastModified = null } = {}) {
  const headers = new Map();
  if (etag) headers.set('etag', etag);
  if (lastModified) headers.set('last-modified', lastModified);
  if (body != null) headers.set('content-type', 'text/calendar');

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    text: async () => body ?? '',
  };
}
