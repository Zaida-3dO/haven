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

export class Dashboard {
  #registry;
  #fetcher;
  #scheduler;
  #hosts = new Map();
  #data = new Map();
  #container;

  constructor({ registry = defaultRegistry, fetcher, scheduler, container = null } = {}) {
    this.#registry = registry;
    this.#fetcher = fetcher ?? new Fetcher();
    this.#scheduler = scheduler ?? new Scheduler();
    this.#container = container;
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
    }
    return host;
  }

  remove(id) {
    this.#scheduler.remove(id);
    this.#hosts.get(id)?.destroy();
    this.#hosts.delete(id);
    this.#data.delete(id);
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
  }

  data(id) {
    return this.#data.get(id) ?? null;
  }

  /** The global search index is in-memory only and rebuilt each session. */
  searchEntries() {
    return this.hosts.flatMap((host) => host.getSearchEntries());
  }

  start() {
    this.#scheduler.start();
  }

  destroy() {
    this.#scheduler.stop();
    for (const host of this.#hosts.values()) host.destroy();
    this.#hosts.clear();
    this.#data.clear();
  }
}
