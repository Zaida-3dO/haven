/**
 * The greeting's phrasing, as DATA.
 *
 * Every line lives in a table here rather than being built up inside the
 * render, so the vocabulary can be extended — a new band, a new weather mood,
 * a phrase you got bored of — without touching a line of logic. That is the
 * whole point of this file: adding a phrase should be a one-line diff to an
 * array.
 *
 * The structure mirrors the Home Assistant morning digest
 * (`agents/first-message-digest.md`): a time band picks the greeting, and the
 * weather adapts the tone on top of it. The old dashboard's version was
 * time-only with random phrasing per band; the weather half is what is new.
 */

/**
 * Time bands, in the order they are tested. `from` is inclusive, and the last
 * band wraps past midnight, which is why `night` is checked as "not any of the
 * others" rather than by hour range.
 */
export const BANDS = Object.freeze([
  { id: 'morning', from: 5, to: 12, greeting: 'Morning' },
  { id: 'afternoon', from: 12, to: 17, greeting: 'Afternoon' },
  { id: 'evening', from: 17, to: 22, greeting: 'Evening' },
  { id: 'night', from: 22, to: 5, greeting: 'Late one' },
]);

/**
 * Weather moods, derived from an OpenWeatherMap condition group id.
 *
 * The ids are the stable thing to branch on — descriptions are localised and
 * vary ("light rain", "shower rain", "moderate rain" are all just rain here).
 * Ranges follow OWM's documented groups:
 *   2xx thunderstorm · 3xx drizzle · 5xx rain · 6xx snow · 7xx atmosphere
 *   800 clear · 80x clouds
 */
export const MOODS = Object.freeze([
  { id: 'thunder', test: (id) => id >= 200 && id < 300 },
  { id: 'rain', test: (id) => (id >= 300 && id < 400) || (id >= 500 && id < 600) },
  { id: 'snow', test: (id) => id >= 600 && id < 700 },
  { id: 'fog', test: (id) => id >= 700 && id < 800 },
  { id: 'clear', test: (id) => id === 800 },
  { id: 'cloudy', test: (id) => id > 800 && id < 900 },
]);

/**
 * Temperature moods, which override a bland sky when it is genuinely extreme.
 * Thresholds are in Celsius; the widget converts before looking them up so the
 * table does not have to know about unit systems.
 */
export const TEMPERATURE_MOODS = Object.freeze([
  { id: 'freezing', test: (c) => c <= 0 },
  { id: 'cold', test: (c) => c > 0 && c <= 7 },
  { id: 'hot', test: (c) => c >= 27 },
]);

/**
 * The lines themselves: band → mood → phrasings.
 *
 * `null` under a band is its weather-less fallback, which is what renders when
 * there is no weather data at all. Every band has one, and that is what makes
 * "degrades cleanly with no weather" structural rather than a special case.
 */
export const PHRASES = Object.freeze({
  morning: {
    null: ['Morning', 'Morning — off we go', 'Morning, then'],
    clear: ['Morning — properly bright out', 'Morning — worth being outside for'],
    rain: ["Morning — it's grim out, working from home?", 'Morning — wet one, take the brolly'],
    thunder: ['Morning — it is loud out there', 'Morning — thunder to start with, lovely'],
    snow: ['Morning — snow out, allow extra time', 'Morning — it snowed'],
    fog: ['Morning — thick out there, mind the drive'],
    cloudy: ['Morning — grey but dry', 'Morning — flat sky, could be worse'],
    freezing: ['Morning — below zero, scrape the car', 'Morning — freezing, layer up'],
    cold: ['Morning — sharp one, coat weather'],
    hot: ['Morning — already warm, water bottle'],
  },
  afternoon: {
    null: ['Afternoon', 'Afternoon — halfway there'],
    clear: ['Afternoon — get outside while it lasts', 'Afternoon — glorious out'],
    rain: ['Afternoon — still coming down', 'Afternoon — indoor sort of day'],
    thunder: ['Afternoon — storm rolling through'],
    snow: ['Afternoon — still snowing'],
    fog: ['Afternoon — murky out'],
    cloudy: ['Afternoon — grey one', 'Afternoon — dry at least'],
    freezing: ['Afternoon — bitter out there'],
    cold: ['Afternoon — chilly one'],
    hot: ['Afternoon — stay in the shade'],
  },
  evening: {
    null: ['Evening', 'Evening — winding down'],
    clear: ['Evening — clear sky, decent sunset odds'],
    rain: ['Evening — raining, good night to stay in'],
    thunder: ['Evening — storm on, curtains and telly'],
    snow: ['Evening — snowing, roads will be fun'],
    fog: ['Evening — fog settling in'],
    cloudy: ['Evening — overcast, cosy enough'],
    freezing: ['Evening — freezing out, heating on'],
    cold: ['Evening — cold one, blanket weather'],
    hot: ['Evening — still warm out'],
  },
  night: {
    null: ['Late one', 'Still up, then', 'Late — go to bed'],
    clear: ['Late — clear night, stars are out'],
    rain: ['Late — rain on the windows, good sleeping weather'],
    thunder: ['Late — storm outside, good luck sleeping'],
    snow: ['Late — snowing out there'],
    fog: ['Late — proper fog out'],
    cloudy: ['Late — cloudy night'],
    freezing: ['Late — freezing out, mind the pipes'],
    cold: ['Late — cold one out there'],
    hot: ['Late — too warm to sleep'],
  },
});

/**
 * Which band an hour falls in.
 *
 * The `from >= to` case is the band that wraps past midnight (night, 22:00 to
 * 04:59), and it is matched explicitly rather than left to a trailing
 * fallback. Leaning on a fallback would work by coincidence — night happens to
 * be last in the table — and would silently misfile 02:00 the moment the table
 * were reordered.
 */
export function bandFor(hour) {
  const match = BANDS.find((band) =>
    band.from < band.to ? hour >= band.from && hour < band.to : hour >= band.from || hour < band.to
  );

  if (match) return match;

  // Unreachable for an integer hour in 0–23, since the bands tile the clock.
  // A non-integer or out-of-range hour lands here rather than throwing.
  throw new RangeError(`bandFor: no band covers hour ${hour}`);
}

/**
 * Which mood a weather reading suggests.
 *
 * Temperature wins over an unremarkable sky — "it is below zero" is more worth
 * saying than "it is cloudy" — but a dramatic sky (storm, snow, fog) wins over
 * temperature, because that is the thing you would actually mention.
 */
export function moodFor({ conditionId, temperatureC } = {}) {
  const sky = MOODS.find((mood) => mood.test(conditionId))?.id ?? null;

  if (sky && sky !== 'clear' && sky !== 'cloudy') return sky;

  const temperature =
    typeof temperatureC === 'number' && Number.isFinite(temperatureC)
      ? (TEMPERATURE_MOODS.find((mood) => mood.test(temperatureC))?.id ?? null)
      : null;

  return temperature ?? sky;
}

/**
 * Pick a phrase.
 *
 * `pick` is injected rather than calling `Math.random` directly so a test can
 * assert on an exact line — a randomly phrased greeting is otherwise
 * untestable, which is how random phrasing usually ends up untested.
 *
 * A band with no line for a mood falls back to its weather-less lines, so a
 * new mood added to `MOODS` without lines degrades instead of throwing.
 */
export function phraseFor({ band, mood, pick = randomPick } = {}) {
  const lines = PHRASES[band] ?? PHRASES.morning;
  const candidates = (mood && lines[mood]?.length ? lines[mood] : lines.null) ?? ['Hello'];
  return pick(candidates);
}

function randomPick(candidates) {
  return candidates[Math.floor(Math.random() * candidates.length)];
}

/** Celsius, whatever the configured unit system reports. */
export function toCelsius(temp, units) {
  if (typeof temp !== 'number' || !Number.isFinite(temp)) return null;
  if (units === 'imperial') return ((temp - 32) * 5) / 9;
  if (units === 'standard') return temp - 273.15;
  return temp;
}

/**
 * The whole greeting, from a time and an optional weather reading.
 *
 * With no weather this returns the band's weather-less phrasing — the widget
 * needs no branch for "weather missing", which is what keeps the degraded path
 * honest rather than an afterthought.
 */
export function greetingFor({ date = new Date(), weather = null, pick } = {}) {
  const band = bandFor(date.getHours());

  const mood = weather
    ? moodFor({
        conditionId: weather.conditionId,
        temperatureC: toCelsius(weather.temp, weather.units),
      })
    : null;

  return { band: band.id, mood, text: phraseFor({ band: band.id, mood, pick }) };
}
