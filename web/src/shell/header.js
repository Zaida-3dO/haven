/**
 * The app header — the fixed 70px bar across the top of the dashboard.
 *
 * Haven had no header at all: the page opened with a bare "Edit dashboard"
 * button on a blank background, which was the single biggest visual
 * difference between it and the dashboard it replaces. The bar carries a
 * wordmark, a search affordance and a clock, left to right.
 *
 * ## Why the search is a button, not an input
 *
 * There is already a working global search — `SearchUI`, opened with
 * Ctrl/Cmd-K, with its own index, keyboard handling and ARIA wiring. Putting a
 * real `<input>` here would mean two search interfaces with two behaviours and
 * two sets of bugs. So this is a button styled to look like the original's
 * field: it opens the palette that already exists.
 *
 * That is not only cheaper, it is better for discoverability. A search you can
 * only reach by guessing a keyboard shortcut is a search most people never
 * find; this makes it visible without duplicating it.
 *
 * ## Why the clock is here and not a widget
 *
 * The clock WIDGET still exists and is unaffected — this is the header's own
 * small clock, the way the original dashboard has one in its top-right
 * cluster. It is the one piece of a wall dashboard read from across the room.
 *
 * Weather deliberately not included — see the note in `createHeader`.
 */

/** How the header's clock renders the time. Locale-driven, 24h from the OS. */
function formatTime(date, locale) {
  return new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit' }).format(date);
}

function formatDate(date, locale) {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(date);
}

/**
 * Builds the header.
 *
 * Returns the element plus a `destroy()`, because the clock holds an interval
 * and a header that is torn down without stopping it leaks a timer per boot.
 *
 * @param {object} [deps]
 * @param {string} [deps.title]      the product name shown beside the mark
 * @param {() => void} [deps.onSearch] opens the global search palette
 * @param {Document} [deps.document]
 * @param {() => Date} [deps.now]    injectable clock, so tests are not
 *                                   dependent on the wall clock
 * @param {string} [deps.locale]
 */
export function createHeader({
  title = 'Haven',
  onSearch = null,
  document: doc = globalThis.document,
  now = () => new Date(),
  locale = undefined,
} = {}) {
  const el = doc.createElement('header');
  el.className = 'haven-header';

  const brand = doc.createElement('div');
  brand.className = 'haven-header__brand';

  const mark = doc.createElement('span');
  mark.className = 'haven-header__mark';
  // Decorative: the product name is the text right beside it.
  mark.setAttribute('aria-hidden', 'true');
  mark.textContent = title.slice(0, 1).toUpperCase();

  // The page's one and only `<h1>`. Before this the document had no top-level
  // heading at all, so a screen reader landed on the page with nothing naming
  // it and heading navigation started at the widget titles.
  const heading = doc.createElement('h1');
  heading.className = 'haven-header__title';
  heading.textContent = title;

  brand.appendChild(mark);
  brand.appendChild(heading);

  const search = doc.createElement('button');
  search.type = 'button';
  search.className = 'haven-header__search';
  // It opens a dialog rather than submitting, and says so.
  search.setAttribute('aria-haspopup', 'dialog');
  search.setAttribute('aria-label', 'Search apps and widgets');

  const searchIcon = doc.createElement('span');
  searchIcon.className = 'haven-header__search-icon';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchIcon.textContent = '\u2315';

  const searchText = doc.createElement('span');
  searchText.className = 'haven-header__search-text';
  searchText.textContent = 'Search apps\u2026';

  const hint = doc.createElement('span');
  hint.className = 'haven-header__search-hint';
  hint.setAttribute('aria-hidden', 'true');
  hint.textContent = 'Ctrl K';

  search.append(searchIcon, searchText, hint);
  if (onSearch) search.addEventListener('click', () => onSearch());

  const status = doc.createElement('div');
  status.className = 'haven-header__status';

  const clock = doc.createElement('div');
  clock.className = 'haven-header__clock';

  const time = doc.createElement('span');
  time.className = 'haven-header__time';
  const dateEl = doc.createElement('span');
  dateEl.className = 'haven-header__date';

  clock.append(time, dateEl);
  status.appendChild(clock);

  function tick() {
    const at = now();
    time.textContent = formatTime(at, locale);
    dateEl.textContent = formatDate(at, locale);
  }
  tick();

  // Weather is NOT here, deliberately. The original dashboard shows it in this
  // cluster, but Haven has no weather source wired up and inventing one would
  // mean a new API key, a new server route and a new failure mode for a purely
  // decorative element. The slot is laid out to take it when a weather source
  // exists; until then the header renders complete without it rather than
  // showing a permanently-empty box.

  // A minute is the right granularity: the header shows hours and minutes, so
  // a faster tick would repaint identical text.
  const timer = typeof setInterval === 'function' ? setInterval(tick, 60_000) : null;

  // `unref` where it exists (Node, not the browser): an interval is enough to
  // keep the Node event loop alive on its own, so a test that builds a header
  // and does not destroy it would hang the whole run rather than fail. In a
  // browser there is no `unref` and none is needed — `destroy()` is the only
  // thing that stops it there, which is why it exists.
  timer?.unref?.();

  el.append(brand, search, status);

  return {
    el,
    tick,
    destroy() {
      if (timer !== null) clearInterval(timer);
    },
  };
}

export default { createHeader };
