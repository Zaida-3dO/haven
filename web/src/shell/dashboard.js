/**
 * The dashboard — what actually wires the pieces together.
 *
 * It holds the registry, one `Fetcher`, one `Scheduler`, and a `WidgetHost`
 * per widget instance. Each widget gets exactly one scheduled task, and that
 * task is the only thing that fetches on its behalf.
 *
 * This is where "the host fetches; widgets render" stops being a slogan: a
 * widget's `dataSource(config)` returns a request description, the dashboard
 * fetches it (deduplicated with every other widget asking for the same thing),
 * wraps the result in a `PanelData` payload, and pushes it to the host.
 */

import { registry as defaultRegistry } from './registry.js';
import { Fetcher } from './fetcher.js';
import { Scheduler } from './scheduler.js';
import { WidgetHost } from './host.js';
import { loadingData, doneData, errorData, staleData } from './panel-data.js';
import { SearchIndex } from './search-index.js';

export class Dashboard {
  #registry;
  #fetcher;
  #scheduler;
  #hosts = new Map();
  #data = new Map();
  #container;
  #searchIndex;
  // Teardowns for host-owned side tasks (the clock tick), keyed by widget id.
  // These register under their OWN scheduler ids, so `remove(id)` cannot reach
  // them by id alone — see `onRemove`.
  #teardowns = new Map();

  constructor({
    registry = defaultRegistry,
    fetcher,
    scheduler,
    container = null,
    searchIndex,
  } = {}) {
    this.#registry = registry;
    this.#fetcher = fetcher ?? new Fetcher();
    this.#scheduler = scheduler ?? new Scheduler();
    this.#container = container;
    // In-memory only, and built fresh with the dashboard — see search-index.js.
    this.#searchIndex = searchIndex ?? new SearchIndex();
  }

  get searchIndex() {
    return this.#searchIndex;
  }

  get scheduler() {
    return this.#scheduler;
  }

  get fetcher() {
    return this.#fetcher;
  }

  get hosts() {
    return [...this.#hosts.values()];
  }

  host(id) {
    return this.#hosts.get(id) ?? null;
  }

  /**
   * Add a widget instance from a saved layout entry.
   *
   * An unknown `type` is a layout referencing a widget this build doesn't have.
   * That must not throw — one removed widget would otherwise stop the whole
   * dashboard loading.
   */
  add({ id, type, config = {} }, container = this.#container) {
    const definition = this.#registry.get(type);
    if (!definition) {
      return null;
    }

    const host = new WidgetHost(definition, { instanceId: id });
    host.mount(container, config);
    this.#hosts.set(host.id, host);

    // Every widget gets a task; a widget with no data source still gets one
    // with a null interval, so nothing has to special-case it later.
    this.#scheduler.add(host.id, {
      intervalMs: definition.dataSource ? definition.refreshMs : null,
      update: () => this.refresh(host.id),
    });

    if (definition.dataSource) {
      this.#push(host, loadingData());
      void this.#scheduler.runNow(host.id);
    } else {
      // A widget with no data source never reaches `#push`, but it can still
      // contribute — a custom page offers its title — so index it on add.
      this.#indexHost(host);
    }
    return host;
  }

  /**
   * Registers a teardown to run when `id` is removed.
   *
   * **Why this exists.** `startClockTicks` registers its scheduler task as
   * `clock-tick:${host.id}` — deliberately namespaced, because the dashboard
   * already registers a task under the bare `host.id` for every widget and
   * `Scheduler.add` is a `Map.set`, so reusing the id would silently overwrite
   * it. The consequence is that `remove(id)` cannot cancel the tick by id: it
   * calls `scheduler.remove(id)` with the bare id and the two never match, so
   * every clock add/remove used to leave a permanent 1 Hz task pushing into a
   * destroyed host. The teardown `startClockTicks` returns was discarded at
   * both call sites; keeping it here is what closes that.
   *
   * @param {string} id widget instance id
   * @param {() => void} teardown
   */
  onRemove(id, teardown) {
    if (typeof teardown !== 'function') return;
    const existing = this.#teardowns.get(id);
    // A widget re-registering must not orphan its previous teardown.
    this.#teardowns.set(id, existing ? () => (existing(), teardown()) : teardown);
  }

  remove(id) {
    this.#scheduler.remove(id);
    // Before destroying the host: a side task that fires in between would push
    // into a host that is already gone.
    const teardown = this.#teardowns.get(id);
    this.#teardowns.delete(id);
    try {
      teardown?.();
    } catch (error) {
      console.warn('Haven: a widget teardown failed.', error);
    }
    this.#hosts.get(id)?.destroy();
    this.#hosts.delete(id);
    this.#data.delete(id);
    // A removed widget takes its search entries with it.
    this.#searchIndex.remove(id);
  }

  /**
   * Fetch for one widget and push the result in.
   *
   * Throws on failure — deliberately. The scheduler catches it and applies
   * backoff; the widget has already been given an error payload to render.
   */
  async refresh(id) {
    const host = this.#hosts.get(id);
    if (!host) return;

    const definition = this.#registry.get(host.type);
    const request = definition?.dataSource?.(host.config);
    if (!request) return;

    const previous = this.#data.get(id) ?? null;
    try {
      const result = await this.#fetcher.fetchWithFallback(request);
      // Stale-but-usable is a soft notice, not an error box.
      this.#push(
        host,
        result.stale ? staleData(result.value, { previous }) : doneData(result.value, { previous })
      );
    } catch (error) {
      this.#push(host, errorData(error, { previous }));
      // Rethrow so the scheduler backs off instead of retrying every tick.
      throw error;
    }
  }

  #push(host, payload) {
    this.#data.set(host.id, payload);
    host.onData(payload);
    // Widgets push to the index on data change — this is that push. The
    // index replaces the widget's previous entries rather than appending, so
    // a 30s refresh cannot make it grow without bound.
    this.#indexHost(host);
  }

  /**
   * Re-read one widget's search entries into the index.
   *
   * `host.getSearchEntries()` is already behind the error boundary and
   * already stamps `widgetId`, so a throwing widget contributes nothing
   * rather than breaking search.
   */
  #indexHost(host) {
    const definition = this.#registry.get(host.type);
    this.#searchIndex.setEntries(host.id, host.getSearchEntries(), {
      label: definition?.name ?? host.type,
    });
  }

  data(id) {
    return this.#data.get(id) ?? null;
  }

  /** The global search index is in-memory only and rebuilt each session. */
  searchEntries() {
    return this.hosts.flatMap((host) => host.getSearchEntries());
  }

  /** Rebuild the whole index from the live hosts. */
  reindexSearch() {
    return this.#searchIndex.syncFromHosts(this.hosts, {
      labelFor: (host) => this.#registry.get(host.type)?.name ?? host.type,
    });
  }

  start() {
    this.#scheduler.start();
  }

  destroy() {
    this.#scheduler.stop();
    // `stop()` already halts every task, so these are belt-and-braces — but a
    // teardown may release something other than a scheduler task.
    for (const teardown of this.#teardowns.values()) {
      try {
        teardown();
      } catch (error) {
        console.warn('Haven: a widget teardown failed.', error);
      }
    }
    this.#teardowns.clear();
    for (const host of this.#hosts.values()) host.destroy();
    this.#hosts.clear();
    this.#data.clear();
    // The index dies with the session; nothing of it outlives the page.
    this.#searchIndex.clear();
  }
}
