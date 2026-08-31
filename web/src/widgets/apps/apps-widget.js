/**
 * The apps widget — the core one, and the reason Haven exists rather than an
 * off-the-shelf dashboard.
 *
 * Two things here are not available anywhere else, and both are load-bearing:
 *
 *  1. **The status dots are probed by the browser**, not the server. See
 *     `web/src/lib/status.js` and `web/src/lib/reachability.js`. Do not move
 *     this server-side; the note in those files explains why at length.
 *  2. **The version pair** — running beside latest — with the difference
 *     between them called out.
 *
 * The third feature worth naming is the **multi-URL menu**: each app can have
 * several ways in (LAN, hostname, Tailscale), each under its own title, and
 * the card offers all of them rather than hiding everything behind one link.
 *
 * ## How this obeys the contract
 *
 *  - **The host fetches; this renders.** `dataSource(config)` describes a
 *    request; the dashboard performs it and pushes the result to `onData`.
 *  - **No `setInterval` anywhere in this file.** Reachability re-probes happen
 *    when the host pushes fresh data, which is on the host's schedule and is
 *    paused when the tab is hidden.
 *  - **The settings form is generated from `configSchema`.** There is no
 *    hand-built form here, deliberately — `web/src/shell/schema.js` turns the
 *    same array into both the form model and the validator.
 *  - **Diff and patch, never blanket re-render.** A status dot changing patches
 *    that one dot in place, so a probe finishing does not close an open menu or
 *    jump the scroll position. A full rebuild happens only when the host pushes
 *    new data (which it does only when the revision moved) or when the user
 *    changes a tab or the sort.
 */

import { registry } from '../../shell/registry.js';
import { STATUS, StatusTracker } from '../../lib/status.js';
import { ALL_CATEGORY, CATEGORIES, SORT, SORT_OPTIONS, buildView } from './model.js';
import { STYLES } from './styles.js';

export const WIDGET_TYPE = 'apps';
export const WIDGET_TAG = 'haven-widget-apps';

/**
 * The one declaration that generates both the settings form and the validator.
 *
 * A flat array of typed descriptors, not JSON Schema — see
 * docs/WIDGET-CONTRACT.md. Nothing in this file writes a settings UI; the
 * shell reads this array.
 *
 * Note what is NOT here: `visitCount`. Visit counts are server-owned and not
 * user-editable (DESIGN §6.2), so there is no field for them and the API
 * rejects one.
 */
export const APPS_CONFIG_SCHEMA = Object.freeze([
  {
    key: 'category',
    type: 'select',
    label: 'Category',
    default: ALL_CATEGORY,
    options: [
      { value: ALL_CATEGORY, label: 'All' },
      ...CATEGORIES.map((c) => ({ value: c, label: c.charAt(0).toUpperCase() + c.slice(1) })),
    ],
    help: 'Which category the widget opens on. Tabs still switch between them.',
  },
  {
    key: 'sort',
    type: 'select',
    label: 'Sort by',
    default: SORT.VISITS,
    options: [...SORT_OPTIONS],
  },
  {
    key: 'showVersions',
    type: 'select',
    label: 'Version display',
    default: 'on',
    options: [
      { value: 'on', label: 'Show current and latest' },
      { value: 'off', label: 'Hide versions' },
    ],
  },
  {
    key: 'statusTtlMs',
    type: 'number',
    label: 'Re-probe reachability after (ms)',
    default: 60_000,
    min: 5_000,
    max: 3_600_000,
    help: 'How long a reachability result is trusted before the next refresh re-probes.',
  },
]);

/**
 * How the host turns a config into a request.
 *
 * `dataSource` returns exactly ONE request descriptor — that is the host's
 * contract (`Dashboard.refresh` calls `fetcher.fetchWithFallback(request)` on
 * a single descriptor), and this widget does not get to extend it. The widget
 * needs two things, the registry and the version pairs, so the *server* joins
 * them: `/api/apps/dashboard` returns `{ apps, versions }` in one response.
 *
 * That is the right place for the join anyway — the version map is served from
 * a shared server-side cache, so combining it costs nothing and saves the grid
 * a second round trip on every refresh.
 *
 * The URL is `/api/*` like everything else: the browser never calls GitHub, so
 * the token stays on the server. Reachability is deliberately NOT fetched here
 * — it is probed in the browser, which is the entire point of the dots.
 */
export function dataSource(config = {}) {
  const category = config.category && config.category !== ALL_CATEGORY ? config.category : null;
  const params = new URLSearchParams();
  if (category) params.set('category', category);
  if (config.showVersions === 'off') params.set('versions', 'false');
  const query = params.toString();

  return {
    // An explicit key so two apps widgets on the same category and version
    // setting collapse to one request rather than two.
    key: `apps:${category ?? 'all'}:${config.showVersions === 'off' ? 'noversions' : 'versions'}`,
    url: query ? `/api/apps/dashboard?${query}` : '/api/apps/dashboard',
  };
}

/**
 * Normalises whatever the host pushed into `{ apps, versions }`.
 *
 * The payload shape varies with how the host fetched it — a plain
 * `/api/apps` response, or a combined object when both endpoints were
 * fetched. Tolerating both here keeps the widget renderable in a test with a
 * one-line fixture.
 */
export function readPayload(value) {
  if (!value) return { apps: [], versions: {} };
  if (Array.isArray(value)) return { apps: value, versions: {} };
  return {
    apps: Array.isArray(value.apps) ? value.apps : [],
    versions: value.versions ?? {},
  };
}

/**
 * The base class, resolved at module load.
 *
 * In a browser this IS `HTMLElement` and `AppsWidget` is a real custom element.
 * Under `node --test` there is no `HTMLElement` at all, and extending an
 * undefined global is a module-load error — which would make this file
 * unimportable and take its pure exports (`dataSource`, `readPayload`, the
 * config schema) down with it.
 *
 * The web workspace has no jsdom on purpose (see `test/helpers/fake-dom.js`),
 * so the shim is the smaller of the two options. It is a bare class with no
 * behaviour: nothing that matters at runtime is being stubbed out, because in
 * the browser this branch is never taken.
 */
const ElementBase =
  typeof HTMLElement === 'function'
    ? HTMLElement
    : class {
        attachShadow() {
          return null;
        }
      };

export class AppsWidget extends ElementBase {
  #config = {};
  #apps = [];
  #versions = {};
  #category = ALL_CATEGORY;
  #sort = SORT.VISITS;
  #tracker = null;
  #shadow = null;
  #openMenuId = null;

  constructor() {
    super();
    this.#shadow = this.attachShadow({ mode: 'open' });
  }

  /**
   * Validate eagerly and THROW on bad config — that is the contract, and it is
   * what lets the host render an error card (with the bad config preserved)
   * instead of a half-broken widget.
   */
  setConfig(config = {}) {
    if (config === null || typeof config !== 'object') {
      throw new Error('apps: config must be an object');
    }
    this.#config = config;
    this.#category = config.category ?? ALL_CATEGORY;
    this.#sort = config.sort ?? SORT.VISITS;

    // The tracker owns no timer; only a TTL. The host decides when to refresh.
    this.#tracker = new StatusTracker({
      ttlMs: config.statusTtlMs ?? 60_000,
      // A dot changing patches that one dot rather than rebuilding the grid,
      // so the open menu and scroll position survive a probe finishing.
      onChange: (id) => this.#patchCard(id),
    });
  }

  onData(data) {
    const { apps, versions } = readPayload(data?.value);
    this.#apps = apps;
    this.#versions = versions;

    // No revision bookkeeping here on purpose: the HOST already drops a data
    // push whose revision has not moved (`WidgetHost.onData`), so by the time
    // this runs the data really is new. Tracking it again would be a second
    // source of truth for the same decision.

    // Probing is kicked off by the host's data push — this is the refresh
    // path, and it inherits the host's schedule and its hidden-tab pause. The
    // widget starts no timer of its own.
    void this.#tracker?.checkAll(apps);
    this.render();
  }

  render() {
    if (!this.#shadow) return;

    const view = buildView(this.#apps, {
      category: this.#category,
      sort: this.#sort,
      statuses: this.#tracker?.snapshot() ?? new Map(),
      versions: this.#config.showVersions === 'off' ? {} : this.#versions,
    });

    const style = document.createElement('style');
    style.textContent = STYLES;

    const root = document.createElement('div');
    root.className = 'apps';
    root.appendChild(this.#renderControls(view));
    root.appendChild(this.#renderGrid(view));

    this.#shadow.replaceChildren(style, root);
  }

  #renderControls(view) {
    const bar = document.createElement('div');
    bar.className = 'controls';

    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');

    for (const tab of view.tabs) {
      const button = document.createElement('button');
      button.className = 'tab';
      button.type = 'button';
      button.textContent = `${tab.label} (${tab.count})`;
      button.dataset.category = tab.value;
      button.setAttribute('role', 'tab');
      const selected = tab.value === view.category;
      button.setAttribute('aria-selected', String(selected));
      if (selected) button.classList.add('tab--active');
      button.addEventListener('click', () => {
        this.#category = tab.value;
        this.#openMenuId = null;
        this.render();
      });
      tabs.appendChild(button);
    }
    bar.appendChild(tabs);

    const sortWrap = document.createElement('label');
    sortWrap.className = 'sort';
    const sortLabel = document.createElement('span');
    sortLabel.className = 'sort__label';
    sortLabel.textContent = 'Sort';
    const select = document.createElement('select');
    select.className = 'sort__select';
    for (const option of view.sortOptions) {
      const opt = document.createElement('option');
      opt.value = option.value;
      opt.textContent = option.label;
      if (option.value === view.sort) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('change', (event) => {
      this.#sort = event.target.value;
      this.render();
    });
    sortWrap.appendChild(sortLabel);
    sortWrap.appendChild(select);
    bar.appendChild(sortWrap);

    return bar;
  }

  #renderGrid(view) {
    const grid = document.createElement('div');
    grid.className = 'grid';

    if (view.empty) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'No apps in this category.';
      grid.appendChild(empty);
      return grid;
    }

    for (const card of view.cards) grid.appendChild(this.#renderCard(card));
    return grid;
  }

  #renderCard(card) {
    const el = document.createElement('article');
    el.className = 'card';
    el.dataset.appId = card.id;

    const head = document.createElement('div');
    head.className = 'card__head';

    if (card.icon) {
      const icon = document.createElement('img');
      icon.className = 'card__icon';
      icon.src = `/api/apps/icons/${encodeURIComponent(card.icon)}`;
      // Decorative: the app's name is right beside it, so announcing the icon
      // too would just repeat it.
      icon.alt = '';
      head.appendChild(icon);
    }

    const titleWrap = document.createElement('div');
    titleWrap.className = 'card__titles';

    const link = document.createElement('a');
    link.className = 'card__name';
    link.href = card.href ?? '#';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = card.name;
    // The hover hint: where a click will ACTUALLY land, which is often not the
    // primary URL because the chain may have fallen through to another alias.
    link.title = card.urlHint;
    link.addEventListener('click', () => this.#recordVisit(card.id));
    titleWrap.appendChild(link);

    if (card.description) {
      const desc = document.createElement('p');
      desc.className = 'card__description';
      desc.textContent = card.description;
      titleWrap.appendChild(desc);
    }

    head.appendChild(titleWrap);
    head.appendChild(this.#renderDot(card));
    el.appendChild(head);

    if (card.version.known) el.appendChild(this.#renderVersions(card));
    if (card.secondaries.length) el.appendChild(this.#renderMenu(card));

    return el;
  }

  /**
   * The status dot.
   *
   * Colour is carried by the class, but the meaning is carried by `title`,
   * `aria-label` and a visually-hidden text node — colour alone must never be
   * the only signal.
   */
  #renderDot(card) {
    const dot = document.createElement('span');
    dot.className = `dot dot--${card.status}`;
    dot.dataset.status = card.status;
    dot.setAttribute('role', 'img');
    dot.setAttribute('aria-label', card.statusLabel);
    dot.title = `${card.statusLabel} — ${card.urlHint}`;

    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = card.statusLabel;
    dot.appendChild(sr);

    return dot;
  }

  /**
   * Current and latest, side by side.
   *
   * When they differ the row gets the `versions--update` class and an explicit
   * "Update" badge — that difference is the point of the feature, so it is
   * called out rather than left for the reader to spot.
   */
  #renderVersions(card) {
    const row = document.createElement('div');
    row.className = `versions${card.version.differs ? ' versions--update' : ''}`;
    row.title = card.version.label;
    row.setAttribute('aria-label', card.version.label);

    const current = document.createElement('span');
    current.className = 'version version--current';
    current.textContent = card.version.current ?? '—';
    const currentLabel = document.createElement('span');
    currentLabel.className = 'version__tag';
    currentLabel.textContent = 'running';
    current.appendChild(currentLabel);

    const latest = document.createElement('span');
    latest.className = 'version version--latest';
    latest.textContent = card.version.latest ?? '—';
    const latestLabel = document.createElement('span');
    latestLabel.className = 'version__tag';
    latestLabel.textContent = 'latest';
    latest.appendChild(latestLabel);

    row.appendChild(current);
    row.appendChild(latest);

    if (card.version.differs) {
      const badge = document.createElement('span');
      badge.className = 'badge badge--update';
      badge.textContent = 'Update';
      row.appendChild(badge);
    }

    return row;
  }

  /**
   * The secondary-URL menu — the headline feature, so it is one click from the
   * card rather than buried behind a settings panel.
   */
  #renderMenu(card) {
    const wrap = document.createElement('div');
    wrap.className = 'menu';

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'menu__toggle';
    toggle.textContent = `${card.secondaries.length} more ${card.secondaries.length === 1 ? 'way' : 'ways'} in`;
    const open = this.#openMenuId === card.id;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.addEventListener('click', () => {
      this.#openMenuId = this.#openMenuId === card.id ? null : card.id;
      this.render();
    });
    wrap.appendChild(toggle);

    const list = document.createElement('ul');
    list.className = `menu__list${open ? ' menu__list--open' : ''}`;
    if (!open) list.hidden = true;

    for (const entry of card.secondaries) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = entry.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      // Each secondary under its OWN title — that is what makes the menu
      // navigable rather than a list of indistinguishable URLs.
      a.textContent = entry.title;
      a.title = entry.url;
      a.addEventListener('click', () => this.#recordVisit(card.id));
      li.appendChild(a);
      list.appendChild(li);
    }

    wrap.appendChild(list);
    return wrap;
  }

  /**
   * Visit counting is a server-side increment.
   *
   * The count is deliberately not client state: it is not user-editable, and
   * the API rejects a client trying to set one. This is fire-and-forget — a
   * failed count must never stop the link opening.
   */
  #recordVisit(id) {
    if (!id) return;
    try {
      void fetch(`/api/apps/${encodeURIComponent(id)}/visit`, { method: 'POST' }).catch(() => {});
    } catch {
      /* opening the app matters; counting it does not */
    }
  }

  /**
   * Patch one card's dot in place.
   *
   * "Never re-render on every data tick — diff and patch." A probe finishing
   * must not rebuild the grid, or an open menu would close and the scroll
   * position would jump under the user.
   */
  #patchCard(id) {
    const root = this.#shadow;
    if (!root?.querySelector) return;
    const card = root.querySelector(`[data-app-id="${CSS.escape(id)}"]`);
    if (!card) return;

    const app = this.#apps.find((a) => a?.id === id);
    if (!app) return;

    const view = buildView([app], {
      category: ALL_CATEGORY,
      sort: this.#sort,
      statuses: this.#tracker?.snapshot() ?? new Map(),
      versions: this.#config.showVersions === 'off' ? {} : this.#versions,
    });
    const fresh = view.cards[0];
    if (!fresh) return;

    const dot = card.querySelector('.dot');
    if (dot) {
      dot.className = `dot dot--${fresh.status}`;
      dot.dataset.status = fresh.status;
      dot.setAttribute('aria-label', fresh.statusLabel);
      dot.title = `${fresh.statusLabel} — ${fresh.urlHint}`;
      const sr = dot.querySelector('.sr-only');
      if (sr) sr.textContent = fresh.statusLabel;
    }

    // The resolved URL may have changed, so the click target follows the dot.
    const link = card.querySelector('.card__name');
    if (link && fresh.href) {
      link.href = fresh.href;
      link.title = fresh.urlHint;
    }
  }

  onResize() {
    // The grid is CSS-driven (auto-fill), so it reflows on its own. Nothing to
    // recompute — but the hook exists so the contract is satisfied explicitly
    // rather than by omission.
  }

  /** Contributes every app to the shared in-memory search index. */
  getSearchEntries() {
    return this.#apps.map((app) => ({
      id: app.id,
      title: app.name,
      subtitle: app.description ?? '',
      url: this.#tracker?.get(app)?.url ?? null,
      keywords: [app.category, ...(app.urls ?? []).map((u) => u?.title).filter(Boolean)].filter(
        Boolean
      ),
    }));
  }

  destroy() {
    this.#tracker?.clear();
    this.#tracker = null;
    this.#shadow?.replaceChildren?.();
  }
}

/** The widget definition, registered with the shell's registry. */
export const appsWidgetDefinition = {
  type: WIDGET_TYPE,
  name: 'Apps',
  tag: WIDGET_TAG,
  defaultSize: { w: 6, h: 4 },
  minSize: { w: 2, h: 2 },
  // Narrow enough for a phone; the card grid is auto-fill so it becomes a
  // single column on its own.
  mobileSize: { w: 4, h: 5 },
  configSchema: APPS_CONFIG_SCHEMA,
  // The HOST refetches on this interval. The widget never schedules anything.
  refreshMs: 5 * 60_000,
  searchable: true,
  configVersion: 1,
  dataSource,
  getStubConfig: () => ({
    category: ALL_CATEGORY,
    sort: SORT.VISITS,
    showVersions: 'on',
    statusTtlMs: 60_000,
  }),
};

/**
 * Registration is a side effect of importing this module, matching how the
 * shell expects widgets to arrive. Both guards make a double import harmless —
 * the host tolerates late registration, but not a duplicate one.
 */
export function registerAppsWidget(target = registry) {
  if (typeof customElements !== 'undefined' && !customElements.get(WIDGET_TAG)) {
    customElements.define(WIDGET_TAG, AppsWidget);
  }
  if (!target.has(WIDGET_TYPE)) target.register(appsWidgetDefinition);
  return target.get(WIDGET_TYPE);
}

export { STATUS };
