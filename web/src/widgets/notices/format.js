/**
 * Pure formatting and ordering helpers for the notices widget.
 *
 * Kept out of `element.js` so every rule below is testable without a DOM —
 * and these are the rules most worth testing, because "in 2 days" being
 * wrong is the kind of bug that looks fine in a screenshot.
 */

/** Least to most urgent. The index doubles as a comparable rank. */
export const SEVERITY_RANK = Object.freeze({ info: 0, warn: 1, urgent: 2 });

/**
 * How each severity presents itself.
 *
 * **Colour is never the only carrier.** Every level has an icon AND a word, so
 * the tile is readable in greyscale, by someone with a colour vision
 * deficiency, and by a screen reader. The icon is a text glyph rather than an
 * image so it inherits the text colour and needs no asset.
 */
export const SEVERITY_PRESENTATION = Object.freeze({
  info: Object.freeze({ icon: 'i', label: 'Info', rank: 0 }),
  warn: Object.freeze({ icon: '!', label: 'Warning', rank: 1 }),
  urgent: Object.freeze({ icon: '!!', label: 'Urgent', rank: 2 }),
});

/** Unknown severities present as info — the level that cannot mislead. */
export function presentation(severity) {
  return SEVERITY_PRESENTATION[severity] ?? SEVERITY_PRESENTATION.info;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * A due date as a relative phrase: "in 2 days", "3 hours ago", "now".
 *
 * `Intl.RelativeTimeFormat` does the wording, so it is localised rather than
 * hand-assembled English. The unit is chosen by magnitude — "in 2 days" is
 * what a person says; "in 48 hours" is what a computer says.
 *
 * @param {string|null} due ISO-8601
 * @param {object} [options]
 * @param {number} [options.now]
 * @param {string} [options.locale]
 * @returns {string|null} null when there is no due date to describe
 */
export function relativeDue(due, { now = Date.now(), locale = undefined } = {}) {
  if (!due) return null;

  const timestamp = Date.parse(due);
  if (!Number.isFinite(timestamp)) return null;

  const delta = timestamp - now;
  const magnitude = Math.abs(delta);

  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  // Under a minute either way, a number is noise: it is happening now.
  if (magnitude < MINUTE) return 'now';

  if (magnitude < HOUR) return format.format(Math.round(delta / MINUTE), 'minute');
  if (magnitude < DAY) return format.format(Math.round(delta / HOUR), 'hour');
  if (magnitude < WEEK) return format.format(Math.round(delta / DAY), 'day');

  // Beyond a week, weeks read better than "in 23 days" up to about a month.
  if (magnitude < 5 * WEEK) return format.format(Math.round(delta / WEEK), 'week');

  return format.format(Math.round(delta / (30 * DAY)), 'month');
}

/**
 * The absolute due date, for the `title` tooltip.
 *
 * The relative phrase is what you read at a glance; the absolute one is what
 * you need when you are actually planning around it, which is why it is on
 * hover rather than on the tile.
 */
export function absoluteDue(due, { locale = undefined } = {}) {
  if (!due) return null;

  const timestamp = Date.parse(due);
  if (!Number.isFinite(timestamp)) return null;

  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp));
}

/** Whether a due date has passed — overdue is presented differently. */
export function isOverdue(due, { now = Date.now() } = {}) {
  if (!due) return false;
  const timestamp = Date.parse(due);
  return Number.isFinite(timestamp) && timestamp < now;
}

/**
 * Order notices for display.
 *
 * The server already returns them ordered, but the widget re-sorts rather than
 * trusting that: a future second source, a cached payload from an older server,
 * or a config change all produce a list this widget still has to render
 * sensibly. Sorting twice is cheap; rendering a misordered urgent notice is not.
 *
 * `due` drives it (DESIGN §6.6). Notices with no due date sort last — they are
 * things to do eventually, and putting them above something due in an hour
 * would be actively misleading. Severity breaks ties.
 */
export function sortNotices(notices = []) {
  return [...notices].sort((a, b) => {
    const aDue = a.due ? Date.parse(a.due) : null;
    const bDue = b.due ? Date.parse(b.due) : null;

    const aHas = Number.isFinite(aDue);
    const bHas = Number.isFinite(bDue);

    if (aHas && bHas && aDue !== bDue) return aDue - bDue;
    if (aHas !== bHas) return aHas ? -1 : 1;

    const rank = presentation(b.severity).rank - presentation(a.severity).rank;
    if (rank !== 0) return rank;

    return String(a.title ?? '').localeCompare(String(b.title ?? ''));
  });
}

/**
 * Apply the widget's config: severity floor first, then the item cap.
 *
 * Filtering before capping is the only order that makes sense — capping first
 * would let eight `info` notices hide the one `urgent` the user set the filter
 * to catch.
 */
export function visibleNotices(notices = [], { minSeverity = 'info', maxItems = 8 } = {}) {
  const floor = presentation(minSeverity).rank;

  const kept = sortNotices(notices).filter((n) => presentation(n.severity).rank >= floor);

  const limit = Number.isFinite(maxItems) && maxItems > 0 ? Math.floor(maxItems) : kept.length;
  return kept.slice(0, limit);
}
