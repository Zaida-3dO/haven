/**
 * The clock widget — Haven's reference widget.
 *
 * This is the widget every later widget is copied from, so it is written to be
 * **read** rather than to be clever. It exercises every part of the contract
 * end to end:
 *
 *  - static metadata with a `configSchema` including a **conditional field**
 *  - `setConfig` that **throws** on bad input, which is what lets the host
 *    render an error card instead of a half-broken widget
 *  - host-driven data via `onData` — and **no timer of its own**
 *  - `onResize` doing something visibly different at different sizes
 *  - an error path rendering a fallback tile with the **bad config preserved**
 *  - `getSearchEntries()` for the global index
 *  - a `migrateConfig` hook proving v1 → v2 migration actually runs
 *
 * ## The division of labour with the host — read this before copying
 *
 * The host does more than it looks. **Do not duplicate it in a widget:**
 *
 *  - `migrate.js` runs `migrateConfig` on load, *before* `setConfig`, so this
 *    widget only ever sees a config at the current `configVersion`.
 *  - `schema.js` validates against `configSchema` (`parseConfig`) before
 *    `setConfig` is called, applying defaults and skipping hidden fields.
 *  - `WidgetHost` wraps every call in an error boundary and renders the
 *    fallback tile with `origConfig` preserved.
 *
 * So `setConfig` here validates only what the **schema cannot express** — the
 * timezone actually resolving in `Intl`. Re-checking types the schema already
 * checked would be a second source of truth, which is the thing the contract
 * exists to prevent.
 *
 * ## The rule most likely to be broken by copying this file
 *
 * **A clock is the most tempting widget in the world to give a `setInterval`,
 * and it must not have one.** Twenty widgets with their own timers is twenty
 * uncoordinated polls with no backoff that keep running in a hidden tab. The
 * host owns every timer; this widget renders only what it is handed via
 * `onData`. If you copy one thing from this file, copy that.
 */

/** Bumped whenever `configSchema` changes shape. Drives the migration hook. */
export const CONFIG_VERSION = 2;

/** At or below this width in grid cells, the date line is dropped — it won't fit. */
export const COMPACT_MAX_W = 2;

/**
 * The config schema — a **flat array of typed option descriptors**, not JSON
 * Schema. The same array generates both the settings form and the validator,
 * so the two cannot drift, and no widget writes its own settings UI.
 */
export const configSchema = Object.freeze([
  {
    key: 'label',
    type: 'text',
    label: 'Label',
    required: true,
    default: 'Local time',
  },
  {
    key: 'source',
    type: 'select',
    label: 'Time source',
    default: 'local',
    options: [
      { value: 'local', label: 'This device' },
      { value: 'timezone', label: 'A specific timezone' },
    ],
  },
  {
    // The conditional field. Visibility is **data, not a function**: a
    // serialisable condition survives the JSON round-trip a stored config
    // makes, and can be validated. A `showIf: (opts) => boolean` cannot.
    //
    // Being hidden does not erase it — the host keeps hidden values, so
    // switching back to `timezone` returns the timezone you typed.
    key: 'timezone',
    type: 'text',
    label: 'Timezone',
    required: true,
    default: 'UTC',
    visible: { field: 'source', operator: 'eq', value: 'timezone' },
  },
  {
    key: 'showSeconds',
    type: 'select',
    label: 'Show seconds',
    default: 'no',
    options: [
      { value: 'yes', label: 'Yes' },
      { value: 'no', label: 'No' },
    ],
  },
]);

/**
 * The clock declares **no `dataSource`**, and that is a deliberate choice
 * worth explaining, because it is the one place this widget looks like it is
 * cheating the contract.
 *
 * `dataSource(config)` describes an HTTP request for the host's `Fetcher` to
 * make. The current time is not something to fetch over HTTP — there is no
 * endpoint for it, and inventing one would put a network round-trip in front
 * of a value the browser already has.
 *
 * What must NOT follow from that is the widget reading the clock itself on a
 * timer. So the time is supplied by a **host-owned scheduler task** — see
 * `startClockTicks` in `shell/clock-source.js` — which pushes a `PanelData`
 * payload in through `onData` exactly as a fetched widget receives one. The
 * widget stays a pure render function, the tick stays on the single scheduler
 * that pauses with the tab, and nothing here schedules anything.
 */

/**
 * Config a freshly added clock starts with.
 *
 * This is what makes "Add widget" produce something that *works immediately*
 * rather than an error card — cheap, and the difference between a good and a
 * bad first impression of the widget.
 */
export function getStubConfig() {
  return { label: 'Local time', source: 'local', showSeconds: 'no' };
}

/**
 * Migrates a stored config forward. **Ships from day one**, because it is
 * trivial now and impossible to retrofit once dashboards are saved.
 *
 * v1 → v2: v1 stored `use24Hour: true|false`. v2 drops it — the locale decides
 * — and gains an explicit `showSeconds`. The old field is translated rather
 * than discarded, so a v1 user's intent survives the upgrade.
 *
 * The host calls this before validation and stamps `configVersion` itself, so
 * this hook only has to produce the v2 *shape*.
 *
 * @param {object} config the stored config
 * @param {number} from the version it was stored at
 */
export function migrateConfig(config, from) {
  const next = { ...config };

  if (from < 2) {
    // v1's `use24Hour` implied a preference for a denser readout, so a v1 user
    // who set it gets seconds; everyone else takes the default.
    next.showSeconds = next.use24Hour ? 'yes' : 'no';
    delete next.use24Hour;
  }

  return next;
}

/** Thrown by `setConfig`. A distinct type so a caller can tell it apart. */
export class ClockConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ClockConfigError';
  }
}

/**
 * Checks the one thing `configSchema` cannot express: that a timezone string
 * is one `Intl` actually recognises.
 *
 * @throws {ClockConfigError}
 */
export function assertUsableTimezone(config) {
  if (config?.source !== 'timezone') return;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone });
  } catch {
    throw new ClockConfigError(`"${config.timezone}" is not a recognised timezone.`);
  }
}

/** Formats a timestamp for display. Pure, so it is trivially testable. */
export function formatTime(timestamp, config) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    ...(config.showSeconds === 'yes' ? { second: '2-digit' } : {}),
    ...(config.source === 'timezone' ? { timeZone: config.timezone } : {}),
  }).format(new Date(timestamp));
}

/** Formats the date line, shown only when the widget is wide enough. */
export function formatDate(timestamp, config) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    ...(config.source === 'timezone' ? { timeZone: config.timezone } : {}),
  }).format(new Date(timestamp));
}

/** Reads the timestamp out of a PanelData payload, whatever shape it carries. */
export function timestampFrom(data) {
  const value = data?.value;
  if (value == null) return null;
  if (typeof value === 'number') return value;
  if (typeof value.timestamp === 'number') return value.timestamp;
  return null;
}

/**
 * The base class for the element.
 *
 * In a browser this is `HTMLElement` and `HavenClock` is a real custom
 * element. Under `node --test` there is no DOM at all, and merely *declaring*
 * `extends HTMLElement` would throw at import time — which would make the
 * widget's pure logic (schema, migration, formatting) untestable without
 * pulling in a DOM emulator just to load the file.
 *
 * So the base is resolved at module load: the class body is identical either
 * way, and the DOM-touching methods are simply never reached in Node.
 */
const ElementBase = globalThis.HTMLElement ?? class {};

const STYLES = `
  :host { display: block; height: 100%; container-type: inline-size; }
  .clock { display: flex; flex-direction: column; justify-content: center;
           height: 100%; padding: 0.5rem; font-variant-numeric: tabular-nums; }
  .clock__label { font-size: 0.75rem; opacity: 0.7; }
  .clock__time { font-size: clamp(1.5rem, 12cqw, 3rem); font-weight: 600; line-height: 1.1; }
  .clock__date { font-size: 0.8rem; opacity: 0.8; }
  .clock--compact .clock__date { display: none; }
  .clock--stale .clock__time { opacity: 0.6; }
  .clock__notice { font-size: 0.7rem; opacity: 0.7; }
  .clock__error { padding: 0.5rem; font-size: 0.8rem; }
  .clock__error pre { overflow: auto; font-size: 0.7rem; opacity: 0.8; }
`;

/**
 * The clock, as a Web Component.
 *
 * Rendered into a **shadow root** so broken markup here cannot corrupt the
 * host layout, and **patched in place** on each tick rather than re-rendered.
 * Blowing the subtree away every second is what would kill a canvas in the 3D
 * widget, and the habit starts in reference files like this one.
 */
export class HavenClock extends ElementBase {
  #config = null;
  /** The config exactly as handed in, kept so an error card can show it. */
  #origConfig = null;
  #data = null;
  #cells = { w: 3, h: 2 };
  #shadow;
  #nodes = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  /**
   * Validates eagerly and **throws** on bad config — the contract, not a
   * suggestion. May be called again with a new config at any time.
   *
   * By the time this runs the host has already migrated the config and
   * validated it against `configSchema`, so the only check left is the one the
   * schema cannot express.
   */
  setConfig(config) {
    // Preserved before validation so the error card can show what was actually
    // set: a misconfigured widget should be openable and fixable, not only
    // deletable.
    this.#origConfig = config;

    assertUsableTimezone(config);

    this.#config = config;
    this.render();
    return this.#config;
  }

  /** The config as supplied, valid or not. Read by the host's error card. */
  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  /**
   * Receives data from the host — a Grafana-style `PanelData` payload.
   *
   * The host already skips calls whose `revision` is unchanged, so this does
   * not need its own revision check; it just draws what it is given.
   */
  onData(data) {
    this.#data = data;
    this.render();
  }

  /**
   * Grid cells changed. The clock drops its date line when it gets narrow — a
   * visible, testable response, standing in for the `renderer.setSize()` call
   * the 3D widget will make from exactly this hook.
   */
  onResize(w, h) {
    this.#cells = { w, h };
    this.render();
  }

  render() {
    if (!this.#config) return;

    // A hard error renders the fallback tile *with the offending config*, so
    // it can be read and fixed. It never blanks the dashboard.
    if (this.#data?.state === 'error') {
      this.#renderError();
      return;
    }

    const nodes = this.#ensureScaffold();

    nodes.clock.classList.toggle('clock--compact', this.#cells.w <= COMPACT_MAX_W);

    // Patch each node only when its text actually changes — never re-render
    // the subtree on a data tick.
    setText(nodes.label, this.#config.label);

    const timestamp = timestampFrom(this.#data);
    if (timestamp !== null) {
      setText(nodes.time, formatTime(timestamp, this.#config));
      setText(nodes.date, formatDate(timestamp, this.#config));
    }

    // A soft notice is not a hard error: stale-but-usable data renders with a
    // marker, in state `done`, rather than an error box.
    const notice = this.#data?.notices?.[0];
    nodes.clock.classList.toggle('clock--stale', Boolean(notice));
    nodes.notice.hidden = !notice;
    if (notice) setText(nodes.notice, notice.message);
  }

  /** Builds the DOM once; every later render patches it in place. */
  #ensureScaffold() {
    if (this.#nodes) return this.#nodes;

    const style = document.createElement('style');
    style.textContent = STYLES;

    const clock = document.createElement('div');
    clock.className = 'clock';

    const label = document.createElement('span');
    label.className = 'clock__label';

    const time = document.createElement('span');
    time.className = 'clock__time';
    time.textContent = '--:--';

    const date = document.createElement('span');
    date.className = 'clock__date';

    const notice = document.createElement('span');
    notice.className = 'clock__notice';
    notice.hidden = true;

    clock.append(label, time, date, notice);
    this.#shadow.replaceChildren(style, clock);

    this.#nodes = { clock, label, time, date, notice };
    return this.#nodes;
  }

  #renderError() {
    const message = this.#data?.errors?.[0]?.message ?? 'Clock data unavailable';

    const box = document.createElement('div');
    box.className = 'clock__error';

    const heading = document.createElement('strong');
    heading.textContent = 'Clock unavailable';

    const detail = document.createElement('p');
    // textContent, never innerHTML — the message may quote a config value.
    detail.textContent = message;

    // The preserved config, so the widget can be fixed rather than deleted.
    const dump = document.createElement('pre');
    dump.textContent = JSON.stringify(this.#origConfig ?? {}, null, 2);

    box.append(heading, detail, dump);

    const style = document.createElement('style');
    style.textContent = STYLES;
    this.#shadow.replaceChildren(style, box);

    // The scaffold is gone, so the next good render rebuilds it.
    this.#nodes = null;
  }

  /**
   * Documents for the global search index.
   *
   * The index is in-memory only and rebuilt each session — it holds real
   * content, so it is never written to localStorage or the database. The host
   * stamps `widgetId`, so this does not guess at one.
   */
  getSearchEntries() {
    if (!this.#config) return [];

    const timestamp = timestampFrom(this.#data);

    return [
      {
        id: `clock:${this.id || this.#config.label}`,
        title: this.#config.label,
        subtitle: timestamp === null ? '' : formatTime(timestamp, this.#config),
        url: this.id ? `#${this.id}` : '',
        keywords: ['clock', 'time', this.#config.source, this.#config.timezone].filter(Boolean),
      },
    ];
  }

  destroy() {
    // Nothing to tear down — and that is the point. A widget with no timer of
    // its own has no timer to clear.
    this.#config = null;
    this.#data = null;
    this.#nodes = null;
  }
}

/** Writes text only when it differs, so an unchanged node is left alone. */
function setText(node, value) {
  const next = value ?? '';
  if (node.textContent !== next) node.textContent = next;
}

/** Registers the element. Guarded so a double import cannot throw. */
export function defineClock(tag = 'haven-clock') {
  if (!globalThis.customElements?.get(tag)) {
    globalThis.customElements?.define(tag, HavenClock);
  }
  return tag;
}
