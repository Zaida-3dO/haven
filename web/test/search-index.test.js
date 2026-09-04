import test from 'node:test';
import assert from 'node:assert/strict';

import { SearchIndex, scoreEntry, MATCH } from '../src/shell/search-index.js';

/**
 * Fixtures are deliberately invented — plausible-looking search results that
 * are nobody's real data. Calendar and alert entries in particular are the
 * exact shape of the personal data this index is careful with, so the test
 * data must not be personal either.
 */
const APPS = [
  {
    id: 'app-reader',
    title: 'Reader',
    subtitle: 'Read-it-later and article archive',
    url: 'https://reader.example.invalid/',
    keywords: ['articles', 'bookmarks', 'https://reader.example.invalid/'],
  },
  {
    id: 'app-photos',
    title: 'Photo Library',
    subtitle: 'Albums and backups',
    url: 'https://photos.example.invalid/',
    keywords: ['pictures', 'albums'],
  },
];

const CALENDAR = [
  {
    id: 'evt-1',
    title: 'Dentist appointment',
    subtitle: 'Tuesday 09:30',
    keywords: ['appointment', 'health'],
  },
  { id: 'evt-2', title: 'Team retro', subtitle: 'Friday 16:00', keywords: ['work'] },
];

const ALERTS = [
  { id: 'alert-1', title: 'Bin day tomorrow', subtitle: 'Recycling', keywords: ['chores'] },
];

function seeded() {
  const index = new SearchIndex();
  index.setEntries('apps-1', APPS, { label: 'Apps' });
  index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
  index.setEntries('alerts-1', ALERTS, { label: 'Alerts' });
  return index;
}

test('indexes entries from several widgets and reports its sources', () => {
  const index = seeded();
  assert.equal(index.size, 5);
  assert.deepEqual(
    index.sources().map((s) => s.label),
    ['Apps', 'Calendar', 'Alerts']
  );
});

test('matches on a title prefix', () => {
  const results = seeded().search('read');
  assert.equal(results[0].title, 'Reader');
});

test('matches on a substring inside the title', () => {
  const results = seeded().search('brary');
  assert.deepEqual(
    results.map((r) => r.title),
    ['Photo Library']
  );
});

test('matches on subtitle and on keywords, not just the title', () => {
  const index = seeded();
  assert.deepEqual(
    index.search('albums').map((r) => r.id),
    ['app-photos']
  );
  assert.deepEqual(
    index.search('chores').map((r) => r.id),
    ['alert-1']
  );
});

test('an app contributes its URLs, so searching a URL finds it', () => {
  const results = seeded().search('reader.example.invalid');
  assert.equal(results[0].id, 'app-reader');
});

test('an exact title match outranks a keyword brush', () => {
  const index = new SearchIndex();
  index.setEntries('w1', [
    // Mentions "retro" only in a keyword...
    { id: 'brush', title: 'Photo Library', keywords: ['retro filters'] },
    // ...against something actually called it.
    { id: 'exact', title: 'Retro' },
  ]);

  const results = index.search('retro');
  assert.equal(results[0].id, 'exact', 'exact title match must come first');
  assert.equal(results[0].score, MATCH.TITLE_EXACT);
  assert.equal(results[1].id, 'brush');
});

test('a title prefix outranks a subtitle match', () => {
  const index = new SearchIndex();
  index.setEntries('w1', [
    { id: 'sub', title: 'Something else', subtitle: 'Team planning' },
    { id: 'title', title: 'Team retro' },
  ]);
  assert.deepEqual(
    index.search('team').map((r) => r.id),
    ['title', 'sub']
  );
});

test('a word-start match ranks as a prefix, not a substring', () => {
  assert.equal(scoreEntry({ title: 'Family calendar' }, 'calendar'), MATCH.TITLE_PREFIX);
  assert.equal(scoreEntry({ title: 'Uncalendared' }, 'calendar'), MATCH.TITLE_SUBSTRING);
});

test('an empty or whitespace query returns nothing rather than everything', () => {
  const index = seeded();
  assert.deepEqual(index.search(''), []);
  assert.deepEqual(index.search('   '), []);
  assert.deepEqual(index.search(null), []);
});

test('a query matching nothing returns no results', () => {
  assert.deepEqual(seeded().search('zzzznothing'), []);
});

test('matching is case-insensitive', () => {
  assert.equal(seeded().search('DENTIST')[0].id, 'evt-1');
});

test('results are grouped by the widget they came from', () => {
  const groups = seeded().searchGrouped('a');
  const labels = groups.map((g) => g.label);
  assert.ok(labels.includes('Apps'));
  assert.ok(labels.includes('Calendar'));
  for (const group of groups) {
    for (const result of group.results) {
      assert.equal(result.widgetId, group.widgetId);
    }
  }
});

test('the widgetId on a result is the pushing widget, not one the entry claims', () => {
  const index = new SearchIndex();
  index.setEntries('real-widget', [{ id: 'e', title: 'Thing', widgetId: 'a-lie' }]);
  assert.equal(index.search('thing')[0].widgetId, 'real-widget');
});

test('limit caps the number of results', () => {
  const index = new SearchIndex();
  index.setEntries(
    'many',
    Array.from({ length: 50 }, (_, i) => ({ id: `e${i}`, title: `Entry ${i}` }))
  );
  assert.equal(index.search('entry').length, 20, 'default limit');
  assert.equal(index.search('entry', { limit: 3 }).length, 3);
});

// ── Replace, not append ───────────────────────────────────────────────────
// A widget refreshing every 30s must not grow the index without bound.

test('re-pushing a widget REPLACES its entries rather than appending', () => {
  const index = new SearchIndex();
  index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
  assert.equal(index.size, 2);

  // The 30s refresh lands with the same data.
  index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
  assert.equal(index.size, 2, 'a refresh must not double the index');

  // And again with changed data: the old entries are gone, not merely joined.
  index.setEntries('calendar-1', [{ id: 'evt-3', title: 'Standup' }], { label: 'Calendar' });
  assert.equal(index.size, 1);
  assert.deepEqual(index.search('dentist'), [], 'a removed event is no longer findable');
});

test('twenty refreshes leave the index the size of one', () => {
  const index = new SearchIndex();
  for (let i = 0; i < 20; i += 1) index.setEntries('apps-1', APPS);
  assert.equal(index.size, APPS.length);
});

test('removing a widget removes its entries', () => {
  const index = seeded();
  assert.equal(index.remove('calendar-1'), true);
  assert.equal(index.size, 3);
  assert.deepEqual(index.search('dentist'), []);
  assert.equal(index.remove('calendar-1'), false, 'removing twice is a no-op');
});

test('pushing an empty set clears that widget from the index', () => {
  const index = seeded();
  index.setEntries('alerts-1', []);
  assert.equal(index.size, 4);
  assert.deepEqual(
    index.sources().map((s) => s.widgetId),
    ['apps-1', 'calendar-1']
  );
});

test('entries without a usable title are dropped', () => {
  const index = new SearchIndex();
  index.setEntries('w1', [
    { id: 'ok', title: 'Keep me' },
    { id: 'blank', title: '   ' },
    { id: 'missing' },
    null,
    'not an object',
  ]);
  assert.equal(index.size, 1);
  assert.equal(index.all()[0].id, 'ok');
});

test('an entry with no id still gets a stable one', () => {
  const index = new SearchIndex();
  index.setEntries('w1', [{ title: 'Anonymous' }]);
  assert.equal(index.all()[0].id, 'w1:0');
});

test('setEntries refuses a missing widgetId', () => {
  const index = new SearchIndex();
  assert.throws(() => index.setEntries('', [{ title: 'x' }]), /widgetId/);
});

test('onChange fires when the index changes', () => {
  let calls = 0;
  const index = new SearchIndex({ onChange: () => (calls += 1) });
  index.setEntries('w1', [{ title: 'A' }]);
  index.remove('w1');
  index.clear();
  assert.equal(calls, 3);
});

// ── Syncing from hosts ────────────────────────────────────────────────────

function fakeHost(id, entries) {
  return { id, getSearchEntries: () => entries.map((e) => ({ ...e, widgetId: id })) };
}

test('syncFromHosts pulls the current entries out of every host', () => {
  const index = new SearchIndex();
  index.syncFromHosts([fakeHost('apps-1', APPS), fakeHost('alerts-1', ALERTS)], {
    labelFor: (host) => (host.id.startsWith('apps') ? 'Apps' : 'Alerts'),
  });
  assert.equal(index.size, 3);
  assert.equal(index.label('apps-1'), 'Apps');
});

test('syncFromHosts drops a widget that has gone away', () => {
  const index = new SearchIndex();
  index.syncFromHosts([fakeHost('apps-1', APPS), fakeHost('alerts-1', ALERTS)]);
  index.syncFromHosts([fakeHost('apps-1', APPS)]);
  assert.equal(index.size, 2);
  assert.deepEqual(index.search('bin day'), []);
});

test('a host whose getSearchEntries yields nothing contributes nothing', () => {
  const index = new SearchIndex();
  index.syncFromHosts([{ id: 'broken', getSearchEntries: () => [] }]);
  assert.equal(index.size, 0);
});

// ── The privacy tripwire ──────────────────────────────────────────────────

/**
 * The index holds calendar event titles and alert contents, and DESIGN §5
 * settles that it is in-memory only — never localStorage, sessionStorage,
 * IndexedDB, the database, or a network call.
 *
 * This test is the tripwire for that decision. It installs spies over every
 * storage and network global and drives the index through its whole
 * lifecycle; if anyone later adds a cache "to make load faster", one of these
 * spies fires and this fails.
 *
 * To see it fail, add a single line to `setEntries` such as
 *   localStorage.setItem('haven-search', JSON.stringify(cleaned));
 * and this test reports the write. Wrapping that same line in
 * `queueMicrotask` or `setTimeout` is also reported — see the drain at the
 * end of the lifecycle below, without which a deferred write fired after the
 * globals were restored and was invisible.
 */
test('the index never touches any persistent store or the network', async () => {
  const touched = [];
  const original = {};

  const storageSpy = (name) => ({
    getItem(k) {
      touched.push(`${name}.getItem(${k})`);
      return null;
    },
    setItem(k) {
      touched.push(`${name}.setItem(${k})`);
    },
    removeItem(k) {
      touched.push(`${name}.removeItem(${k})`);
    },
    key() {
      touched.push(`${name}.key`);
      return null;
    },
    clear() {
      touched.push(`${name}.clear`);
    },
    length: 0,
  });

  const spies = {
    localStorage: storageSpy('localStorage'),
    sessionStorage: storageSpy('sessionStorage'),
    indexedDB: {
      open(n) {
        touched.push(`indexedDB.open(${n})`);
        return {};
      },
      deleteDatabase(n) {
        touched.push(`indexedDB.deleteDatabase(${n})`);
        return {};
      },
    },
    fetch: (...args) => {
      touched.push(`fetch(${String(args[0])})`);
      return Promise.resolve({ ok: true, json: async () => ({}) });
    },
    XMLHttpRequest: class {
      open(...args) {
        touched.push(`XMLHttpRequest.open(${args.join(' ')})`);
      }
      send() {
        touched.push('XMLHttpRequest.send');
      }
      setRequestHeader() {}
    },
    navigator: {
      sendBeacon(u) {
        touched.push(`sendBeacon(${u})`);
        return true;
      },
    },
    caches: {
      open(n) {
        touched.push(`caches.open(${n})`);
        return Promise.resolve({});
      },
    },
  };

  for (const [key, value] of Object.entries(spies)) {
    original[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }

  try {
    // The full lifecycle, with the sensitive data the constraint is about.
    const index = new SearchIndex({ onChange: () => {} });
    index.setEntries('apps-1', APPS, { label: 'Apps' });
    index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
    index.setEntries('alerts-1', ALERTS, { label: 'Alerts' });
    index.setEntries('calendar-1', CALENDAR, { label: 'Calendar' });
    index.syncFromHosts([fakeHost('apps-1', APPS)]);
    index.search('dentist');
    index.searchGrouped('bin');
    index.all();
    index.sources();
    index.remove('apps-1');
    index.clear();

    // **Drain before restoring the globals.** The spies used to be torn down
    // around a purely synchronous body, so a write deferred by even one turn
    // — `queueMicrotask(() => sendBeacon(...))` — landed after the real
    // globals were back and the tripwire never saw it: 27 pass, 0 fail for a
    // leak of the whole index. A cache added "to make load faster" is exactly
    // the kind of thing that would be written asynchronously, so draining here
    // is what makes this tripwire mean what it claims.
    await Promise.resolve(); // microtasks: queueMicrotask, a resolved .then
    await new Promise((resolve) => setTimeout(resolve, 0)); // macrotasks: setTimeout 0
  } finally {
    for (const [key, descriptor] of Object.entries(original)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }

  assert.deepEqual(
    touched,
    [],
    `the search index must stay in memory — it reached for: ${touched.join(', ')}`
  );
});

test('a fresh index starts empty — it is rebuilt each session, never restored', () => {
  const first = new SearchIndex();
  first.setEntries('calendar-1', CALENDAR);
  assert.equal(first.size, 2);

  // Nothing survives into a new instance, because nothing was written anywhere.
  const second = new SearchIndex();
  assert.equal(second.size, 0);
  assert.deepEqual(second.search('dentist'), []);
});
