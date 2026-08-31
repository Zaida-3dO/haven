/**
 * The widget host — the boundary between the shell and a widget instance.
 *
 * One `WidgetHost` wraps one widget. It owns the tile element and the widget's
 * shadow root, runs the config through migration and validation, pushes data
 * in, and catches everything the widget throws. A widget never sees a fetch, a
 * timer, or another widget.
 *
 * The rule this exists to enforce: a throwing widget renders a fallback tile
 * and NEVER blanks the dashboard.
 */

import { parseConfig, ConfigError } from './schema.js';
import { migrateConfig } from './migrate.js';
import { loadingData, errorData, DONE, ERROR } from './panel-data.js';

/**
 * How long to wait for a custom element to be defined before showing an error.
 *
 * Lovelace's fix: a lazily-loaded widget that registers a moment after first
 * paint must not flash an error card at the user. So the error card is
 * suppressed for this long while `customElements.whenDefined(tag)` is pending,
 * and the tile rebuilds when the definition lands.
 */
export const LATE_REGISTRATION_GRACE_MS = 2_000;

export const HOST_STATE = Object.freeze({
  PENDING: 'pending',
  READY: 'ready',
  ERROR: 'error',
});

export class WidgetHost {
  #definition;
  #instanceId;
  #root;
  #shadow = null;
  #element = null;
  #state = HOST_STATE.PENDING;

  #config = null;
  /**
   * The config exactly as it arrived, before validation.
   *
   * Lovelace keeps `origConfig` on its error card so a misconfigured widget can
   * be OPENED AND FIXED rather than only deleted. Losing it is the difference
   * between "edit this" and "delete and start again".
   */
  #origConfig = null;
  #error = null;
  #data = null;
  #lastRenderedRevision = -1;
  #destroyed = false;

  #documentRef;
  #customElementsRef;
  #graceMs;
  #onError;

  constructor(
    definition,
    {
      instanceId,
      documentRef = globalThis.document,
      customElementsRef = globalThis.customElements,
      graceMs = LATE_REGISTRATION_GRACE_MS,
      onError = null,
    } = {}
  ) {
    if (!definition) throw new Error('WidgetHost: a widget definition is required');
    this.#definition = definition;
    this.#instanceId = instanceId ?? `${definition.type}-${Math.random().toString(36).slice(2, 9)}`;
    this.#documentRef = documentRef;
    this.#customElementsRef = customElementsRef;
    this.#graceMs = graceMs;
    this.#onError = onError;
  }

  get id() {
    return this.#instanceId;
  }

  get type() {
    return this.#definition.type;
  }

  get state() {
    return this.#state;
  }

  get error() {
    return this.#error;
  }

  /** The bad config, preserved so the settings form can open on it. */
  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  get element() {
    return this.#element;
  }

  get root() {
    return this.#root;
  }

  /**
   * Mount into `container`.
   *
   * The tile is a plain host element; the widget itself lives in a shadow root
   * so its markup — broken or not — cannot reach the dashboard's layout.
   */
  mount(container, storedConfig = {}) {
    this.#root = this.#documentRef.createElement('div');
    this.#root.className = 'haven-widget';
    this.#root.dataset.widgetId = this.#instanceId;
    this.#root.dataset.widgetType = this.#definition.type;
    // Stable id per instance, so `#widget-id` in the URL can scroll to it.
    this.#root.id = this.#instanceId;

    // Shadow DOM per widget: a widget with unclosed tags corrupts only itself.
    this.#shadow = this.#root.attachShadow ? this.#root.attachShadow({ mode: 'open' }) : null;

    container.appendChild(this.#root);
    this.setConfig(storedConfig);
    return this.#root;
  }

  /**
   * Migrate, validate, and hand the config to the widget.
   *
   * `setConfig` throwing is the contract — it is what lets the host render an
   * error card instead of a half-broken widget. So the throw is caught HERE,
   * turned into an error tile, and never allowed to escape into the shell.
   * May be called again at any time.
   */
  setConfig(storedConfig = {}) {
    this.#origConfig = storedConfig;
    try {
      // Migration runs on load, before validation: the widget's own
      // `setConfig` should only ever see a config at the current version.
      const { config: migrated } = migrateConfig(this.#definition, storedConfig);
      this.#config = parseConfig(this.#definition.configSchema, migrated);
      this.#error = null;
      this.#build();
    } catch (error) {
      this.#fail(error);
    }
    return this.#state;
  }

  /**
   * Build the widget element, tolerating a definition that has not landed yet.
   *
   * If the custom element is not yet defined we do NOT show an error. We wait
   * out the grace period on `customElements.whenDefined(tag)` and rebuild, so
   * a lazily-loaded widget never flashes an error card at the user.
   */
  #build() {
    const tag = this.#definition.tag;
    const defined = this.#customElementsRef?.get?.(tag);

    if (!defined) {
      this.#renderPending();
      this.#awaitDefinition(tag);
      return;
    }

    try {
      const element = this.#documentRef.createElement(tag);
      // The widget receives its config through the same contract method
      // whether it is a real custom element or a test double.
      element.setConfig?.(this.#config);
      this.#element = element;
      this.#mountElement(element);
      this.#state = HOST_STATE.READY;
      // A config change can arrive after data; replay it so the widget is not
      // left blank waiting for the next refresh.
      if (this.#data) this.onData(this.#data, { force: true });
      else this.render();
    } catch (error) {
      this.#fail(error);
    }
  }

  #awaitDefinition(tag) {
    const whenDefined = this.#customElementsRef?.whenDefined?.(tag);
    if (!whenDefined) {
      // No custom-element registry at all (a bare test environment): this is a
      // genuine failure, not a late registration.
      this.#fail(new Error(`Unknown widget element <${tag}>`));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (settled || this.#destroyed) return;
      settled = true;
      // Grace expired and the definition never arrived — now it is an error.
      this.#fail(new Error(`Widget <${tag}> was never defined`));
    }, this.#graceMs);
    // Don't hold a Node test process open waiting on the grace timer.
    timer?.unref?.();

    whenDefined.then(
      () => {
        if (settled || this.#destroyed) return;
        settled = true;
        clearTimeout(timer);
        this.#build();
      },
      (error) => {
        if (settled || this.#destroyed) return;
        settled = true;
        clearTimeout(timer);
        this.#fail(error);
      }
    );
  }

  #mountElement(element) {
    const target = this.#shadow ?? this.#root;
    target.replaceChildren?.(element) ?? target.appendChild(element);
  }

  /**
   * Push data in. Everything a widget receives comes through here.
   *
   * The revision check is what keeps "never re-render on every data tick"
   * honest: identical data carries an unchanged revision, so the widget is not
   * asked to redraw and a canvas is never blown away.
   */
  onData(data, { force = false } = {}) {
    this.#data = data;
    if (this.#state !== HOST_STATE.READY || !this.#element) return;
    if (!force && data.revision === this.#lastRenderedRevision) return;

    this.#guard(() => {
      this.#element.onData?.(data);
      this.#lastRenderedRevision = data.revision;
    });
    this.render();
  }

  /**
   * Render behind the error boundary.
   *
   * Every widget render is wrapped: a widget that throws here becomes a
   * fallback tile, and its siblings keep rendering.
   */
  render() {
    if (this.#state !== HOST_STATE.READY || !this.#element) return;
    this.#guard(() => this.#element.render?.());
  }

  onResize(w, h) {
    if (this.#state !== HOST_STATE.READY || !this.#element) return;
    this.#guard(() => this.#element.onResize?.(w, h));
  }

  /** Search entries, behind the boundary — a throwing widget yields none. */
  getSearchEntries() {
    if (!this.#definition.searchable || this.#state !== HOST_STATE.READY || !this.#element) {
      return [];
    }
    let entries = [];
    this.#guard(() => {
      entries = this.#element.getSearchEntries?.() ?? [];
    });
    return entries.map((entry) => ({ ...entry, widgetId: this.#instanceId }));
  }

  destroy() {
    this.#destroyed = true;
    if (this.#element) {
      // A widget's own cleanup must not stop the host tearing the tile down.
      try {
        this.#element.destroy?.();
      } catch {
        /* already going away */
      }
    }
    this.#element = null;
    this.#root?.remove?.();
    this.#root = null;
    this.#shadow = null;
  }

  /**
   * The error boundary itself.
   *
   * Anything a widget throws is caught, converted to a fallback tile, and
   * reported — never rethrown. That is the whole contract: one bad widget must
   * not take out the dashboard.
   */
  #guard(fn) {
    try {
      fn();
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    }
  }

  #fail(error) {
    this.#state = HOST_STATE.ERROR;
    this.#error = error;
    this.#onError?.(error, this);
    this.#renderError(error);
  }

  #renderPending() {
    // Deliberately NOT an error card: the definition may still be loading.
    const target = this.#shadow ?? this.#root;
    if (!target) return;
    const el = this.#documentRef.createElement('div');
    el.className = 'haven-widget__pending';
    el.textContent = '';
    target.replaceChildren?.(el) ?? target.appendChild(el);
  }

  /**
   * The fallback tile.
   *
   * It names the widget, shows why it failed, and — critically — keeps the bad
   * config on the card so the settings form can open on it and fix it.
   */
  #renderError(error) {
    const target = this.#shadow ?? this.#root;
    if (!target) return;

    const card = this.#documentRef.createElement('div');
    card.className = 'haven-widget__error';
    card.dataset.widgetType = this.#definition.type;

    const title = this.#documentRef.createElement('strong');
    title.textContent = `${this.#definition.name ?? this.#definition.type} failed`;

    const detail = this.#documentRef.createElement('p');
    // textContent, never innerHTML: the message may quote a config value.
    detail.textContent = error instanceof Error ? error.message : String(error);

    card.appendChild(title);
    card.appendChild(detail);

    if (error instanceof ConfigError && error.issues?.length) {
      const list = this.#documentRef.createElement('ul');
      for (const issue of error.issues) {
        const li = this.#documentRef.createElement('li');
        li.textContent = `${issue.key} ${issue.message}`;
        list.appendChild(li);
      }
      card.appendChild(list);
    }

    // The preserved config rides on the element, so "Edit" can open the form
    // pre-filled with what the user actually typed.
    card.origConfig = this.#origConfig;
    target.replaceChildren?.(card) ?? target.appendChild(card);
  }
}

/**
 * Turn a fetch result into a `PanelData` payload for a host.
 * Kept here so the dashboard has one place that decides loading/done/error.
 */
export function initialData() {
  return loadingData();
}

export { DONE, ERROR, errorData };
