/**
 * The Library Analytics subpage, driven in a real browser.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * The unit suite covers the connector's aggregation and the page's render
 * function against a fake DOM. Neither can see the two things that actually
 * broke this feature before:
 *
 *  1. The route. The page lives at `#/page/library-analytics` — WITH the
 *     leading slash inside the fragment. `#page/...` without it is a widget
 *     deep link and resolves to something else entirely. That distinction
 *     lives in the router's parsing and is invisible to a render-only test.
 *  2. The degradation. The shipped version of this page rendered an empty
 *     state forever because the connector it waited for was never built. The
 *     e2e harness configures NO snapshot file (see `server.js`), so a run
 *     here exercises the missing-snapshot path against the real server, the
 *     real route and the real fetch — not a stub returning a hand-written
 *     object.
 *
 * That second point is the one worth stating plainly: a missing snapshot is a
 * CONFIGURATION state, not a failure. It must render an honest empty state and
 * must not throw. The console guard in `fixtures.js` fails any test whose page
 * logged an error, so "did not throw" is asserted on every test below rather
 * than only where it is named.
 *
 * ### On asserting visibility rather than presence
 * The router SHOWS and HIDES the two roots (`gridRoot.hidden = true`) instead
 * of tearing them down, so `.grid-stack` is still in the DOM while a page is
 * open. Every assertion below is therefore about what the user can SEE. An
 * earlier draft of this file asserted the grid had been removed, and failed
 * against perfectly correct code — worth stating so the next person does not
 * reintroduce it.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { test, expect, waitForDashboard } from './fixtures.js';

const ROUTE = '#/page/library-analytics';

test.describe('library analytics page', () => {
  test('the route resolves to the page and hides the dashboard', async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
    await expect(page.locator('.grid-stack')).toBeVisible();

    await page.evaluate((route) => {
      window.location.hash = route;
    }, ROUTE);

    await waitForPage(page);

    // Asserting the grid is HIDDEN is the half that makes this able to fail: a
    // router that rendered the page without swapping views would still show a
    // `.page__title`, and a presence-only check would pass.
    await expect(page.locator('.grid-stack')).toBeHidden();
    await expect(page.locator('.page__title')).toHaveText(/library/i);
  });

  test('a missing snapshot renders an honest empty state, not an error', async ({ page }) => {
    // The harness sets no `HAVEN_MEDIA_LIBRARY_FILE`, so the connector reports
    // `status: "unavailable"` and the page takes its no-snapshot branch. This
    // is the required degradation, proven end to end against the real server.
    await page.goto(`/${ROUTE}`);
    await waitForPage(page);

    const text = await page.locator('.page__empty').innerText();

    // The negative half is the load-bearing half: the ERROR branch of
    // `render()` also produces a `.page__empty` paragraph, so a test that only
    // checked the element existed would pass while the user was actually
    // reading "Library statistics could not be loaded: ...".
    expect(text).toMatch(/no media library snapshot/i);
    expect(text).not.toMatch(/could not be loaded/i);

    // And it must not have degraded into the router's unknown-page fallback,
    // which would also look like "a page rendered something".
    await expect(page.locator('.page__missing')).toHaveCount(0);
  });

  test('the page settles rather than sitting on its loading state', async ({ page }) => {
    // Pins the router's data seam. If `load()` were never awaited, or its
    // result never re-rendered, the page would keep the "Loading…" paragraph
    // it paints synchronously and would look identical to a slow network.
    await page.goto(`/${ROUTE}`);
    await waitForPage(page);

    await expect(page.locator('.page__empty')).not.toHaveText(/loading/i);
  });

  test('the leading slash matters — #page/... is not this route', async ({ page }) => {
    // `#/page/x` is a route; `#page/x` is a widget deep link. They differ by
    // one character and the wrong one silently does nothing useful, so the
    // distinction is pinned rather than left to a reader of the router.
    await page.goto('/');
    await waitForDashboard(page);

    await page.evaluate(() => {
      window.location.hash = '#page/library-analytics';
    });

    // Still the dashboard: no page view was opened.
    await expect(page.locator('.grid-stack')).toBeVisible();
    await expect(page.locator('.page__title')).toHaveCount(0);
  });

  test('navigating back to the dashboard restores the grid', async ({ page }) => {
    // The router's teardown, and with it the `renderToken` guard that stops a
    // slow load painting over a view the user already left.
    await page.goto(`/${ROUTE}`);
    await waitForPage(page);

    await page.evaluate(() => {
      window.location.hash = '';
    });
    await waitForDashboard(page);

    await expect(page.locator('.grid-stack')).toBeVisible();
    await expect(page.locator('.page__empty')).toHaveCount(0);
  });
});

/**
 * Waits for the subpage to have rendered its own content.
 *
 * Waits on the page's header rather than a fixed timeout: the render is
 * asynchronous (the shell fetches, then re-renders) and a sleep would be
 * either flaky or slow.
 */
async function waitForPage(page) {
  await page.waitForSelector('.page__title', { state: 'visible' });
}
