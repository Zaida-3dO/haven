/**
 * The torrents widget.
 *
 * It fetches nothing and owns no timer. Data arrives through `onData()`, the
 * host having fetched `/api/widgets/torrents` on the schedule it owns — see
 * docs/WIDGET-CONTRACT.md. Everything here is turning that payload into DOM.
 *
 * The one non-obvious piece is `#patch`. A naive widget would rebuild its list
 * on every tick; with a five-second refresh that means throwing away and
 * recreating every row twelve times a minute, which loses scroll position,
 * kills any transition mid-flight, and is exactly the habit the contract bans
 * ("never re-render on every data tick — diff and patch"). So rows are keyed by
 * torrent hash, matched against what is already in the DOM, and only the text
 * nodes whose values actually changed are written.
 */

import {
  capTorrents,
  formatEta,
  formatPercent,
  formatSize,
  formatSpeed,
  stateLabel,
  truncateName,
} from './format.js';

export const TORRENTS_WIDGET_TAG = 'haven-widget-torrents';

/**
 * The base class, resolved at import time.
 *
 * In a browser this is `HTMLElement`. Under `node --test` there is no such
 * global, and the web workspace deliberately has no jsdom (see
 * `web/test/helpers/fake-dom.js`) — so the widget falls back to a bare class
 * and the tests drive it directly with a fake document. This keeps the render
 * logic testable without dragging in a DOM emulator to test twenty lines of
 * element plumbing.
 */
const ElementBase = globalThis.HTMLElement ?? class {};

/** How many rows fit before the tile stops being a tile. */
export const DEFAULT_MAX_ROWS = 6;

/**
 * Below this many grid columns the tile is the mobile one: the secondary
 * details (size, ratio, upload speed) are dropped rather than wrapped, because
 * a wrapped row is what actually breaks a narrow layout.
 */
export const NARROW_COLUMNS = 3;

const STYLES = `
  :host { display: block; height: 100%; }
  .torrents { display: flex; flex-direction: column; gap: 0.5rem; height: 100%;
    font: inherit; overflow: hidden; }
  .torrents__notice { font-size: 0.75rem; opacity: 0.75; display: flex; gap: 0.35rem;
    align-items: baseline; }
  .torrents__notice--stale::before { content: '•'; opacity: 0.6; }
  .torrents__list { list-style: none; margin: 0; padding: 0; display: flex;
    flex-direction: column; gap: 0.5rem; overflow-y: auto; flex: 1; min-height: 0; }
  .torrent { display: grid; gap: 0.2rem; }
  .torrent__name { font-size: 0.8rem; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; }
  .torrent__bar { height: 4px; border-radius: 2px; background: currentColor;
    opacity: 0.15; position: relative; overflow: hidden; }
  .torrent__fill { position: absolute; inset: 0 auto 0 0; background: currentColor;
    border-radius: 2px; transition: width 0.3s ease; }
  .torrent__meta { display: flex; gap: 0.5rem; font-size: 0.7rem; opacity: 0.75;
    white-space: nowrap; }
  .torrent__meta span { flex: none; }
  .torrent--error .torrent__name { opacity: 0.8; }
  .torrents__empty, .torrents__unreachable { font-size: 0.8rem; opacity: 0.7;
    display: grid; gap: 0.25rem; place-content: center; text-align: center; flex: 1; }
  .torrents__hint { font-size: 0.7rem; opacity: 0.8; }
  .torrents__more { font-size: 0.7rem; opacity: 0.7; }
  .torrents--narrow .torrent__meta .torrent__detail { display: none; }
`;

export class TorrentsWidget extends ElementBase {
  #config = { maxRows: DEFAULT_MAX_ROWS };
  #data = null;
  #shadow = null;
  #els = null;
  /** hash -> the row element currently in the DOM, for diff-and-patch. */
  #rows = new Map();
  #narrow = false;

  connectedCallback() {
    this.#ensureShadow();
    this.render();
  }

  /**
   * Validate eagerly and THROW on bad config — the contract, not a suggestion.
   * It is what lets the host render an error card instead of a half-broken
   * widget, so the host's own `parseConfig` result is re-checked here for the
   * one field this widget interprets itself.
   */
  setConfig(config = {}) {
    const maxRows = config.maxRows ?? DEFAULT_MAX_ROWS;
    if (!Number.isFinite(Number(maxRows)) || Number(maxRows) < 1) {
      throw new Error('torrents: maxRows must be a positive number');
    }
    this.#config = { ...config, maxRows: Number(maxRows) };
    // A config change can alter how many rows are shown, so the existing rows
    // are no longer a valid basis for a diff.
    this.#resetRows();
    this.render();
  }

  onData(data) {
    this.#data = data;
    this.render();
  }

  /**
   * The mobile breakpoint. The widget is told its size in grid cells and drops
   * the secondary columns rather than letting them wrap.
   */
  onResize(w) {
    const narrow = Number(w) <= NARROW_COLUMNS;
    if (narrow === this.#narrow) return;
    this.#narrow = narrow;
    this.render();
  }

  destroy() {
    this.#rows.clear();
    this.#els = null;
  }

  /**
   * Search entries: one per torrent, so the global palette can find a download
   * by name. Only ever built from data already rendered.
   */
  getSearchEntries() {
    const torrents = this.#torrents();
    return torrents.map((torrent) => ({
      id: `torrent-${torrent.hash}`,
      title: torrent.name,
      subtitle: `${stateLabel(torrent.state)} · ${formatPercent(torrent.progress)}`,
      url: null,
      keywords: ['torrent', 'download', torrent.state, torrent.category].filter(Boolean),
    }));
  }

  #torrents() {
    const value = this.#data?.value;
    return Array.isArray(value?.torrents) ? value.torrents : [];
  }

  #ensureShadow() {
    if (this.#shadow) return;
    // A widget may be constructed without `attachShadow` in a test double; the
    // element still has to render somewhere rather than throwing.
    this.#shadow = this.shadowRoot ?? this.attachShadow?.({ mode: 'open' }) ?? this;
  }

  #scaffold() {
    if (this.#els) return this.#els;
    this.#ensureShadow();

    const style = document.createElement('style');
    style.textContent = STYLES;

    const root = document.createElement('div');
    root.className = 'torrents';

    const notice = document.createElement('p');
    notice.className = 'torrents__notice';

    const list = document.createElement('ul');
    list.className = 'torrents__list';

    const more = document.createElement('p');
    more.className = 'torrents__more';

    root.appendChild(notice);
    root.appendChild(list);
    root.appendChild(more);

    this.#shadow.replaceChildren(style, root);
    this.#els = { root, notice, list, more };
    return this.#els;
  }

  #resetRows() {
    this.#rows.clear();
    if (this.#els) this.#els.list.replaceChildren();
  }

  render() {
    // No connectedness guard: `#scaffold` establishes the shadow root on
    // first use, so a widget whose config or data arrives before it is
    // attached still renders rather than staying silently blank.
    const els = this.#scaffold();
    const payload = this.#data?.value ?? null;

    els.root.className = this.#narrow ? 'torrents torrents--narrow' : 'torrents';

    // No data yet is not a state to editorialise about — the host has already
    // pushed a loading payload and will push real data shortly.
    if (!this.#data) {
      this.#setNotice(els, '');
      return;
    }

    if (payload && payload.configured === false) {
      this.#renderMessage(
        els,
        'qBittorrent is not configured.',
        payload.notices?.[0]?.hint ?? 'Set HAVEN_QBITTORRENT_URL, _USER and _PASS.'
      );
      return;
    }

    if (payload?.unreachable) {
      this.#renderMessage(
        els,
        payload.authFailed ? 'qBittorrent rejected the login.' : 'qBittorrent is unreachable.',
        payload.authFailed
          ? 'Check the configured username and password.'
          : 'It will reconnect on its own when the service is back.'
      );
      return;
    }

    // A hard error from the host with nothing cached behind it.
    if (this.#data.state === 'error' && !payload) {
      this.#renderMessage(els, 'Could not load torrents.', this.#data.errors?.[0]?.message ?? '');
      return;
    }

    const torrents = this.#torrents();
    const { shown, hidden } = capTorrents(torrents, this.#config.maxRows);

    // A soft notice — stale cached data — is drawn as a marker ABOVE the real
    // data, never as an error box that replaces it.
    const notice = payload?.notices?.[0] ?? this.#data.notices?.[0] ?? null;
    this.#setNotice(els, notice?.message ?? '', Boolean(notice?.stale ?? payload?.stale));

    if (torrents.length === 0) {
      // Empty is emphatically not an error: nothing downloading is the normal
      // state of a healthy machine.
      this.#resetRows();
      els.list.replaceChildren(this.#message('Nothing downloading.', ''));
      els.more.textContent = '';
      return;
    }

    this.#patch(els.list, shown);
    els.more.textContent = hidden > 0 ? `+${hidden} more` : '';
  }

  #setNotice(els, message, stale = false) {
    els.notice.textContent = message;
    els.notice.className = stale ? 'torrents__notice torrents__notice--stale' : 'torrents__notice';
  }

  #renderMessage(els, message, hint) {
    this.#resetRows();
    this.#setNotice(els, '');
    els.more.textContent = '';
    els.list.replaceChildren(this.#message(message, hint));
  }

  #message(message, hint) {
    const wrapper = document.createElement('li');
    wrapper.className = 'torrents__empty';

    const main = document.createElement('span');
    // textContent, never innerHTML — a torrent name is untrusted input.
    main.textContent = message;
    wrapper.appendChild(main);

    if (hint) {
      const sub = document.createElement('span');
      sub.className = 'torrents__hint';
      sub.textContent = hint;
      wrapper.appendChild(sub);
    }
    return wrapper;
  }

  /**
   * Diff and patch, keyed on torrent hash.
   *
   * Rows that already exist are updated in place and only where a value
   * actually differs; rows that have gone are removed; new rows are created.
   * The list is then reordered by moving existing nodes rather than rebuilding
   * them, so a row that merely changed position keeps its identity — and with
   * it its scroll offset and its in-flight progress-bar transition.
   */
  #patch(list, torrents) {
    const seen = new Set();

    for (const torrent of torrents) {
      seen.add(torrent.hash);
      const existing = this.#rows.get(torrent.hash);
      if (existing) this.#updateRow(existing, torrent);
      else this.#rows.set(torrent.hash, this.#createRow(torrent));
    }

    for (const [hash, row] of this.#rows) {
      if (seen.has(hash)) continue;
      row.el.remove();
      this.#rows.delete(hash);
    }

    // Order: append in the desired sequence. Appending a node already in the
    // list MOVES it, so nothing is recreated.
    for (const torrent of torrents) {
      const row = this.#rows.get(torrent.hash);
      if (row) list.appendChild(row.el);
    }
  }

  #createRow(torrent) {
    const el = document.createElement('li');
    el.className = 'torrent';
    el.dataset.hash = torrent.hash;

    const name = document.createElement('div');
    name.className = 'torrent__name';

    const bar = document.createElement('div');
    bar.className = 'torrent__bar';
    const fill = document.createElement('div');
    fill.className = 'torrent__fill';
    bar.appendChild(fill);

    const meta = document.createElement('div');
    meta.className = 'torrent__meta';
    const state = document.createElement('span');
    const percent = document.createElement('span');
    const down = document.createElement('span');
    const up = document.createElement('span');
    up.className = 'torrent__detail';
    const eta = document.createElement('span');
    const size = document.createElement('span');
    size.className = 'torrent__detail';
    for (const cell of [state, percent, down, up, eta, size]) meta.appendChild(cell);

    for (const part of [name, bar, meta]) el.appendChild(part);

    const row = { el, name, fill, state, percent, down, up, eta, size, values: {} };
    this.#updateRow(row, torrent);
    return row;
  }

  /**
   * Write only what changed.
   *
   * The `values` cache is what makes this cheap: with a five-second refresh
   * most fields are identical tick to tick, and assigning an unchanged
   * `textContent` still dirties layout in a real browser.
   */
  #updateRow(row, torrent) {
    const next = {
      name: truncateName(torrent.name, this.#narrow ? 24 : 42),
      title: torrent.name,
      width: `${(Math.min(Math.max(torrent.progress ?? 0, 0), 1) * 100).toFixed(1)}%`,
      state: stateLabel(torrent.state),
      percent: formatPercent(torrent.progress),
      down: `↓ ${formatSpeed(torrent.dlspeed)}`,
      up: `↑ ${formatSpeed(torrent.upspeed)}`,
      eta: formatEta(torrent.eta),
      size: formatSize(torrent.size),
      error: torrent.state === 'error',
    };
    const prev = row.values;

    if (next.name !== prev.name) row.name.textContent = next.name;
    // The full name on hover — the truncated one is for the layout, not for
    // hiding information.
    if (next.title !== prev.title) row.name.setAttribute('title', next.title);
    if (next.width !== prev.width) row.fill.style.width = next.width;
    if (next.state !== prev.state) row.state.textContent = next.state;
    if (next.percent !== prev.percent) row.percent.textContent = next.percent;
    if (next.down !== prev.down) row.down.textContent = next.down;
    if (next.up !== prev.up) row.up.textContent = next.up;
    if (next.eta !== prev.eta) row.eta.textContent = next.eta;
    if (next.size !== prev.size) row.size.textContent = next.size;
    if (next.error !== prev.error) {
      row.el.className = next.error ? 'torrent torrent--error' : 'torrent';
    }

    row.values = next;
  }

  /** Test seam: which hashes are currently rendered, in order. */
  get renderedHashes() {
    return [...(this.#els?.list.children ?? [])]
      .map((child) => child.dataset?.hash)
      .filter((hash) => hash !== undefined);
  }
}

/**
 * The widget definition the shell registers.
 *
 * `dataSource` is how a config becomes a request — the host calls it, fetches
 * the result, and pushes it back through `onData`. Note it returns a plain
 * `/api/*` URL and no credentials of any kind: the backend holds those.
 */
export const torrentsWidgetDefinition = {
  type: 'torrents',
  name: 'Torrents',
  tag: TORRENTS_WIDGET_TAG,
  defaultSize: { w: 4, h: 3 },
  minSize: { w: 2, h: 2 },
  mobileSize: { w: 2, h: 3 },
  refreshMs: 5_000,
  searchable: true,
  configVersion: 1,

  configSchema: [
    {
      key: 'maxRows',
      type: 'number',
      label: 'Torrents shown',
      help: 'The rest are summarised as a count.',
      default: DEFAULT_MAX_ROWS,
      min: 1,
      max: 25,
    },
  ],

  /** Adding the widget must produce something that works immediately. */
  getStubConfig: () => ({ maxRows: DEFAULT_MAX_ROWS }),

  /**
   * The dedup key is deliberately constant: two torrent widgets on one
   * dashboard are one request, because the endpoint takes no per-widget
   * parameters. `cacheMs` is kept under `refreshMs` so the cache smooths
   * concurrent callers without ever making the tile skip a refresh.
   */
  dataSource: () => ({
    key: 'widgets/torrents',
    url: '/api/widgets/torrents',
    cacheMs: 2_000,
  }),
};

/** Registering the element is idempotent — a module may be imported twice. */
export function defineTorrentsWidget(registry = null) {
  if (globalThis.customElements && !customElements.get(TORRENTS_WIDGET_TAG)) {
    customElements.define(TORRENTS_WIDGET_TAG, TorrentsWidget);
  }
  if (registry && !registry.has(torrentsWidgetDefinition.type)) {
    registry.register(torrentsWidgetDefinition);
  }
  return torrentsWidgetDefinition;
}
