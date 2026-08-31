/**
 * Grouping and formatting for the calendar widget — pure, no DOM.
 *
 * Split out from the element so the part that is easy to get wrong (dates)
 * can be tested directly, at a fixed "now", across several viewer timezones.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * TIMEZONE — THE WHOLE REASON THIS MODULE EXISTS
 *
 * There are two kinds of event and they must be handled differently, or one
 * of them renders on the wrong day:
 *
 *  - A TIMED event is an instant (`start: '2026-06-10T08:00:00.000Z'`). The
 *    day it belongs to depends on the VIEWER: 23:30Z on the 10th is the 10th
 *    in London and the 10th in Tokyo is already the 11th. So its day is
 *    derived in LOCAL time, never by slicing the ISO string — `start.slice(0,
 *    10)` is the UTC day and is simply a bug for any viewer not on UTC.
 *
 *  - An ALL-DAY event is a date, not an instant (`startDate: '2026-06-12'`).
 *    It is the 12th everywhere. It must NEVER be put through `new Date(...)`
 *    and re-extracted, because `new Date('2026-06-12')` parses as UTC
 *    midnight and yields the 11th for any viewer west of UTC. Its date string
 *    is used as-is.
 *
 * The server sorts by UTC day, which is fine as a stable total order; the
 * regroup into local days happens here, in the browser, where the viewer's
 * zone is actually known.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** `YYYY-MM-DD` for a Date, in the viewer's local timezone. */
export function localDayKey(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The day an event belongs to, from the viewer's point of view.
 *
 * All-day events return their date string untouched; timed events are
 * converted to local time first.
 */
export function dayKeyFor(event) {
  if (event.allDay) return event.startDate;
  return localDayKey(new Date(event.start));
}

/** Parse a `YYYY-MM-DD` into a LOCAL midnight Date, never a UTC one. */
export function parseDayKey(key) {
  const [year, month, day] = key.split('-').map(Number);
  // The three-argument form is local-time by definition; `new Date(key)`
  // would be parsed as UTC and land on the previous day west of UTC.
  return new Date(year, month - 1, day);
}

/** Whole days between two day keys, in local terms. */
export function daysBetween(fromKey, toKey) {
  const from = parseDayKey(fromKey);
  const to = parseDayKey(toKey);
  return Math.round((to - from) / 86_400_000);
}

/**
 * A human label for a day, relative to today where that reads better.
 *
 * "Today" and "Tomorrow" are what make the tile scannable — a clear "today"
 * is an explicit requirement — and a weekday name is more useful than a date
 * inside the coming week.
 */
export function dayLabel(dayKey, now = new Date(), { locale } = {}) {
  const todayKey = localDayKey(now);
  const delta = daysBetween(todayKey, dayKey);

  if (delta === 0) return 'Today';
  if (delta === 1) return 'Tomorrow';
  if (delta === -1) return 'Yesterday';

  const date = parseDayKey(dayKey);
  if (delta > 1 && delta < 7) {
    return date.toLocaleDateString(locale, { weekday: 'long' });
  }
  return date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** `09:00` — in the viewer's local timezone, which is the point. */
export function formatTime(iso, { locale, hour12 } = {}) {
  return new Date(iso).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12,
  });
}

/**
 * The time range shown against a timed event.
 *
 * An end that lands on the same instant, or is missing, renders as just the
 * start — "09:00–09:00" is noise.
 */
export function formatTimeRange(event, options = {}) {
  if (event.allDay) return 'All day';
  const start = formatTime(event.start, options);
  if (!event.end || event.end === event.start) return start;
  return `${start}–${formatTime(event.end, options)}`;
}

/**
 * Is this all-day event spanning more than one day?
 * Used to render "Trip away" with a range rather than a bare "All day".
 */
export function isMultiDay(event) {
  return Boolean(event.allDay && event.endDate && event.endDate !== event.startDate);
}

/**
 * Has a timed event already finished?
 *
 * Used to de-emphasise the earlier part of today rather than hide it — the
 * server's window reaches slightly into the past so that an event happening
 * right now is still shown.
 */
export function isPast(event, now = new Date()) {
  if (event.allDay) return daysBetween(localDayKey(now), event.endDate ?? event.startDate) < 0;
  return new Date(event.end ?? event.start) < now;
}

/**
 * Drop events that finished before today, then group what is left by local
 * day, in chronological order.
 *
 * Returns `[{ dayKey, label, isToday, events }]`.
 *
 * @param {Array<object>} events normalised events from the connector
 * @param {{ now?: Date, limit?: number, locale?: string, hour12?: boolean }} options
 */
export function groupByDay(events = [], { now = new Date(), limit = null, locale } = {}) {
  const todayKey = localDayKey(now);

  const upcoming = events.filter((event) => {
    if (!event) return false;
    const key = dayKeyFor(event);
    if (!key) return false;
    // An all-day event spanning today still belongs to today even though it
    // started earlier, so compare against its END where it has one.
    const endKey = event.allDay
      ? (event.endDate ?? key)
      : localDayKey(new Date(event.end ?? event.start));
    return daysBetween(todayKey, endKey) >= 0;
  });

  const sorted = [...upcoming].sort(compareEvents);
  const capped = typeof limit === 'number' && limit > 0 ? sorted.slice(0, limit) : sorted;

  const groups = new Map();
  for (const event of capped) {
    // A multi-day all-day event in progress is shown under today rather than
    // under the day it began, which would sort it above "Today".
    const rawKey = dayKeyFor(event);
    const key = daysBetween(todayKey, rawKey) < 0 ? todayKey : rawKey;

    const group = groups.get(key) ?? {
      dayKey: key,
      label: dayLabel(key, now, { locale }),
      isToday: key === todayKey,
      events: [],
    };
    group.events.push(event);
    groups.set(key, group);
  }

  return [...groups.values()].sort((a, b) =>
    a.dayKey < b.dayKey ? -1 : a.dayKey > b.dayKey ? 1 : 0
  );
}

/**
 * Chronological, all-day first within a day — the same rule the server uses,
 * re-applied here because the local-day regroup can reorder across a
 * midnight boundary.
 */
export function compareEvents(a, b) {
  const dayA = dayKeyFor(a);
  const dayB = dayKeyFor(b);
  if (dayA !== dayB) return dayA < dayB ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.allDay) return a.title.localeCompare(b.title);
  if (a.start !== b.start) return a.start < b.start ? -1 : 1;
  return a.title.localeCompare(b.title);
}

/**
 * Search entries for the global index.
 *
 * Event titles are among the most personal data on the dashboard, which is
 * why the index they feed is in-memory only (see
 * `web/src/shell/search-index.js`). Nothing here writes to storage; these are
 * handed to the shell, which holds them in a private field.
 *
 * The date is put in `keywords` so that typing a month finds events in it,
 * without the title itself being polluted.
 */
export function toSearchEntries(
  events = [],
  { widgetId = 'calendar', now = new Date(), locale } = {}
) {
  return events.filter(Boolean).map((event) => {
    const dayKey = dayKeyFor(event);
    const when = dayLabel(dayKey, now, { locale });
    const time = event.allDay ? 'All day' : formatTime(event.start, { locale });

    return {
      id: event.id,
      widgetId,
      title: event.title,
      subtitle: `${when} · ${time}${event.location ? ` · ${event.location}` : ''}`,
      url: null,
      keywords: [dayKey, event.feedName, event.location].filter(Boolean),
    };
  });
}
