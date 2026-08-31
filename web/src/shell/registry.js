/**
 * The widget registry.
 *
 * A widget registers by `type` — the stable identity used in saved layouts —
 * along with its static metadata. Nothing here touches the DOM, so the whole
 * registry is testable without a browser.
 *
 * Static metadata, per docs/WIDGET-CONTRACT.md:
 *
 *   type         registry identity, stable, used in saved layouts
 *   name         human label in the "Add widget" panel
 *   tag          custom-element tag name
 *   defaultSize  { w, h } grid cells on insert
 *   minSize      { w, h } grid cells minimum — maps to GridStack minW/minH
 *   mobileSize   { w, h } grid cells in the mobile breakpoint
 *   configSchema flat array of typed field descriptors
 *   refreshMs    how often the HOST refetches (never the widget)
 *   searchable   whether it contributes to the global index
 */

import { assertValidSchema, applyDefaults } from './schema.js';

const DEFAULT_SIZE = Object.freeze({ w: 3, h: 2 });
const DEFAULT_MIN_SIZE = Object.freeze({ w: 1, h: 1 });

function size(value, fallback) {
  if (!value) return fallback;
  return Object.freeze({ w: value.w ?? fallback.w, h: value.h ?? fallback.h });
}

export class WidgetRegistry {
  #byType = new Map();

  /**
   * @param {object} definition
   * @returns {object} the normalised, frozen definition
   */
  register(definition) {
    if (!definition || typeof definition.type !== 'string' || definition.type === '') {
      throw new Error('register: a widget definition needs a string `type`');
    }
    if (this.#byType.has(definition.type)) {
      throw new Error(`register: widget type "${definition.type}" is already registered`);
    }

    // Validate the schema at registration, not at first render: a malformed
    // schema should fail at boot where it is obvious, rather than in a form.
    const configSchema = assertValidSchema(definition.configSchema ?? [], definition.type);

    const defaultSize = size(definition.defaultSize, DEFAULT_SIZE);
    const normalised = Object.freeze({
      type: definition.type,
      name: definition.name ?? definition.type,
      tag: definition.tag ?? `haven-widget-${definition.type}`,
      defaultSize,
      minSize: size(definition.minSize, DEFAULT_MIN_SIZE),
      // A widget that does not declare a mobile size keeps its default size.
      mobileSize: size(definition.mobileSize, defaultSize),
      configSchema: Object.freeze(configSchema),
      // `null` means "never refreshes on a timer" — a static widget such as a
      // clock or an iframe should not occupy a slot in the schedule.
      refreshMs: definition.refreshMs ?? null,
      searchable: Boolean(definition.searchable),
      configVersion: definition.configVersion ?? 1,
      migrateConfig: definition.migrateConfig ?? null,
      getStubConfig: definition.getStubConfig ?? null,
      // How the host turns a config into a request. Absent = no data needed.
      dataSource: definition.dataSource ?? null,
    });

    this.#byType.set(normalised.type, normalised);
    return normalised;
  }

  get(type) {
    return this.#byType.get(type) ?? null;
  }

  has(type) {
    return this.#byType.has(type);
  }

  list() {
    return [...this.#byType.values()];
  }

  /** The "Add widget" panel's catalogue. */
  catalogue() {
    return this.list().map((d) => ({
      type: d.type,
      name: d.name,
      defaultSize: d.defaultSize,
      minSize: d.minSize,
    }));
  }

  /**
   * `getStubConfig` matters more than it looks: it is what makes "Add widget"
   * produce something that WORKS IMMEDIATELY rather than an error card. If a
   * widget does not supply one we still fall back to the schema defaults, so
   * adding a widget never yields a blank config.
   */
  stubConfig(type) {
    const definition = this.get(type);
    if (!definition) throw new Error(`stubConfig: unknown widget type "${type}"`);

    const fromWidget =
      typeof definition.getStubConfig === 'function' ? definition.getStubConfig() : {};

    return {
      ...applyDefaults(definition.configSchema, fromWidget ?? {}),
      configVersion: definition.configVersion,
    };
  }

  /** Test seam — the module-level singleton is shared process-wide otherwise. */
  clear() {
    this.#byType.clear();
  }
}

/** The shell's one registry. */
export const registry = new WidgetRegistry();
