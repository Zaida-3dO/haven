/**
 * The apps-card kebab menu must render ABOVE every sibling card, not just the
 * one directly below it in DOM order — Agent Standup item
 * e2aadd6c-9118-4c06-a9b7-eb4ce6e4b322.
 *
 * ── The bug, and why a z-index bump could not fix it ───────────────────────
 * `.card:hover, .card:focus-within` in styles.js applies
 * `transform: translateY(-2px)` — the hover lift. A `transform` other than
 * `none` creates a NEW STACKING CONTEXT on the element carrying it. Opening a
 * card's kebab menu focuses the toggle button inside that card, which makes
 * the card `:focus-within`, which applies the transform, which makes the
 * CARD a stacking context. `.menu__list` (z-index: 2) is a descendant of that
 * card, so its z-index is only ever compared against its own siblings inside
 * the card's context — it can never climb above a SIBLING CARD, whose
 * position in the paint order is instead decided by the grid's own stacking
 * context (plain DOM order, since siblings share `z-index: auto`). That is
 * why the failure was reported as "sometimes on top, sometimes behind": a
 * card earlier in DOM order loses to the next one, and the same menu on the
 * last card in the grid has nothing after it to lose to.
 *
 * The fix (apps-widget.js `#renderCard`, styles.js `.card--menu-open`)
 * cancels the transform — and so the stacking context — for exactly the card
 * whose menu is open, via a class driven by `#openMenuId` rather than
 * `:focus-within` itself.
 *
 * ── Why this must be a browser test ────────────────────────────────────────
 * Stacking-context order is COMPUTED PAINT ORDER, not declared CSS text. A
 * test asserting "the stylesheet contains `.card--menu-open { transform:
 * none }`" would pass even if that rule were outranked by specificity, or if
 * `#openMenuId` never actually reached the DOM as a class — exactly the kind
 * of gap this repo has already shipped once (see styles.js's own comment on
 * ".menu__list[hidden]": a CSS-text assertion passed a wrong value and
 * rejected the right one). `document.elementFromPoint` asks the browser what
 * it actually painted at a pixel, which a stylesheet-text assertion cannot
 * fake.
 *
 * ── How the grid is forced into multiple rows ──────────────────────────────
 * `.grid` is `repeat(auto-fill, minmax(min(100%, 13.5rem), 1fr))`, so the
 * column count depends on the widget tile's own width, which this suite does
 * not pin. Rather than assume a column count, this spec pushes enough apps
 * (16) that the grid wraps into several rows at any width from 390px to
 * 1440px, then locates the target pair by comparing bounding boxes rather
 * than by fixed index: "the card BEFORE the first one whose top has moved
 * down" is the last card of row one, in every layout.
 */

import { test, expect, waitForDashboard } from './fixtures.js';

const APPS_WIDGET_ID = 'apps-main';

/**
 * 16 apps, each with THREE secondary URLs so every card's open menu has
 * enough list items to be tall — the original report's screenshot shows a
 * multi-row menu overlapping the card below by a real margin, not by a
 * pixel. A menu with a single item is too short to reach the next row at
 * the grid's normal row gap, which is what the first version of this spec
 * measured and wrongly treated as "no bug to see" instead of "test setup
 * too shallow to exercise it".
 */
const MANY_APPS = Array.from({ length: 16 }, (_, i) => ({
  id: `e2e-stacking-app-${i}`,
  name: `Stacking Probe ${i}`,
  description: 'Fixture app used only to exercise menu stacking.',
  category: 'tools',
  urls: [
    { title: 'Open', url: `https://stacking-probe-${i}.invalid`, primary: true },
    { title: 'Open Local via IP', url: `https://stacking-probe-${i}-alt.invalid` },
    { title: 'Open via Hostname', url: `https://stacking-probe-${i}-host.invalid` },
    { title: 'Open via Tailscale', url: `https://stacking-probe-${i}-ts.invalid` },
    { title: 'Open via LAN alias', url: `https://stacking-probe-${i}-lan.invalid` },
    { title: 'Open via reverse proxy', url: `https://stacking-probe-${i}-proxy.invalid` },
  ],
}));

/** Mirrors apps-widget-subtitle-row.spec.js's own `pushApps` helper. */
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

function innerRootLocator(page) {
  return page.locator(`#${APPS_WIDGET_ID}`).locator('> haven-widget-apps');
}

/**
 * Opens the Nth card's kebab menu (by DOM order, 0-based) with a REAL
 * Playwright pointer click — not a scripted `element.click()`.
 *
 * This distinction is load-bearing for this spec specifically. A scripted
 * `.click()` inside `page.evaluate` fires the click handler (so the menu
 * DOES open) but is not a pointer event and moves no real mouse — so the
 * card never actually becomes `:hover`, `.card:hover`'s
 * `transform: translateY(-2px)` never applies, the card never becomes a
 * stacking context, and the exact bug this spec exists to catch cannot
 * reproduce. Confirmed directly (mutation-check note in the PR): with the
 * fix fully disabled, a scripted `.click()` still left the card's computed
 * `transform` as `none` (`:focus-within` was false too — a scripted click
 * moves no focus either), so the spec would have kept passing against the
 * ORIGINAL bug. A real Playwright `locator.click()` performs the actual
 * mouse move + down + up, which both hovers and focuses the button, which
 * is what makes this an honest reproduction of what a user does.
 *
 * `page.locator` pierces open shadow roots on its own with a normal CSS
 * chain, unlike `element.querySelector`, so no manual shadow-root walk is
 * needed here (contrast `pushApps`/`firstRowBoundary`, which read computed
 * geometry via `getBoundingClientRect` inside `page.evaluate` and do need
 * the manual walk).
 */
async function openMenu(page, cardIndex) {
  const toggle = page
    .locator(`#${APPS_WIDGET_ID}`)
    .locator('> haven-widget-apps')
    .locator('.card')
    .nth(cardIndex)
    .locator('.menu__toggle');
  await toggle.click();
}

/**
 * Finds the last card of the FIRST row and the first card of the SECOND row,
 * by comparing `top` — deliberately not a fixed index, since the column
 * count this grid renders depends on the tile's own width.
 */
async function firstRowBoundary(page) {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    const inner = host?.shadowRoot?.firstElementChild?.shadowRoot ?? null;
    const cards = inner ? Array.from(inner.querySelectorAll('.card')) : [];
    const rects = cards.map((el) => el.getBoundingClientRect());
    if (rects.length < 2) return null;

    const firstTop = rects[0].top;
    let lastOfFirstRow = 0;
    for (let i = 1; i < rects.length; i++) {
      if (Math.abs(rects[i].top - firstTop) < 1) {
        lastOfFirstRow = i;
      } else {
        // First card whose top has moved down — row two has started.
        return { lastOfFirstRow, firstOfSecondRow: i };
      }
    }
    return null; // every card fit on one row — this viewport can't test the bug
  }, APPS_WIDGET_ID);
}

/**
 * Each viewport gets its OWN `test.describe`, with `test.use({ viewport })`
 * set before `beforeEach` boots the page — mirroring mobile.spec.js's own
 * pattern of a fresh boot AT the target viewport, rather than booting
 * desktop and resizing mid-test.
 *
 * This was tried the other way first (boot at the project default 1440px,
 * then `page.setViewportSize` inside the test) and produced a real but
 * misleading difference: GridStack's mid-session re-column, starting from a
 * desktop layout, gave the apps tile a narrower width (~179px) than booting
 * directly at 390px does (~358px) — apparently carrying over a column
 * count from the desktop layout rather than recomputing from scratch. Both
 * are presumably real GridStack behaviour, but only the clean-boot width
 * reproduces the multi-row, multi-column layout this spec needs; the
 * resize-carryover width degenerates to single-column cards too narrow and
 * tall to exercise the bug at all. A fresh boot per viewport is also just
 * what a user actually does — opening the dashboard on a phone, not
 * shrinking a desktop window down to phone size.
 */
for (const viewport of [
  { width: 1440, height: 1000, label: '1440px' },
  { width: 390, height: 844, label: '390px' },
]) {
  test.describe(`apps widget kebab menu stacking (${viewport.label})`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test.beforeEach(async ({ page }) => {
      // Same rationale as apps-widget-subtitle-row.spec.js: fixture apps
      // point at `.invalid` hosts, so the real reachability probe each
      // `onData` call triggers is routed here instead of hitting real DNS.
      await page.route('**://*.invalid/**', (route) => route.fulfill({ status: 204, body: '' }));
      await page.goto('/');
      await waitForDashboard(page);
    });

    test('an open menu on the last card of row one paints above the card below it', async ({
      page,
    }) => {
      await pushApps(page, MANY_APPS);

      const custom = innerRootLocator(page);
      await expect(custom).toHaveCount(1);

      const boundary = await firstRowBoundary(page);
      expect(
        boundary,
        `the widget tile at ${viewport.label} must be narrow enough to wrap ` +
          '16 cards into at least two rows for this test to mean anything'
      ).not.toBeNull();

      const { lastOfFirstRow } = boundary;

      await openMenu(page, lastOfFirstRow);
      // The hover lift transitions over 140ms (styles.js: "transition:
      // transform 140ms ease..."). Probing immediately after the click can
      // catch it mid-transition, at a transform so close to zero it barely
      // shifts anything — a real user sees the settled state, so this waits
      // past the transition before reading geometry, same as they would.
      await page.waitForTimeout(200);

      // Read the open menu's own bounding box, and a point that lies inside
      // BOTH the menu and the card immediately below it — that overlap is
      // exactly what the screenshot in the original report shows (AdGuard
      // Home's "Open Local via IP" clipped behind the CueArcode card).
      const probe = await page.evaluate(
        ({ id, cardIndex }) => {
          const host = document.getElementById(id);
          const inner = host?.shadowRoot?.firstElementChild?.shadowRoot ?? null;
          const cards = inner ? Array.from(inner.querySelectorAll('.card')) : [];
          const card = cards[cardIndex];
          const list = card?.querySelector('.menu__list');
          if (!list || list.hidden) return { ok: false, reason: 'menu did not open' };

          const listRect = list.getBoundingClientRect();
          const cardTop = card.getBoundingClientRect().top;
          // The card directly UNDER the open menu, not merely the next one in
          // DOM order — on a multi-column grid the next DOM sibling is often
          // in a different column and never overlaps the menu at all (the
          // menu is anchored bottom-right of ITS OWN card, so it lands on
          // whichever row-two card shares that horizontal range). First
          // narrow to cards in the NEAREST row below (smallest top greater
          // than this card's own top — every row shares one top value), then
          // pick whichever of THOSE has the greatest horizontal overlap with
          // the menu. Picking by horizontal overlap alone, across every row,
          // ties on every row below the first (same two columns repeat down
          // the grid) and silently grabs the LAST one — several rows down,
          // nowhere near the menu — rather than the row actually below it.
          //
          // The "greater than THIS card's top" comparison must tolerate the
          // hover-lift transform itself: the OPEN card is shifted -2px by
          // `.card:hover`/`.card--menu-open`, so a card in the very SAME row
          // that is NOT hovered sits up to 2px lower — close enough to read
          // as "a card below" under a naive `>` comparison, and this is
          // exactly what happened when the fix was reverted for the
          // mutation-check: a same-row sibling only 2px lower was mistaken
          // for row two. A real next row starts a full card-height plus gap
          // down, so anything within half a card's own height is still the
          // same row.
          const rowTolerance = card.getBoundingClientRect().height / 2;
          let nearestRowTop = null;
          for (const el of cards) {
            const top = el.getBoundingClientRect().top;
            if (top > cardTop + rowTolerance && (nearestRowTop === null || top < nearestRowTop)) {
              nearestRowTop = top;
            }
          }
          if (nearestRowTop === null)
            return {
              ok: false,
              reason: 'no card below to overlap',
              cardCount: cards.length,
              allTops: cards.map((c) => Math.round(c.getBoundingClientRect().top)),
            };

          let belowCard = null;
          let bestOverlap = 0;
          for (const el of cards) {
            const rect = el.getBoundingClientRect();
            if (Math.abs(rect.top - nearestRowTop) >= 1) continue; // not the nearest row
            const overlapWidth =
              Math.min(rect.right, listRect.right) - Math.max(rect.left, listRect.left);
            if (overlapWidth > bestOverlap) {
              bestOverlap = overlapWidth;
              belowCard = el;
            }
          }
          if (!belowCard)
            return {
              ok: false,
              reason: 'no card below to overlap',
              cardTop,
              listRect,
              nearestRowTop,
              rowRects: cards
                .filter((c) => Math.abs(c.getBoundingClientRect().top - nearestRowTop) < 1)
                .map((c) => c.getBoundingClientRect()),
            };

          const belowRect = belowCard.getBoundingClientRect();
          const overlapTop = Math.max(listRect.top, belowRect.top);
          const overlapBottom = Math.min(listRect.bottom, belowRect.bottom);
          const overlapLeft = Math.max(listRect.left, belowRect.left);
          const overlapRight = Math.min(listRect.right, belowRect.right);

          if (overlapTop >= overlapBottom || overlapLeft >= overlapRight) {
            return {
              ok: false,
              reason: 'menu does not geometrically overlap the card below it',
              listRect,
              belowRect,
            };
          }

          return {
            ok: true,
            x: (overlapLeft + overlapRight) / 2,
            y: (overlapTop + overlapBottom) / 2,
          };
        },
        { id: APPS_WIDGET_ID, cardIndex: lastOfFirstRow }
      );

      expect(
        probe.ok,
        `${probe.reason ?? 'setup for the overlap probe failed'} :: ${JSON.stringify(probe)}`
      ).toBe(true);

      // The actual assertion: ask the browser what it PAINTED at the
      // overlap point. It must be part of the open menu, not the card
      // underneath it swallowing the click/paint.
      //
      // `elementFromPoint` does not cross a shadow boundary on its own — it
      // stops at the outermost open root's host element — so this walks each
      // nested `shadowRoot.elementFromPoint` in turn to reach the real
      // painted element, exactly as the widget is nested two shadow roots
      // deep (see fixtures.js's own two-boundary walks).
      const topElementInfo = await page.evaluate(
        ({ x, y }) => {
          let el = document.elementFromPoint(x, y);
          while (el?.shadowRoot) {
            const nested = el.shadowRoot.elementFromPoint(x, y);
            if (!nested || nested === el) break;
            el = nested;
          }
          return {
            tag: el?.tagName ?? null,
            className: typeof el?.className === 'string' ? el.className : null,
            closestMenu: Boolean(el?.closest?.('.menu__list, .menu__item, .menu__toggle, .menu')),
            closestCard: el?.closest?.('.card')?.dataset?.appId ?? null,
          };
        },
        { x: probe.x, y: probe.y }
      );

      expect(
        topElementInfo.closestMenu,
        `expected the open menu to be the topmost painted element at the overlap point, ` +
          `got tag=${topElementInfo.tag} class="${topElementInfo.className}" ` +
          `(inside card ${topElementInfo.closestCard}) — the menu is rendering BEHIND ` +
          'the card below it, which is the exact stacking-context bug this spec guards'
      ).toBe(true);
    });
  });
}
