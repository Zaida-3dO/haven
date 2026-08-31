import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STATUS } from '../src/lib/status.js';
import {
  ALL_CATEGORY,
  SORT,
  STALE_AFTER_MS,
  buildCard,
  buildView,
  categoryTabs,
  filterByCategory,
  primaryUrl,
  safeUrl,
  secondaryUrls,
  sortApps,
  versionAge,
  versionPair,
} from '../src/widgets/apps/model.js';

/** Fixtures use `.invalid` hostnames throughout — see docs/SECURITY.md. */
const appFixture = (overrides = {}) => ({
  id: 'example-service',
  name: 'Example Service',
  description: 'What this service is for.',
  category: 'tools',
  icon: null,
  visitCount: 0,
  urls: [
    { title: 'Open', url: 'https://example.invalid', primary: true },
    { title: 'Open Local', url: 'https://example.local.invalid' },
    { title: 'Open via Tailscale', url: 'https://example.ts.invalid' },
  ],
  ...overrides,
});

describe('categoryTabs', () => {
  test('offers All plus only the categories that have apps', () => {
    const tabs = categoryTabs([
      appFixture({ id: 'a', category: 'media' }),
      appFixture({ id: 'b', category: 'tools' }),
    ]);

    assert.deepEqual(
      tabs.map((t) => t.value),
      [ALL_CATEGORY, 'media', 'tools']
    );
    // An empty category tab would be a dead end.
    assert.ok(!tabs.some((t) => t.value === 'personal'));
  });

  test('counts the apps in each tab', () => {
    const tabs = categoryTabs([
      appFixture({ id: 'a', category: 'media' }),
      appFixture({ id: 'b', category: 'media' }),
      appFixture({ id: 'c', category: 'ai' }),
    ]);

    assert.equal(tabs.find((t) => t.value === ALL_CATEGORY).count, 3);
    assert.equal(tabs.find((t) => t.value === 'media').count, 2);
    assert.equal(tabs.find((t) => t.value === 'ai').count, 1);
  });

  test('keeps the canonical category order rather than insertion order', () => {
    const tabs = categoryTabs([
      appFixture({ id: 'a', category: 'tools' }),
      appFixture({ id: 'b', category: 'personal' }),
    ]);

    assert.deepEqual(
      tabs.map((t) => t.value),
      [ALL_CATEGORY, 'personal', 'tools']
    );
  });
});

describe('filterByCategory', () => {
  const apps = [
    appFixture({ id: 'a', category: 'media' }),
    appFixture({ id: 'b', category: 'tools' }),
  ];

  test('All returns everything', () => {
    assert.equal(filterByCategory(apps, ALL_CATEGORY).length, 2);
  });

  test('a category returns only its apps', () => {
    const filtered = filterByCategory(apps, 'media');
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].id, 'a');
  });

  test('does not mutate the input', () => {
    const original = [...apps];
    filterByCategory(apps, 'media');
    assert.deepEqual(apps, original);
  });
});

describe('sortApps', () => {
  const apps = [
    appFixture({ id: 'a', name: 'Alpha', visitCount: 1, category: 'tools' }),
    appFixture({ id: 'b', name: 'Bravo', visitCount: 9, category: 'ai' }),
    appFixture({ id: 'c', name: 'Charlie', visitCount: 5, category: 'media' }),
  ];

  /**
   * Visit-count sorting is the default and one of the carried-over features:
   * the things you actually open rise to the top on their own.
   */
  test('visits sorts most-visited first', () => {
    assert.deepEqual(
      sortApps(apps, SORT.VISITS).map((a) => a.id),
      ['b', 'c', 'a']
    );
  });

  test('visits falls back to name on a tie, so the order is stable', () => {
    const tied = [
      appFixture({ id: 'z', name: 'Zulu', visitCount: 3 }),
      appFixture({ id: 'm', name: 'Mike', visitCount: 3 }),
    ];
    assert.deepEqual(
      sortApps(tied, SORT.VISITS).map((a) => a.id),
      ['m', 'z']
    );
  });

  test('an app with no visitCount sorts as zero rather than vanishing', () => {
    const mixed = [appFixture({ id: 'n', name: 'NoCount', visitCount: undefined }), apps[1]];
    assert.deepEqual(
      sortApps(mixed, SORT.VISITS).map((a) => a.id),
      ['b', 'n']
    );
  });

  test('name sorts alphabetically', () => {
    assert.deepEqual(
      sortApps(apps, SORT.NAME).map((a) => a.id),
      ['a', 'b', 'c']
    );
  });

  test('category sorts by category then name', () => {
    assert.deepEqual(
      sortApps(apps, SORT.CATEGORY).map((a) => a.category),
      ['ai', 'media', 'tools']
    );
  });

  test('status floats what you can actually open right now', () => {
    const statuses = new Map([
      ['a', { status: STATUS.UNREACHABLE }],
      ['b', { status: STATUS.UNKNOWN }],
      ['c', { status: STATUS.REACHABLE }],
    ]);
    assert.deepEqual(
      sortApps(apps, SORT.STATUS, statuses).map((a) => a.id),
      ['c', 'b', 'a']
    );
  });

  test('does not mutate the input array', () => {
    const order = apps.map((a) => a.id);
    sortApps(apps, SORT.NAME);
    assert.deepEqual(
      apps.map((a) => a.id),
      order
    );
  });
});

describe('primaryUrl', () => {
  test('prefers the entry flagged primary, not the first', () => {
    const app = appFixture({
      urls: [
        { title: 'Local', url: 'https://local.invalid' },
        { title: 'Main', url: 'https://main.invalid', primary: true },
      ],
    });
    assert.equal(primaryUrl(app), 'https://main.invalid');
  });

  test('falls back to the first entry when none is flagged', () => {
    const app = appFixture({ urls: [{ title: 'Only', url: 'https://only.invalid' }] });
    assert.equal(primaryUrl(app), 'https://only.invalid');
  });

  test('is null when there are no urls', () => {
    assert.equal(primaryUrl(appFixture({ urls: [] })), null);
  });
});

describe('secondaryUrls', () => {
  /**
   * The multi-URL menu is the headline feature. It must exclude the URL the
   * card's main click already goes to, and — importantly — it is the RESOLVED
   * target that gets excluded, not the declared primary, because the resolved
   * one is where a click actually lands.
   */
  test('excludes the resolved target, not the declared primary', () => {
    const app = appFixture();
    const menu = secondaryUrls(app, 'https://example.ts.invalid');

    assert.deepEqual(
      menu.map((m) => m.url),
      ['https://example.invalid', 'https://example.local.invalid']
    );
  });

  test('excludes the primary when nothing has been resolved yet', () => {
    const menu = secondaryUrls(appFixture(), null);
    assert.ok(!menu.some((m) => m.url === 'https://example.invalid'));
    assert.equal(menu.length, 2);
  });

  test('carries each URL under its own title', () => {
    const menu = secondaryUrls(appFixture(), 'https://example.invalid');
    assert.deepEqual(
      menu.map((m) => m.title),
      ['Open Local', 'Open via Tailscale']
    );
  });

  test('names an untitled entry rather than rendering a blank', () => {
    const app = appFixture({
      urls: [
        { title: 'Main', url: 'https://main.invalid', primary: true },
        { title: '   ', url: 'https://other.invalid' },
      ],
    });
    assert.equal(secondaryUrls(app, 'https://main.invalid')[0].title, 'Link 2');
  });

  test('is empty for a single-URL app', () => {
    const app = appFixture({
      urls: [{ title: 'Only', url: 'https://only.invalid', primary: true }],
    });
    assert.deepEqual(secondaryUrls(app, 'https://only.invalid'), []);
  });
});

describe('versionPair', () => {
  test('reports an update when the two differ', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: 'v1.2.0', status: 'differs' },
    });

    assert.equal(pair.differs, true);
    assert.match(pair.label, /Update available/);
    assert.match(pair.label, /1\.0\.0/);
    assert.match(pair.label, /1\.2\.0/);
  });

  test('does not report an update when they match', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: '1.0.0', status: 'same' },
    });

    assert.equal(pair.differs, false);
    assert.match(pair.label, /Up to date/);
  });

  /** Missing version info degrades quietly — show what is known, not an error. */
  test('shows the current version alone when there is no latest', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: null, status: 'unknown' },
    });

    assert.equal(pair.known, true);
    assert.equal(pair.differs, false);
    assert.match(pair.label, /Running 1\.0\.0/);
  });

  test('shows the latest version alone when the current is unknown', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: null, latest: '2.0.0', status: 'unknown' },
    });

    assert.equal(pair.known, true);
    assert.match(pair.label, /Latest release 2\.0\.0/);
  });

  test('knows nothing when there is no entry at all, and is not an error', () => {
    const pair = versionPair(appFixture(), {});

    assert.equal(pair.known, false);
    assert.equal(pair.differs, false);
    assert.equal(pair.current, null);
    assert.equal(pair.latest, null);
  });

  test('an upstream error still yields a renderable pair rather than throwing', () => {
    const pair = versionPair(appFixture(), {
      'example-service': {
        current: '1.0.0',
        latest: null,
        status: 'unknown',
        error: 'rate_limited',
      },
    });

    assert.equal(pair.known, true);
    assert.equal(pair.current, '1.0.0');
  });
});

describe('buildCard', () => {
  test('an unprobed app is unknown and still clickable on its primary', () => {
    const card = buildCard(appFixture());

    assert.equal(card.status, STATUS.UNKNOWN);
    assert.equal(card.href, 'https://example.invalid');
  });

  test('the href follows the resolved URL, not the primary', () => {
    const statuses = new Map([
      ['example-service', { status: STATUS.REACHABLE, url: 'https://example.ts.invalid' }],
    ]);
    const card = buildCard(appFixture(), { statuses });

    assert.equal(card.href, 'https://example.ts.invalid');
    assert.equal(card.status, STATUS.REACHABLE);
  });

  /** Colour must not be the only carrier of meaning. */
  test('carries a worded status label naming the app', () => {
    const statuses = new Map([
      ['example-service', { status: STATUS.UNREACHABLE, url: 'https://example.invalid' }],
    ]);
    const card = buildCard(appFixture(), { statuses });

    assert.match(card.statusLabel, /Example Service/);
    assert.match(card.statusLabel, /Not reachable/);
  });

  test('the hover hint names where a click will land', () => {
    const statuses = new Map([
      ['example-service', { status: STATUS.REACHABLE, url: 'https://example.ts.invalid' }],
    ]);
    const card = buildCard(appFixture(), { statuses });

    assert.match(card.urlHint, /example\.ts\.invalid/);
  });

  test('the menu excludes the resolved href', () => {
    const statuses = new Map([
      ['example-service', { status: STATUS.REACHABLE, url: 'https://example.ts.invalid' }],
    ]);
    const card = buildCard(appFixture(), { statuses });

    assert.ok(!card.secondaries.some((s) => s.url === 'https://example.ts.invalid'));
    assert.equal(card.secondaries.length, 2);
  });
});

describe('buildView', () => {
  const apps = [
    appFixture({ id: 'a', name: 'Alpha', category: 'media', visitCount: 2 }),
    appFixture({ id: 'b', name: 'Bravo', category: 'tools', visitCount: 8 }),
  ];

  test('filters and sorts together', () => {
    const view = buildView(apps, { category: ALL_CATEGORY, sort: SORT.VISITS });

    assert.deepEqual(
      view.cards.map((c) => c.id),
      ['b', 'a']
    );
  });

  test('a category narrows the cards but not the tabs', () => {
    const view = buildView(apps, { category: 'media', sort: SORT.NAME });

    assert.equal(view.cards.length, 1);
    // The tabs must still offer every category, or you could not switch back.
    assert.equal(view.tabs.length, 3);
  });

  test('reports empty for a category with nothing in it', () => {
    const view = buildView(apps, { category: 'personal' });

    assert.equal(view.empty, true);
    assert.equal(view.cards.length, 0);
  });

  test('an empty registry is empty rather than an error', () => {
    const view = buildView([], {});

    assert.equal(view.empty, true);
    assert.equal(view.tabs.length, 1);
  });
});

describe('safeUrl', () => {
  /**
   * A `javascript:` href executes on click. The API rejects these, but the
   * seed path (`seedApps` -> `createApp`) does not go through `validateApp`,
   * so the render boundary should not depend on which write path a row
   * arrived by.
   */
  test('rejects a javascript: URL', () => {
    assert.equal(safeUrl('javascript:alert(1)'), null);
  });

  test('rejects a data: URL', () => {
    assert.equal(safeUrl('data:text/html,<script>alert(1)</script>'), null);
  });

  test('rejects other schemes', () => {
    assert.equal(safeUrl('file:///etc/passwd'), null);
    assert.equal(safeUrl('vbscript:msgbox(1)'), null);
  });

  test('allows http and https', () => {
    assert.equal(safeUrl('https://example.invalid'), 'https://example.invalid');
    assert.equal(safeUrl('http://example.invalid'), 'http://example.invalid');
  });

  test('is null for missing input', () => {
    assert.equal(safeUrl(null), null);
    assert.equal(safeUrl(''), null);
    assert.equal(safeUrl('   '), null);
  });

  test('a dangerous primary URL never becomes an href', () => {
    const app = appFixture({
      urls: [{ title: 'Bad', url: 'javascript:alert(1)', primary: true }],
    });
    assert.equal(primaryUrl(app), null);
    assert.equal(buildCard(app).href, null);
  });

  test('a dangerous secondary URL is dropped from the menu', () => {
    const app = appFixture({
      urls: [
        { title: 'Good', url: 'https://good.invalid', primary: true },
        { title: 'Bad', url: 'javascript:alert(1)' },
      ],
    });
    assert.deepEqual(secondaryUrls(app, 'https://good.invalid'), []);
  });

  test('a dangerous resolved URL does not become the card href', () => {
    const statuses = new Map([
      ['example-service', { status: STATUS.REACHABLE, url: 'javascript:alert(1)' }],
    ]);
    const card = buildCard(appFixture(), { statuses });

    assert.notEqual(card.href, 'javascript:alert(1)');
    assert.equal(card.href, 'https://example.invalid');
  });
});

describe('versionPair without a server-computed status', () => {
  /**
   * The server normally sends `status`, but a cached payload from an older
   * build may not. Reporting "no update" in that case would silently hide the
   * one thing the feature exists to show.
   */
  test('compares the strings itself when status is absent', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: '1.3.0' },
    });

    assert.equal(pair.differs, true);
    assert.match(pair.label, /Update available/);
  });

  test('treats a leading v as noise, like the server does', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.2.3', latest: 'v1.2.3' },
    });

    assert.equal(pair.differs, false);
  });

  test('still defers to the server status when it is present', () => {
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: '1.3.0', status: 'same' },
    });

    assert.equal(pair.differs, false);
  });
});

/**
 * Staleness of the running-version reading.
 *
 * This exists because the file behind `current` is written by a separate
 * refresher process, and a refresher that dies fails SILENTLY: the file simply
 * stops changing and the dashboard goes on showing an old version as though it
 * were current. Every test here is guarding the visibility of that failure.
 */
describe('versionAge', () => {
  const NOW = Date.parse('2026-08-31T12:00:00.000Z');
  const at = (iso) => versionAge(iso, () => NOW);

  test('reads a recent timestamp as fresh, with a phrase', () => {
    const age = at('2026-08-31T11:30:00.000Z');

    assert.equal(age.stale, false);
    assert.equal(age.text, '30m ago');
  });

  test('under a minute reads as just now', () => {
    assert.equal(at('2026-08-31T11:59:40.000Z').text, 'just now');
  });

  test('hours and days get their own units', () => {
    assert.equal(at('2026-08-31T09:00:00.000Z').text, '3h ago');
    assert.equal(at('2026-08-28T12:00:00.000Z').text, '3d ago');
  });

  test('a reading older than a day is stale', () => {
    // A refresher worth running runs at least daily, so a reading older than
    // this means something is broken rather than merely slow.
    const age = at('2026-08-30T11:00:00.000Z');

    assert.equal(age.stale, true);
    assert.equal(age.text, '1d ago');
  });

  test('the boundary is inclusive — exactly a day old is already stale', () => {
    assert.equal(at('2026-08-30T12:00:00.000Z').stale, true);
    assert.equal(at('2026-08-30T12:00:01.000Z').stale, false);
  });

  test('a missing or unparseable timestamp is not stale and has no text', () => {
    // No timestamp means the version came from the env map, which has no
    // knowable age. Calling that "stale" would cry wolf on every card.
    assert.deepEqual(at(null), { text: null, stale: false, ms: null });
    assert.deepEqual(at('  '), { text: null, stale: false, ms: null });
    assert.deepEqual(at('not a date'), { text: null, stale: false, ms: null });
  });

  test('a future timestamp is clamped rather than read as negative', () => {
    const age = at('2026-09-01T12:00:00.000Z');

    assert.equal(age.ms, 0);
    assert.equal(age.stale, false);
    assert.equal(age.text, 'just now');
  });

  test('STALE_AFTER_MS is a day', () => {
    assert.equal(STALE_AFTER_MS, 24 * 60 * 60 * 1000);
  });
});

describe('versionPair — staleness of the running version', () => {
  const NOW = Date.parse('2026-08-31T12:00:00.000Z');
  const now = () => NOW;

  test('carries the age of a fresh reading without warning about it', () => {
    const pair = versionPair(
      appFixture(),
      {
        'example-service': {
          current: '1.0.0',
          latest: '1.0.0',
          status: 'same',
          currentAsOf: '2026-08-31T10:00:00.000Z',
        },
      },
      { now }
    );

    assert.equal(pair.currentAge, '2h ago');
    assert.equal(pair.currentStale, false);
    // A fresh reading is context, not an alert — the label stays clean.
    assert.equal(pair.label, 'Up to date (1.0.0)');
  });

  test('a stale reading is called out in the label', () => {
    // The label is what a screen reader announces, so the caveat has to be in
    // it rather than living only in a colour.
    const pair = versionPair(
      appFixture(),
      {
        'example-service': {
          current: '1.0.0',
          latest: '1.0.0',
          status: 'same',
          currentAsOf: '2026-08-01T12:00:00.000Z',
        },
      },
      { now }
    );

    assert.equal(pair.currentStale, true);
    assert.equal(pair.currentAge, '30d ago');
    assert.match(pair.label, /last checked 30d ago/);
    // The underlying facts survive the warning rather than being replaced.
    assert.match(pair.label, /Up to date \(1\.0\.0\)/);
  });

  test('no currentAsOf means no age and no warning', () => {
    // The env-map fallback. Behaviour identical to before the file existed.
    const pair = versionPair(appFixture(), {
      'example-service': { current: '1.0.0', latest: '1.0.0', status: 'same' },
    });

    assert.equal(pair.currentAsOf, null);
    assert.equal(pair.currentAge, null);
    assert.equal(pair.currentStale, false);
    assert.equal(pair.label, 'Up to date (1.0.0)');
  });

  test('staleness does not suppress the update affordance', () => {
    // An old reading is still a reading: if it differs from the latest
    // release, that is still worth showing.
    const pair = versionPair(
      appFixture(),
      {
        'example-service': {
          current: '1.0.0',
          latest: '2.0.0',
          status: 'differs',
          currentAsOf: '2026-07-01T12:00:00.000Z',
        },
      },
      { now }
    );

    assert.equal(pair.differs, true);
    assert.equal(pair.currentStale, true);
    assert.match(pair.label, /Update available/);
    assert.match(pair.label, /last checked/);
  });
});
