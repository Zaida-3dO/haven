/**
 * Resizing the sidebar and its cards, in a real browser.
 *
 * ── Why this cannot be a unit test ───────────────────────────────────────
 * Three of the four claims here are unobservable in the fake DOM, and the
 * most important one is unobservable in a SCREENSHOT too:
 *
 *  1. **Content scrolls INSIDE a shortened card.** A clipped card and a
 *     scrolling card look identical in a still image — same box, same visible
 *     content. The difference is `scrollHeight > clientHeight` on the body
 *     plus the ability to actually move `scrollTop`, and only a layout engine
 *     produces either. This is the acceptance criterion for the feature Ope
 *     asked for ("id rather have an internal scroll bar on the widget"), so
 *     it is asserted by scrolling, not by looking.
 *
 *  2. **The scrollport is not starved.** The measured failure is a
 *     `clientHeight` of 0 on `.haven-sidebar__scroll`, which requires real
 *     flex layout. The fake DOM has none.
 *
 *  3. **Sizes survive a reload.** That is a round trip through two HTTP
 *     endpoints and a database.
 *
 * `boot.js` cannot be unit-tested at all — it imports GridStack, whose ESM
 * will not load under `node --test` — so the wiring that turns a drag into a
 * persisted size is only reachable here.
 */

import { test, expect, waitForDashboard } from './fixtures.js';

/** A card that is NOT the pinned status card, and its live sizes. */
const CARD = '.haven-sidebar__scroll .haven-sidebar__card';

/**
 * Enters edit mode through the profile menu.
 *
 * The same route as `resize.spec.js` and `add-panel-zone.spec.js`: the
 * toolbar toggle is `hidden` in view mode, and calling `editMode.enter()`
 * through `page.evaluate` would pass even if the menu were unreachable.
 */
async function enterEditMode(page) {
  await page.click('.haven-profile__trigger');
  await page.click('.haven-profile__item[data-item-id="edit"]');
  await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'true');
}

/** The roster as the server holds it, keyed by id. */
async function rosterById(page) {
  const res = await page.request.get('/api/instances');
  expect(res.ok(), 'the roster endpoint should answer').toBeTruthy();
  const body = await res.json();
  return Object.fromEntries((body.instances ?? body).map((i) => [i.id, i]));
}

/** The persisted sidebar width. */
async function savedWidth(page) {
  const res = await page.request.get('/api/preferences');
  expect(res.ok(), 'the preferences endpoint should answer').toBeTruthy();
  return (await res.json()).preferences.sidebarWidth;
}

/** Drags a handle by a pixel delta with real mouse steps. */
async function dragBy(page, locator, { dx = 0, dy = 0 }) {
  const box = await locator.boundingBox();
  if (!box) throw new Error('handle has no box — is edit mode on?');

  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  // Several steps: a single jump can be treated as a click rather than a drag.
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 6 });
  await page.mouse.move(x + dx, y + dy, { steps: 6 });
  await page.mouse.up();
}

test.describe('sidebar sizing', () => {
  /** Restores the shipped defaults — the suite shares one database. */
  test.afterEach(async ({ page }) => {
    await page.request.patch('/api/preferences', { data: { sidebarWidth: 320 } });
    const roster = await rosterById(page);
    for (const instance of Object.values(roster)) {
      if (instance.zone === 'sidebar' && instance.height !== null) {
        await page.request.put(`/api/instances/${encodeURIComponent(instance.id)}`, {
          data: { ...instance, height: null },
        });
      }
    }
  });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('the resize affordances exist only in edit mode', async ({ page }) => {
    // Built disabled and untabbable, then armed by `setEditable` — the same
    // rule the move/remove controls follow. A visible-but-dead handle, or one
    // reachable by keyboard in view mode, are both real bugs.
    const handle = page.locator('.haven-sidebar__width-handle');
    const grip = page.locator('.haven-sidebar__grip').first();

    await expect(handle).toBeHidden();
    await expect(grip).toBeHidden();
    expect(await handle.isDisabled()).toBe(true);

    await enterEditMode(page);

    await expect(handle).toBeVisible();
    await expect(grip).toBeVisible();
    expect(await handle.isDisabled()).toBe(false);
  });

  test('the pinned status card has no height grip', async ({ page }) => {
    // It is the sidebar's own child rather than a child of the scrollport, so
    // a height on it would take space FROM the scrollport — the starvation
    // case. The rule is enforced in `sidebar-size.js`; this is the reason a
    // user never meets it.
    await enterEditMode(page);

    const pinnedGrips = page.locator('.haven-sidebar__card--pinned .haven-sidebar__grip');
    await expect(pinnedGrips).toHaveCount(0);
    // …while the unpinned cards do have them, or the assertion above is
    // satisfied by there being no grips at all.
    expect(await page.locator(CARD + ' .haven-sidebar__grip').count()).toBeGreaterThan(0);
  });

  test('dragging a grip shortens the card and its content scrolls INSIDE it', async ({ page }) => {
    // The acceptance criterion, and the one a screenshot cannot settle.
    //
    // ── Why this targets the CALENDAR rather than the first card ──────────
    // Measured in a browser: the first sidebar card is Weather, whose body is
    // 67px — already below `MIN_CARD_HEIGHT` (80). Dragging it "shorter"
    // therefore clamps UP to the floor, and an assertion that the card got
    // shorter fails against working code. The calendar is both the card Ope
    // actually complained about ("reduce the height of the calendar widget")
    // and one with a real event list to scroll, so it is the honest subject.
    await enterEditMode(page);

    const card = page.locator(CARD).filter({ has: page.locator('#sidebar-calendar') });
    await expect(card, 'the calendar card should be in the scrollport').toHaveCount(1);

    const body = card.locator('.haven-sidebar__body');
    const before = (await body.boundingBox()).height;
    // Precondition, so this test cannot pass vacuously on a card that was
    // already at the floor — which is exactly how its first version failed.
    expect(before, 'the calendar must start tall enough to shrink').toBeGreaterThan(120);

    // Upward = shorter, and well clear of the floor.
    await dragBy(page, card.locator('.haven-sidebar__grip'), { dy: -(before - 100) });

    await expect
      .poll(async () => (await body.boundingBox()).height, {
        message: 'the card body should have got shorter',
      })
      .toBeLessThan(before);

    // THE proof. A clipped card and a scrolling card are visually identical in
    // a still image; what separates them is overflowing content that can
    // actually be moved.
    const scrolled = await page.evaluate(() => {
      const el = document.getElementById('sidebar-calendar')?.parentElement;
      if (!el) return null;
      const overflows = el.scrollHeight > el.clientHeight + 1;
      el.scrollTop = 40;
      return { overflows, scrollTop: el.scrollTop, overflowY: getComputedStyle(el).overflowY };
    });

    expect(scrolled.overflowY, 'the body must be a scrollport').toBe('auto');
    expect(scrolled.overflows, 'the content must exceed the shortened card').toBe(true);
    expect(scrolled.scrollTop, 'the content must actually scroll, not merely clip').toBeGreaterThan(
      0
    );
  });

  test('the grip announces its slider value, live, during a drag and a keypress', async ({
    page,
  }) => {
    // The specific trap on this item: a value that renders once and never
    // updates looks correct in source (role="slider" plus a one-time
    // aria-valuenow) and is still broken for a screen reader, which announces
    // whatever the attribute holds AT THE MOMENT it is queried — mid-drag,
    // mid-keypress, not just on first render. Asserted here, not just in the
    // unit suite, because only a real drag exercises the actual interaction
    // path end to end.
    await enterEditMode(page);

    const card = page.locator(CARD).filter({ has: page.locator('#sidebar-calendar') });
    const grip = card.locator('.haven-sidebar__grip');

    await expect(grip).toHaveAttribute('role', 'slider');
    await expect(grip).toHaveAttribute('aria-valuemin', '80');
    await expect(grip).toHaveAttribute('aria-valuemax', '2000');

    const initial = await grip.getAttribute('aria-valuenow');
    expect(initial, 'the grip must report a value before any interaction').not.toBeNull();

    // Drag it shorter and read the attribute WHILE the value should have
    // moved — not after a reload, not from source, from the live DOM.
    await dragBy(page, grip, { dy: -100 });

    await expect
      .poll(async () => grip.getAttribute('aria-valuenow'), {
        message: 'aria-valuenow must move after a drag, not stay at its initial render',
      })
      .not.toBe(initial);

    const afterDrag = await grip.getAttribute('aria-valuenow');
    const valuetextAfterDrag = await grip.getAttribute('aria-valuetext');
    expect(valuetextAfterDrag, 'aria-valuetext must match the number it accompanies').toBe(
      `${afterDrag} pixels`
    );

    // And again via the keyboard path, which is a SEPARATE code path
    // (`sidebar-resize.js`'s `keys()` vs `drag()`) — both must keep the grip
    // in sync, not just the mouse one. ArrowDown INCREASES height (see
    // `sidebar-resize.js`), moving away from the floor the drag above may
    // already be close to, rather than ArrowUp which could clamp at
    // MIN_CARD_HEIGHT and produce a false "did not move" failure.
    await grip.focus();
    await page.keyboard.press('ArrowDown');

    await expect
      .poll(async () => grip.getAttribute('aria-valuenow'), {
        message: 'aria-valuenow must move again after an arrow-key press',
      })
      .not.toBe(afterDrag);
  });

  test('a shortened card cannot starve the scrollport', async ({ page }) => {
    // The governing hazard. A card whose height grew without bound would
    // compete with the pinned card for the column; at three such cards the
    // scrollport measured `clientHeight: 0` with `overflow: hidden`, leaving
    // them unreachable. Heights bound the BODY, so this must stay > 0.
    await enterEditMode(page);

    for (const grip of await page.locator(CARD + ' .haven-sidebar__grip').all()) {
      await dragBy(page, grip, { dy: 400 });
    }

    const measured = await page.evaluate(() => {
      const scroll = document.querySelector('.haven-sidebar__scroll');
      const pinned = document.querySelector('.haven-sidebar__card--pinned');
      return {
        scrollClientHeight: scroll?.clientHeight ?? -1,
        pinnedVisible: (pinned?.getBoundingClientRect().height ?? 0) > 0,
        pinnedInScroll: pinned?.parentElement === scroll,
      };
    });

    expect(measured.scrollClientHeight, 'the scrollport must never collapse').toBeGreaterThan(0);
    expect(measured.pinnedVisible, 'the pinned card must stay visible').toBe(true);
    expect(measured.pinnedInScroll, 'the pinned card must stay OUTSIDE the scrollport').toBe(false);
  });

  test('a card height persists across a reload only after Save', async ({ page }) => {
    // Drafting: Ope asked that an unsaved change be lost on refresh. Both
    // halves are asserted, because a feature that never persists and one that
    // always persists each satisfy only one of them.
    await enterEditMode(page);
    // The calendar again: it has room to shrink without hitting the floor.
    const id = 'sidebar-calendar';
    const card = page.locator(CARD).filter({ has: page.locator(`#${id}`) });

    await dragBy(page, card.locator('.haven-sidebar__grip'), { dy: -100 });

    // 1. Not yet saved — the server must still hold no height.
    expect((await rosterById(page))[id].height, 'a drag alone must not persist').toBeNull();

    // 2. Save, and it lands.
    await page.click('.haven-toolbar__save');
    await expect
      .poll(async () => (await rosterById(page))[id].height, {
        message: 'Save should persist the drafted height',
      })
      .not.toBeNull();

    const saved = (await rosterById(page))[id].height;

    // 3. It survives a reload and is re-applied to the DOM.
    await page.reload();
    await waitForDashboard(page);

    const applied = await page.evaluate(
      (cardId) => document.getElementById(cardId)?.parentElement?.style.height ?? null,
      id
    );
    expect(applied, 'the stored height must be re-applied on boot').toBe(`${saved}px`);
  });

  test('dragging the width handle widens the sidebar and persists on Save', async ({ page }) => {
    await enterEditMode(page);

    const sidebar = page.locator('.haven-sidebar');
    const before = (await sidebar.boundingBox()).width;

    // The sidebar is on the RIGHT, so dragging LEFT makes it wider.
    await dragBy(page, page.locator('.haven-sidebar__width-handle'), { dx: -120 });

    await expect
      .poll(async () => (await sidebar.boundingBox()).width, {
        message: 'dragging left should widen the sidebar',
      })
      .toBeGreaterThan(before);

    await page.click('.haven-toolbar__save');

    await expect
      .poll(async () => savedWidth(page), { message: 'Save should persist the width' })
      .toBeGreaterThan(320);

    const width = await savedWidth(page);
    await page.reload();
    await waitForDashboard(page);

    const rendered = Math.round((await page.locator('.haven-sidebar').boundingBox()).width);
    // The handle overlays the border, so allow a pixel of rounding either way.
    expect(
      Math.abs(rendered - width),
      `rendered ${rendered} vs saved ${width}`
    ).toBeLessThanOrEqual(2);
  });

  test('Discard reverts a resize instead of keeping it', async ({ page }) => {
    await enterEditMode(page);

    const sidebar = page.locator('.haven-sidebar');
    const before = Math.round((await sidebar.boundingBox()).width);

    await dragBy(page, page.locator('.haven-sidebar__width-handle'), { dx: -120 });
    expect(Math.round((await sidebar.boundingBox()).width)).toBeGreaterThan(before);

    await page.click('.haven-toolbar__discard');

    await expect
      .poll(async () => Math.round((await sidebar.boundingBox()).width), {
        message: 'Discard should put the width back',
      })
      .toBe(before);

    expect(await savedWidth(page), 'nothing may have been persisted').toBe(320);
  });

  test('the width handle is operable from the keyboard', async ({ page }) => {
    // A drag is a mouse gesture; a resize affordance that exists only for a
    // mouse is one a keyboard user cannot reach at all. Nothing else in this
    // shell hand-rolls a drag, so this is the first one that had to answer it.
    await enterEditMode(page);

    const sidebar = page.locator('.haven-sidebar');
    const before = Math.round((await sidebar.boundingBox()).width);

    await page.locator('.haven-sidebar__width-handle').focus();
    await page.keyboard.press('ArrowLeft');

    await expect
      .poll(async () => Math.round((await sidebar.boundingBox()).width), {
        message: 'ArrowLeft should widen the sidebar',
      })
      .toBeGreaterThan(before);
  });
});
