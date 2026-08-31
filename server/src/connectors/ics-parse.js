/**
 * ICS parsing — text in, normalised events out.
 *
 * Split from `calendar.js` so the parse is testable without a fetch, and so
 * the fetch layer has no opinions about calendar semantics.
 *
 * Parsing is delegated to `ical.js` (the parser Thunderbird uses) rather than
 * hand-rolled. Recurrence, `EXDATE` exceptions, per-occurrence overrides
 * (`RECURRENCE-ID`) and VTIMEZONE offsets are precisely where hand-written ICS
 * parsers go wrong, and all four are load-bearing for a calendar tile.
 */

import ICAL from 'ical.js';

/**
 * Hard ceiling on occurrences expanded from a single recurrence rule.
 *
 * An unbounded `RRULE` (`FREQ=DAILY` with no `UNTIL`/`COUNT`) is legal and
 * common — a birthday, a daily standup. The window bounds it in practice, but
 * a rule with a tiny interval and a distant window could still expand into
 * millions of instances and pin the event loop. This is the backstop.
 */
const MAX_OCCURRENCES_PER_EVENT = 750;

/** Guards against a feed whose sheer size would blow out the response. */
const MAX_EVENTS_PER_FEED = 2_000;

export class IcsParseError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IcsParseError';
  }
}

/**
 * An all-day event is a DATE, not an instant, and must stay that way.
 *
 * `DTSTART;VALUE=DATE:20260612` means "the 12th", full stop — it is not
 * midnight in any particular zone. Converting it to a `Date` picks a zone by
 * accident: `toJSDate()` on a floating date yields `2026-06-11T23:00:00Z` for
 * a machine in BST, which renders the event on the ELEVENTH for any viewer at
 * or west of UTC. So an all-day event carries `startDate: 'YYYY-MM-DD'` and NO
 * instant, and the browser formats the string without ever constructing a
 * `Date` from it.
 */
function isoDate(icalTime) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${icalTime.year}-${pad(icalTime.month)}-${pad(icalTime.day)}`;
}

/**
 * Register the feed's own VTIMEZONE definitions.
 *
 * A feed carrying `DTSTART;TZID=Europe/London` is unresolvable unless the
 * matching VTIMEZONE is registered first — `ical.js` would otherwise treat the
 * time as floating and silently drop the offset, shifting events by up to a
 * day. Registration is global to `ical.js`, so we only add zones the service
 * does not already know rather than clobbering shared state.
 */
function registerTimezones(comp) {
  for (const vtimezone of comp.getAllSubcomponents('vtimezone')) {
    try {
      const zone = new ICAL.Timezone(vtimezone);
      if (zone.tzid && !ICAL.TimezoneService.has(zone.tzid)) {
        ICAL.TimezoneService.register(zone.tzid, zone);
      }
    } catch {
      // A malformed VTIMEZONE must not take the whole feed down; the events
      // in it still parse, just as floating times.
    }
  }
}

/**
 * Turn one occurrence into the normalised shape the widget renders.
 *
 * Note what is NOT here: no `description`, no `attendees`, no `organizer`.
 * The tile shows a title, a time and a location, so that is all that crosses
 * the wire. Sending the rest would put more personal data into the browser
 * (and into the in-memory search index) for no rendering benefit.
 */
function toEvent(event, startTime, endTime, feed) {
  const allDay = startTime.isDate;
  const startIso = allDay ? null : startTime.toJSDate().toISOString();

  return {
    // Stable per occurrence: a recurring event's UID repeats, so the start
    // has to be part of the id or search entries collide across occurrences.
    id: `${feed.id}:${event.uid ?? 'no-uid'}:${allDay ? isoDate(startTime) : startIso}`,
    title: event.summary?.trim() || '(untitled)',
    location: event.location?.trim() || null,
    allDay,
    // Exactly one of the instant pair / the date pair is populated — see
    // `isoDate` above for why an all-day event must not carry an instant.
    start: startIso,
    end: allDay ? null : (endTime?.toJSDate().toISOString() ?? null),
    startDate: allDay ? isoDate(startTime) : null,
    /**
     * DTEND on an all-day event is EXCLUSIVE per RFC 5545 — a single-day
     * event on the 12th has DTEND 20260613. Storing the exclusive value would
     * make every one-day event look like it spans two, so we store the last
     * day the event actually covers.
     */
    endDate: allDay && endTime ? isoDate(endTime.clone().adjust(-1, 0, 0, 0)) : null,
    feedId: feed.id,
    feedName: feed.name,
  };
}

/**
 * Expand a recurring event across `[windowStart, windowEnd]`.
 *
 * `ical.js`'s iterator already applies `EXDATE`, so exclusions need no special
 * handling here — but per-occurrence overrides (`RECURRENCE-ID`, "move just
 * next Tuesday's to 3pm") do, and `getOccurrenceDetails` is what applies them.
 */
function expandRecurring(event, feed, windowStart, windowEnd, out) {
  const iterator = event.iterator();
  let next;
  let seen = 0;

  while ((next = iterator.next())) {
    if (seen++ >= MAX_OCCURRENCES_PER_EVENT) break;

    const occurrenceStart = next.toJSDate();
    // Past the window: the iterator is chronological, so nothing later can
    // qualify either.
    if (occurrenceStart > windowEnd) break;

    let details;
    try {
      // Applies a RECURRENCE-ID override if this instance has one.
      details = event.getOccurrenceDetails(next);
    } catch {
      continue;
    }

    // An occurrence that ENDS before the window opened is over; one still
    // running is kept, so a multi-day trip in progress does not vanish.
    const occurrenceEnd = details.endDate?.toJSDate() ?? occurrenceStart;
    if (occurrenceEnd < windowStart) continue;

    out.push(toEvent(details.item ?? event, details.startDate, details.endDate, feed));
  }
}

/**
 * Parse one feed's ICS text into normalised events within a time window.
 *
 * @param {string} text raw `text/calendar`
 * @param {{ id: string, name: string }} feed identity for attribution
 * @param {{ windowStart: Date, windowEnd: Date }} window
 * @returns {Array<object>} normalised events
 * @throws {IcsParseError} when the payload is not parseable as iCalendar
 */
export function parseIcs(text, feed, { windowStart, windowEnd }) {
  if (typeof text !== 'string' || text.trim() === '') {
    throw new IcsParseError('Calendar feed was empty.');
  }

  let comp;
  try {
    comp = new ICAL.Component(ICAL.parse(text));
  } catch (error) {
    // The upstream message can quote the payload, so keep it to the error
    // NAME rather than embedding arbitrary feed content in our own message.
    throw new IcsParseError(`Calendar feed is not valid iCalendar data (${error.name}).`);
  }

  registerTimezones(comp);

  const events = [];
  for (const vevent of comp.getAllSubcomponents('vevent')) {
    if (events.length >= MAX_EVENTS_PER_FEED) break;

    let event;
    try {
      event = new ICAL.Event(vevent);
    } catch {
      // One malformed VEVENT must not discard the other 200.
      continue;
    }

    // Overrides are emitted as part of their parent series by
    // `getOccurrenceDetails`; emitting them again here would double them up.
    if (event.isRecurrenceException()) continue;

    try {
      if (event.isRecurring()) {
        expandRecurring(event, feed, windowStart, windowEnd, events);
      } else {
        const start = event.startDate;
        if (!start) continue;
        const startJs = start.toJSDate();
        const endJs = event.endDate?.toJSDate() ?? startJs;
        // Same window rule as recurring: in-progress events survive.
        if (startJs > windowEnd || endJs < windowStart) continue;
        events.push(toEvent(event, start, event.endDate, feed));
      }
    } catch {
      continue;
    }
  }

  return events;
}

/**
 * Sort chronologically, with all-day events first within a day.
 *
 * All-day events have no instant to sort by, so they are ordered by their
 * date string and placed ahead of that day's timed events — which is both how
 * every calendar UI does it and the only ordering that does not depend on the
 * viewer's zone.
 *
 * The day an event sorts under is derived from its UTC date here, which is
 * deliberate: the server has no idea what zone the viewer is in, so it only
 * guarantees a stable total order. The BROWSER regroups by local day — see
 * `web/src/widgets/calendar/group.js`.
 */
export function sortEvents(events) {
  return [...events].sort((a, b) => {
    const dayA = a.allDay ? a.startDate : a.start.slice(0, 10);
    const dayB = b.allDay ? b.startDate : b.start.slice(0, 10);
    if (dayA !== dayB) return dayA < dayB ? -1 : 1;
    if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
    if (a.allDay) return a.title.localeCompare(b.title);
    if (a.start !== b.start) return a.start < b.start ? -1 : 1;
    return a.title.localeCompare(b.title);
  });
}

export { MAX_OCCURRENCES_PER_EVENT, MAX_EVENTS_PER_FEED };
