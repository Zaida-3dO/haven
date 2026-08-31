/**
 * The greeting and clock widget's custom element.
 *
 * Time, date, and a greeting that adapts to the time of day AND the weather —
 * "Morning — it's grim out, working from home?" (DESIGN §6.8). The old version
 * was time-only with random phrasing per band; folding weather in is the new
 * part.
 *
 * Two rules from docs/WIDGET-CONTRACT.md shape everything here:
 *
 *   THIS WIDGET OWNS NO TIMER. A clock is the most tempting `setInterval` in
 *   any dashboard and it is exactly the one the contract forbids. It
 *   subscribes to the shared `clockTicker` instead — one interval for every
 *   clock on the board, paused with the tab. See `clock.js` for why the tick
 *   cannot simply be the host's data refresh: the host correctly skips a
 *   redraw when the payload's revision is unchanged, and a clock's display
 *   changes with the wall clock rather than with its data.
 *
 *   IT FETCHES NOTHING. The weather it reads is the SAME payload the weather
 *   widget gets, requested under the same fetcher key, so having both on the
 *   board costs one request rather than two.
 *
 * And it must degrade cleanly: with no weather data it falls back to the time
 * -only phrasing rather than showing an error, because a clock that breaks
 * when the weather service is down is a bad clock.
 */

import { clockTicker } from './clock.js';
import { greetingFor } from './phrases.js';

const STYLES = `
  :host { display: block; height: 100%; font: inherit; }
  .greeting { display: flex; flex-direction: column; justify-content: center; gap: 0.25rem; height: 100%; }
  .greeting__line { font-size: 1.4rem; font-weight: 600; line-height: 1.2; }
  .clock { font-size: 2.75rem; font-weight: 300; line-height: 1; font-variant-numeric: tabular-nums; }
  .date { opacity: 0.7; font-size: 0.9rem; }
`;

export class HavenGreetingWidget extends HTMLElement {
  #config = {};
  #payload = null;
  #root;

  /**
   * The chosen phrase is held rather than re-picked, because the phrasing is
   * random: re-picking on every tick would reshuffle the greeting once a
   * second. It is re-picked only when the band or the weather mood changes.
   */
  #phrase = null;
  #phraseKey = null;

  /** Unsubscribe from the shared ticker; set while mounted. */
  #untick = null;

  /** Injectable so a test can drive the tick without a real interval. */
  ticker = clockTicker;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
  }

  /**
   * Subscribe on mount, unsubscribe on unmount — so a removed widget never
   * leaves a timer running, and the shared interval stops with the last clock.
   */
  connectedCallback() {
    this.#untick ??= this.ticker.subscribe(() => this.render());
    this.render();
  }

  disconnectedCallback() {
    this.#untick?.();
    this.#untick = null;
  }

  setConfig(config = {}) {
    if (config.showSeconds !== undefined && typeof config.showSeconds !== 'boolean') {
      throw new Error('greeting: showSeconds must be a boolean');
    }
    if (config.name !== undefined && typeof config.name !== 'string') {
      throw new Error('greeting: name must be a string');
    }
    this.#config = config;
  }

  /**
   * The host's tick AND the weather arrive through here — there is only one
   * input to this widget, which is what keeps it a pure render function.
   */
  onData(payload) {
    this.#payload = payload;
    this.render();
  }

  render() {
    const now = this.#now();
    const weather = this.#weather();

    const style = document.createElement('style');
    style.textContent = STYLES;

    const wrap = el('div', { className: 'greeting' });
    wrap.appendChild(
      text('div', this.#greetingLine(now, weather), { className: 'greeting__line' })
    );
    wrap.appendChild(text('div', this.#clock(now), { className: 'clock' }));
    wrap.appendChild(text('div', this.#date(now), { className: 'date' }));

    this.#root.replaceChildren(style, wrap);
  }

  /**
   * The weather reading the phrasing needs, or null.
   *
   * Null covers every failure mode at once — no data yet, the connector
   * unconfigured, an upstream error, a payload in an error state — and null is
   * exactly what makes `greetingFor` fall back to time-only phrasing. There is
   * deliberately no error branch below this line.
   */
  #weather() {
    const value = this.#payload?.value;
    if (!value || value.status !== 'ok' || !value.data?.current) return null;

    return {
      conditionId: value.data.current.conditionId,
      temp: value.data.current.temp,
      units: value.data.units,
    };
  }

  #greetingLine(now, weather) {
    const { band, mood, text: phrase } = greetingFor({ date: now, weather });

    // Re-pick only when the band or mood changes, so the wording is stable
    // between ticks instead of reshuffling every second.
    const key = `${band}:${mood ?? 'none'}`;
    if (key !== this.#phraseKey) {
      this.#phraseKey = key;
      this.#phrase = phrase;
    }

    const name = this.#config.name?.trim();
    return name ? `${this.#phrase}, ${name}` : this.#phrase;
  }

  #clock(now) {
    return now.toLocaleTimeString(this.#config.locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(this.#config.showSeconds ? { second: '2-digit' } : {}),
    });
  }

  #date(now) {
    return now.toLocaleDateString(this.#config.locale, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    });
  }

  /**
   * The current time.
   *
   * Read from the clock at render, NOT from a timer this widget started. The
   * host decides when to call render; this only decides what to draw.
   */
  #now() {
    return new Date();
  }

  destroy() {
    this.#untick?.();
    this.#untick = null;
    this.#root.replaceChildren();
  }
}

function el(tag, props = {}) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  return node;
}

function text(tag, content, props = {}) {
  const node = el(tag, props);
  node.textContent = content;
  return node;
}
