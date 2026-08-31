/**
 * The apps widget's logic, with no DOM in it.
 *
 * Filtering, sorting and view-model building live here so they can be tested
 * by calling a function with a fixture rather than by driving a rendered
 * component. The web component in `apps-widget.js` is then a thin translation
 * of these results into elements.
 */

import { STATUS, statusLabel, urlHint } from '../../lib/status.js';

/** Carried over from the old dashboard, and from the server's CATEGORIES. */
export const CATEGORIES = Object.freeze(['personal', 'media', 'home', 'ai', 'tools']);

/** The pseudo-category for the "everything" tab. */
export const ALL_CATEGORY = 'all';

export const SORT = Object.freeze({
  VISITS: 'visits',
  NAME: 'name',
  CATEGORY: 'category',
  STATUS: 'status',
});

export const SORT_OPTIONS = Object.freeze([
  // Visit-count first because it is the default and the interesting one: the
  // things you actually open rise to the top on their own.
  { value: SORT.VISITS, label: 'Most visited' },
  { value: SORT.NAME, label: 'Name' },
  { value: SORT.CATEGORY, label: 'Category' },
  { value: SORT.STATUS, label: 'Reachable first' },
]);

/**
 * Status sort order.
 *
 * Reachable first, then the ones we are still asking about, then states that
 * carry no information, and unreachable last — the point of the sort is to
 * float what you can actually open right now.
 */
const STATUS_RANK = {
  [STATUS.REACHABLE]: 0,
  [STATUS.CHECKING]: 1,
  [STATUS.UNKNOWN]: 2,
  [STATUS.UNREACHABLE]: 3,
};

/** Category tabs, plus "All". Only categories that have apps are offered. */
export function categoryTabs(apps = []) {
  const present = new Set(apps.map((a) => a?.category).filter(Boolean));
  return [
    { value: ALL_CATEGORY, label: 'All', count: apps.length },
    ...CATEGORIES.filter((c) => present.has(c)).map((c) => ({
      value: c,
      label: c.charAt(0).toUpperCase() + c.slice(1),
      count: apps.filter((a) => a?.category === c).length,
    })),
  ];
}

export function filterByCategory(apps = [], category = ALL_CATEGORY) {
  if (!category || category === ALL_CATEGORY) return [...apps];
  return apps.filter((app) => app?.category === category);
}

/**
 * Sorts a copy of `apps`.
 *
 * Every comparator falls through to name, so the order is total and stable
 * regardless of the input order — a grid that reshuffles equal-ranked cards
 * between refreshes is disorienting.
 */
export function sortApps(apps = [], sort = SORT.VISITS, statuses = new Map()) {
  const byName = (a, b) => String(a?.name ?? '').localeCompare(String(b?.name ?? ''));
  const list = [...apps];

  switch (sort) {
    case SORT.NAME:
      return list.sort(byName);

    case SORT.CATEGORY:
      return list.sort(
        (a, b) => String(a?.category ?? '').localeCompare(String(b?.category ?? '')) || byName(a, b)
      );

    case SORT.STATUS:
      return list.sort((a, b) => {
        const rank = (app) =>
          STATUS_RANK[statuses.get(app?.id)?.status] ?? STATUS_RANK[STATUS.UNKNOWN];
        return rank(a) - rank(b) || byName(a, b);
      });

    case SORT.VISITS:
    default:
      // Descending: most-opened first. The count is server-owned and not
      // user-editable (DESIGN §6.2), which is why nothing here can write it.
      return list.sort((a, b) => (b?.visitCount ?? 0) - (a?.visitCount ?? 0) || byName(a, b));
  }
}

/**
 * Every URL that reaches an `href` passes through here first.
 *
 * `javascript:` in an href is script execution on click, and `data:` can carry
 * a document. The API already rejects both (`server/src/routes/apps-schema.js`
 * allows only http/https), so this is a second line rather than the only one —
 * but it is worth having, because the API is not the only way a row is
 * created: `seedApps` inserts `config/apps.json` through `createApp` directly,
 * without going through `validateApp`. That file is operator-supplied rather
 * than attacker-supplied, so this is defence in depth and not a live hole; the
 * point is that the render boundary should not *depend* on which write path a
 * row arrived by.
 *
 * Returns null for anything not http/https, which callers treat exactly like a
 * missing URL.
 */
export function safeUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  try {
    const protocol = new URL(url, 'https://haven.invalid').protocol;
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

/**
 * The primary URL — the one shown as the card's main action when nothing has
 * been probed yet, and the fallback if nothing answers.
 */
export function primaryUrl(app) {
  const urls = Array.isArray(app?.urls) ? app.urls : [];
  return safeUrl((urls.find((u) => u?.primary) ?? urls[0])?.url) ?? null;
}

/**
 * The secondary-URL menu — the headline feature.
 *
 * Every variant EXCEPT the one the card's main click already goes to, each
 * under its own title. The exclusion is what keeps the menu useful: repeating
 * the destination you just offered as the big button is noise, and it is the
 * resolved target that gets excluded rather than the declared primary, because
 * the resolved one is where a click actually lands.
 */
export function secondaryUrls(app, resolvedUrl = null) {
  const urls = Array.isArray(app?.urls) ? app.urls : [];
  const exclude = resolvedUrl ?? primaryUrl(app);
  return (
    urls
      // The index is taken BEFORE filtering, so a fallback title refers to the
      // entry's real position in the app's URL list rather than its position in
      // the menu — otherwise the same link is "Link 2" or "Link 1" depending on
      // which variant happened to resolve.
      .map((entry, index) => ({ url: safeUrl(entry?.url), title: entry?.title, index }))
      .filter(({ url }) => url && url !== exclude)
      .map(({ title, url, index }) => ({
        title: title?.trim() || `Link ${index + 1}`,
        url,
      }))
  );
}

/**
 * The version pair for a card.
 *
 * `differs` is the affordance the whole feature exists for: an update is
 * available. Everything else — one side missing, both missing, an upstream
 * error — renders as whatever is known and NEVER as an error, per the brief.
 */
export function versionPair(app, versions = {}) {
  const info = versions?.[app?.id] ?? null;
  const current = info?.current ?? null;
  const latest = info?.latest ?? null;

  // `status` is computed on the server, but it is not trusted blindly: if the
  // field is missing (an older cached payload, say) the two strings are
  // compared here rather than silently reporting "no update". The comparison
  // mirrors the server's — normalise a leading `v`, compare case-insensitively
  // — because tags in the wild are `v1.2.3`, `1.2.3` and worse, and the only
  // question being asked is "are these the same?".
  const normalise = (v) =>
    String(v)
      .trim()
      .toLowerCase()
      .replace(/^v(?=\d)/, '');
  const differs = Boolean(
    current &&
    latest &&
    (info?.status ? info.status === 'differs' : normalise(current) !== normalise(latest))
  );

  return {
    current,
    latest,
    latestUrl: info?.latestUrl ?? null,
    differs,
    // Nothing at all to show: the card omits the row rather than drawing two
    // empty slots.
    known: Boolean(current || latest),
    label: differs
      ? `Update available: ${current} → ${latest}`
      : current && latest
        ? `Up to date (${current})`
        : current
          ? `Running ${current}`
          : latest
            ? `Latest release ${latest}`
            : 'Version unknown',
  };
}

/**
 * Everything one card needs, as plain data.
 *
 * Building this separately from rendering is what lets the card's contents be
 * asserted in a test without a DOM, and it keeps the component a translation
 * step rather than a place where logic hides.
 */
export function buildCard(app, { statuses = new Map(), versions = {} } = {}) {
  const entry = statuses.get(app?.id) ?? {
    status: STATUS.UNKNOWN,
    url: primaryUrl(app),
    checkedAt: null,
  };
  // Guarded again here: the resolved URL comes back through the tracker, so
  // this is the last point before it becomes an href.
  const href = safeUrl(entry.url) ?? primaryUrl(app);

  return {
    id: app?.id,
    name: app?.name ?? app?.id ?? 'Unnamed',
    description: app?.description ?? '',
    category: app?.category ?? 'tools',
    icon: app?.icon ?? null,
    visitCount: app?.visitCount ?? 0,
    href,
    status: entry.status,
    // Colour must not carry the meaning alone: both of these become
    // title/aria-label text on the dot and the link.
    statusLabel: statusLabel(entry, app?.name ?? ''),
    urlHint: urlHint({ ...entry, url: href }),
    secondaries: secondaryUrls(app, href),
    version: versionPair(app, versions),
  };
}

/**
 * The whole view model: tabs, the visible cards, and the sort state.
 */
export function buildView(
  apps = [],
  { category = ALL_CATEGORY, sort = SORT.VISITS, statuses = new Map(), versions = {} } = {}
) {
  const filtered = filterByCategory(apps, category);
  const sorted = sortApps(filtered, sort, statuses);

  return {
    tabs: categoryTabs(apps),
    category,
    sort,
    sortOptions: SORT_OPTIONS,
    cards: sorted.map((app) => buildCard(app, { statuses, versions })),
    empty: sorted.length === 0,
  };
}
