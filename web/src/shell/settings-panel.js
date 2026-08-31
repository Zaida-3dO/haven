/**
 * The settings panel — the second consumer of `configSchema`.
 *
 * `schema.js` already turns one flat descriptor array into BOTH a validator
 * (`validateConfig`/`parseConfig`) and a form description (`buildFormModel`).
 * Until now nothing rendered the second half, so every widget option was
 * reachable only by editing the database. This module is that renderer, and it
 * is deliberately the *only* settings UI in the codebase: no widget writes its
 * own, because two sources of truth drift immediately.
 *
 * Four rules shape everything below.
 *
 * **1. There is exactly one validator, and it is not in this file.** Errors
 * come from `buildFormModel`, which calls `validateConfig` internally. Nothing
 * here decides whether a URL is a URL or a number is in range. A second
 * implementation would disagree with the first within a week, and the widget
 * contract exists to prevent precisely that.
 *
 * **2. A secret never round-trips to the browser.** `buildFormModel` returns
 * `value: ''` for a `secret` field, and this panel never fills one in from the
 * stored config. It shows whether a value is *set* and offers to replace it.
 * On submit, a secret whose input is untouched is OMITTED from the patch
 * entirely rather than being sent as `''` — sending the empty string would
 * quietly wipe a stored credential every time the user changed an unrelated
 * option. Getting this wrong on a public dashboard puts credentials in the DOM.
 *
 * **3. A hidden field keeps its value.** `validateConfig` already carries
 * hidden values through untouched and does not validate them. The form must
 * not undo that, so the submitted patch is layered OVER the current config
 * rather than replacing it: a field that is not currently rendered is not
 * mentioned in the patch and therefore survives.
 *
 * **4. Saving goes through the existing config path.** `host.setConfig()` runs
 * `migrateConfig` and then `parseConfig`. Writing straight to a widget would
 * skip the migration hook, which is the one thing that cannot be retrofitted.
 */

import { buildFormModel, validateConfig } from './schema.js';

/** What a `secret` input's placeholder says, by whether one is already stored. */
export const SECRET_SET_HINT = 'A value is saved. Type a new one to replace it.';
export const SECRET_UNSET_HINT = 'No value saved.';

/**
 * Is a secret currently stored for this key?
 *
 * Deliberately a presence test on the *config the caller holds*, never a read
 * of the value into the form. The panel is told "set" or "not set" and that is
 * all it ever learns about a credential.
 */
function secretIsSet(config, key) {
  const value = config?.[key];
  return typeof value === 'string' ? value !== '' : value !== undefined && value !== null;
}

/**
 * Fold the values the user typed into a config patch.
 *
 * Exported because it is the load-bearing half of the panel and deserves to be
 * testable without a DOM. `entries` is `[{ key, type, raw }]` — one per
 * *rendered* field, which is what makes rule 3 fall out for free: a hidden
 * field is not rendered, so it is not in `entries`, so it is not in the patch,
 * so `{ ...current, ...patch }` keeps it.
 *
 * Deliberately takes only the entries, never the current config: a function
 * that cannot see the stored value cannot accidentally echo a secret back
 * into what it returns.
 *
 * @param {Array<{key: string, type: string, raw: any}>} entries
 * @returns {object} the patch — only the keys the user may change
 */
export function collectPatch(entries = []) {
  const patch = {};
  for (const entry of entries) {
    if (!entry || typeof entry.key !== 'string') continue;

    if (entry.type === 'secret') {
      // Untouched (or cleared) secret: say nothing about it. `{...current,
      // ...patch}` then leaves the stored credential exactly where it was.
      // Sending '' here is the bug this whole branch exists to prevent.
      const typed = typeof entry.raw === 'string' ? entry.raw : '';
      if (typed === '') continue;
      patch[entry.key] = typed;
      continue;
    }

    patch[entry.key] = entry.raw;
  }
  return patch;
}

/**
 * Merge a patch over a config and validate the result.
 *
 * Returns what `validateConfig` returns, so the caller gets `issues` keyed by
 * field and can render each against its own input. No second validator.
 */
export function applyPatch(schema = [], current = {}, entries = []) {
  const merged = { ...current, ...collectPatch(entries) };
  return { merged, ...validateConfig(schema, merged) };
}

/**
 * Creates the settings panel.
 *
 * The panel is built once and shown/hidden, not created per open, so its ARIA
 * wiring and its place in the tab order stay stable — the same reasoning as
 * the search palette.
 *
 * @param {object} deps
 * @param {(id: string) => object|null} deps.resolve  widget id -> { definition, config, title }
 * @param {(id: string, config: object) => any} deps.onSave  persist; may be async
 * @param {(err: Error) => void} [deps.onError]
 * @param {Document} [deps.document]
 */
export function createSettingsPanel({
  resolve,
  onSave = () => {},
  onError = () => {},
  document: doc = globalThis.document,
  idPrefix = 'haven-settings',
} = {}) {
  if (typeof resolve !== 'function') {
    throw new Error('createSettingsPanel: a resolve(widgetId) function is required');
  }

  let openId = null;
  let schema = [];
  let config = {};
  /** The rendered inputs, in schema order — the source for `collectPatch`. */
  let inputs = [];
  /** Where focus was before the panel took it, so close can hand it back. */
  let previouslyFocused = null;
  let issuesByKey = new Map();

  const el = doc.createElement('aside');
  el.className = 'haven-settings';
  el.hidden = true;
  // A modal dialog: focus is trapped inside it while it is open, so it must
  // announce itself as one rather than as an anonymous region.
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.setAttribute('aria-labelledby', `${idPrefix}-heading`);

  const heading = doc.createElement('h2');
  heading.className = 'haven-settings__heading';
  heading.id = `${idPrefix}-heading`;
  heading.textContent = 'Settings';

  const form = doc.createElement('form');
  form.className = 'haven-settings__form';

  const fields = doc.createElement('div');
  fields.className = 'haven-settings__fields';

  /**
   * The error summary. `role="alert"` rather than `status`: a failed save is
   * an interruption worth hearing immediately, and it is the only way a
   * screen-reader user learns the form did not close because it was rejected.
   */
  const summary = doc.createElement('p');
  summary.className = 'haven-settings__summary';
  summary.id = `${idPrefix}-summary`;
  summary.setAttribute('role', 'alert');
  summary.hidden = true;

  const actions = doc.createElement('div');
  actions.className = 'haven-settings__actions';

  const saveButton = doc.createElement('button');
  saveButton.type = 'submit';
  saveButton.className = 'haven-settings__save';
  saveButton.textContent = 'Save';

  const cancelButton = doc.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'haven-settings__cancel';
  cancelButton.textContent = 'Cancel';

  actions.append(saveButton, cancelButton);
  form.append(fields, summary, actions);
  el.append(heading, form);

  cancelButton.addEventListener?.('click', () => close());
  form.addEventListener?.('submit', (event) => {
    event?.preventDefault?.();
    void submit();
  });

  /**
   * Focus containment.
   *
   * Tab from the last control wraps to the first and Shift+Tab wraps back, so
   * a keyboard user cannot tab out into the dimmed dashboard behind an open
   * modal and lose track of where they are. Escape closes.
   */
  el.addEventListener?.('keydown', (event) => {
    if (event?.key === 'Escape') {
      event.preventDefault?.();
      close();
      return;
    }
    if (event?.key !== 'Tab') return;

    const stops = focusables();
    if (stops.length === 0) return;

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = doc.activeElement;

    if (event.shiftKey && active === first) {
      event.preventDefault?.();
      last.focus?.();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault?.();
      first.focus?.();
    }
  });

  /** Every control the user can tab to, in DOM order. */
  function focusables() {
    return [...inputs.map((i) => i.el), saveButton, cancelButton].filter(
      (node) => node && !node.disabled && !node.hidden
    );
  }

  /**
   * Build one field: label, control, help text and its error slot.
   *
   * The label carries a real `for` pointing at the input's `id`, which is what
   * makes clicking the label focus the control and what makes a screen reader
   * announce the two together. `aria-describedby` ties the help and the error
   * to the same input, so the error is read out as part of the field rather
   * than as a stray paragraph somewhere below it.
   */
  function buildField(model) {
    const inputId = `${idPrefix}-${model.key}`;
    const helpId = `${inputId}-help`;
    const errorId = `${inputId}-error`;

    const wrap = doc.createElement('div');
    wrap.className = 'haven-settings__field';
    wrap.dataset.fieldKey = model.key;

    const label = doc.createElement('label');
    label.className = 'haven-settings__label';
    label.setAttribute('for', inputId);
    label.textContent = model.label;

    const control =
      model.type === 'select' ? doc.createElement('select') : doc.createElement('input');
    control.id = inputId;
    control.className = 'haven-settings__input';
    control.dataset.fieldKey = model.key;
    control.dataset.fieldType = model.type;

    if (model.type === 'select') {
      for (const option of model.options ?? []) {
        const value = option && typeof option === 'object' ? option.value : option;
        const text = option && typeof option === 'object' ? (option.label ?? value) : option;
        const opt = doc.createElement('option');
        opt.value = value;
        opt.textContent = String(text);
        if (value === model.value) opt.selected = true;
        control.appendChild(opt);
      }
      control.value = model.value ?? '';
    } else {
      // `secret` renders as a password input, and — the point of the whole
      // rule — is NEVER given a value. `buildFormModel` hands back '' for it;
      // this must not "helpfully" fill it in from the config.
      control.setAttribute('type', inputTypeFor(model.type));
      control.value = model.type === 'secret' ? '' : stringify(model.value);
      if (model.type === 'number') {
        if (model.min !== undefined) control.setAttribute('min', String(model.min));
        if (model.max !== undefined) control.setAttribute('max', String(model.max));
      }
    }

    if (model.required) control.setAttribute('aria-required', 'true');

    const describedBy = [];

    // Help text. A secret's help ALWAYS says whether one is stored, because
    // an empty password box otherwise reads as "nothing is configured".
    const helpText =
      model.type === 'secret'
        ? [secretIsSet(config, model.key) ? SECRET_SET_HINT : SECRET_UNSET_HINT, model.help]
            .filter(Boolean)
            .join(' ')
        : model.help;

    let help = null;
    if (helpText) {
      help = doc.createElement('p');
      help.className = 'haven-settings__help';
      help.id = helpId;
      help.textContent = helpText;
      describedBy.push(helpId);
    }

    const error = doc.createElement('p');
    error.className = 'haven-settings__error';
    error.id = errorId;
    error.hidden = true;
    describedBy.push(errorId);

    control.setAttribute('aria-describedby', describedBy.join(' '));

    wrap.appendChild(label);
    wrap.appendChild(control);
    if (help) wrap.appendChild(help);
    wrap.appendChild(error);

    return { wrap, control, error, model };
  }

  function inputTypeFor(type) {
    if (type === 'secret') return 'password';
    if (type === 'number') return 'number';
    if (type === 'url') return 'url';
    return 'text';
  }

  function stringify(value) {
    return value === undefined || value === null ? '' : String(value);
  }

  /**
   * Re-render the fields from the current config.
   *
   * Called on open and whenever a change flips a `visible` condition, because
   * conditional visibility is evaluated by `buildFormModel` against the values
   * — so a mode switch has to rebuild to show the fields it reveals.
   */
  function render() {
    const values = { ...config, ...collectPatch(entries()) };
    const models = buildFormModel(schema, values);

    inputs = [];
    const children = [];

    for (const model of models) {
      const field = buildField(model);
      inputs.push({ key: model.key, type: model.type, el: field.control, error: field.error });

      // A change can reveal or hide other fields, so re-render on change.
      // `input` rather than `change` so typing into a text box that gates
      // another field updates as the user types.
      field.control.addEventListener?.('input', onFieldChange);
      field.control.addEventListener?.('change', onFieldChange);

      children.push(field.wrap);
    }

    fields.replaceChildren(...children);
    paintErrors();
  }

  /** The rendered inputs as `collectPatch` entries. */
  function entries() {
    return inputs.map((input) => ({
      key: input.key,
      type: input.type,
      raw: input.el.value,
    }));
  }

  function onFieldChange() {
    const before = inputs.map((i) => i.key).join('|');
    // Rebuilding on every keystroke would steal focus, so only rebuild when
    // the SET of visible fields actually changed.
    const values = { ...config, ...collectPatch(entries()) };
    const after = buildFormModel(schema, values)
      .map((m) => m.key)
      .join('|');
    if (before !== after) render();
  }

  /** Show each issue against its own field, and summarise for the alert. */
  function paintErrors() {
    for (const input of inputs) {
      const message = issuesByKey.get(input.key) ?? null;
      if (message) {
        input.error.textContent = message;
        input.error.hidden = false;
        input.el.setAttribute?.('aria-invalid', 'true');
      } else {
        input.error.textContent = '';
        input.error.hidden = true;
        input.el.removeAttribute?.('aria-invalid');
      }
    }

    if (issuesByKey.size === 0) {
      summary.textContent = '';
      summary.hidden = true;
    } else {
      const count = issuesByKey.size;
      summary.textContent = `${count} ${count === 1 ? 'field needs' : 'fields need'} attention.`;
      summary.hidden = false;
    }
  }

  /**
   * Validate and persist.
   *
   * Validation is `validateConfig` — the same function `parseConfig` and the
   * host use. On failure the panel STAYS OPEN with the errors against their
   * fields, because closing would look like a successful save.
   */
  async function submit() {
    if (!openId) return null;

    const { merged, ok, value, issues } = applyPatch(schema, config, entries());
    issuesByKey = new Map(issues.map((i) => [i.key, i.message]));

    if (!ok) {
      paintErrors();
      // Send focus to the first field that failed, so a keyboard user is put
      // where the problem is rather than left to hunt for it.
      inputs.find((i) => issuesByKey.has(i.key))?.el?.focus?.();
      return null;
    }

    paintErrors();

    try {
      // `merged`, not `value`: `validateConfig` returns a coerced copy that is
      // useful for checking, but persisting must keep whatever the migration
      // hook and the widget's own version stamp put there. The save path
      // re-validates anyway, so this cannot store something invalid.
      await onSave(openId, { ...merged, ...value });
      close();
      return merged;
    } catch (error) {
      // Staying open on failure is deliberate — the same reasoning as edit
      // mode's save: dropping out would look like it worked.
      summary.textContent = error instanceof Error ? error.message : String(error);
      summary.hidden = false;
      onError(error);
      return null;
    }
  }

  /**
   * Open the panel on a widget.
   *
   * Resolving through the caller keeps this module free of any dependency on
   * the dashboard, which is what lets it be tested against a fake resolve.
   */
  function open(widgetId) {
    const target = resolve(widgetId);
    if (!target) return null;

    previouslyFocused = doc.activeElement ?? null;

    openId = widgetId;
    schema = target.definition?.configSchema ?? [];
    // A widget in the error state has no valid config, but the host preserved
    // the bad one (`origConfig`) precisely so the form can open on it and fix
    // it rather than the user having to delete the widget.
    config = target.config ?? {};
    issuesByKey = new Map();

    heading.textContent = `${target.title ?? target.definition?.name ?? 'Widget'} settings`;
    render();

    el.hidden = false;
    // First control, not the Save button: the user came here to change a value.
    focusables()[0]?.focus?.();
    return openId;
  }

  function close() {
    if (!openId) return;
    openId = null;
    inputs = [];
    issuesByKey = new Map();
    fields.replaceChildren();
    summary.textContent = '';
    summary.hidden = true;
    el.hidden = true;
    // Hand focus back to the gear that opened us, rather than dumping the
    // user at the top of the document.
    previouslyFocused?.focus?.();
    previouslyFocused = null;
  }

  return {
    el,
    open,
    close,
    submit,

    get isOpen() {
      return openId !== null;
    },

    get widgetId() {
      return openId;
    },

    /** The rendered field keys, in order. Exposed for tests and debugging. */
    get fieldKeys() {
      return inputs.map((i) => i.key);
    },

    /** The input for a key, or null when that field is not currently shown. */
    field(key) {
      return inputs.find((i) => i.key === key)?.el ?? null;
    },

    /** The error element for a key, or null. */
    errorFor(key) {
      return inputs.find((i) => i.key === key)?.error ?? null;
    },
  };
}

/**
 * Wires a settings panel to a dashboard.
 *
 * Kept here rather than in `boot.js` so the resolve/save pair — the part that
 * decides HOW a config is persisted — sits next to the panel that depends on
 * it.
 *
 * `onSave` goes through `host.setConfig()`, which runs `migrateConfig` and
 * then `parseConfig`. That is the whole reason it does not write to the widget
 * element directly: bypassing it would skip the migration hook.
 */
export function connectSettings({
  dashboard,
  registry,
  document: doc = globalThis.document,
  onSaved = () => {},
  onError = () => {},
} = {}) {
  if (!dashboard) throw new Error('connectSettings: a dashboard is required');

  const panel = createSettingsPanel({
    document: doc,
    onError,

    resolve(widgetId) {
      const host = dashboard.host(widgetId);
      if (!host) return null;
      const definition = registry?.get?.(host.type) ?? null;
      if (!definition) return null;
      return {
        definition,
        // The preserved bad config when the widget failed to configure, so a
        // broken widget can be OPENED AND FIXED rather than only deleted.
        config: host.config ?? host.origConfig ?? {},
        title: definition.name ?? host.type,
      };
    },

    onSave(widgetId, config) {
      const host = dashboard.host(widgetId);
      if (!host) throw new Error(`No widget "${widgetId}" to save.`);

      // The existing config path: migrate, then validate, then hand to the
      // widget. `setConfig` swallows a throw into an error tile, so the
      // failure has to be read back off the host state.
      const state = host.setConfig(config);
      if (host.error) throw host.error;

      onSaved(widgetId, config, state);
      return state;
    },
  });

  return panel;
}
