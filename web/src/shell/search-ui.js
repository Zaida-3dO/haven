/**
 * The global search UI.
 *
 * A keyboard-first palette over `SearchIndex`. Ctrl/Cmd-K opens it, typing
 * filters, arrows move, Enter jumps, Escape closes — and it is fully operable
 * without ever touching a mouse, because that is the whole point of a palette.
 *
 * Results are GROUPED BY THE WIDGET THEY CAME FROM ("Apps", "Calendar",
 * "Alerts"). A result's origin is never ambiguous: "Dentist" under Calendar
 * and a "Dentist" bookmark under Apps are different answers to the same query
 * and the user has to be able to tell them apart at a glance.
 *
 * Accessibility follows the ARIA combobox pattern: the input is the
 * `combobox`, the list is its `listbox`, groups are `group`s with their own
 * labels, and focus STAYS IN THE INPUT while `aria-activedescendant` points at
 * the highlighted option. That is what makes arrow-keys-while-typing work for
 * a screen reader as well as it does visually.
 *
 * ── The deep-link seam ───────────────────────────────────────────────────
 * Selecting a result jumps to its widget via the `#widget-id` deep link,
 * which scrolls to it and briefly highlights it. That scroll-and-highlight
 * behaviour lives in the grid and is being built separately, so this module
 * does NOT implement it — it calls a `navigateToWidget(widgetId, entry)`
 * callback passed in at construction. The default just sets
 * `location.hash`, which is the contract the grid listens on. When the grid
 * work lands, wiring is one argument, and neither side had to guess at the
 * other's internals.
 * ─────────────────────────────────────────────────────────────────────────
 */

const OPEN_KEY = 'k';

export const SEARCH_UI_STATE = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
});

/** Was this the open-the-palette chord? Ctrl-K on Windows/Linux, Cmd-K on a Mac. */
export function isOpenShortcut(event) {
  if (!event || event.key?.toLowerCase() !== OPEN_KEY) return false;
  return Boolean(event.metaKey || event.ctrlKey);
}

/**
 * A result's default action.
 *
 * An entry with a `url` is a thing you go TO — an app, a link — and opening it
 * is plainly the more useful action than scrolling to the tile that mentions
 * it. An entry without one (a calendar event, an alert) has nowhere else to
 * go, so we jump to the widget showing it.
 */
export function defaultActionFor(entry) {
  return entry?.url ? 'open-url' : 'goto-widget';
}

export class SearchUI {
  #index;
  #documentRef;
  #root = null;
  #input = null;
  #listbox = null;
  #status = null;
  #state = SEARCH_UI_STATE.CLOSED;

  /** Flattened options, in render order — this is what the arrows walk. */
  #options = [];
  #activeIndex = -1;
  #groups = [];
  #query = '';

  #navigateToWidget;
  #openUrl;
  #onOpen;
  #onClose;
  #keydownHandler = null;
  #idPrefix;
  #limit;
  /** Where focus was before we stole it, so Escape can hand it back. */
  #previouslyFocused = null;

  constructor(
    index,
    {
      documentRef = globalThis.document,
      /**
       * The deep-link seam. The grid owns scroll-and-highlight; we only ask
       * for it. Default sets the hash, which is the documented contract.
       */
      navigateToWidget = null,
      openUrl = null,
      onOpen = null,
      onClose = null,
      idPrefix = 'haven-search',
      limit = 20,
    } = {}
  ) {
    if (!index) throw new Error('SearchUI: a SearchIndex is required');
    this.#index = index;
    this.#documentRef = documentRef;
    this.#navigateToWidget = navigateToWidget;
    this.#openUrl = openUrl;
    this.#onOpen = onOpen;
    this.#onClose = onClose;
    this.#idPrefix = idPrefix;
    this.#limit = limit;
  }

  get state() {
    return this.#state;
  }

  get isOpen() {
    return this.#state === SEARCH_UI_STATE.OPEN;
  }

  get root() {
    return this.#root;
  }

  get input() {
    return this.#input;
  }

  get query() {
    return this.#query;
  }

  /** The flattened options the arrow keys walk, in render order. */
  get options() {
    return this.#options;
  }

  get groups() {
    return this.#groups;
  }

  get activeIndex() {
    return this.#activeIndex;
  }

  get activeOption() {
    return this.#options[this.#activeIndex] ?? null;
  }

  /**
   * Build the palette into `container` and start listening for the shortcut.
   * The palette is built once and hidden, not created per open, so focus and
   * ARIA wiring stay stable.
   */
  mount(container) {
    const doc = this.#documentRef;

    const root = doc.createElement('div');
    root.className = 'haven-search';
    root.id = `${this.#idPrefix}-root`;
    root.setAttribute?.('hidden', '');
    // A dialog, so a screen reader announces it as a layer over the page.
    root.setAttribute?.('role', 'dialog');
    root.setAttribute?.('aria-modal', 'true');
    root.setAttribute?.('aria-label', 'Search the dashboard');

    const input = doc.createElement('input');
    input.className = 'haven-search__input';
    input.id = `${this.#idPrefix}-input`;
    input.setAttribute?.('type', 'text');
    input.setAttribute?.('role', 'combobox');
    input.setAttribute?.('aria-expanded', 'false');
    input.setAttribute?.('aria-controls', `${this.#idPrefix}-listbox`);
    input.setAttribute?.('aria-autocomplete', 'list');
    input.setAttribute?.('autocomplete', 'off');
    input.setAttribute?.('placeholder', 'Search apps, calendar and alerts');
    input.setAttribute?.('aria-label', 'Search the dashboard');

    const listbox = doc.createElement('div');
    listbox.className = 'haven-search__results';
    listbox.id = `${this.#idPrefix}-listbox`;
    listbox.setAttribute?.('role', 'listbox');
    listbox.setAttribute?.('aria-label', 'Search results');

    // Announced politely so a screen-reader user hears the result count
    // change as they type without it interrupting them.
    const status = doc.createElement('p');
    status.className = 'haven-search__status';
    status.setAttribute?.('role', 'status');
    status.setAttribute?.('aria-live', 'polite');

    root.appendChild(input);
    root.appendChild(status);
    root.appendChild(listbox);
    container.appendChild(root);

    this.#root = root;
    this.#input = input;
    this.#listbox = listbox;
    this.#status = status;

    input.addEventListener?.('input', (event) => {
      this.setQuery(event?.target?.value ?? input.value ?? '');
    });
    input.addEventListener?.('keydown', (event) => this.handleKeydown(event));

    // Clicking a result does the same thing Enter does.
    listbox.addEventListener?.('click', (event) => {
      const id = event?.target?.closest?.('[data-result-index]')?.dataset?.resultIndex;
      if (id === undefined) return;
      this.#activeIndex = Number(id);
      this.select();
    });

    this.#render();
    return root;
  }

  /**
   * Listen for the open shortcut globally, so search is reachable from
   * anywhere on the page without the user first focusing anything.
   */
  attachShortcut(target = this.#documentRef) {
    if (!target?.addEventListener) return null;
    this.#keydownHandler = (event) => {
      if (isOpenShortcut(event)) {
        event.preventDefault?.();
        this.open();
        return;
      }
      // Escape closes from anywhere, including when focus has wandered.
      if (event?.key === 'Escape' && this.isOpen) this.close();
    };
    target.addEventListener('keydown', this.#keydownHandler);
    return this.#keydownHandler;
  }

  open() {
    if (this.isOpen) return;
    this.#previouslyFocused = this.#documentRef?.activeElement ?? null;
    this.#state = SEARCH_UI_STATE.OPEN;
    this.#root?.removeAttribute?.('hidden');
    this.#input?.setAttribute?.('aria-expanded', 'true');
    this.setQuery('');
    // Focus the input, not the list: the user's next keystroke is a letter.
    this.#input?.focus?.();
    this.#onOpen?.(this);
  }

  close() {
    if (!this.isOpen) return;
    this.#state = SEARCH_UI_STATE.CLOSED;
    this.#root?.setAttribute?.('hidden', '');
    this.#input?.setAttribute?.('aria-expanded', 'false');
    this.#input?.removeAttribute?.('aria-activedescendant');
    this.#query = '';
    if (this.#input) this.#input.value = '';
    this.#options = [];
    this.#groups = [];
    this.#activeIndex = -1;
    // Hand focus back where it was, so Escape does not dump the user at the
    // top of the document.
    this.#previouslyFocused?.focus?.();
    this.#previouslyFocused = null;
    this.#onClose?.(this);
  }

  toggle() {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Re-query the index and redraw. Called on every keystroke. */
  setQuery(query) {
    this.#query = typeof query === 'string' ? query : '';
    if (this.#input && this.#input.value !== this.#query) this.#input.value = this.#query;

    this.#groups = this.#query.trim()
      ? this.#index.searchGrouped(this.#query, { limit: this.#limit })
      : [];
    this.#options = this.#groups.flatMap((group) =>
      group.results.map((entry) => ({ entry, group }))
    );
    // First result preselected, so Enter after typing does the obvious thing.
    this.#activeIndex = this.#options.length > 0 ? 0 : -1;
    this.#render();
    return this.#options.length;
  }

  /**
   * Refresh in place after the index changed underneath us — a widget's 30s
   * refresh should not silently leave stale results on screen.
   */
  refresh() {
    if (this.isOpen) this.setQuery(this.#query);
  }

  /** Arrows wrap, because a palette with five results should not dead-end. */
  move(delta) {
    if (this.#options.length === 0) {
      this.#activeIndex = -1;
      return null;
    }
    const count = this.#options.length;
    const from = this.#activeIndex < 0 ? (delta > 0 ? -1 : 0) : this.#activeIndex;
    this.#activeIndex = (((from + delta) % count) + count) % count;
    this.#syncActiveDescendant();
    return this.activeOption;
  }

  handleKeydown(event) {
    const key = event?.key;
    switch (key) {
      case 'ArrowDown':
        event.preventDefault?.();
        this.move(1);
        return true;
      case 'ArrowUp':
        event.preventDefault?.();
        this.move(-1);
        return true;
      case 'Home':
        if (this.#options.length === 0) return false;
        event.preventDefault?.();
        this.#activeIndex = 0;
        this.#syncActiveDescendant();
        return true;
      case 'End':
        if (this.#options.length === 0) return false;
        event.preventDefault?.();
        this.#activeIndex = this.#options.length - 1;
        this.#syncActiveDescendant();
        return true;
      case 'Enter':
        event.preventDefault?.();
        this.select();
        return true;
      case 'Escape':
        event.preventDefault?.();
        this.close();
        return true;
      default:
        return false;
    }
  }

  /**
   * Act on the highlighted result, then close.
   *
   * Returns what it did, so a caller (and a test) can tell "opened a URL" from
   * "jumped to a widget" without watching side effects.
   */
  select(index = this.#activeIndex) {
    const option = this.#options[index];
    if (!option) return null;

    const { entry } = option;
    const action = defaultActionFor(entry);

    // Close first: the palette should not still be covering the widget we
    // just scrolled to.
    this.close();

    if (action === 'open-url') {
      if (this.#openUrl) this.#openUrl(entry.url, entry);
      else globalThis.open?.(entry.url, '_blank', 'noopener');
    } else {
      this.#goToWidget(entry.widgetId, entry);
    }

    return { action, entry };
  }

  /**
   * The deep-link seam.
   *
   * The grid owns `#widget-id` scroll-and-highlight; we only ask for it. With
   * no callback injected we set `location.hash`, which is exactly the signal
   * the grid listens for — so the two halves meet at the URL and neither
   * needs the other's internals.
   */
  #goToWidget(widgetId, entry) {
    if (!widgetId) return;
    if (this.#navigateToWidget) {
      this.#navigateToWidget(widgetId, entry);
      return;
    }
    const location = globalThis.location;
    if (location) location.hash = `#${widgetId}`;
  }

  destroy() {
    if (this.#keydownHandler) {
      this.#documentRef?.removeEventListener?.('keydown', this.#keydownHandler);
      this.#keydownHandler = null;
    }
    this.#root?.remove?.();
    this.#root = null;
    this.#input = null;
    this.#listbox = null;
    this.#status = null;
    this.#options = [];
    this.#groups = [];
  }

  #optionId(index) {
    return `${this.#idPrefix}-option-${index}`;
  }

  #syncActiveDescendant() {
    if (!this.#listbox) return;
    // Focus never leaves the input; `aria-activedescendant` is what tells a
    // screen reader which option is current.
    const active = this.#optionId(this.#activeIndex);
    if (this.#activeIndex >= 0) this.#input?.setAttribute?.('aria-activedescendant', active);
    else this.#input?.removeAttribute?.('aria-activedescendant');

    for (const [i, el] of this.#optionElements.entries()) {
      const selected = i === this.#activeIndex;
      el.setAttribute?.('aria-selected', selected ? 'true' : 'false');
      el.className = selected
        ? 'haven-search__option haven-search__option--active'
        : 'haven-search__option';
    }
  }

  #optionElements = [];

  #render() {
    if (!this.#listbox) return;
    const doc = this.#documentRef;
    this.#optionElements = [];
    const nodes = [];

    if (this.#query.trim() === '') {
      // Empty state — say what is searchable rather than showing a void.
      nodes.push(this.#message(this.#emptyStateText()));
      this.#setStatus('');
    } else if (this.#options.length === 0) {
      nodes.push(this.#message(`No matches for “${this.#query.trim()}”. Try a different word.`));
      this.#setStatus('No results');
    } else {
      let optionIndex = 0;
      for (const group of this.#groups) {
        const section = doc.createElement('div');
        section.className = 'haven-search__group';
        section.setAttribute?.('role', 'group');

        const heading = doc.createElement('p');
        heading.className = 'haven-search__group-label';
        heading.id = `${this.#idPrefix}-group-${group.widgetId}`;
        // The label IS the answer to "where did this come from?".
        heading.textContent = group.label;
        section.setAttribute?.('aria-labelledby', heading.id);
        section.appendChild(heading);

        for (const entry of group.results) {
          const option = doc.createElement('div');
          option.className = 'haven-search__option';
          option.id = this.#optionId(optionIndex);
          option.setAttribute?.('role', 'option');
          option.setAttribute?.(
            'aria-selected',
            optionIndex === this.#activeIndex ? 'true' : 'false'
          );
          option.dataset.resultIndex = String(optionIndex);
          option.dataset.widgetId = entry.widgetId;

          const title = doc.createElement('span');
          title.className = 'haven-search__option-title';
          // textContent, never innerHTML — these are calendar titles and
          // alert bodies, i.e. text we did not author.
          title.textContent = entry.title;
          option.appendChild(title);

          if (entry.subtitle) {
            const subtitle = doc.createElement('span');
            subtitle.className = 'haven-search__option-subtitle';
            subtitle.textContent = entry.subtitle;
            option.appendChild(subtitle);
          }

          // Say where Enter will actually land, like the app tiles do.
          const hint = doc.createElement('span');
          hint.className = 'haven-search__option-hint';
          hint.textContent = entry.url ? entry.url : `Go to ${group.label}`;
          option.appendChild(hint);

          section.appendChild(option);
          this.#optionElements.push(option);
          optionIndex += 1;
        }

        nodes.push(section);
      }
      const count = this.#options.length;
      const groupCount = this.#groups.length;
      this.#setStatus(
        `${count} result${count === 1 ? '' : 's'} in ${groupCount} ` +
          `${groupCount === 1 ? 'section' : 'sections'}`
      );
    }

    this.#listbox.replaceChildren?.(...nodes);
    this.#syncActiveDescendant();
  }

  #emptyStateText() {
    const sources = this.#index.sources?.() ?? [];
    if (sources.length === 0) {
      return 'Nothing to search yet — add a widget and its contents show up here.';
    }
    const labels = [...new Set(sources.map((s) => s.label))];
    return `Start typing to search ${formatList(labels)}.`;
  }

  #message(text) {
    const el = this.#documentRef.createElement('p');
    el.className = 'haven-search__message';
    el.textContent = text;
    return el;
  }

  #setStatus(text) {
    if (this.#status) this.#status.textContent = text;
  }
}

function formatList(items) {
  if (items.length === 0) return 'the dashboard';
  if (items.length === 1) return items[0];
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
