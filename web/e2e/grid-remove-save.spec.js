/**
 * Removing a GRID tile must arm Save.
 *
 * ── Why this spec exists, and why a unit test could not replace it ───────
 * `boot.js`'s `connectGrid({ onRemoved })` calls `toolbar?.sync()` right after
 * a grid removal (`web/src/shell/boot.js:188-201`) specifically because a
 * removal reflows the tiles around it, and that surviving geometry is exactly
 * what a layout save persists — without the `sync()` call, Save stays
 * greyed out reading "no changes" while the board has visibly moved.
 *
 * `boot.js` is never imported or executed by any unit test — it pulls in
 * GridStack, whose published ESM will not load under `node --test` (every
 * reference to it in the web suite is `readFileSync`, i.e. an assertion about
 * SOURCE TEXT). A source-text assertion cannot tell live code from dead code:
 * commenting out `toolbar?.sync()` at boot.js:201 removes the only line that
 * exercises the regression this spec exists to catch, while a regex looking
 * for the string `onRemoved` or `toolbar?.sync` elsewhere in the file would
 * still find a match and report the mutation killed. Only a browser, with a
 * real removal and a real Save button, notices.
 *
 * `sidebar-draft.spec.js:225` covers a REMOVAL, but of a *sidebar* card via
 * `sidebar-zone.js`'s buffered draft — a structurally different path from a
 * GridStack tile's `onRemoved` callback, which deletes server-side
 * immediately (see the comment at edit-mode.js:191-201: "a removed grid
 * widget is deleted server-side the moment it is clicked... there is nothing
 * about the removal itself left for a layout save to persist... what a save
 * DOES still owe is the reflow"). No existing spec drives that path.
 */

import { test, expect, waitForDashboard, WIDGET_IDS } from './fixtures.js';

/**
 * Enters edit mode through the profile menu — the toolbar toggle is `hidden`
 * in view mode, so calling `editMode.enter()` through `page.evaluate` would
 * pass even if the menu were completely unreachable. Same route as every
 * other spec in this suite.
 */
async function enterEditMode(page) {
  await page.click('.haven-profile__trigger');
  await page.click('.haven-profile__item[data-item-id="edit"]');
  await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'true');
}

/**
 * This spec removes a widget PERMANENTLY, server-side, the moment the remove
 * control is clicked (unlike a sidebar removal, a grid removal is not
 * drafted — see the comment at the top of this file). So the victim's full
 * instance row AND its layout node, across every breakpoint, are captured
 * before the click and restored after — otherwise this spec would leave the
 * shared database one grid widget short of what every other spec in the
 * suite (`render-smoke`'s anti-drift roster guard chief among them) expects
 * to find.
 */
async function captureInstance(page, id) {
  const res = await page.request.get('/api/instances');
  expect(res.ok(), 'the instances endpoint should answer').toBeTruthy();
  const body = await res.json();
  const entry = (body.instances ?? body).find((i) => i.id === id);
  expect(entry, `${id} should exist before this spec touches it`).toBeTruthy();
  return entry;
}

async function captureLayoutNodes(page, id) {
  const res = await page.request.get('/api/layout');
  expect(res.ok(), 'the layout endpoint should answer').toBeTruthy();
  const { layout } = await res.json();
  const nodesByBreakpoint = {};
  for (const [breakpoint, nodes] of Object.entries(layout ?? {})) {
    const node = nodes.find((n) => n.id === id);
    if (node) nodesByBreakpoint[breakpoint] = node;
  }
  return nodesByBreakpoint;
}

async function restoreInstance(page, entry, nodesByBreakpoint) {
  const created = await page.request.post('/api/instances', { data: entry });
  if (created.status() === 409) {
    // Already there (the test failed before deleting) — nothing to restore.
    return;
  }
  expect(created.ok(), 're-creating the removed instance should succeed').toBeTruthy();

  if (Object.keys(nodesByBreakpoint).length === 0) return;

  const layoutRes = await page.request.get('/api/layout');
  const { layout } = await layoutRes.json();
  const payload = {};
  for (const [breakpoint, node] of Object.entries(nodesByBreakpoint)) {
    const nodes = (layout?.[breakpoint] ?? []).filter((n) => n.id !== node.id);
    nodes.push(node);
    payload[breakpoint] = nodes;
  }
  await page.request.put('/api/layout', { data: payload });
}

test.describe('removing a grid tile arms Save', () => {
  const victimId = WIDGET_IDS[0];
  let entry = null;
  let nodesByBreakpoint = {};

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
    entry = await captureInstance(page, victimId);
    nodesByBreakpoint = await captureLayoutNodes(page, victimId);
  });

  test.afterEach(async ({ page }) => {
    await restoreInstance(page, entry, nodesByBreakpoint);
  });

  test('removing a grid tile makes Save go live', async ({ page }) => {
    await enterEditMode(page);

    const save = page.locator('.haven-toolbar__save');
    // Nothing has changed yet — Save should read not-dirty. Asserted on
    // `aria-disabled`, not colour: the button has a 120ms background
    // transition, and reading the computed colour immediately after a state
    // change catches the start of that transition rather than the end state
    // (documented trap on this item — see sidebar-draft.spec.js for the
    // same reasoning, which caught two false failures for exactly this).
    await expect(save).toHaveAttribute('aria-disabled', 'true');

    const tilesBefore = await page.locator('.grid-stack-item').count();
    const victim = page.locator(`.grid-stack-item[gs-id="${victimId}"]`);
    await expect(victim).toHaveCount(1);

    // The per-widget remove control, enabled only in edit mode
    // (edit-mode.js's `setMode` toggles `.haven-widget__control`).
    await victim.locator('.haven-widget__control--remove').click();

    await expect(page.locator('.grid-stack-item')).toHaveCount(tilesBefore - 1);
    await expect(victim).toHaveCount(0);

    // THE assertion the whole spec exists for: the reflow left by the
    // removal must have armed Save.
    await expect(save, 'removing a grid tile must arm Save via toolbar.sync()').toHaveAttribute(
      'aria-disabled',
      'false'
    );
  });
});
