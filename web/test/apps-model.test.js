import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { STATUS } from '../src/lib/status.js';
import {
  ALL_CATEGORY,
  SORT,
  buildCard,
  buildView,
  categoryTabs,
  filterByCategory,
  primaryUrl,
  secondaryUrls,
  sortApps,
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
