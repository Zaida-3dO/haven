/**
 * Presentation helpers for the weather widget.
 *
 * These are pure functions, kept out of the custom element so they can be
 * tested without a DOM. The element below them does nothing but put their
 * output into nodes.
 */

/** OpenWeatherMap's unit systems and the symbol each one reports temps in. */
const DEGREES = Object.freeze({
  metric: '°C',
  imperial: '°F',
  standard: 'K',
});

export function degrees(units) {
  return DEGREES[units] ?? DEGREES.metric;
}

/** Wind comes back as m/s for metric and standard, mph for imperial. */
export function windUnit(units) {
  return units === 'imperial' ? 'mph' : 'm/s';
}

export function formatTemp(value, units) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '--';
  return `${Math.round(value)}${degrees(units)}`;
}

/**
 * A forecast day's weekday label.
 *
 * The server deliberately sends an ISO date rather than a formatted weekday,
 * because it has no idea what locale the browser is in. Formatting here is the
 * whole reason for that split.
 */
export function weekday(isoDate, { locale, now = Date.now() } = {}) {
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return '';

  const today = new Date(now).toISOString().slice(0, 10);
  if (isoDate === today) return 'Today';

  const tomorrow = new Date(new Date(now).getTime() + 86_400_000).toISOString().slice(0, 10);
  if (isoDate === tomorrow) return 'Tomorrow';

  return date.toLocaleDateString(locale, { weekday: 'short', timeZone: 'UTC' });
}

/** OpenWeatherMap serves its own icons; this is the documented URL shape. */
export function iconUrl(icon, { size = 2 } = {}) {
  if (!icon) return null;
  return `https://openweathermap.org/img/wn/${icon}@${size}x.png`;
}

/**
 * How long ago the data was fetched, for the staleness marker.
 *
 * Only ever coarse: a stale tile needs to say "this is old" and roughly how
 * old, not tick a precise duration.
 */
export function staleness(cachedAt, { now = Date.now() } = {}) {
  if (typeof cachedAt !== 'number') return 'a while ago';

  const minutes = Math.floor((now - cachedAt) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

/** Sentence-case a lowercase upstream description like "light rain". */
export function describe(description) {
  if (typeof description !== 'string' || description === '') return '';
  return description[0].toUpperCase() + description.slice(1);
}
