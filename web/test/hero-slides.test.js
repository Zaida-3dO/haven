import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  APP_SLIDE,
  COVER_BASE,
  IMAGE_SLIDE,
  coverSrc,
  normaliseSlide,
  normaliseSlides,
  safeUrl,
  shouldAutoRotate,
  slidesFrom,
  step,
} from '../src/widgets/hero/slides.js';
import { doneData, errorData } from '../src/shell/panel-data.js';

describe('safeUrl', () => {
  test('accepts http and https', () => {
    assert.equal(safeUrl('https://example.invalid/app'), 'https://example.invalid/app');
    assert.equal(safeUrl('http://example.invalid'), 'http://example.invalid');
  });

  test('rejects javascript: — a slide URL is stored input, not a constant', () => {
    // eslint-disable-next-line no-script-url
    assert.equal(safeUrl('javascript:alert(1)'), null);
    assert.equal(safeUrl('data:text/html,<script>'), null);
    assert.equal(safeUrl('vbscript:msgbox'), null);
  });

  test('accepts a relative URL and does NOT rewrite it to absolute', () => {
    // The dummy base exists only to parse the protocol; returning the resolved
    // absolute URL would silently move a link to a different origin.
    assert.equal(safeUrl('/apps/thing'), '/apps/thing');
  });

  test('rejects empty and non-string input', () => {
    assert.equal(safeUrl(''), null);
    assert.equal(safeUrl('   '), null);
    assert.equal(safeUrl(undefined), null);
    assert.equal(safeUrl(42), null);
  });
});

describe('coverSrc', () => {
  test('resolves a bare cover filename against the icons route', () => {
    assert.equal(coverSrc({ cover: 'hero-thing.jpg' }), `${COVER_BASE}hero-thing.jpg`);
  });

  test('encodes a filename so a space cannot break the URL', () => {
    assert.equal(coverSrc({ cover: 'my cover.png' }), `${COVER_BASE}my%20cover.png`);
  });

  test('rejects a cover carrying a path, even though the server refuses to store one', () => {
    // Defence in depth: a slide can also come from widget config, which the
    // server never validated.
    assert.equal(coverSrc({ cover: '../../etc/passwd' }), null);
    assert.equal(coverSrc({ cover: 'a/b.png' }), null);
    assert.equal(coverSrc({ cover: String.raw`a\b.png` }), null);
  });

  test('an image slide may carry an absolute src, protocol-checked', () => {
    assert.equal(coverSrc({ src: 'https://cdn.invalid/a.png' }), 'https://cdn.invalid/a.png');
    // eslint-disable-next-line no-script-url
    assert.equal(coverSrc({ src: 'javascript:alert(1)' }), null);
  });

  test('no cover and no src is null, not an empty string', () => {
    assert.equal(coverSrc({}), null);
    assert.equal(coverSrc({ cover: '  ' }), null);
  });
});

describe('normaliseSlide', () => {
  test('an app slide keeps its title, tagline, cover and link', () => {
    const slide = normaliseSlide({
      id: 'ledger',
      type: 'app',
      title: 'Ledger',
      tagline: 'Track what you spend',
      cover: 'hero-ledger.jpg',
      url: 'https://ledger.invalid',
    });

    assert.equal(slide.type, APP_SLIDE);
    assert.equal(slide.title, 'Ledger');
    assert.equal(slide.tagline, 'Track what you spend');
    assert.equal(slide.image, `${COVER_BASE}hero-ledger.jpg`);
    assert.equal(slide.url, 'https://ledger.invalid');
  });

  test('defaults to an app slide when the type is missing or unknown', () => {
    assert.equal(normaliseSlide({ title: 'A' }).type, APP_SLIDE);
    assert.equal(normaliseSlide({ type: 'nonsense', title: 'A' }).type, APP_SLIDE);
  });

  test('an app slide with no title is dropped — there is nothing to read', () => {
    assert.equal(normaliseSlide({ type: 'app', cover: 'a.png' }), null);
    assert.equal(normaliseSlide({ type: 'app', title: '   ' }), null);
  });

  test('an image slide with no image is dropped, but needs no title', () => {
    assert.equal(normaliseSlide({ type: 'image' }), null);
    const slide = normaliseSlide({ type: 'image', cover: 'a.png' });
    assert.equal(slide.type, IMAGE_SLIDE);
    assert.equal(slide.title, '');
  });

  test('an unsafe URL is stripped without dropping the whole slide', () => {
    // The slide is still readable; only the link is refused.
    // eslint-disable-next-line no-script-url
    const slide = normaliseSlide({ title: 'A', url: 'javascript:alert(1)' });
    assert.equal(slide.title, 'A');
    assert.equal(slide.url, null);
  });

  test('a slide with no id gets a stable positional one', () => {
    assert.equal(normaliseSlide({ title: 'A' }, 3).id, 'slide-3');
  });

  test('non-objects are dropped rather than throwing', () => {
    for (const bad of [null, undefined, 'string', 42, []]) {
      assert.equal(normaliseSlide(bad), null, `${JSON.stringify(bad)} should be dropped`);
    }
  });
});

describe('normaliseSlides', () => {
  test('one malformed slide is dropped, not the whole hero', () => {
    const slides = normaliseSlides([
      { title: 'Good' },
      { type: 'app' }, // no title
      null,
      { title: 'Also good' },
    ]);

    assert.deepEqual(
      slides.map((s) => s.title),
      ['Good', 'Also good']
    );
  });

  test('a non-array is an empty list, not a throw', () => {
    assert.deepEqual(normaliseSlides(undefined), []);
    assert.deepEqual(normaliseSlides({ slides: [] }), []);
  });
});

describe('slidesFrom', () => {
  test('reads the endpoint shape { slides: [...] }', () => {
    const data = doneData({ slides: [{ title: 'A' }] });
    assert.equal(slidesFrom(data).length, 1);
  });

  test('also accepts a bare array', () => {
    assert.equal(slidesFrom(doneData([{ title: 'A' }])).length, 1);
  });

  test('an error payload with no value yields no slides rather than throwing', () => {
    assert.deepEqual(slidesFrom(errorData(new Error('down'))), []);
    assert.deepEqual(slidesFrom(null), []);
  });
});

describe('step', () => {
  test('wraps forward past the end', () => {
    assert.equal(step(2, 3, 1), 0);
  });

  test('wraps backward past the start — the case a naive modulo gets wrong', () => {
    // (0 - 1) % 3 is -1 in JavaScript, which would index off the array.
    assert.equal(step(0, 3, -1), 2);
  });

  test('a zero or negative count is index zero, not NaN', () => {
    assert.equal(step(0, 0, 1), 0);
    assert.equal(step(5, 0, -1), 0);
  });

  test('clamps an out-of-range index back into the list', () => {
    assert.equal(step(9, 3, 0), 0);
  });
});

describe('shouldAutoRotate', () => {
  test('rotates with more than one slide, unpaused and full motion', () => {
    assert.equal(shouldAutoRotate({ count: 3, paused: false, reducedMotion: false }), true);
  });

  test('reduced motion stops it outright', () => {
    // Not shortened, not slowed — this setting is a request not to be shown
    // moving content, and an auto-playing banner is the clearest case of it.
    assert.equal(shouldAutoRotate({ count: 3, paused: false, reducedMotion: true }), false);
  });

  test('paused stops it — hover or focus', () => {
    assert.equal(shouldAutoRotate({ count: 3, paused: true, reducedMotion: false }), false);
  });

  test('one slide is not a carousel', () => {
    assert.equal(shouldAutoRotate({ count: 1, paused: false, reducedMotion: false }), false);
    assert.equal(shouldAutoRotate({ count: 0, paused: false, reducedMotion: false }), false);
  });
});
