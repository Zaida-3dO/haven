/**
 * The calendar widget — upcoming events, grouped by day.
 *
 * A near-pure render function, per docs/WIDGET-CONTRACT.md. Note what is
 * absent and must stay absent:
 *
 *   - No `fetch`. The host fetches; `dataSource(config)` below only DESCRIBES
 *     the request, and the shell performs it.
 *   - No `setInterval`. The scheduler owns every timer in Haven. Twenty
 *     widgets with their own timers is the single easiest way to get this
 *     design wrong.
 *   - No ICS URL. The browser never sees one — the backend holds it and
 *     returns normalised events.
 *
 * Rendering diffs on `revision` rather than redrawing every tick, and the
 * DOM is built with `textContent` throughout: event titles are attacker-
 * adjacent (anyone who can put an event in your calendar controls them), so
 * nothing here goes near `innerHTML`.
 */

import {
  groupByDay,
  formatTimeRange,
  isMultiDay,
  isPast,
  toSearchEntries,
  parseDayKey,
} from './group.js';

/**
 * Where "open my calendar" goes.
 *
 * Deliberately the bare Google Calendar address, with no feed identifier in
 * it. A feed's ICS URL is a BEARER CREDENTIAL — anyone holding one can read
 * the whole calendar — so no part of a feed may ever reach an href, and this
 * constant is the reason there is nothing per-feed to build a link from.
 * Google resolves it to whichever account the browser is signed in as, which
 * is exactly the behaviour wanted.
 */
export const GOOGLE_CALENDAR_URL = 'https://calendar.google.com/';

export const CALENDAR_WIDGET_TYPE = 'calendar';
export const CALENDAR_WIDGET_TAG = 'haven-widget-calendar';

/** Calendars change slowly, so the host refetches on a long interval. */
export const CALENDAR_REFRESH_MS = 15 * 60_000;

/**
 * The config schema — a flat array of typed descriptors, which generates the
 * settings form AND the validator from one definition.
 *
 * Note there is no ICS URL field. The feed is backend configuration
 * (`HAVEN_CALENDAR_ICS_URL`), not per-instance widget config, precisely
 * because it is a bearer credential and a `url` field would put it in the
 * browser and in the saved layout.
 */
export const calendarConfigSchema = [
  {
    key: 'title',
    type: 'text',
    label: 'Title',
    default: 'Calendar',
    maxLength: 40,
  },
  {
    key: 'maxEvents',
    type: 'number',
    label: 'Maximum events shown',
    default: 25,
    min: 1,
    max: 100,
  },
  {
    key: 'showLocation',
    type: 'select',
    label: 'Show location',
    default: 'yes',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
];

/**
 * How the host turns a config into a request.
 *
 * The `key` collapses every calendar instance onto one request: two calendar
 * widgets on a dashboard must produce ONE backend call, which the fetcher's
 * dedup gives us for free once the key matches.
 */
export function calendarDataSource() {
  return {
    key: 'widget:calendar',
    url: '/api/widgets/calendar',
    cacheMs: CALENDAR_REFRESH_MS,
  };
}

/** A stub config that works immediately — no error card on "Add widget". */
export function calendarStubConfig() {
  return { title: 'Calendar', maxEvents: 25, showLocation: 'yes' };
}

const STYLES = `
  :host { display: block; font: inherit; container-type: inline-size; }
  .cal { display: flex; flex-direction: column; gap: 0.5rem; height: 100%; }
  .cal__head {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 0.5rem;
  }
  .cal__title { font-weight: 600; }
  .cal__notice {
    font-size: 0.75rem; opacity: 0.75; padding: 0.15rem 0.4rem;
    border: 1px solid currentColor; border-radius: 0.25rem; white-space: nowrap;
  }
  .cal__list { display: flex; flex-direction: column; gap: 0.6rem; overflow-y: auto; }
  .cal__day { display: flex; flex-direction: column; gap: 0.2rem; }
  .cal__daylabel {
    font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
    opacity: 0.6; position: sticky; top: 0;
  }
  .cal__day--today .cal__daylabel { opacity: 1; font-weight: 700; }
  .cal__event {
    display: grid; grid-template-columns: minmax(3.2rem, auto) 1fr;
    gap: 0.1rem 0.5rem; align-items: baseline; padding: 0.15rem 0;
    border-left: 3px solid transparent; padding-left: 0.4rem;
  }
  .cal__event--past { opacity: 0.45; }
  /* All-day events are visually distinct from timed ones, not just labelled. */
  .cal__event--allday { background: color-mix(in srgb, currentColor 7%, transparent); border-radius: 0.2rem; }
  .cal__when { font-variant-numeric: tabular-nums; font-size: 0.8rem; opacity: 0.8; }
  .cal__event--allday .cal__when { font-style: italic; }
  .cal__what { display: flex; flex-direction: column; min-width: 0; }
  /* Truncation that cannot break the layout, however long a title is. */
  .cal__name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cal__where {
    font-size: 0.75rem; opacity: 0.65;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .cal__feed { font-size: 0.7rem; opacity: 0.7; }
  /*
   * "Open Google Calendar". The tile is read-only, so this is the whole of
   * the affordance for changing anything — it needs to be findable without
   * dominating a tile whose job is showing what is coming up.
   */
  .cal__open {
    font-size: 0.75rem; white-space: nowrap; color: inherit; opacity: 0.75;
    text-decoration: none; border-bottom: 1px solid currentColor;
  }
  .cal__open:hover, .cal__open:focus-visible { opacity: 1; }
  .cal__empty, .cal__setup { opacity: 0.7; padding: 0.5rem 0; }
  .cal__setup code { font-size: 0.85em; }
  /* Mobile / narrow tile: stack the time above the title rather than
     squeezing a two-column grid into 150px. */
  @container (max-width: 260px) {
    .cal__event { grid-template-columns: 1fr; gap: 0; }
    .cal__when { font-size: 0.75rem; }
  }
`;

/**
 * Feed colours. Deterministic by feed index so a feed keeps its colour
 * between renders, which is what makes several feeds distinguishable at a
 * glance rather than merely labelled.
 */
const FEED_COLOURS = [
  'oklch(65% 0.16 250)',
  'oklch(68% 0.16 145)',
  'oklch(70% 0.17 60)',
  'oklch(65% 0.19 20)',
  'oklch(66% 0.15 300)',
];

/**
 * The base class, resolved at import time.
 *
 * `extends HTMLElement` would be evaluated when this module is imported, so
 * the module could not be loaded at all outside a browser — including by a
 * `node:test` suite, which is how this widget's rendering is tested (the web
 * workspace has no jsdom by design). Falling back to a bare class keeps the
 * module importable; the element is only ever `define`d where a real
 * `HTMLElement` exists.
 */
const ElementBase = globalThis.HTMLElement ?? class {};

export class CalendarWidget extends ElementBase {
  #config = calendarStubConfig();
  #data = null;
  #lastRevision = -1;
  #root = null;
  /** feedId -> colour, assigned in the order feeds arrive. */
  #feedColours = new Map();
  /** Injected in tests; the element uses the real clock in a browser. */
  #now = () => new Date();

  /** Test seam so "today" is deterministic without faking global time. */
  setNow(fn) {
    this.#now = fn;
  }

  /**
   * Validate eagerly and THROW on bad config — that is the contract, and it
   * is what lets the host render a fixable error card instead of a
   * half-broken widget.
   */
  setConfig(config = {}) {
    const maxEvents = config.maxEvents ?? 25;
    if (typeof maxEvents !== 'number' || Number.isNaN(maxEvents) || maxEvents < 1) {
      throw new Error('Calendar: `maxEvents` must be a positive number.');
    }
    this.#config = { ...calendarStubConfig(), ...config };
    // A config change can alter what is drawn (the cap, the title), so force
    // the next render rather than letting the revision check skip it.
    this.#lastRevision = -1;
  }

  onData(data) {
    this.#data = data;
  }

  /** Everything the widget knows how to show, from one payload. */
  render() {
    const root = this.#ensureRoot();
    const data = this.#data;

    // Never re-render on an unchanged tick — diff on the revision counter.
    if (data && data.revision === this.#lastRevision) return;
    this.#lastRevision = data?.revision ?? -1;

    const body = document.createElement('div');
    body.className = 'cal';
    body.appendChild(this.#renderHead(data));

    const value = data?.value ?? null;

    if (!data || data.state === 'loading') {
      body.appendChild(this.#paragraph('cal__empty', 'Loading…'));
    } else if (data.state === 'error' && !value) {
      // A hard error with nothing cached. The host also draws its own error
      // boundary; this is the in-widget equivalent for a failed fetch.
      body.appendChild(this.#paragraph('cal__empty', 'Could not load the calendar.'));
    } else if (value && value.configured === false) {
      body.appendChild(this.#renderSetup(value));
    } else {
      body.appendChild(this.#renderEvents(value));
    }

    root.replaceChildren(this.#styleNode(), body);
  }

  #renderHead(data) {
    const head = document.createElement('div');
    head.className = 'cal__head';

    const title = document.createElement('span');
    title.className = 'cal__title';
    title.textContent = this.#config.title ?? 'Calendar';
    head.appendChild(title);

    // A soft notice is NOT a hard error: stale data renders normally with a
    // marker beside it rather than being replaced by an error box.
    const stale = data?.value?.stale || data?.notices?.some?.((n) => n.stale);
    if (stale) {
      const notice = document.createElement('span');
      notice.className = 'cal__notice';
      notice.textContent = 'Showing cached';
      notice.title = 'The calendar could not be refreshed; this is the last data we had.';
      head.appendChild(notice);
    }

    /**
     * The way out to a calendar you can actually change.
     *
     * The tile is read-only by construction: it is built from ICS feeds, and
     * an iCal address grants read access only. Rather than pretend otherwise
     * with an edit affordance that could not work, this hands the job to
     * Google Calendar, where an edit reaches Ope's phone and Tomi.
     *
     * A FIXED, feed-independent URL. An ICS feed URL is a bearer credential,
     * so nothing derived from a feed may appear in an href — see
     * `GOOGLE_CALENDAR_URL`. `noopener noreferrer` because `target="_blank"`
     * otherwise hands the opened page a `window.opener` handle back to the
     * dashboard.
     */
    const open = document.createElement('a');
    open.className = 'cal__open';
    open.href = GOOGLE_CALENDAR_URL;
    open.target = '_blank';
    open.rel = 'noopener noreferrer';
    open.textContent = 'Open Google Calendar';
    open.title = 'Open Google Calendar in a new tab to add or change events';
    head.appendChild(open);

    return head;
  }

  /** The "not configured" tile — a hint, deliberately not an error. */
  #renderSetup(value) {
    const wrap = document.createElement('div');
    wrap.className = 'cal__setup';

    const line = document.createElement('p');
    line.textContent = 'No calendar connected yet.';
    wrap.appendChild(line);

    const hint = document.createElement('p');
    hint.textContent =
      typeof value?.hint === 'string' && value.hint
        ? value.hint
        : 'Set HAVEN_CALENDAR_ICS_URL to a calendar’s secret iCal address.';
    wrap.appendChild(hint);

    return wrap;
  }

  #renderEvents(value) {
    const events = Array.isArray(value?.events) ? value.events : [];
    const groups = groupByDay(events, {
      now: this.#now(),
      limit: this.#config.maxEvents,
    });

    if (groups.length === 0) {
      // An empty calendar is a quiet week, not a failure.
      return this.#paragraph('cal__empty', 'Nothing coming up.');
    }

    this.#assignFeedColours(value?.feeds ?? []);

    const list = document.createElement('div');
    list.className = 'cal__list';
    const multipleFeeds = (value?.feeds?.length ?? 0) > 1;

    for (const group of groups) {
      const day = document.createElement('section');
      day.className = group.isToday ? 'cal__day cal__day--today' : 'cal__day';
      day.dataset.day = group.dayKey;

      const label = document.createElement('h3');
      label.className = 'cal__daylabel';
      label.textContent = group.label;
      day.appendChild(label);

      for (const event of group.events) {
        day.appendChild(this.#renderEvent(event, multipleFeeds));
      }
      list.appendChild(day);
    }

    return list;
  }

  #renderEvent(event, multipleFeeds) {
    const now = this.#now();
    const row = document.createElement('div');
    row.className = 'cal__event';
    if (event.allDay) row.classList.add('cal__event--allday');
    if (isPast(event, now)) row.classList.add('cal__event--past');
    row.dataset.eventId = event.id;
    row.dataset.allDay = String(Boolean(event.allDay));
    if (event.feedId) row.dataset.feedId = event.feedId;
    // Where the event came from. Every event is `feed` — an iCal address is
    // read-only — but it is carried through rather than assumed so the tile
    // does not have to be changed again if another source is ever added.
    if (event.source) row.dataset.source = event.source;

    // The feed's colour rides on the left border, so several calendars are
    // distinguishable without a legend eating the tile.
    const colour = this.#feedColours.get(event.feedId);
    if (colour && multipleFeeds) row.style.borderLeftColor = colour;

    const when = document.createElement('span');
    when.className = 'cal__when';
    when.textContent = isMultiDay(event) ? 'All day →' : formatTimeRange(event);
    row.appendChild(when);

    const what = document.createElement('span');
    what.className = 'cal__what';

    const name = document.createElement('span');
    name.className = 'cal__name';
    // textContent, never innerHTML — an event title is upstream-controlled.
    name.textContent = event.title;
    name.title = event.title;
    what.appendChild(name);

    if (this.#config.showLocation !== 'no' && event.location) {
      const where = document.createElement('span');
      where.className = 'cal__where';
      where.textContent = event.location;
      what.appendChild(where);
    }

    if (multipleFeeds && event.feedName) {
      const feed = document.createElement('span');
      feed.className = 'cal__feed';
      feed.textContent = event.feedName;
      if (colour) feed.style.color = colour;
      what.appendChild(feed);
    }

    row.appendChild(what);
    return row;
  }

  #assignFeedColours(feeds) {
    feeds.forEach((feed, index) => {
      if (feed?.id && !this.#feedColours.has(feed.id)) {
        this.#feedColours.set(feed.id, FEED_COLOURS[index % FEED_COLOURS.length]);
      }
    });
  }

  /**
   * Search entries for the shell's in-memory index.
   *
   * Event titles are personal data. The index they go into is never
   * persisted — see `web/src/shell/search-index.js`, which has a tripwire
   * test enforcing exactly that. Nothing here touches storage.
   */
  getSearchEntries() {
    const events = this.#data?.value?.events;
    if (!Array.isArray(events)) return [];
    return toSearchEntries(events, { now: this.#now() });
  }

  onResize() {
    // Layout is container-query driven, so a resize needs no work here — the
    // CSS reacts on its own and a re-render would be wasted.
  }

  destroy() {
    this.#feedColours.clear();
    this.#data = null;
  }

  #ensureRoot() {
    if (!this.#root) {
      this.#root = this.shadowRoot ?? this.attachShadow?.({ mode: 'open' }) ?? this;
    }
    return this.#root;
  }

  #styleNode() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    return style;
  }

  #paragraph(className, text) {
    const p = document.createElement('p');
    p.className = className;
    p.textContent = text;
    return p;
  }
}

export { parseDayKey };
