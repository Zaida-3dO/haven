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
  SIDEBAR_WIDGET_IDS,
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
    const measured = await page.evaluate(measureAtViewport, SIDEBAR_WIDGET_IDS);

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
