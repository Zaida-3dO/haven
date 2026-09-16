/**
 * The apps-card subtitle row: description and kebab share ONE row.
 *
 * ── Why this spec exists ──────────────────────────────────────────────────
 * `apps-widget.js#renderCard` builds a single `.card__subtitle-row` that holds
 * both `.card__description` and the kebab menu container (`#renderMenu`,
 * always appended — see the comment at apps-widget.js:439-440). No DOM test
 * covers this: `web/test/apps-widget.test.js` explicitly scopes itself to
 * "definition and data contract... no DOM", and no Playwright spec touched
 * this widget before now.
 *
 * A unit test structurally cannot stand in for this one. The fake DOM in
 * `web/test/helpers/fake-dom.js` has no layout engine and would happily let a
 * kebab button sit as a sibling of `.card__subtitle-row` rather than a child
 * of it — the exact defect this spec exists to catch. Only real DOM parentage
 * (`element.parentElement`), asked of a real browser, tells the two apart.
 *
 * ── How the widget is driven ──────────────────────────────────────────────
 * The e2e harness seeds NO apps (`HAVEN_APPS_CONFIG` points at a path that
 * does not exist — see `web/e2e/server.js`), so the live `apps-main` widget
 * renders its empty state, not a card. Rather than stand up a real apps.json
 * fixture (out of this spec's territory — `docs/`, `server/src/*` are owned
 * by sibling crews), this spec calls the widget custom element's own
 * `onData()` directly with an in-memory app, exactly the shape `WidgetHost`
 * itself pushes (`host.js`: `this.#element.onData?.(data)`, where
 * `data.value` is read by `readPayload`). That is the real render path with
 * real data, not a mock of one — the same call the shell makes on every
 * refresh tick, just triggered once from the test instead of from a fetch.
 *
 * ── Coordination note ──────────────────────────────────────────────────────
 * A sibling crew is concurrently fixing eef15ff5 (two-line description
 * alignment) in web/src/widgets/apps/styles.js. This spec does not touch that
 * file and asserts STRUCTURE (same-row parentage) rather than any layout or
 * alignment property, so it holds regardless of how that CSS fix lands.
 */

import { test, expect, waitForDashboard } from './fixtures.js';

const APPS_WIDGET_ID = 'apps-main';

/** One app with a description, so `.card__description` renders. */
const APP_WITH_DESCRIPTION = {
  id: 'e2e-subtitle-app',
  name: 'Subtitle Row Probe',
  description: 'A fixture app used only to exercise the subtitle row.',
  category: 'tools',
  urls: [{ title: 'Open', url: 'https://subtitle-row-probe.invalid', primary: true }],
};

/** An app with no description, but still eligible for a menu container. */
const APP_WITHOUT_DESCRIPTION = {
  id: 'e2e-subtitle-app-bare',
  name: 'Bare Probe',
  description: '',
  category: 'tools',
  urls: [{ title: 'Open', url: 'https://bare-probe.invalid', primary: true }],
};

/**
 * Reaches the apps widget's OWN custom element, past both shadow boundaries,
 * and pushes data through the exact call `WidgetHost.onData` makes.
 *
 * Mirrors the walk documented in `render-smoke.spec.js`:
 *   host div (shadowRoot #1) -> <haven-widget-apps> (shadowRoot #2)
 */
async function pushApps(page, apps) {
  const result = await page.evaluate(
    ({ id, apps: appList }) => {
      const host = document.getElementById(id);
      const custom = host?.shadowRoot?.firstElementChild ?? null;
      if (!custom || typeof custom.onData !== 'function') {
        return { ok: false, reason: 'widget element or onData() not found' };
      }
      custom.onData({ value: { apps: appList, versions: {} }, revision: Date.now() });
      return { ok: true };
    },
    { id: APPS_WIDGET_ID, apps }
  );
  expect(result.ok, result.reason ?? 'pushApps should reach the widget').toBe(true);
}

/** The apps widget's inner shadow root, where its own content lives. */
function innerRootLocator(page) {
  return page.locator(`#${APPS_WIDGET_ID}`).locator('> haven-widget-apps');
}

test.describe('apps widget card subtitle row', () => {
  test.beforeEach(async ({ page }) => {
    // `onData()` kicks off a real reachability probe for every app it is
    // given (`StatusTracker.checkAll`, called from `AppsWidget.onData`) —
    // deliberately a real browser-side `fetch`, not a stub (see
    // `web/src/lib/status.js`: "THIS RUNS IN THE BROWSER, DELIBERATELY").
    // This spec's fixture apps point at `.invalid` hosts, the same
    // unresolvable-by-construction convention every fixture in this repo
    // uses, so the probe is routed here rather than left to hit real DNS —
    // which would otherwise fail with `net::ERR_NAME_NOT_RESOLVED` and trip
    // the shared `page` fixture's console-error guard. Fulfilling it as
    // "reachable" is arbitrary and does not matter to what this spec
    // asserts: DOM parentage of the description and the kebab, not the dot's
    // colour.
    await page.route('**://*.invalid/**', (route) => route.fulfill({ status: 204, body: '' }));
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('the description and the kebab are both children of one .card__subtitle-row', async ({
    page,
  }) => {
    await pushApps(page, [APP_WITH_DESCRIPTION]);

    const custom = innerRootLocator(page);
    await expect(custom).toHaveCount(1);

    const structure = await custom.evaluate((el) => {
      const card = el.shadowRoot?.querySelector('.card');
      const subtitleRow = card?.querySelector('.card__subtitle-row') ?? null;
      const description = subtitleRow?.querySelector('.card__description') ?? null;
      const menu = subtitleRow?.querySelector('.menu') ?? null;
      return {
        hasSubtitleRow: Boolean(subtitleRow),
        descriptionIsChild: Boolean(description && description.parentElement === subtitleRow),
        menuIsChild: Boolean(menu && menu.parentElement === subtitleRow),
        // A regression that pulls the kebab onto its own row would leave the
        // menu present in the card but NOT inside `.card__subtitle-row`.
        menuExistsAnywhereInCard: Boolean(card?.querySelector('.menu')),
      };
    });

    expect(structure.hasSubtitleRow, 'the card should have a .card__subtitle-row').toBe(true);
    expect(
      structure.descriptionIsChild,
      '.card__description should be a direct child of .card__subtitle-row'
    ).toBe(true);
    expect(
      structure.menuExistsAnywhereInCard,
      'the kebab menu container should exist in the card'
    ).toBe(true);
    expect(
      structure.menuIsChild,
      'the kebab menu container should be a direct child of .card__subtitle-row, ' +
        'not pulled onto its own row'
    ).toBe(true);
  });

  test('the menu container exists even for a card with zero menu items', async ({ page }) => {
    // No description, and a single primary URL with no secondaries and no
    // known version — the "nothing to offer" case `#fillMenu` documents as
    // producing an EMPTY container rather than none at all. The container
    // still has to be there for a later probe or version fetch to refill.
    await pushApps(page, [APP_WITHOUT_DESCRIPTION]);

    const custom = innerRootLocator(page);
    await expect(custom).toHaveCount(1);

    const structure = await custom.evaluate((el) => {
      const card = el.shadowRoot?.querySelector('.card');
      const subtitleRow = card?.querySelector('.card__subtitle-row') ?? null;
      const menu = subtitleRow?.querySelector('.menu') ?? null;
      return {
        hasSubtitleRow: Boolean(subtitleRow),
        menuIsChild: Boolean(menu && menu.parentElement === subtitleRow),
      };
    });

    expect(structure.hasSubtitleRow, 'the card should have a .card__subtitle-row').toBe(true);
    expect(
      structure.menuIsChild,
      'the menu container must exist in the DOM even with zero menu items'
    ).toBe(true);
  });
});
