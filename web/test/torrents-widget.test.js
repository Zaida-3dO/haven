import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TorrentsWidget,
  torrentsWidgetDefinition,
  DEFAULT_MAX_ROWS,
} from '../src/widgets/torrents/torrents-widget.js';
import { WidgetRegistry } from '../src/shell/registry.js';
import { doneData, staleData, errorData } from '../src/shell/panel-data.js';
import { createFakeDocument, FakeElement } from './helpers/fake-dom.js';

/**
 * The widget renders through the global `document`, exactly as the shell's own
 * tests do, so the fake DOM is installed globally for the duration.
 */
function withFakeDom(run) {
  const document = createFakeDocument();
  const prevDoc = globalThis.document;
  globalThis.document = document;
  try {
    return run(document);
  } finally {
    globalThis.document = prevDoc;
  }
}

/** A widget instance wired to the fake DOM, with a shadow root of its own. */
function makeWidget(config = {}) {
  const widget = new TorrentsWidget();
  // `attachShadow` comes from FakeElement in the real host; here the widget is
  // constructed directly, so it is given a shadow root to render into.
  widget.shadowRoot = new FakeElement('#shadow-root');
  widget.setConfig({ maxRows: DEFAULT_MAX_ROWS, ...config });
  return widget;
}

const torrent = (overrides = {}) => ({
  hash: 'aaaa',
  name: 'ubuntu-24.04-desktop-amd64.iso',
  progress: 0.42,
  state: 'downloading',
  dlspeed: 1_500_000,
  upspeed: 250_000,
  size: 6_000_000_000,
  eta: 2_400,
  category: 'linux',
  ...overrides,
});

const payload = (value, previous = null) => doneData(value, { previous });

/** The rendered list element, found through the fake DOM's class lookup. */
const listOf = (widget) => widget.shadowRoot.querySelector('.torrents__list');

/**
 * The visible text only.
 *
 * Deliberately NOT `shadowRoot.textContent`: that would include the `<style>`
 * block, whose CSS class names contain words like "error" — and an assertion
 * that a tile shows no error would then pass or fail on a stylesheet.
 */
/** The class list on the notice line — where the stale marker lives. */
const noticeClasses = (widget) => {
  const root = widget.shadowRoot.children.find((c) => String(c.className).startsWith('torrents'));
  const notice = root.children.find((c) => String(c.className).includes('torrents__notice'));
  return String(notice?.className ?? '').split(/\s+/);
};

const textOf = (widget) => {
  const root =
    widget.shadowRoot.querySelector('.torrents') ??
    widget.shadowRoot.querySelector('.torrents torrents--narrow');
  return root ? root.textContent : '';
};

test('renders a torrent with name, progress, speeds and ETA', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(payload({ configured: true, torrents: [torrent()] }));

    const text = textOf(widget);
    assert.match(text, /ubuntu-24\.04-desktop-amd64\.iso/);
    assert.match(text, /Downloading/);
    assert.match(text, /42%/);
    assert.match(text, /↓ 1\.5 MB\/s/);
    assert.match(text, /↑ 250 kB\/s/);
    assert.match(text, /40m/);
  });
});

test('the progress bar is set from progress, not from text', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    widget.onData(payload({ configured: true, torrents: [torrent({ progress: 0.25 })] }));

    const fill = widget.shadowRoot.querySelector('.torrent__fill');
    assert.equal(fill.style.width, '25.0%');
  });
});

test('the full name is on hover even when the visible one is truncated', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    const long = 'a.very.long.torrent.release.name.2160p.WEB-DL.HEVC-SOMEGROUP.mkv';

    widget.onData(payload({ configured: true, torrents: [torrent({ name: long })] }));

    const name = widget.shadowRoot.querySelector('.torrent__name');
    assert.equal(name.getAttribute('title'), long, 'the full name must survive as a tooltip');
    assert.ok(name.textContent.length < long.length, 'the visible name should be shortened');
  });
});

/**
 * The rule the contract is bluntest about: never re-render on every tick.
 */
test('an update patches the existing rows rather than rebuilding them', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    const first = payload({ configured: true, torrents: [torrent()] });
    widget.onData(first);

    const rowBefore = listOf(widget).children[0];

    widget.onData(
      payload(
        { configured: true, torrents: [torrent({ progress: 0.6, dlspeed: 2_000_000 })] },
        first
      )
    );

    const rowAfter = listOf(widget).children[0];
    // Identity: the SAME element object, not an equivalent new one. A rebuild
    // would lose scroll position and kill the progress-bar transition.
    assert.equal(rowAfter, rowBefore, 'the row element must be reused, not recreated');
    assert.match(rowAfter.textContent, /60%/);
    assert.match(rowAfter.textContent, /↓ 2\.0 MB\/s/);
  });
});

test('a torrent that disappears takes its row with it', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    const first = payload({
      configured: true,
      torrents: [torrent({ hash: 'a', name: 'a' }), torrent({ hash: 'b', name: 'b' })],
    });
    widget.onData(first);
    assert.deepEqual(widget.renderedHashes, ['a', 'b']);

    widget.onData(
      payload({ configured: true, torrents: [torrent({ hash: 'b', name: 'b' })] }, first)
    );

    assert.deepEqual(widget.renderedHashes, ['b']);
  });
});

test('reordering moves rows instead of recreating them', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    const slow = torrent({ hash: 'slow', name: 'slow', dlspeed: 1_000 });
    const fast = torrent({ hash: 'fast', name: 'fast', dlspeed: 900_000 });

    const first = payload({ configured: true, torrents: [slow, fast] });
    widget.onData(first);
    assert.deepEqual(widget.renderedHashes, ['fast', 'slow']);

    const slowRow = listOf(widget).children[1];

    // The slow one speeds up and overtakes.
    widget.onData(
      payload(
        {
          configured: true,
          torrents: [
            { ...slow, dlspeed: 5_000_000 },
            { ...fast, dlspeed: 10_000 },
          ],
        },
        first
      )
    );

    assert.deepEqual(widget.renderedHashes, ['slow', 'fast']);
    assert.equal(listOf(widget).children[0], slowRow, 'the row moved, it was not rebuilt');
  });
});

test('caps the list and says how many are hidden', () => {
  withFakeDom(() => {
    const widget = makeWidget({ maxRows: 3 });
    const many = Array.from({ length: 12 }, (_, i) =>
      torrent({ hash: `h${i}`, name: `t${i}`, state: 'seeding' })
    );

    widget.onData(payload({ configured: true, torrents: many }));

    assert.equal(widget.renderedHashes.length, 3);
    assert.match(textOf(widget), /\+9 more/);
  });
});

test('nothing downloading is an empty state, not an error', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(payload({ configured: true, torrents: [] }));

    const text = textOf(widget);
    assert.match(text, /Nothing downloading/i);
    assert.doesNotMatch(text, /error/i);
    assert.doesNotMatch(text, /unreachable/i);
  });
});

test('stale data renders the data plus a marker, never an error box', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    const value = {
      configured: true,
      stale: true,
      torrents: [torrent()],
      notices: [{ message: 'Showing cached data', stale: true }],
    };

    widget.onData(staleData(value));

    // The soft-notice rule: the torrent is still there, with a marker over it.
    assert.match(textOf(widget), /ubuntu-24\.04/);
    assert.match(textOf(widget), /Showing cached data/);
    // The marker is a class on the notice line, not a separate error box.
    assert.ok(
      noticeClasses(widget).includes('torrents__notice--stale'),
      'a stale payload should carry the stale marker class'
    );
  });
});

test('an unreachable service is a clear tile that promises to recover', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(
      payload({
        configured: true,
        unreachable: true,
        authFailed: false,
        torrents: [],
        notices: [{ message: 'qBittorrent is not reachable right now.' }],
      })
    );

    const text = textOf(widget);
    assert.match(text, /unreachable/i);
    assert.match(text, /reconnect/i);
  });
});

test('an auth failure says what to fix, which is a different fix', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(
      payload({ configured: true, unreachable: true, authFailed: true, torrents: [], notices: [] })
    );

    const text = textOf(widget);
    assert.match(text, /rejected the login/i);
    assert.match(text, /username and password/i);
  });
});

test('not configured is a hint, not an error card', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(
      payload({
        configured: false,
        torrents: [],
        notices: [
          { message: 'not configured', hint: 'Set HAVEN_QBITTORRENT_URL, _USER and _PASS.' },
        ],
      })
    );

    const text = textOf(widget);
    assert.match(text, /not configured/i);
    assert.match(text, /HAVEN_QBITTORRENT_URL/);
  });
});

test('a hard error with no cached payload still renders a tile', () => {
  withFakeDom(() => {
    const widget = makeWidget();

    widget.onData(errorData(new Error('Request failed: 500')));

    assert.match(textOf(widget), /Could not load torrents/i);
  });
});

test('the narrow breakpoint drops the secondary details', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    widget.onData(payload({ configured: true, torrents: [torrent()] }));

    const rootOf = (w) => w.shadowRoot.children.find((c) => c.className.startsWith('torrents'));

    assert.equal(rootOf(widget).className, 'torrents');

    widget.onResize(2, 3);

    // The class is what hides the extra columns; without it a narrow tile
    // wraps, which is what actually breaks the layout on a phone.
    assert.equal(rootOf(widget).className, 'torrents torrents--narrow');
  });
});

test('names are shortened harder on a narrow tile', () => {
  withFakeDom(() => {
    const long = 'a.very.long.torrent.release.name.2160p.WEB-DL.HEVC-SOMEGROUP.mkv';
    const wide = makeWidget();
    wide.onData(payload({ configured: true, torrents: [torrent({ name: long })] }));
    const wideText = wide.shadowRoot.querySelector('.torrent__name').textContent;

    const narrow = makeWidget();
    narrow.onResize(2, 3);
    narrow.onData(payload({ configured: true, torrents: [torrent({ name: long })] }));
    const narrowText = narrow.shadowRoot.querySelector('.torrent__name').textContent;

    assert.ok(narrowText.length < wideText.length);
  });
});

test('setConfig throws on a bad config — the contract the error card relies on', () => {
  withFakeDom(() => {
    const widget = new TorrentsWidget();
    widget.shadowRoot = new FakeElement('#shadow-root');

    assert.throws(() => widget.setConfig({ maxRows: 0 }), /maxRows/);
    assert.throws(() => widget.setConfig({ maxRows: 'lots' }), /maxRows/);
  });
});

test('search entries name each torrent and its state', () => {
  withFakeDom(() => {
    const widget = makeWidget();
    widget.onData(payload({ configured: true, torrents: [torrent()] }));

    const entries = widget.getSearchEntries();

    assert.equal(entries.length, 1);
    assert.equal(entries[0].title, 'ubuntu-24.04-desktop-amd64.iso');
    assert.match(entries[0].subtitle, /Downloading/);
    assert.ok(entries[0].keywords.includes('torrent'));
  });
});

test('the definition registers, and its dataSource is a credential-free /api call', () => {
  const registry = new WidgetRegistry();
  const definition = registry.register(torrentsWidgetDefinition);

  assert.equal(definition.type, 'torrents');
  assert.equal(definition.searchable, true);
  // The host owns the schedule — the widget declares an interval and never
  // acts on it.
  assert.ok(definition.refreshMs > 0);

  const request = definition.dataSource({ maxRows: 6 });
  assert.equal(request.url, '/api/widgets/torrents');
  // Two torrent widgets on one dashboard must collapse to one request.
  assert.equal(request.key, 'widgets/torrents');
  assert.equal(JSON.stringify(request).includes('password'), false);
});

test('the stub config makes an added widget work immediately', () => {
  const registry = new WidgetRegistry();
  registry.register(torrentsWidgetDefinition);

  const stub = registry.stubConfig('torrents');

  assert.equal(stub.maxRows, DEFAULT_MAX_ROWS);
  assert.equal(stub.configVersion, 1);
});

test('the widget module never mentions a credential or an upstream address', async () => {
  // A structural guard on the rule that matters most: the shell talks to
  // /api/*, and anything qBittorrent-specific belongs in the backend.
  const source = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('../src/widgets/torrents/torrents-widget.js', import.meta.url), 'utf8')
  );

  assert.doesNotMatch(source, /HAVEN_QBITTORRENT_PASS\s*[:=]/);
  assert.doesNotMatch(source, /api\/v2/);
});
