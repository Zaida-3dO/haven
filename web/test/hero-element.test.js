import assert from 'node:assert/strict';
import test, { describe, after } from 'node:test';

import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';
import { doneData, errorData } from '../src/shell/panel-data.js';

/**
 * The element resolves its base class at module load — `HTMLElement` in a
 * browser, a bare class under `node --test`, which is what lets the widget's
 * pure logic be imported without a DOM emulator. That bare class has no
 * `attachShadow`, so a minimal `HTMLElement` and `document` are installed
 * BEFORE the module is imported, and removed afterwards so no other suite
 * inherits them.
 *
 * `FakeElement` is the same double the host suite uses, so the element is
 * exercised against the shared helper rather than a bespoke one.
 */
const realDocument = globalThis.document;
const realHTMLElement = globalThis.HTMLElement;

globalThis.document = createFakeDocument();
globalThis.HTMLElement = class extends FakeElement {
  constructor() {
    super('haven-widget-hero');
  }
};

const { HavenHeroWidget, handleSwipe, SWIPE_THRESHOLD_PX } = await import(
  '../src/widgets/hero/element.js'
);

after(() => {
  globalThis.document = realDocument;
  globalThis.HTMLElement = realHTMLElement;
});

const SLIDES = [
  {
    id: 'ledger',
    type: 'app',
    title: 'Ledger',
    tagline: 'Track what you spend',
    cover: 'hero-ledger.jpg',
    url: 'https://ledger.invalid',
  },
  {
    id: 'atlas',
    type: 'app',
    title: 'Atlas',
    tagline: 'Every map you own',
    cover: 'hero-atlas.jpg',
    url: 'https://atlas.invalid',
  },
  { id: 'banner', type: 'image', cover: 'banner.png' },
];

/**
 * Builds an element with the ticker replaced by a hand-driven one, so a
 * rotation happens exactly when the test says so.
 */
function makeHero({ config = {}, slides = SLIDES, reducedMotion = false, connect = true } = {}) {
  const el = new HavenHeroWidget();
  const rotations = { subscribed: 0, fire: null, unsubscribed: 0 };

  el.reducedMotion = () => reducedMotion;
  el.subscribeRotation = ({ shouldRotate, onRotate }) => {
    rotations.subscribed += 1;
    rotations.fire = () => {
      if (shouldRotate()) onRotate();
    };
    return () => void (rotations.unsubscribed += 1);
  };

  el.setConfig(config);
  if (connect) el.connectedCallback();
  if (slides) el.onData(doneData({ slides }));

  return { el, rotations };
}

/** The rendered nodes, by class, out of the shadow root. */
const find = (el, className) => el.shadowRoot.querySelector(className);

describe('rendering', () => {
  test('renders the first slide with its title, tagline and cover', () => {
    const { el } = makeHero();

    assert.equal(find(el, '.hero__title').textContent, 'Ledger');
    assert.equal(find(el, '.hero__tagline').textContent, 'Track what you spend');
    assert.equal(
      find(el, '.hero__img').getAttribute('src'),
      '/api/apps/icons/hero-ledger.jpg'
    );
  });

  test('an app slide is a link to the app, with a describing label', () => {
    const { el } = makeHero();
    const slide = find(el, '.hero__slide');

    assert.equal(slide.getAttribute('href'), 'https://ledger.invalid');
    assert.equal(slide.getAttribute('rel'), 'noopener noreferrer');
    assert.equal(slide.getAttribute('aria-label'), 'Open Ledger');
  });

  test('a slide with no URL is not a link — the href is REMOVED, not empty', () => {
    // An anchor with href="" points at the current page and is still
    // focusable, so it must be removed rather than blanked.
    const { el } = makeHero({ slides: [{ type: 'image', cover: 'a.png' }] });
    const slide = find(el, '.hero__slide');

    assert.equal(slide.getAttribute('href'), null);
    assert.equal(slide.getAttribute('rel'), null);
  });

  test('the cover image is lazy-loaded and async-decoded', () => {
    // A hero is the easiest place in a dashboard to ship a 4MB JPEG.
    const { el } = makeHero();
    const img = find(el, '.hero__img');

    assert.equal(img.getAttribute('loading'), 'lazy');
    assert.equal(img.getAttribute('decoding'), 'async');
  });

  test('the cover carries an empty alt — it is decorative, the title says it', () => {
    const { el } = makeHero();
    assert.equal(find(el, '.hero__img').getAttribute('alt'), '');
  });

  test('showTagline: false hides the tagline', () => {
    const { el } = makeHero({ config: { showTagline: false } });
    assert.equal(find(el, '.hero__tagline').hidden, true);
  });

  test('the carousel announces itself as one', () => {
    const { el } = makeHero();
    const hero = find(el, '.hero');

    assert.equal(hero.getAttribute('role'), 'group');
    assert.equal(hero.getAttribute('aria-roledescription'), 'carousel');
  });

  test('before any data it says loading, not "nothing featured"', () => {
    // The two are different states and conflating them would be a lie shown
    // on every first paint.
    const { el } = makeHero({ slides: null });
    assert.match(find(el, '.hero__empty').textContent, /Loading/);
  });

  test('an empty slide list after data says nothing is featured', () => {
    const { el } = makeHero({ slides: [] });
    assert.match(find(el, '.hero__empty').textContent, /Nothing featured/);
  });
});

describe('navigation', () => {
  test('next and previous wrap in both directions', () => {
    const { el } = makeHero();

    assert.equal(el.index, 0);
    el.next();
    assert.equal(find(el, '.hero__title').textContent, 'Atlas');
    el.next();
    el.next();
    assert.equal(el.index, 0, 'forward wraps to the start');

    el.previous();
    assert.equal(el.index, 2, 'backward wraps to the end');
  });

  test('the arrow keys navigate', () => {
    const { el } = makeHero();
    const hero = find(el, '.hero');

    hero.dispatchEvent({ type: 'keydown', key: 'ArrowRight' });
    assert.equal(el.index, 1);

    hero.dispatchEvent({ type: 'keydown', key: 'ArrowLeft' });
    assert.equal(el.index, 0);
  });

  test('an unrelated key does nothing', () => {
    const { el } = makeHero();
    find(el, '.hero').dispatchEvent({ type: 'keydown', key: 'a' });
    assert.equal(el.index, 0);
  });

  test('the hero is reachable by keyboard at all', () => {
    const { el } = makeHero();
    assert.equal(find(el, '.hero').getAttribute('tabindex'), '0');
  });

  test('a dot jumps to its slide and marks itself current', () => {
    const { el } = makeHero();
    const dots = find(el, '.hero__nav').children;

    assert.equal(dots.length, 3);
    assert.equal(dots[0].getAttribute('aria-current'), 'true');

    dots[2].dispatchEvent({ type: 'click' });

    assert.equal(el.index, 2);
    assert.equal(dots[2].getAttribute('aria-current'), 'true');
    assert.equal(dots[0].getAttribute('aria-current'), 'false');
  });

  test('the dots are NOT rebuilt on a rotation — that would drop keyboard focus', () => {
    const { el } = makeHero();
    const before = find(el, '.hero__nav').children[0];

    el.next();

    assert.equal(find(el, '.hero__nav').children[0], before, 'same node, patched in place');
  });

  test('a single slide hides the dots — there is nothing to navigate between', () => {
    const { el } = makeHero({ slides: [SLIDES[0]] });
    assert.equal(find(el, '.hero__nav').hidden, true);
  });
});

describe('swipe', () => {
  test('a swipe left advances, a swipe right goes back', () => {
    const { el } = makeHero();

    handleSwipe(200, 200 - SWIPE_THRESHOLD_PX - 1, el);
    assert.equal(el.index, 1, 'swiping left moves forward, like every native pager');

    handleSwipe(200, 200 + SWIPE_THRESHOLD_PX + 1, el);
    assert.equal(el.index, 0);
  });

  test('a short drag is a tap, not a swipe', () => {
    const { el } = makeHero();
    handleSwipe(200, 200 - (SWIPE_THRESHOLD_PX - 1), el);
    assert.equal(el.index, 0, 'below the threshold must not navigate');
  });

  test('a touch with no end position is ignored rather than throwing', () => {
    const { el } = makeHero();
    assert.equal(handleSwipe(200, null, el), null);
    assert.equal(el.index, 0);
  });
});

describe('rotation and pausing', () => {
  test('the ticker advances the slide', () => {
    const { el, rotations } = makeHero();

    rotations.fire();
    assert.equal(el.index, 1);
  });

  test('hovering pauses it, leaving resumes it', () => {
    const { el, rotations } = makeHero();
    const hero = find(el, '.hero');

    hero.dispatchEvent({ type: 'mouseenter' });
    assert.equal(el.paused, true);
    rotations.fire();
    assert.equal(el.index, 0, 'a hovered hero must not change under the reader');

    hero.dispatchEvent({ type: 'mouseleave' });
    rotations.fire();
    assert.equal(el.index, 1);
  });

  test('focus INSIDE the hero pauses it — a keyboard user is mid-interaction', () => {
    // focusin, not focus: the focus lands on the slide's link or a dot, not on
    // the container itself.
    const { el, rotations } = makeHero();
    const hero = find(el, '.hero');

    hero.dispatchEvent({ type: 'focusin' });
    rotations.fire();
    assert.equal(el.index, 0);

    hero.dispatchEvent({ type: 'focusout' });
    rotations.fire();
    assert.equal(el.index, 1);
  });

  test('reduced motion stops auto-rotation but NOT manual navigation', () => {
    const { el, rotations } = makeHero({ reducedMotion: true });

    rotations.fire();
    assert.equal(el.index, 0, 'it must not move on its own');

    el.next();
    assert.equal(el.index, 1, 'but it must still function');
  });

  test('a single slide does not auto-rotate', () => {
    const { el } = makeHero({ slides: [SLIDES[0]] });
    assert.equal(el.autoRotates, false);
  });

  test('the rotation interval comes from config and is clamped', () => {
    assert.equal(makeHero({ config: { rotateSeconds: 15 } }).el.rotateMs, 15_000);
    // A zero would mean a rotation on every tick of the shared ticker.
    assert.equal(makeHero({ config: { rotateSeconds: 0 } }).el.rotateMs, 3000);
    assert.equal(makeHero({ config: { rotateSeconds: 9999 } }).el.rotateMs, 120_000);
    assert.equal(makeHero({ config: { rotateSeconds: 'nonsense' } }).el.rotateMs, 8000);
  });
});

describe('data and lifecycle', () => {
  test('a refetch that keeps your slide does not throw you back to the first', () => {
    const { el } = makeHero();
    el.next();
    el.next();
    assert.equal(el.index, 2);

    el.onData(doneData({ slides: [...SLIDES, { title: 'New', type: 'app' }] }));

    assert.equal(el.index, 2, 'the index is clamped, not reset');
  });

  test('a refetch that shrinks the list past your slide resets the index', () => {
    const { el } = makeHero();
    el.next();
    el.next();

    el.onData(doneData({ slides: [SLIDES[0]] }));

    assert.equal(el.index, 0);
  });

  test('an error renders a fallback tile with the bad config preserved', () => {
    // A misconfigured widget must be openable and fixable, not only deletable.
    const { el } = makeHero({ config: { rotateSeconds: 8 } });
    el.onData(errorData(new Error('hero endpoint is down')));

    const box = find(el, '.hero__error');
    assert.match(box.textContent, /hero endpoint is down/);
    assert.match(box.textContent, /rotateSeconds/);
  });

  test('setConfig throws on a bad type — the contract, not a suggestion', () => {
    const el = new HavenHeroWidget();
    assert.throws(() => el.setConfig({ showTagline: 'yes' }), /showTagline must be a boolean/);
  });

  test('setConfig preserves the offending config for the error card', () => {
    const el = new HavenHeroWidget();
    const bad = { showTagline: 'yes' };
    assert.throws(() => el.setConfig(bad));
    assert.equal(el.origConfig, bad);
  });

  test('search entries cover the app slides only', () => {
    // An image slide has nothing to search for and no app to jump to.
    const { el } = makeHero();
    const entries = el.getSearchEntries();

    assert.deepEqual(
      entries.map((e) => e.title),
      ['Ledger', 'Atlas']
    );
    assert.equal(entries[0].url, 'https://ledger.invalid');
  });

  test('destroy unsubscribes from the shared ticker', () => {
    // A removed widget must not leave a subscriber on the shared timer.
    const { el, rotations } = makeHero();
    el.destroy();
    assert.equal(rotations.unsubscribed, 1);
  });

  test('disconnecting unsubscribes too', () => {
    const { el, rotations } = makeHero();
    el.disconnectedCallback();
    assert.equal(rotations.unsubscribed, 1);
  });
});
