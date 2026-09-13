/**
 * Adding a widget to the SIDEBAR rather than to the grid.
 *
 * ── Why this spec exists, and why a unit test could not replace it ───────
 * The destination chooser's routing lives in `boot.js`'s `onAdd`, and
 * `boot.js` is never imported or executed by any unit test — it pulls in
 * GridStack, whose published ESM will not load under `node --test`. Every
 * reference to it in the web suite is `readFileSync`, i.e. an assertion about
 * SOURCE TEXT.
 *
 * That distinction is not academic. A source-text assertion cannot tell live
 * code from dead code: mutating the branch to
 * `if (false && insertion.zone === 'sidebar')` short-circuits the routing away
 * entirely while preserving every literal the regex matches, so
 * `boot-wiring.test.js` passed 14/14 on a build where choosing "Sidebar" could
 * never work. That mutation survived, and it was reported as killed. This file
 * is the guard that actually fails when the routing is dead.
 *
 * So the assertion here is deliberately BEHAVIOURAL: choose Sidebar, add a
 * widget, and require that the grid tile count does not move. A widget that
 * leaked onto the grid, or was never added at all, both fail it.
 */

import { test, expect, waitForDashboard, WIDGET_IDS } from './fixtures.js';

/**
 * Enters edit mode through the profile menu.
 *
 * Same route as `resize.spec.js`, and for the same reason: the toolbar toggle
 * is `hidden` in view mode, and calling `editMode.enter()` through
 * `page.evaluate` would pass even if the menu were completely unreachable.
 * The add panel only opens in edit mode.
 */
async function enterEditMode(page) {
  await page.click('.haven-profile__trigger');
  await page.click('.haven-profile__item[data-item-id="edit"]');
  await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'true');
}

/** Instance ids the server currently holds, by zone. */
async function rosterIds(page) {
  const res = await page.request.get('/api/instances');
  expect(res.ok(), 'the roster endpoint should answer').toBeTruthy();
  const body = await res.json();
  const instances = body.instances ?? body;
  return {
    all: instances.map((i) => i.id),
    grid: instances.filter((i) => i.zone !== 'sidebar').map((i) => i.id),
    sidebar: instances.filter((i) => i.zone === 'sidebar').map((i) => i.id),
    byId: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

test.describe('adding a widget to the sidebar', () => {
  /**
   * Ids this spec created, removed after each test.
   *
   * The suite runs `workers: 1` against ONE shared database, and several specs
   * assert exact roster counts (`render-smoke`'s anti-drift guard,
   * `sidebarWidgetIds`). A widget left behind by this file would not fail this
   * file — it would fail a later one, which is the worst kind of flake to
   * diagnose. So cleanup is not politeness here, it is a precondition for
   * every spec that runs after it.
   */
  let created = [];

  test.beforeEach(async ({ page }) => {
    created = [];
    await page.goto('/');
    await waitForDashboard(page);
  });

  test.afterEach(async ({ page }) => {
    for (const id of created) {
      await page.request.delete(`/api/instances/${encodeURIComponent(id)}`);
    }
    created = [];
  });

  test('the panel offers a destination, defaulting to the main grid', async ({ page }) => {
    await enterEditMode(page);

    const panel = page.locator('.haven-add-panel');
    await expect(panel).toBeVisible();

    const gridRadio = panel.locator('input[data-zone="grid"]');
    const sidebarRadio = panel.locator('input[data-zone="sidebar"]');

    await expect(gridRadio).toHaveCount(1);
    await expect(sidebarRadio).toHaveCount(1);
    await expect(gridRadio).toBeChecked();
    await expect(sidebarRadio).not.toBeChecked();

    // A shared `name` is what makes them mutually exclusive. Without it both
    // can be selected and the panel silently reads whichever comes first.
    const names = await panel
      .locator('input[type="radio"]')
      .evaluateAll((els) => els.map((e) => e.name));
    expect(new Set(names).size, 'the destination radios must share one name').toBe(1);
    expect(names[0]).toBeTruthy();
  });

  test('choosing Sidebar adds the widget to the sidebar and NOT to the grid', async ({ page }) => {
    // THE regression guard. `boot.js` routes a sidebar insertion to
    // `sidebarZone.add` and returns before `grid.insert`; if that branch is
    // dead — or never ran — the widget lands on the grid instead, and the tile
    // count is what catches it. Source-text assertions cannot: `false &&`
    // leaves every literal in place.
    const before = await rosterIds(page);
    const tilesBefore = await page.locator('.grid-stack-item').count();
    const cardsBefore = await page.locator('.haven-sidebar__card').count();

    await enterEditMode(page);

    await page.locator('.haven-add-panel input[data-zone="sidebar"]').check();
    const addButton = page.locator('.haven-add-panel__add').first();
    const addedType = await addButton.getAttribute('data-widget-type');
    await addButton.click();

    // Wait on the sidebar actually growing rather than on a timer.
    await expect(page.locator('.haven-sidebar__card')).toHaveCount(cardsBefore + 1);

    const after = await rosterIds(page);
    const newIds = after.all.filter((id) => !before.all.includes(id));
    expect(newIds, 'exactly one instance should have been created').toHaveLength(1);
    created = newIds;
    const [newId] = newIds;

    // 1. It is a SIDEBAR instance server-side.
    expect(after.byId[newId].zone).toBe('sidebar');
    expect(after.byId[newId].type).toBe(addedType);

    // 2. The grid did not grow. This is the assertion the surviving mutation
    //    failed to trip: a widget routed to the grid by mistake shows up here.
    await expect(
      page.locator('.grid-stack-item'),
      'choosing Sidebar must not put a tile on the grid'
    ).toHaveCount(tilesBefore);
    expect(after.grid, 'the grid roster must be untouched').toEqual(before.grid);

    // 3. It is mounted inside the scrollport, not beside the pinned card —
    //    a sibling of the pin starves the scrollport and becomes unreachable.
    const placement = await page.evaluate((id) => {
      const host = document.getElementById(id);
      const card = host?.closest('.haven-sidebar__card');
      const scroll = document.querySelector('.haven-sidebar__scroll');
      return {
        mounted: !!host,
        inScroll: !!card && card.parentElement === scroll,
        onGrid: !!document.querySelector(`.grid-stack-item[gs-id="${id}"]`),
      };
    }, newId);

    expect(placement.mounted, 'the widget should be mounted in the sidebar').toBe(true);
    expect(placement.inScroll, 'an added card must live inside the scrollport').toBe(true);
    expect(placement.onGrid, 'the widget must not also be a grid tile').toBe(false);
  });

  test('a widget added to the sidebar survives a reload', async ({ page }) => {
    // The round trip through the database, which is what "it persisted" means.
    // Adding without persisting looks identical until the page is reloaded.
    const before = await rosterIds(page);
    const cardsBefore = await page.locator('.haven-sidebar__card').count();

    await enterEditMode(page);
    await page.locator('.haven-add-panel input[data-zone="sidebar"]').check();
    await page.locator('.haven-add-panel__add').first().click();
    await expect(page.locator('.haven-sidebar__card')).toHaveCount(cardsBefore + 1);

    const after = await rosterIds(page);
    created = after.all.filter((id) => !before.all.includes(id));
    expect(created).toHaveLength(1);
    const [newId] = created;

    await page.reload();
    await waitForDashboard(page);

    // An ATTRIBUTE selector, not `#id`. `page.locator()` builds its selector
    // string in the Node process, where `CSS.escape` does not exist — it is a
    // browser global, and reaching for it here is a `ReferenceError` that
    // fails the test for a reason having nothing to do with the app.
    // `[id="..."]` needs no escaping in the first place.
    await expect(
      page.locator(`[id="${newId}"]`),
      'the added sidebar widget should still be there after a reload'
    ).toHaveCount(1);
    await expect(page.locator('.haven-sidebar__card')).toHaveCount(cardsBefore + 1);
    await expect(page.locator('.grid-stack-item')).toHaveCount(WIDGET_IDS.length);
  });

  test('choosing Main grid still adds to the grid', async ({ page }) => {
    // The other half of the branch. Without this, a routing bug that sent
    // EVERYTHING to the sidebar would pass the test above.
    const before = await rosterIds(page);
    const tilesBefore = await page.locator('.grid-stack-item').count();

    await enterEditMode(page);
    await expect(page.locator('.haven-add-panel input[data-zone="grid"]')).toBeChecked();
    await page.locator('.haven-add-panel__add').first().click();

    await expect(page.locator('.grid-stack-item')).toHaveCount(tilesBefore + 1);

    const after = await rosterIds(page);
    created = after.all.filter((id) => !before.all.includes(id));
    expect(created).toHaveLength(1);
    expect(after.byId[created[0]].zone, 'a grid add must not be zoned sidebar').not.toBe('sidebar');
    expect(after.sidebar, 'the sidebar roster must be untouched').toEqual(before.sidebar);
  });
});
