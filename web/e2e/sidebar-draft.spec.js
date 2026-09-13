/**
 * Sidebar changes are DRAFTED: nothing is written until Save.
 *
 * ── Why this spec exists, and why a unit test could not replace it ───────
 * The acceptance criterion here is a full round trip through a real server:
 * *reorder, do not save, refresh, and find the change gone*. That is three
 * things a unit test structurally cannot do — it has no server to persist to,
 * no page to reload, and no `boot.js` to wire the draft to edit mode in the
 * first place (`boot.js` imports GridStack, whose published ESM will not load
 * under `node --test`, so every reference to it in the web suite is
 * `readFileSync`).
 *
 * That distinction is load-bearing rather than academic. A source-text
 * assertion cannot tell live code from dead code: mutating the wiring to
 * `sidebarZone: () => null` leaves every literal a regex would match while
 * the entire draft becomes unreachable, and the sidebar goes straight back to
 * persisting on the click. Only a browser notices.
 *
 * ── What each test pins ──────────────────────────────────────────────────
 * 1. A reorder arms Save and blocks the "Done editing" exit.
 * 2. A reorder abandoned by a REFRESH is lost. ← the defect Ope reported
 * 3. Discard puts the original order back.
 * 4. Discard brings back a REMOVED card — impossible before this change,
 *    because the row was deleted at click time.
 * 5. Save actually persists, so drafting did not just break persistence.
 */

import { test, expect, waitForDashboard, allSidebarWidgetIds } from './fixtures.js';

/**
 * Enters edit mode through the profile menu.
 *
 * The same route as `resize.spec.js` and `add-panel-zone.spec.js`, and for the
 * same reason: the toolbar toggle is `hidden` in view mode, and driving
 * `editMode.enter()` through `page.evaluate` would pass even if the menu were
 * completely unreachable.
 */
async function enterEditMode(page) {
  await page.click('.haven-profile__trigger');
  await page.click('.haven-profile__item[data-item-id="edit"]');
  await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'true');
}

/**
 * The sidebar's unpinned cards, top to bottom, by instance id.
 *
 * Read from the DOM rather than from the roster, because the whole point of a
 * draft is that the two DISAGREE until Save: the cards move immediately and
 * the server is not told. Hidden cards are excluded — a drafted removal hides
 * its card rather than detaching it, so a plain child query would still count
 * one the user can no longer see.
 *
 * The card ids come from the `haven-sidebar__card--<id>` modifier, which is
 * emitted for every card (`createSidebarCard`), so nothing here depends on a
 * widget's shadow DOM. Sidebar cards are light DOM; only the widget BODIES
 * inside them are shadow roots, and this never reaches into one.
 */
async function visibleSidebarOrder(page) {
  return page.evaluate(() => {
    const scroll = document.querySelector('.haven-sidebar__scroll');
    if (!scroll) return [];
    return [...scroll.children]
      .filter((el) => !el.hidden && el.className.includes('haven-sidebar__card'))
      .map((el) => {
        const match = [...el.classList].find(
          (c) =>
            c.startsWith('haven-sidebar__card--') &&
            !c.startsWith('haven-sidebar__card--type-') &&
            c !== 'haven-sidebar__card--pinned'
        );
        return match ? match.replace('haven-sidebar__card--', '') : null;
      })
      .filter(Boolean);
  });
}

/** The sidebar order the SERVER holds, by `sortOrder`. */
async function persistedSidebarOrder(page) {
  const res = await page.request.get('/api/instances');
  expect(res.ok(), 'the roster endpoint should answer').toBeTruthy();
  const body = await res.json();
  return (body.instances ?? body)
    .filter((entry) => entry.zone === 'sidebar')
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0))
    .map((entry) => entry.id);
}

/** Clicks a card's move-up arrow. */
async function moveUp(page, id) {
  await page.click(
    `.haven-sidebar__card--${id} .haven-sidebar__control[data-sidebar-control="up"]`
  );
}

test.describe('sidebar changes are drafted until Save', () => {
  /**
   * The sidebar order as the server held it before this file ran.
   *
   * The suite runs `workers: 1` against ONE shared database and several specs
   * assert exact roster contents, so a spec that reordered the sidebar and
   * left it that way would not fail itself — it would fail a later file, which
   * is the worst kind of flake to diagnose. Restoring is a precondition for
   * everything that runs after this, not politeness.
   */
  let original = [];

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
    original = await persistedSidebarOrder(page);
  });

  test.afterEach(async ({ page }) => {
    for (const [index, id] of original.entries()) {
      const res = await page.request.get(`/api/instances`);
      const body = await res.json();
      const entry = (body.instances ?? body).find((i) => i.id === id);
      if (!entry) continue;
      await page.request.put(`/api/instances/${encodeURIComponent(id)}`, {
        data: { ...entry, sortOrder: index, zone: 'sidebar' },
      });
    }
  });

  test('a reorder arms Save and blocks the Done-editing exit', async ({ page }) => {
    // Item 4: the grid's `layoutDiffers` covers grid geometry only, so before
    // this change the sidebar could be reordered with Save still greyed out
    // reading "No changes to save".
    await enterEditMode(page);

    const save = page.locator('.haven-toolbar__save');
    const toggle = page.locator('.haven-toolbar__toggle');
    await expect(save).toHaveAttribute('aria-disabled', 'true');
    await expect(toggle).toHaveAttribute('aria-disabled', 'false');

    const before = await visibleSidebarOrder(page);
    await moveUp(page, before[1]);

    // Asserted on `aria-disabled` rather than on the button's colour: the
    // rule has `transition: background 120ms`, so reading the computed colour
    // straight after the click catches the START of the transition. Two
    // earlier agents filed false failures that way.
    await expect(save).toHaveAttribute('aria-disabled', 'false');

    // Ope: "the 'done editing' button should only be clickable after save
    // (where there is nothing to save) otherwise your choice should only be
    // save or discard."
    await expect(toggle).toHaveAttribute('aria-disabled', 'true');

    // And it must genuinely not work, not merely look blocked — `aria-disabled`
    // is advisory and the browser still fires the click.
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  });

  test('a reorder is LOST on refresh when it was never saved', async ({ page }) => {
    // ── THE acceptance criterion ──────────────────────────────────────────
    // Ope: "changes should be drafted if i don't click save and i refresh my
    // changes should be lost not persisted". Before this change `applyOrder`
    // wrote `sortOrder` on the click, so the reorder SURVIVED the refresh.
    await enterEditMode(page);

    const before = await visibleSidebarOrder(page);
    expect(before.length, 'need at least two unpinned cards to reorder').toBeGreaterThan(1);

    await moveUp(page, before[1]);

    const reordered = await visibleSidebarOrder(page);
    expect(reordered[0]).toBe(before[1]);
    expect(reordered, 'the cards must move on screen immediately').not.toEqual(before);

    // The server must not have been told anything.
    expect(
      await persistedSidebarOrder(page),
      'a drafted reorder must not reach the server'
    ).toEqual(original);

    await page.reload();
    await waitForDashboard(page);

    expect(
      await visibleSidebarOrder(page),
      'an unsaved reorder must be GONE after a refresh'
    ).toEqual(before);
  });

  test('Discard puts the original order back', async ({ page }) => {
    await enterEditMode(page);

    const before = await visibleSidebarOrder(page);
    await moveUp(page, before[1]);
    expect(await visibleSidebarOrder(page)).not.toEqual(before);

    await page.click('.haven-toolbar__discard');

    expect(await visibleSidebarOrder(page), 'Discard must restore the order').toEqual(before);
    expect(await persistedSidebarOrder(page)).toEqual(original);
  });

  test('Discard brings back a REMOVED card', async ({ page }) => {
    // The half that was impossible before: removal deleted the row at click
    // time, so there was nothing left for Discard to restore. `noteRemoval()`
    // was deleted on exactly that reasoning — correct about the mechanism,
    // wrong about the intent.
    await enterEditMode(page);

    const before = await visibleSidebarOrder(page);
    const victim = before[0];

    await page.click(
      `.haven-sidebar__card--${victim} .haven-sidebar__control[data-sidebar-control="remove"]`
    );

    expect(await visibleSidebarOrder(page), 'the card should disappear from view').not.toContain(
      victim
    );
    expect(await allSidebarWidgetIds(page), 'but nothing may be deleted server-side yet').toContain(
      victim
    );

    await page.click('.haven-toolbar__discard');

    expect(await visibleSidebarOrder(page), 'Discard must bring the card back').toEqual(before);
    expect(await allSidebarWidgetIds(page)).toContain(victim);
  });

  test('Save persists the reorder across a reload', async ({ page }) => {
    // The other end of the criterion: drafting must not have simply broken
    // persistence. A test suite where nothing ever saves would pass every
    // assertion above.
    await enterEditMode(page);

    const before = await visibleSidebarOrder(page);
    await moveUp(page, before[1]);
    const expected = await visibleSidebarOrder(page);

    await page.click('.haven-toolbar__save');

    // Save returns to view mode, which is the observable signal the layout
    // PUT resolved and the draft was committed.
    await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    await waitForDashboard(page);

    expect(await visibleSidebarOrder(page), 'a saved reorder must survive a reload').toEqual(
      expected
    );
  });
});
