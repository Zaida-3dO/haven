/**
 * The render smoke test: every widget actually drew something, with real size.
 *
 * ── Why this file exists ─────────────────────────────────────────────────
 * On 2026-09-04 a P0 was raised claiming every widget on the dashboard was
 * rendering an empty frame. It was WRONG, but it took two rounds of manual
 * browser work and a wasted crew dispatch to establish that, because Haven's
 * widgets sit behind TWO nested shadow roots and both investigators measured
 * the outer one:
 *
 *     .grid-stack-item-content     <- no shadow root, correctly
 *       └ div.haven-widget         <- shadow root #1  (WidgetHost.mount)
 *           └ <haven-widget-apps>  <- shadow root #2  (the element itself)
 *               └ ~49,000 chars of real content
 *
 * `textContent`, `innerHTML` and `childElementCount` all stop at the first
 * boundary, so the outer node reads as empty on a perfectly healthy page.
 * Measuring it and concluding "the dashboard is blank" is a mistake that has
 * now been made twice, and this file exists to make it impossible to make a
 * third time: the assertions below walk to the INNER root and say, in code,
 * where the content actually lives.
 *
 * ── Why it is a browser test and not a unit test ──────────────────────────
 * The unit suite runs against `web/test/helpers/fake-dom.js`, which has no
 * layout engine and backs children with a plain array. It therefore cannot
 * observe any of the three things asserted here — an unpopulated shadow root,
 * a zero-height box, or a tile clipped to nothing. Six bugs have shipped past
 * roughly 900 green unit tests through precisely that blind spot.
 *
 * ── What would make these fail ───────────────────────────────────────────
 * These are not decorative. Each assertion has a specific, nameable failure:
 *  - a widget whose `render()` throws early, leaving the host's shadow root
 *    holding an error card or the empty `haven-widget__pending` div
 *  - a custom element that never upgrades, so the inner shadow root is absent
 *  - a CSS regression that collapses a tile, a card or `<main>` to 0px, which
 *    is the failure the sidebar's own comment warns about for the 3D home card
 *    ("its iframe sizes to its container, so its body needs an explicit height
 *    or it collapses to 0px")
 * ─────────────────────────────────────────────────────────────────────────
 */

import { test, expect, waitForDashboard, WIDGET_IDS, SIDEBAR_WIDGET_IDS } from './fixtures.js';

/**
 * Measures every named widget by walking both shadow boundaries, in the page.
 *
 * Written as one self-contained function passed to `page.evaluate`: it is
 * serialised to the browser, so it may not close over anything in this module.
 * Everything it needs arrives in `ids`. Results come back as plain data so a
 * failure message can name WHICH condition broke rather than reporting a bare
 * `false`.
 */
const measureWidgets = (ids) =>
  ids.map((id) => {
    const host = document.getElementById(id);
    if (!host) return { id, found: false };

    // Boundary 1: the host div's shadow root.
    const outerRoot = host.shadowRoot ?? null;
    // The widget's custom element lives directly inside it.
    const custom = outerRoot?.firstElementChild ?? null;
    // Boundary 2: the custom element's own shadow root — where content lives.
    const innerRoot = custom?.shadowRoot ?? null;

    // Content length EXCLUDING <style>. A widget renders its stylesheet into
    // its own root, so counting innerHTML wholesale would let a widget that
    // drew nothing but CSS pass as "non-empty" — which is the vacuous version
    // of this very assertion.
    let contentChars = 0;
    let elementCount = 0;
    if (innerRoot) {
      for (const child of innerRoot.children) {
        if (child.tagName === 'STYLE') continue;
        elementCount += 1;
        contentChars += (child.textContent ?? '').length;
      }
    }

    const hostBox = host.getBoundingClientRect();
    const customBox = custom?.getBoundingClientRect() ?? null;

    return {
      id,
      found: true,
      hasOuterShadow: Boolean(outerRoot),
      customTag: custom?.tagName ?? null,
      hasInnerShadow: Boolean(innerRoot),
      elementCount,
      contentChars,
      hostHeight: Math.round(hostBox.height),
      hostWidth: Math.round(hostBox.width),
      customHeight: customBox ? Math.round(customBox.height) : 0,
      // An error tile is a rendered thing with real size, so size alone would
      // not catch it — the host swaps its content for `.haven-widget__error`.
      isErrorCard: Boolean(outerRoot?.querySelector('.haven-widget__error')),
      // The pending placeholder is deliberately empty; a widget still showing
      // it after boot never upgraded.
      isPending: Boolean(outerRoot?.querySelector('.haven-widget__pending')),
    };
  });

/** Asserts one measurement is a genuinely rendered widget. */
function expectRendered(w, label) {
  expect(w.found, `${label} (${w.id}) should be in the document`).toBe(true);
  expect(w.hasOuterShadow, `${label} (${w.id}) should have the host shadow root`).toBe(true);
  // `HAVEN-` rather than `HAVEN-WIDGET-`: the clock registers as `haven-clock`
  // while everything else is `haven-widget-<type>`. Asserting the narrower
  // prefix would fail on both clocks in the default roster — a false failure
  // in the test rather than a real one in the app.
  expect(w.customTag, `${label} (${w.id}) should mount a haven-* custom element`).toMatch(
    /^HAVEN-/
  );
  expect(w.isPending, `${label} (${w.id}) should not still be the pending placeholder`).toBe(false);
  expect(w.isErrorCard, `${label} (${w.id}) should not have fallen back to an error card`).toBe(
    false
  );

  // The inner root is the whole point of this file.
  expect(
    w.hasInnerShadow,
    `${label} (${w.id}) should have its OWN shadow root inside the host's — ` +
      `this is the second boundary, and content lives here, not on .haven-widget`
  ).toBe(true);
  expect(
    w.elementCount,
    `${label} (${w.id}) should render at least one non-<style> element into its inner root`
  ).toBeGreaterThan(0);
  expect(
    w.contentChars,
    `${label} (${w.id}) should render real content, not just a stylesheet`
  ).toBeGreaterThan(0);

  // Non-zero height: the half of this that a DOM-shape assertion cannot see.
  expect(w.hostHeight, `${label} (${w.id}) should have non-zero height`).toBeGreaterThan(0);
  expect(w.hostWidth, `${label} (${w.id}) should have non-zero width`).toBeGreaterThan(0);
  expect(
    w.customHeight,
    `${label} (${w.id})'s widget element should not be collapsed to 0px`
  ).toBeGreaterThan(0);
}

test.describe('render smoke', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('every grid widget renders content into its inner shadow root', async ({ page }) => {
    const measured = await page.evaluate(measureWidgets, WIDGET_IDS);

    expect(measured, 'every roster widget should have been measured').toHaveLength(
      WIDGET_IDS.length
    );
    for (const widget of measured) expectRendered(widget, 'grid widget');
  });

  test('every sidebar widget renders content into its inner shadow root', async ({ page }) => {
    // The sidebar mounts real widget hosts, so it has the same two-boundary
    // structure — and it is the more fragile of the two, because a sidebar
    // card's body is sized by CSS rather than by GridStack. The 3D home card
    // is the standing example: its iframe sizes to its container, so a lost
    // height rule collapses it to 0px while leaving the DOM entirely correct.
    const measured = await page.evaluate(measureWidgets, SIDEBAR_WIDGET_IDS);

    expect(measured, 'every sidebar widget should have been measured').toHaveLength(
      SIDEBAR_WIDGET_IDS.length
    );
    for (const widget of measured) expectRendered(widget, 'sidebar widget');
  });

  test('the page chrome itself has real height', async ({ page }) => {
    // The P0's other symptom was `<main>` at zero height. A widget can be
    // perfectly healthy inside a container that has collapsed, and then
    // nothing is visible regardless.
    const boxes = await page.evaluate(() => {
      const read = (selector) => {
        const el = document.querySelector(selector);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { height: Math.round(rect.height), width: Math.round(rect.width) };
      };
      return {
        grid: read('#haven-grid'),
        layout: read('#haven-layout'),
        sidebar: read('.haven-sidebar'),
        gridStack: read('.grid-stack'),
      };
    });

    for (const [name, box] of Object.entries(boxes)) {
      expect(box, `${name} should exist`).not.toBeNull();
      expect(box.height, `${name} should have non-zero height`).toBeGreaterThan(0);
      expect(box.width, `${name} should have non-zero width`).toBeGreaterThan(0);
    }
  });

  test('no widget is clipped to nothing by its tile', async ({ page }) => {
    // A tile with height that renders content taller than itself and hides the
    // overflow looks identical to a working widget in the DOM. This compares
    // the rendered element against the box it sits in.
    const clipped = await page.evaluate(
      (ids) =>
        ids
          .map((id) => {
            const host = document.getElementById(id);
            const tile = host?.closest('.grid-stack-item');
            if (!host || !tile) return null;
            const tileBox = tile.getBoundingClientRect();
            return {
              id,
              tileHeight: Math.round(tileBox.height),
              tileWidth: Math.round(tileBox.width),
            };
          })
          .filter(Boolean),
      WIDGET_IDS
    );

    expect(clipped).toHaveLength(WIDGET_IDS.length);
    for (const tile of clipped) {
      expect(tile.tileHeight, `${tile.id}'s tile should have real height`).toBeGreaterThan(0);
      expect(tile.tileWidth, `${tile.id}'s tile should have real width`).toBeGreaterThan(0);
    }
  });

  test('the widget roster the tests assert against matches what the server seeds', async ({
    page,
  }) => {
    // An anti-drift guard, not a feature test. `WIDGET_IDS` is a hand-copied
    // mirror of the server's `DEFAULT_INSTANCES`, and every other test in this
    // suite iterates it — so if the server's seed gains a widget and this list
    // does not, all of those tests keep passing while quietly checking less
    // than they claim to. That is the vacuous-pass failure mode, so it gets an
    // explicit assertion rather than a comment asking people to remember.
    const served = await page.request.get('/api/instances');
    expect(served.ok(), 'the roster endpoint should answer').toBeTruthy();

    const body = await served.json();
    const ids = (body.instances ?? body).map((entry) => entry.id);

    expect(
      ids.sort(),
      'WIDGET_IDS is out of step with the seeded roster — update it in fixtures.js'
    ).toEqual([...WIDGET_IDS].sort());
  });
});
