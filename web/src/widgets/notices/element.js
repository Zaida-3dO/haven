/**
 * The notices widget's custom element.
 *
 * It renders whatever matches the DESIGN §6.6 envelope, from any source, and
 * it FETCHES NOTHING ON A SCHEDULE. The list arrives through `onData()` from
 * the host, which owns the poll, and there is no `setInterval` in this file.
 *
 * ## The one place it does call the network, and why that is not a violation
 *
 * Dismissing a notice and pressing an action button both POST. That is a USER
 * GESTURE, not a poll: it happens because someone clicked, it has no timer
 * behind it, and it cannot run in a hidden tab. The rule the contract states
 * is that a widget must not schedule its own refresh — and this widget does
 * not; it asks the host to refresh after the write instead.
 *
 * Both calls go to `/api/widgets/notices/...` and carry only an opaque id.
 * **An action never calls a service directly.** What a button actually does —
 * which Home Assistant service, on which host, with which long-lived token —
 * is resolved in the backend, so none of it is in front-end JSON and none of
 * it is guessable from the DOM (docs/SECURITY.md).
 *
 * ## Presentation rules worth not breaking
 *
 *  - **Severity is never carried by colour alone.** Every notice shows an icon
 *    and a word as well, so the tile survives greyscale, a colour vision
 *    deficiency and a screen reader.
 *  - **`due` drives ordering**, soonest first, undated last.
 *  - **Empty is good news.** "Nothing needs you" is a calm state, not an error
 *    box — the widget is doing its job precisely when it has nothing to say.
 */

import { absoluteDue, isOverdue, presentation, relativeDue, visibleNotices } from './format.js';
import { NOTICES_ENDPOINT } from './definition.js';

const STYLES = `
  :host { display: block; height: 100%; font: inherit; container-type: inline-size; }
  .notices { display: flex; flex-direction: column; gap: 0.5rem; height: 100%; overflow: auto; }

  .notice {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: 0.5rem;
    align-items: start;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    /* Colour is a REINFORCEMENT here. The badge below carries the same
       information as an icon and a word, so nothing depends on seeing it. */
    border-left: 3px solid var(--severity-colour, rgba(127,127,127,0.5));
    background: rgba(127,127,127,0.08);
  }
  .notice--info   { --severity-colour: #4a90d9; }
  .notice--warn   { --severity-colour: #d99a4a; }
  .notice--urgent { --severity-colour: #d95a4a; }

  /* The non-colour carrier: a glyph plus a word, always present. */
  .badge {
    display: inline-flex; align-items: center; gap: 0.25rem;
    font-size: 0.7rem; font-weight: 700; line-height: 1.4;
    padding: 0.05rem 0.35rem; border-radius: 4px;
    border: 1px solid var(--severity-colour);
    color: var(--severity-colour);
    white-space: nowrap;
  }
  .badge__icon { font-family: monospace; }

  .notice__main { min-width: 0; display: flex; flex-direction: column; gap: 0.15rem; }
  .notice__title { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
  .notice__body { font-size: 0.85rem; opacity: 0.8; overflow-wrap: anywhere; }
  .notice__meta { font-size: 0.75rem; opacity: 0.7; display: flex; gap: 0.4rem; flex-wrap: wrap; }
  .notice__due--overdue { color: #d95a4a; font-weight: 600; }
  .notice__link { color: inherit; }

  .notice__actions { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.25rem; }
  button {
    font: inherit; font-size: 0.8rem; cursor: pointer;
    padding: 0.15rem 0.5rem; border-radius: 4px;
    border: 1px solid rgba(127,127,127,0.45); background: transparent; color: inherit;
  }
  button:hover:not(:disabled) { background: rgba(127,127,127,0.15); }
  button:disabled { opacity: 0.5; cursor: progress; }

  .notice__dismiss {
    border: none; background: transparent; opacity: 0.5;
    font-size: 1rem; line-height: 1; padding: 0.1rem 0.3rem;
  }
  .notice__dismiss:hover:not(:disabled) { opacity: 1; background: rgba(127,127,127,0.15); }

  /* Good news, not an error: calm, centred, no icon of alarm. */
  .empty {
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.25rem; height: 100%; text-align: center;
  }
  .empty__title { font-weight: 600; }
  .empty__body { font-size: 0.85rem; opacity: 0.7; }

  .hint { display: flex; flex-direction: column; gap: 0.35rem; }
  .hint__title { font-weight: 600; }
  .hint__body { font-size: 0.85rem; opacity: 0.75; }
  code { font-size: 0.8em; padding: 0.1em 0.3em; border-radius: 3px; background: rgba(127,127,127,0.18); }

  /* A soft notice is a quiet marker on real data, not an error box. */
  .notice-bar { font-size: 0.75rem; opacity: 0.7; }
  .failure { font-size: 0.8rem; color: #d95a4a; }

  /* At the mobile breakpoint the tile is narrow: the badge word goes, the
     glyph and the colour stay, so severity still has two carriers. */
  @container (max-width: 260px) {
    .badge__label { display: none; }
    .notice { grid-template-columns: auto 1fr; }
    .notice__dismiss { grid-column: 2; justify-self: end; }
  }
`;

const ElementBase = globalThis.HTMLElement ?? class {};

export class HavenNoticesWidget extends ElementBase {
  #config = {};
  #origConfig = null;
  #payload = null;
  #root;
  /** Ids being written right now, so a double click cannot double-post. */
  #pending = new Set();
  /** Ids dismissed locally, hidden before the next poll confirms it. */
  #dismissed = new Set();
  #failure = null;

  /**
   * Test seams.
   *
   * Set as properties rather than taken as constructor arguments: the browser
   * constructs a custom element with NO arguments, so a required-options
   * constructor would work in tests and throw in the only place that matters.
   */
  #fetch = null;
  #onChange = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  /** Swap the transport. The default is the global `fetch`. */
  set fetchImpl(impl) {
    this.#fetch = impl;
  }

  /**
   * Called after a successful write, so the shell can refetch rather than the
   * widget waiting out the poll interval. The widget still schedules nothing
   * itself — it only says "something changed".
   */
  set onChange(handler) {
    this.#onChange = handler;
  }

  /**
   * Validate eagerly and THROW on bad config — the contract, not a suggestion.
   *
   * The host has already validated against `configSchema`, so this checks only
   * what the schema cannot express: that `maxItems` is a usable count. A widget
   * told to show zero notices is a widget that renders nothing and looks broken.
   */
  setConfig(config = {}) {
    this.#origConfig = config;

    if (config.maxItems !== undefined) {
      const max = Number(config.maxItems);
      if (!Number.isFinite(max) || max < 1) {
        throw new Error('notices: maxItems must be a positive number');
      }
    }

    this.#config = config;
    return this.#config;
  }

  get origConfig() {
    return this.#origConfig;
  }

  get config() {
    return this.#config;
  }

  onData(payload) {
    this.#payload = payload;

    // A notice the server no longer sends has been dealt with; drop it from
    // the local set so it cannot linger and hide a genuinely new notice that
    // happens to reuse the id.
    const live = new Set((payload?.value?.notices ?? []).map((n) => n.id));
    for (const id of [...this.#dismissed]) if (!live.has(id)) this.#dismissed.delete(id);

    this.render();
  }

  onResize() {
    // Layout responds through a CSS container query rather than JS, so there
    // is nothing to recompute here. Declared because the contract lists it.
  }

  render() {
    const style = document.createElement('style');
    style.textContent = STYLES;
    // One replaceChildren, never innerHTML: a notice title is arbitrary text
    // from a source and must never be parsed as markup.
    this.#root.replaceChildren(style, this.#content());
  }

  #content() {
    const value = this.#payload?.value;

    if (!value) return el('div', { className: 'hint' }, [text('span', 'Loading notices…')]);

    if (value.status === 'not_configured') return this.#renderHint(value);

    const wrap = el('div', { className: 'notices' });

    const notices = visibleNotices(
      (value.notices ?? []).filter((n) => !this.#dismissed.has(n.id)),
      { minSeverity: this.#config.minSeverity, maxItems: this.#config.maxItems }
    );

    if (notices.length === 0) {
      wrap.appendChild(this.#renderEmpty(value));
    } else {
      for (const notice of notices) wrap.appendChild(this.#renderNotice(notice));
    }

    // A soft notice is not a hard error: the list still draws, with a marker.
    const soft = value.notice ?? this.#payload?.notices?.[0]?.message;
    if (soft) wrap.appendChild(text('div', soft, { className: 'notice-bar' }));

    // A failed write is the user's own action not working, so it is said out
    // loud rather than logged — but it does not replace the list.
    if (this.#failure) wrap.appendChild(text('div', this.#failure, { className: 'failure' }));

    return wrap;
  }

  /**
   * The empty state.
   *
   * This must read as GOOD NEWS. An empty notices tile means nothing needs
   * attention, which is the outcome the widget exists to report — rendering it
   * like a failure would train the user to distrust a working dashboard.
   */
  #renderEmpty(value) {
    const wrap = el('div', { className: 'empty' });
    wrap.appendChild(text('span', 'Nothing needs you', { className: 'empty__title' }));

    // When a filter is hiding things, say so — otherwise "nothing needs you"
    // is a lie the user configured and then forgot about.
    const total = (value.notices ?? []).length;
    const body =
      total > 0
        ? `${total} ${total === 1 ? 'notice is' : 'notices are'} hidden by this widget's filter.`
        : 'You are all caught up.';

    wrap.appendChild(text('span', body, { className: 'empty__body' }));
    return wrap;
  }

  /** The "not configured" tile — a first-run instruction, not a failure. */
  #renderHint(value) {
    const wrap = el('div', { className: 'hint' });
    wrap.appendChild(text('span', 'Notices are not configured', { className: 'hint__title' }));

    const body = el('span', { className: 'hint__body' });
    // The hint comes from the server and names an environment variable; it is
    // inserted as text, never as markup.
    body.textContent = value.hint ?? 'Configure a notice source to enable this widget.';
    wrap.appendChild(body);

    return wrap;
  }

  #renderNotice(notice) {
    const look = presentation(notice.severity);
    const row = el('div', { className: `notice notice--${look.label.toLowerCase()}` });
    row.dataset.noticeId = notice.id;

    // ── The severity badge: glyph + word, so colour is never load-bearing ──
    const badge = el('span', { className: 'badge' });
    badge.appendChild(text('span', look.icon, { className: 'badge__icon' }));
    badge.appendChild(text('span', look.label, { className: 'badge__label' }));
    // The word is hidden by a container query on a narrow tile, so the
    // accessible name has to live on the badge itself.
    badge.setAttribute('aria-label', `${look.label} notice`);
    badge.setAttribute('title', `${look.label} notice`);
    row.appendChild(badge);

    const main = el('div', { className: 'notice__main' });

    if (notice.url) {
      // The envelope guarantees this is an absolute http(s) URL — the ingest
      // validator rejects `javascript:` before it can ever be stored.
      const link = el('a', { className: 'notice__title notice__link' });
      link.textContent = notice.title;
      link.setAttribute('href', notice.url);
      link.setAttribute('rel', 'noopener noreferrer');
      link.setAttribute('target', '_blank');
      main.appendChild(link);
    } else {
      main.appendChild(text('span', notice.title, { className: 'notice__title' }));
    }

    if (notice.body) main.appendChild(text('span', notice.body, { className: 'notice__body' }));

    const meta = el('div', { className: 'notice__meta' });

    const relative = relativeDue(notice.due);
    if (relative) {
      const overdue = isOverdue(notice.due);
      const due = text('span', overdue ? `${relative} — overdue` : relative, {
        className: overdue ? 'notice__due notice__due--overdue' : 'notice__due',
      });
      // Relative at a glance, absolute when you are actually planning.
      const absolute = absoluteDue(notice.due);
      if (absolute) due.setAttribute('title', absolute);
      meta.appendChild(due);
    }

    if (this.#config.showSource && notice.source) {
      meta.appendChild(text('span', notice.source, { className: 'notice__source' }));
    }

    if (meta.children.length > 0) main.appendChild(meta);

    if (notice.actions?.length) main.appendChild(this.#renderActions(notice));

    row.appendChild(main);
    row.appendChild(this.#renderDismiss(notice));

    return row;
  }

  /**
   * Action buttons.
   *
   * Each carries only the action's opaque id. Pressing one POSTs to the
   * backend, which is the only thing that knows what the action means.
   */
  #renderActions(notice) {
    const wrap = el('div', { className: 'notice__actions' });

    for (const action of notice.actions) {
      const button = el('button', { className: 'notice__action' });
      button.textContent = action.label;
      button.dataset.actionId = action.id;
      button.disabled = this.#pending.has(notice.id);
      button.addEventListener('click', () => this.#performAction(notice, action));
      wrap.appendChild(button);
    }

    return wrap;
  }

  #renderDismiss(notice) {
    const button = el('button', { className: 'notice__dismiss' });
    button.textContent = '×';
    button.setAttribute('aria-label', `Dismiss: ${notice.title}`);
    button.setAttribute('title', 'Dismiss');
    button.disabled = this.#pending.has(notice.id);
    button.addEventListener('click', () => this.#dismiss(notice));
    return button;
  }

  /**
   * Dismiss, optimistically.
   *
   * The tile updates immediately and the write goes out behind it: waiting for
   * a round trip before a notice disappears makes the dashboard feel broken.
   * If the write fails the notice comes back and the failure is stated, which
   * is the only honest way to be optimistic.
   */
  async #dismiss(notice) {
    if (this.#pending.has(notice.id)) return;

    this.#pending.add(notice.id);
    this.#dismissed.add(notice.id);
    this.#failure = null;
    this.render();

    try {
      await this.#post(`${NOTICES_ENDPOINT}/${encodeURIComponent(notice.id)}/dismiss`);
      this.#onChange?.();
    } catch (error) {
      this.#dismissed.delete(notice.id);
      this.#failure = `Could not dismiss "${notice.title}". ${describeFailure(error)}`;
    } finally {
      this.#pending.delete(notice.id);
      this.render();
    }
  }

  /**
   * Perform an action.
   *
   * NOT optimistic, unlike dismissal: an action has a real effect somewhere
   * else, and showing it as done before the backend confirms would be a lie
   * about the state of the house. The button disables while it is in flight.
   */
  async #performAction(notice, action) {
    if (this.#pending.has(notice.id)) return;

    this.#pending.add(notice.id);
    this.#failure = null;
    this.render();

    try {
      const result = await this.#post(
        `${NOTICES_ENDPOINT}/${encodeURIComponent(notice.id)}/actions/${encodeURIComponent(action.id)}`
      );
      if (result?.dismissed) this.#dismissed.add(notice.id);
      this.#onChange?.();
    } catch (error) {
      this.#failure = `"${action.label}" did not work. ${describeFailure(error)}`;
    } finally {
      this.#pending.delete(notice.id);
      this.render();
    }
  }

  async #post(url) {
    const send = this.#fetch ?? ((...args) => globalThis.fetch(...args));

    const response = await send(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const error = new Error(body.message ?? `Request failed (${response.status})`);
      error.status = response.status;
      throw error;
    }

    return response.json().catch(() => ({}));
  }

  /**
   * Documents for the global search index.
   *
   * The index is IN-MEMORY ONLY and rebuilt each session — notice contents are
   * the most personal data on the dashboard, so they are never written to
   * localStorage or the database. `shell/search-index.js` has a tripwire test
   * enforcing that; nothing here persists anything.
   *
   * The host stamps `widgetId`, so this does not guess at one.
   */
  getSearchEntries() {
    const notices = (this.#payload?.value?.notices ?? []).filter((n) => !this.#dismissed.has(n.id));

    return notices.map((notice) => {
      const relative = relativeDue(notice.due);
      const look = presentation(notice.severity);

      return {
        id: `notice:${notice.id}`,
        title: notice.title,
        // Whatever is most useful to disambiguate two similar titles.
        subtitle: notice.body ?? relative ?? look.label,
        url: this.id ? `#${this.id}` : '',
        keywords: ['notice', notice.severity, notice.source, relative].filter(Boolean),
      };
    });
  }

  destroy() {
    // No timer to clear — the widget never had one. Clearing the sets stops a
    // late in-flight write from touching a torn-down element's state.
    this.#pending.clear();
    this.#dismissed.clear();
    this.#payload = null;
    this.#root.replaceChildren();
  }
}

/** A failed write, in words a person can act on. */
function describeFailure(error) {
  if (error?.status === 404) return 'It may already have been dealt with.';
  if (error?.status === 503) return 'The source is not configured.';
  if (error?.status === 502) return 'The service did not respond.';
  return 'Try again in a moment.';
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const child of children) node.appendChild(child);
  return node;
}

function text(tag, content, props = {}) {
  const node = el(tag, props);
  node.textContent = content;
  return node;
}
