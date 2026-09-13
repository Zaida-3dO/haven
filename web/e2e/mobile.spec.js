/**
 * The dashboard at 390x844 — a phone-sized viewport, across every widget.
 *
 * ── Why this is separate from the stylesheet contract tests ───────────────
 * `web/test/sidebar-layout-contract.test.js` and its siblings already assert
 * that the right `@media (max-width: …)` rules EXIST in `main.css`. That is a
 * genuinely useful check and it is not this. A rule can be present, correct,
 * and still not apply — outranked by a later selector, scoped to a container
 * that is not the one that ends up wrapping the element, or simply never
 * matched because the breakpoint the JS uses and the breakpoint the CSS uses
 * have drifted apart. Only a real viewport settles it.
 *
 * The mobile breakpoint is `<= 768px` (`DEFAULT_MOBILE_BREAKPOINT` in
 * `web/src/shell/grid-layout.js`) and mobile is a 4-column grid against
 * desktop's 12, so 390px is comfortably inside it rather than balanced on the
 * edge — a test sitting exactly on a boundary is a test that flips on a
 * one-pixel change.
 *
 * ── What these assert that a desktop run cannot ───────────────────────────
 * Every widget still renders content and still has real height when the
 * column count changes and the sidebar reflows. A widget that renders fine at
 * 1440px and collapses at 390px is invisible to every other test in this
 * suite, because they all run at the configured desktop viewport.
 * ─────────────────────────────────────────────────────────────────────────
 */

import {
  test,
  expect,
  waitForDashboard,
  WIDGET_IDS,
  sidebarWidgetIds,
  widgetText,
} from './fixtures.js';

/** A phone viewport: iPhone-class, and well inside the 768px breakpoint. */
const MOBILE = { width: 390, height: 844 };

/**
 * Measures a widget's rendered content and box, walking BOTH shadow roots.
 *
 * Serialised into the page, so it closes over nothing from this module. The
 * two-boundary walk is the same one `render-smoke.spec.js` documents at
 * length: content lives in the custom element's own root, not on
 * `.haven-widget`.
 */
const measureAtViewport = (ids) =>
  ids.map((id) => {
    const host = document.getElementById(id);
    if (!host) return { id, found: false };

    const custom = host.shadowRoot?.firstElementChild ?? null;
    const innerRoot = custom?.shadowRoot ?? null;

    let contentChars = 0;
    if (innerRoot) {
      for (const child of innerRoot.children) {
        if (child.tagName === 'STYLE') continue;
        contentChars += (child.textContent ?? '').length;
      }
    }

    const box = host.getBoundingClientRect();
    return {
      id,
      found: true,
      hasInnerShadow: Boolean(innerRoot),
      contentChars,
      height: Math.round(box.height),
      width: Math.round(box.width),
      // Overflowing the viewport horizontally is the classic mobile failure:
      // the page renders but scrolls sideways.
      right: Math.round(box.right),
    };
  });

test.describe('mobile (390x844)', () => {
  test.use({ viewport: MOBILE });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('the grid switches to the mobile breakpoint', async ({ page }) => {
    // The JS-side breakpoint, not the CSS one: this is what decides which
    // saved layout is loaded and how many columns are rendered. If this says
    // "desktop" at 390px then every per-breakpoint layout behaviour below it
    // is wrong regardless of what the stylesheet does.
    const state = await page.evaluate(() => ({
      breakpoint: window.__haven?.gridHandle?.breakpoint?.() ?? null,
      columns: document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null,
    }));

    expect(state.breakpoint, 'a 390px viewport should be the mobile breakpoint').toBe('mobile');
    expect(state.columns, 'mobile is a 4-column grid').toBe(4);
  });

  test('every grid widget still renders content with real height', async ({ page }) => {
    const measured = await page.evaluate(measureAtViewport, WIDGET_IDS);

    expect(measured).toHaveLength(WIDGET_IDS.length);
    for (const widget of measured) {
      expect(widget.found, `${widget.id} should be mounted on mobile`).toBe(true);
      expect(widget.hasInnerShadow, `${widget.id} should still render into its inner root`).toBe(
        true
      );
      expect(
        widget.contentChars,
        `${widget.id} should still render real content at 390px`
      ).toBeGreaterThan(0);
      expect(widget.height, `${widget.id} should not collapse at 390px`).toBeGreaterThan(0);
      expect(widget.width, `${widget.id} should have width at 390px`).toBeGreaterThan(0);
    }
  });

  test('every sidebar widget still renders content with real height', async ({ page }) => {
    // The sidebar is the piece that reflows hardest on mobile — it is a fixed
    // 320px column on desktop and has to become something else entirely at
    // 390px. That is exactly where a card can end up with zero height while
    // its widget is perfectly healthy.
    const measured = await page.evaluate(measureAtViewport, await sidebarWidgetIds(page));

    for (const widget of measured) {
      expect(widget.found, `${widget.id} should be mounted on mobile`).toBe(true);
      expect(
        widget.contentChars,
        `${widget.id} should still render real content at 390px`
      ).toBeGreaterThan(0);
      expect(widget.height, `${widget.id} should not collapse at 390px`).toBeGreaterThan(0);
    }
  });

  test('the page does not scroll sideways', async ({ page }) => {
    // A horizontal scrollbar on a phone is the single most common mobile
    // regression, and it is invisible at 1440px. A few pixels of slack absorbs
    // sub-pixel rounding without letting a real overflow through.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(
      overflow.scrollWidth,
      'the document should not be wider than the viewport'
    ).toBeLessThanOrEqual(overflow.clientWidth + 2);
  });

  test('widget copy survives the narrow layout', async ({ page }) => {
    // Content, not just boxes: a tile can keep its height while its text is
    // clipped away to nothing by a narrow column.
    expect(await widgetText(page, 'torrents')).toMatch(/qBittorrent is not configured/i);
    expect(await widgetText(page, 'clock-local')).toMatch(/\d{1,2}:\d{2}/);
  });
});

/**
 * Narrowing an ALREADY-LOADED dashboard down to a phone width.
 *
 * ── Why this describe block exists, separately from the one above ─────────
 * Everything above uses `test.use({ viewport: MOBILE })`, and Playwright
 * applies that viewport BEFORE `page.goto`. So every one of those tests
 * exercises the same single path: a dashboard that was *born* narrow. That
 * path always worked.
 *
 * The path that was broken is the other one — a grid built at one width and
 * then resized past the breakpoint. `mountGrid` read the media query once, at
 * `GridStack.init`, and subscribed to nothing, so the column count was frozen
 * at whatever it was on load. `breakpoint()` correctly began reporting
 * `mobile` as soon as the window narrowed, and nothing acted on it: the grid
 * stayed `gs-12`, and a 2-column tile at 390px is about 37px wide.
 *
 * That is not a hypothetical. It is what a phone does on rotation, and what
 * any desktop window does on being dragged narrow. It was invisible to the
 * whole suite because no test had ever changed the viewport after boot.
 *
 * These tests fail against the pre-fix code: `columns` stays 12 and the clock
 * tiles measure ~37px wide, so both the breakpoint assertion and the width
 * assertion break. They are the reason the fix is a media-query subscription
 * rather than a change to the initial read.
 * ─────────────────────────────────────────────────────────────────────────
 */
test.describe('resizing a loaded dashboard across the breakpoint', () => {
  // Deliberately DESKTOP-sized to begin with — the whole point is to cross the
  // boundary after boot rather than to start on the far side of it.
  test.use({ viewport: { width: 1280, height: 900 } });

  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('narrowing to a phone width switches the grid to mobile columns', async ({ page }) => {
    const before = await page.evaluate(() => ({
      breakpoint: window.__haven?.gridHandle?.breakpoint?.() ?? null,
      columns: document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null,
    }));

    // It must genuinely start on desktop, or the test proves nothing: a grid
    // that was already 4 columns would "pass" without ever switching.
    expect(before.breakpoint, 'this test must start on the desktop breakpoint').toBe('desktop');
    expect(before.columns, 'desktop is a 12-column grid').toBe(12);

    await page.setViewportSize(MOBILE);

    // Poll rather than assert once: the `change` handler runs on the browser's
    // media-query task, and `grid.column()` relays every tile, so the new
    // column count is not observable in the same tick as the resize.
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null
          ),
        { message: 'the grid should re-column to mobile after the viewport narrows' }
      )
      .toBe(4);

    const after = await page.evaluate(() => ({
      breakpoint: window.__haven?.gridHandle?.breakpoint?.() ?? null,
      // `gs-12` left on the element is the visible form of this bug, so assert
      // on the class too rather than on the JS column count alone.
      gridClasses: document.querySelector('.grid-stack')?.className ?? '',
    }));

    expect(after.breakpoint, 'the handle should report mobile once narrowed').toBe('mobile');
    expect(after.gridClasses, 'the grid should no longer be in its 12-column mode').not.toMatch(
      /\bgs-12\b/
    );
    expect(after.gridClasses, 'the grid should be in its 4-column mode').toMatch(/\bgs-4\b/);
  });

  test('widgets are usably wide after narrowing, not slivers', async ({ page }) => {
    await page.setViewportSize(MOBILE);

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null
          ),
        { message: 'the grid should re-column before widths are measured' }
      )
      .toBe(4);

    const measured = await page.evaluate(measureAtViewport, WIDGET_IDS);

    // The observed failure was ~37px wide for a 2-of-12 tile at 390px. A
    // quarter of the viewport is the narrowest a 4-column grid can legitimately
    // produce; anything under 25% means the grid never left its desktop mode.
    // Bounded well above 37 and well below the true value, so it is a real
    // assertion rather than one tuned to today's exact pixels.
    const minimumUsableWidth = Math.round(MOBILE.width * 0.25) - 8;

    for (const widget of measured) {
      expect(widget.found, `${widget.id} should still be mounted after narrowing`).toBe(true);
      expect(
        widget.width,
        `${widget.id} should be usably wide after narrowing, not a ~37px sliver`
      ).toBeGreaterThan(minimumUsableWidth);
      expect(
        widget.height,
        `${widget.id} should still have height after narrowing`
      ).toBeGreaterThan(0);
      expect(
        widget.contentChars,
        `${widget.id} should still render real content after narrowing`
      ).toBeGreaterThan(0);
    }
  });

  test('the page does not scroll sideways after narrowing', async ({ page }) => {
    await page.setViewportSize(MOBILE);

    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null
          ),
        { message: 'the grid should re-column before overflow is measured' }
      )
      .toBe(4);

    // Re-columning moves every tile. Widening the grid past the viewport while
    // doing so would be a regression of the horizontal-overflow protection,
    // which is the one part of mobile that was already working.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));

    expect(
      overflow.scrollWidth,
      'the document should not be wider than the viewport after narrowing'
    ).toBeLessThanOrEqual(overflow.clientWidth + 2);
  });

  test('widening back to desktop restores the 12-column grid', async ({ page }) => {
    // The reverse crossing. A one-way fix would leave a phone user who rotates
    // to landscape, or a desktop user who re-maximises, stuck in 4 columns —
    // the same bug with the breakpoints swapped.
    await page.setViewportSize(MOBILE);
    await expect
      .poll(async () =>
        page.evaluate(() => document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null)
      )
      .toBe(4);

    await page.setViewportSize({ width: 1280, height: 900 });
    await expect
      .poll(
        async () =>
          page.evaluate(
            () => document.querySelector('.grid-stack')?.gridstack?.getColumn() ?? null
          ),
        { message: 'the grid should return to desktop columns when widened' }
      )
      .toBe(12);

    const after = await page.evaluate(() => ({
      breakpoint: window.__haven?.gridHandle?.breakpoint?.() ?? null,
      gridClasses: document.querySelector('.grid-stack')?.className ?? '',
    }));

    expect(after.breakpoint).toBe('desktop');
    expect(after.gridClasses).toMatch(/\bgs-12\b/);
  });
});
