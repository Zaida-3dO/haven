/**
 * The global search index.
 *
 * Search spans everything on the page, not just apps. Widgets implement
 * `getSearchEntries()` and the shell PUSHES their entries in here on data
 * change; the index never reaches back into a widget to pull. That keeps the
 * same "the host drives, the widget renders" split the rest of the shell has,
 * and it means a widget that throws contributes nothing rather than breaking
 * search (`WidgetHost.getSearchEntries` already catches for us).
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PRIVACY — THE POINT OF THIS MODULE, NOT A FOOTNOTE
 *
 * This index holds calendar event titles and alert contents: the most
 * personal data on the dashboard. It is therefore IN-MEMORY ONLY. It is
 * never written to `localStorage`, `sessionStorage`, IndexedDB, the SQLite
 * database, or any network call, and it is rebuilt from scratch each
 * session. See docs/DESIGN.md §5 — the slightly slower load is the accepted
 * trade for keeping personal data out of browser storage.
 *
 * Concretely, that means everything below lives in a private field of this
 * class and nothing in this file touches a storage API. If a future change
 * wants to warm the index from a cache to make load faster, that is exactly
 * what this decision forbids — raise it rather than adding it.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Entry shape, per docs/WIDGET-CONTRACT.md:
 *
 *   { id, widgetId, title, subtitle, url, keywords: [] }
 */

/**
 * How a match scored, worst to best. Ranking has to be simple, but more
 * importantly it has to be UNSURPRISING: something whose title is exactly
 * what you typed must never sit below something that merely mentions it in a
 * keyword. Hence a tier per match quality rather than a blended score.
 */
export const MATCH = Object.freeze({
  NONE: 0,
  KEYWORD_SUBSTRING: 1,
  KEYWORD_PREFIX: 2,
  SUBTITLE_SUBSTRING: 3,
  SUBTITLE_PREFIX: 4,
  TITLE_SUBSTRING: 5,
  TITLE_PREFIX: 6,
  TITLE_EXACT: 7,
});

const DEFAULT_LIMIT = 20;

function normalise(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/** Prefix beats substring beats nothing, for one field. */
function scoreField(haystack, needle, { exact, prefix, substring }) {
  const text = normalise(haystack);
  if (!text) return MATCH.NONE;
  if (exact !== undefined && text === needle) return exact;
  if (text.startsWith(needle)) return prefix;
  // A word-start match anywhere in the string ranks as a prefix too: typing
  // "cal" should find "Family calendar" as readily as "Calendar".
  if (text.includes(` ${needle}`)) return prefix;
  return text.includes(needle) ? substring : MATCH.NONE;
}

/**
 * Score one entry against an already-normalised query.
 * Returns `MATCH.NONE` when the entry does not match at all.
 */
export function scoreEntry(entry, needle) {
  if (!needle) return MATCH.NONE;

  let best = scoreField(entry.title, needle, {
    exact: MATCH.TITLE_EXACT,
    prefix: MATCH.TITLE_PREFIX,
    substring: MATCH.TITLE_SUBSTRING,
  });
  if (best === MATCH.TITLE_EXACT) return best;

  best = Math.max(
    best,
    scoreField(entry.subtitle, needle, {
      prefix: MATCH.SUBTITLE_PREFIX,
      substring: MATCH.SUBTITLE_SUBSTRING,
    })
  );

  for (const keyword of entry.keywords ?? []) {
    best = Math.max(
      best,
      scoreField(keyword, needle, {
        prefix: MATCH.KEYWORD_PREFIX,
        substring: MATCH.KEYWORD_SUBSTRING,
      })
    );
    if (best >= MATCH.TITLE_SUBSTRING) break;
  }

  return best;
}

/** Drop anything unusable and freeze what is left. */
function normaliseEntry(entry, widgetId, index) {
  if (!entry || typeof entry !== 'object') return null;
  const title = typeof entry.title === 'string' ? entry.title.trim() : '';
  // A result the user cannot read is worse than no result.
  if (!title) return null;

  const keywords = Array.isArray(entry.keywords)
    ? entry.keywords.filter((k) => typeof k === 'string' && k.trim() !== '')
    : [];

  return Object.freeze({
    // `widgetId` decides the group a result appears under, so the index's own
    // idea of which widget pushed the entry wins over anything in the entry.
    widgetId,
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `${widgetId}:${index}`,
    title,
    subtitle: typeof entry.subtitle === 'string' ? entry.subtitle : '',
    url: typeof entry.url === 'string' && entry.url !== '' ? entry.url : null,
    keywords: Object.freeze(keywords),
  });
}

export class SearchIndex {
  /**
   * widgetId → frozen array of entries.
   *
   * A Map keyed by widget is what makes "replace, not append" structural
   * rather than a discipline someone has to remember: a widget refreshing
   * every 30s overwrites its own bucket, so the index cannot grow
   * unboundedly, and removing a widget drops its bucket entirely.
   *
   * It is also the only copy of this data. Nothing here persists it.
   */
  #byWidget = new Map();
  /** widgetId → the label results are grouped under ("Apps", "Calendar"). */
  #labels = new Map();
  #onChange;

  constructor({ onChange = null } = {}) {
    this.#onChange = onChange;
  }

  /**
   * Replace everything this widget contributed.
   *
   * This is the ONLY way entries get in, and it is a replace rather than an
   * append on purpose: `getSearchEntries()` returns a widget's complete
   * current set, so the previous set is by definition stale.
   */
  setEntries(widgetId, entries = [], { label } = {}) {
    if (typeof widgetId !== 'string' || widgetId === '') {
      throw new Error('SearchIndex.setEntries: a string widgetId is required');
    }

    const cleaned = (Array.isArray(entries) ? entries : [])
      .map((entry, i) => normaliseEntry(entry, widgetId, i))
      .filter(Boolean);

    if (cleaned.length === 0) {
      // Nothing to contribute: drop the bucket rather than keeping an empty
      // one, so `sources()` reflects what can actually be found.
      this.#byWidget.delete(widgetId);
    } else {
      this.#byWidget.set(widgetId, Object.freeze(cleaned));
    }

    if (label !== undefined) this.#labels.set(widgetId, label);
    this.#onChange?.(this);
    return cleaned.length;
  }

  /** Forget a widget entirely — its entries go with it. */
  remove(widgetId) {
    const had = this.#byWidget.delete(widgetId);
    this.#labels.delete(widgetId);
    if (had) this.#onChange?.(this);
    return had;
  }

  /** Drop everything. The index is rebuilt from scratch each session. */
  clear() {
    this.#byWidget.clear();
    this.#labels.clear();
    this.#onChange?.(this);
  }

  get size() {
    let total = 0;
    for (const entries of this.#byWidget.values()) total += entries.length;
    return total;
  }

  /** Every entry, in widget insertion order. Mostly for tests and debugging. */
  all() {
    return [...this.#byWidget.values()].flat();
  }

  entriesFor(widgetId) {
    return this.#byWidget.get(widgetId) ?? [];
  }

  label(widgetId) {
    return this.#labels.get(widgetId) ?? widgetId;
  }

  /**
   * Pull the current entries out of every host and replace the index with
   * them. This is the shell's "rebuild" path — on boot, and whenever a
   * widget's data changes.
   *
   * `hosts` are `WidgetHost`s: `getSearchEntries()` there is already wrapped
   * in the error boundary and already stamps `widgetId`, so a throwing widget
   * simply contributes nothing.
   */
  syncFromHosts(hosts = [], { labelFor = null } = {}) {
    const seen = new Set();
    for (const host of hosts) {
      if (!host?.id) continue;
      seen.add(host.id);
      this.setEntries(host.id, host.getSearchEntries?.() ?? [], {
        label: labelFor ? labelFor(host) : undefined,
      });
    }
    // A host that has gone away takes its entries with it.
    for (const widgetId of [...this.#byWidget.keys()]) {
      if (!seen.has(widgetId)) this.remove(widgetId);
    }
    return this.size;
  }

  /**
   * Search. Prefix and substring, across title, subtitle and keywords.
   *
   * Results come back sorted best-first, ties broken by title so the order is
   * stable between identical queries rather than depending on widget order.
   */
  search(query, { limit = DEFAULT_LIMIT } = {}) {
    const needle = normalise(query);
    if (!needle) return [];

    const hits = [];
    for (const entries of this.#byWidget.values()) {
      for (const entry of entries) {
        const score = scoreEntry(entry, needle);
        if (score !== MATCH.NONE) hits.push({ entry, score });
      }
    }

    hits.sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title, undefined));

    return hits.slice(0, limit).map((hit) => ({ ...hit.entry, score: hit.score }));
  }

  /**
   * Search, already grouped by the widget the results came from — which is
   * how the UI renders them, so that "Apps" and "Calendar" results are never
   * confusable. Groups are ordered by their best hit.
   */
  searchGrouped(query, options = {}) {
    const groups = new Map();
    for (const result of this.search(query, options)) {
      const group = groups.get(result.widgetId) ?? {
        widgetId: result.widgetId,
        label: this.label(result.widgetId),
        results: [],
      };
      group.results.push(result);
      groups.set(result.widgetId, group);
    }
    return [...groups.values()];
  }

  /** The widgets currently contributing, for an empty-state hint. */
  sources() {
    return [...this.#byWidget.keys()].map((widgetId) => ({
      widgetId,
      label: this.label(widgetId),
      count: this.#byWidget.get(widgetId).length,
    }));
  }
}
