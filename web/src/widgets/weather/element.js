/**
 * The weather widget's custom element.
 *
 * It renders current conditions and a 4-day forecast, and it FETCHES NOTHING.
 * Data arrives through `onData()` from the host, which owns the schedule; this
 * file contains no `fetch`, no `setInterval` and no API key, because all three
 * live behind `/api/widgets/weather` (docs/WIDGET-CONTRACT.md, docs/SECURITY.md).
 *
 * The connector answers three shapes and each renders differently:
 *
 *   status: 'ok'              → the weather, plus a staleness marker if stale
 *   status: 'not_configured'  → a hint naming the one thing to set
 *   an error payload          → the host's error boundary handles it
 */

import { describe, formatTemp, iconUrl, staleness, weekday, windUnit } from './format.js';

const STYLES = `
  :host { display: block; height: 100%; font: inherit; }
  .weather { display: flex; flex-direction: column; gap: 0.75rem; height: 100%; }
  .current { display: flex; align-items: center; gap: 0.75rem; }
  .current__icon { width: 64px; height: 64px; flex: none; }
  .current__temp { font-size: 2rem; font-weight: 600; line-height: 1; }
  .current__meta { display: flex; flex-direction: column; gap: 0.15rem; }
  .current__description { text-transform: none; }
  .current__detail { opacity: 0.7; font-size: 0.85rem; }
  .forecast { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.5rem; margin-top: auto; }
  .day { display: flex; flex-direction: column; align-items: center; gap: 0.15rem; font-size: 0.85rem; }
  .day__icon { width: 32px; height: 32px; }
  .day__max { font-weight: 600; }
  .day__min { opacity: 0.6; }
  /* A soft notice is not an error box: it is a quiet marker on real data. */
  .notice { font-size: 0.75rem; opacity: 0.7; display: flex; align-items: center; gap: 0.35rem; }
  .hint { display: flex; flex-direction: column; gap: 0.35rem; }
  .hint__title { font-weight: 600; }
  .hint__body { font-size: 0.85rem; opacity: 0.75; }
  code { font-size: 0.8em; padding: 0.1em 0.3em; border-radius: 3px; background: rgba(127,127,127,0.18); }
`;

export class HavenWeatherWidget extends HTMLElement {
  #config = {};
  #payload = null;
  #root;

  constructor() {
    super();
    // Shadow DOM per widget: broken markup here cannot corrupt the layout.
    this.#root = this.attachShadow({ mode: 'open' });
  }

  /**
   * Validate eagerly and THROW on bad config — that is the contract, and it is
   * what lets the host render an error card rather than a half-drawn widget.
   */
  setConfig(config = {}) {
    if (config.showForecast !== undefined && typeof config.showForecast !== 'boolean') {
      throw new Error('weather: showForecast must be a boolean');
    }
    this.#config = config;
  }

  onData(payload) {
    this.#payload = payload;
    this.render();
  }

  render() {
    const nodes = this.#build();
    // One replaceChildren rather than innerHTML: nothing here is ever parsed
    // as markup, so an upstream description cannot inject anything.
    this.#root.replaceChildren(...nodes);
  }

  #build() {
    const style = document.createElement('style');
    style.textContent = STYLES;

    return [style, this.#content()];
  }

  #content() {
    const value = this.#payload?.value;

    if (!value) return el('div', { className: 'hint' }, [text('span', 'Loading weather…')]);

    if (value.status === 'not_configured') return this.#renderHint(value);

    if (value.status !== 'ok' || !value.data) {
      // Nothing usable. Throwing hands it to the host's error boundary, which
      // owns what a failed widget looks like.
      throw new Error(value.message ?? 'Weather is unavailable');
    }

    return this.#renderWeather(value);
  }

  /**
   * The "not configured" tile.
   *
   * This is a first-run state, not a failure, so it reads as an instruction:
   * it names the single thing to set and nothing else.
   */
  #renderHint(value) {
    const wrap = el('div', { className: 'hint' });
    wrap.appendChild(text('span', 'Weather is not configured', { className: 'hint__title' }));

    const body = el('span', { className: 'hint__body' });
    // The hint comes from the server and names an env var or a settings key;
    // it is inserted as text, never as markup.
    body.textContent = value.hint ?? 'Add the weather configuration to enable this widget.';
    wrap.appendChild(body);

    return wrap;
  }

  #renderWeather(value) {
    const { data, stale, cachedAt } = value;
    const units = data.units;

    const wrap = el('div', { className: 'weather' });
    wrap.appendChild(this.#renderCurrent(data, units));

    if (this.#config.showForecast !== false && data.forecast?.length) {
      wrap.appendChild(this.#renderForecast(data.forecast, units));
    }

    // A soft notice is not a hard error: the data still draws, with a marker.
    if (stale) {
      const notice = el('div', { className: 'notice' });
      notice.textContent = `Offline — last updated ${staleness(cachedAt)}`;
      wrap.appendChild(notice);
    }

    return wrap;
  }

  #renderCurrent(data, units) {
    const current = data.current ?? {};
    const row = el('div', { className: 'current' });

    const icon = iconUrl(current.icon);
    if (icon) {
      const img = el('img', { className: 'current__icon' });
      img.src = icon;
      // The description is the accessible name; the icon is decorative twice over.
      img.alt = describe(current.description);
      img.loading = 'lazy';
      row.appendChild(img);
    }

    const meta = el('div', { className: 'current__meta' });
    meta.appendChild(text('span', formatTemp(current.temp, units), { className: 'current__temp' }));

    const description = describe(current.description);
    if (description) {
      meta.appendChild(text('span', description, { className: 'current__description' }));
    }

    const details = [];
    if (data.location) details.push(data.location);
    if (typeof current.feelsLike === 'number' && current.feelsLike !== current.temp) {
      details.push(`feels like ${formatTemp(current.feelsLike, units)}`);
    }
    if (typeof current.windSpeed === 'number') {
      details.push(`${Math.round(current.windSpeed)} ${windUnit(units)}`);
    }
    if (details.length) {
      meta.appendChild(text('span', details.join(' · '), { className: 'current__detail' }));
    }

    row.appendChild(meta);
    return row;
  }

  #renderForecast(forecast, units) {
    const grid = el('div', { className: 'forecast' });

    for (const day of forecast) {
      const cell = el('div', { className: 'day' });
      cell.appendChild(text('span', weekday(day.date, { locale: this.#config.locale })));

      const icon = iconUrl(day.icon, { size: 2 });
      if (icon) {
        const img = el('img', { className: 'day__icon' });
        img.src = icon;
        img.alt = describe(day.description);
        img.loading = 'lazy';
        cell.appendChild(img);
      }

      cell.appendChild(text('span', formatTemp(day.max, units), { className: 'day__max' }));
      cell.appendChild(text('span', formatTemp(day.min, units), { className: 'day__min' }));
      grid.appendChild(cell);
    }

    return grid;
  }

  destroy() {
    this.#root.replaceChildren();
  }
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
