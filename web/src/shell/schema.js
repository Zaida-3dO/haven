/**
 * `configSchema` — a flat array of typed option descriptors.
 *
 * NOT JSON Schema. All four prior-art projects (Lovelace, Grafana, Homarr,
 * Glance) independently built a purpose-made flat option list instead, which is
 * the strongest single signal in the study. See docs/WIDGET-CONTRACT.md.
 *
 * The same array drives BOTH the settings form and the validator. That is the
 * whole point: two sources of truth drift immediately, so there is exactly one
 * here and both `buildFormModel` and `validateConfig` read it.
 *
 * A descriptor:
 *
 *   {
 *     key: 'refreshMs',                    // required, unique within the schema
 *     type: 'number',                      // url | number | text | select | secret
 *     label: 'Refresh interval',           // form label; defaults to `key`
 *     required: false,
 *     default: 60000,
 *     min: 1000, max: 3600000,             // number only
 *     options: [{ value, label }],         // select only
 *     visible: { field, operator, value }, // declarative, see below
 *   }
 */

/** The five option types the contract allows. */
export const FIELD_TYPES = Object.freeze(['url', 'number', 'text', 'select', 'secret']);

/**
 * Conditional visibility is DATA, not a function.
 *
 * Lovelace uses a serialisable condition tree; Grafana uses
 * `showIf: (opts) => boolean`. We take Lovelace's, because a function does not
 * survive a JSON round-trip and cannot be validated — and a widget config is
 * stored as JSON.
 */
const OPERATORS = {
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
  in: (a, b) => Array.isArray(b) && b.includes(a),
  truthy: (a) => Boolean(a),
  falsy: (a) => !a,
};

export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {Array<{ key: string, message: string }>} issues
   */
  constructor(message, issues = []) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

/**
 * Is a field visible, given the current values?
 *
 * A field with no `visible` clause is always visible. An unknown operator is
 * treated as "not visible" rather than throwing — a bad schema should not be
 * able to take the dashboard down at render time.
 */
export function isVisible(field, values = {}) {
  const rule = field?.visible;
  if (!rule) return true;
  const op = OPERATORS[rule.operator];
  if (!op) return false;
  return Boolean(op(values[rule.field], rule.value));
}

/** The fields of `schema` that are visible for `values`, in declaration order. */
export function visibleFields(schema = [], values = {}) {
  return schema.filter((field) => isVisible(field, values));
}

/**
 * Validate a schema itself. Called by the registry at registration time so a
 * malformed schema fails loudly at boot rather than mysteriously in a form.
 */
export function assertValidSchema(schema, widgetType = '<unknown>') {
  if (!Array.isArray(schema)) {
    throw new ConfigError(`configSchema for "${widgetType}" must be an array`);
  }
  const seen = new Set();
  for (const field of schema) {
    if (!field || typeof field.key !== 'string' || field.key === '') {
      throw new ConfigError(`configSchema for "${widgetType}": every field needs a string key`);
    }
    if (seen.has(field.key)) {
      throw new ConfigError(`configSchema for "${widgetType}": duplicate key "${field.key}"`);
    }
    seen.add(field.key);
    if (!FIELD_TYPES.includes(field.type)) {
      throw new ConfigError(
        `configSchema for "${widgetType}": field "${field.key}" has unknown type "${field.type}"`
      );
    }
    if (field.type === 'select' && !Array.isArray(field.options)) {
      throw new ConfigError(
        `configSchema for "${widgetType}": select field "${field.key}" needs an options array`
      );
    }
  }
  return schema;
}

/** Apply schema defaults to a config, without overwriting anything present. */
export function applyDefaults(schema = [], config = {}) {
  const out = { ...config };
  for (const field of schema) {
    if (out[field.key] === undefined && field.default !== undefined) {
      out[field.key] = field.default;
    }
  }
  return out;
}

/** A form input hands back strings; a `number` field should still validate. */
function coerce(field, raw) {
  if (field.type === 'number' && typeof raw === 'string' && raw.trim() !== '') {
    const n = Number(raw);
    return Number.isNaN(n) ? raw : n;
  }
  return raw;
}

function checkOne(field, value) {
  switch (field.type) {
    case 'number': {
      if (typeof value !== 'number' || Number.isNaN(value)) return 'must be a number';
      if (field.min !== undefined && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== undefined && value > field.max) return `must be at most ${field.max}`;
      return null;
    }
    case 'url': {
      if (typeof value !== 'string') return 'must be a string';
      try {
        const parsed = new URL(value);
        if (!parsed.protocol) return 'must be a valid URL';
      } catch {
        return 'must be a valid URL';
      }
      return null;
    }
    case 'select': {
      const allowed = (field.options ?? []).map((o) => (o && typeof o === 'object' ? o.value : o));
      return allowed.includes(value) ? null : `must be one of: ${allowed.join(', ')}`;
    }
    case 'text':
    case 'secret': {
      if (typeof value !== 'string') return 'must be a string';
      if (field.maxLength !== undefined && value.length > field.maxLength) {
        return `must be at most ${field.maxLength} characters`;
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * Validate a config against its schema.
 *
 * Returns `{ ok, value, issues }` rather than throwing, because the settings
 * form wants to show every problem at once. `parseConfig` is the throwing
 * wrapper that `setConfig` uses.
 *
 * Only VISIBLE fields are validated: a hidden `apiKey` is not required just
 * because `mode` used to be `api`. Hidden values are still carried through
 * untouched, so flipping the mode back does not lose what you typed.
 */
export function validateConfig(schema = [], config = {}) {
  const withDefaults = applyDefaults(schema, config);
  const issues = [];
  const value = { ...withDefaults };
  const shown = new Set(visibleFields(schema, withDefaults).map((f) => f.key));

  for (const field of schema) {
    if (!shown.has(field.key)) continue;
    const raw = coerce(field, withDefaults[field.key]);
    value[field.key] = raw;

    const missing = raw === undefined || raw === null || raw === '';
    if (missing) {
      if (field.required) issues.push({ key: field.key, message: 'is required' });
      continue;
    }
    const problem = checkOne(field, raw);
    if (problem) issues.push({ key: field.key, message: problem });
  }

  return { ok: issues.length === 0, value, issues };
}

/**
 * Validate and return the config, or throw.
 *
 * `setConfig` throwing on bad config is the contract, not a suggestion: it is
 * what lets the shell render an error card (with the bad config preserved on
 * it) instead of a half-broken widget.
 */
export function parseConfig(schema = [], config = {}) {
  const { ok, value, issues } = validateConfig(schema, config);
  if (!ok) {
    const detail = issues.map((i) => `${i.key} ${i.message}`).join('; ');
    throw new ConfigError(`Invalid config: ${detail}`, issues);
  }
  return value;
}

/**
 * The form model — the second consumer of the one schema array.
 *
 * Returns a plain description that the settings UI renders. Keeping it data
 * means the form can be unit-tested without a DOM, and it guarantees the form
 * and the validator can never disagree about which fields exist.
 */
export function buildFormModel(schema = [], values = {}) {
  const withDefaults = applyDefaults(schema, values);
  const { issues } = validateConfig(schema, withDefaults);
  const byKey = new Map(issues.map((i) => [i.key, i.message]));

  return visibleFields(schema, withDefaults).map((field) => ({
    key: field.key,
    type: field.type,
    label: field.label ?? field.key,
    help: field.help ?? null,
    required: Boolean(field.required),
    // A `secret` renders as a password input, and its value is never echoed
    // back into the form model — secrets belong to the backend, not the browser.
    masked: field.type === 'secret',
    value: field.type === 'secret' ? '' : (withDefaults[field.key] ?? ''),
    options: field.type === 'select' ? (field.options ?? []) : null,
    min: field.min,
    max: field.max,
    error: byKey.get(field.key) ?? null,
  }));
}
