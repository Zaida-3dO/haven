/**
 * A real GridStack `resizestop`, driven by a real mouse.
 *
 * This is the gap the grid work flagged and could not close: `resizestop` is
 * the hook a WebGL widget uses for `renderer.setSize()`, and until now nothing
 * had ever fired it. The unit suite cannot — GridStack is not loadable under
 * `node --test` — so the whole path from "user drags the grip" through
 * GridStack's node update to the widget's `onResize(w, h)` was asserted only
 * in a comment.
 *
 * The drag is done with real `mouse.move` steps rather than a synthetic event,
 * because a synthesised `mousedown` is exactly the thing that would pass while
 * the real interaction was broken.
 */

import { test, expect, waitForDashboard, geometryOf, tileFor } from './fixtures.js';

/** Enters edit mode, which is what turns the resize grips on. */
async function enterEditMode(page) {
  await page.click('.haven-toolbar__toggle');
  await expect(page.locator('.haven-toolbar__toggle')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.grid-stack')).toHaveClass(/haven-grid--editing/);
}

/**
 * Drags a tile's south-east resize grip by a pixel delta and waits for
 * GridStack to settle.
 *
 * Waits on the node's geometry actually changing rather than on a timer: the
 * grid updates its node synchronously on `resizestop`, so the new value is the
 * signal that the interaction completed.
 */
async function dragResizeHandle(page, widgetId, { dx, dy }) {
  const tile = tileFor(page, widgetId);
  // GridStack marks tiles `ui-resizable-autohide`: the grips are `display:none`
  // until the pointer is over the tile. Hovering first is what a user does, and
  // without it the handle has a zero-sized box and cannot be dragged.
  await tile.hover();

  const handle = tile.locator('.ui-resizable-se');
  await expect(handle).toBeVisible();

  const box = await handle.boundingBox();
  if (!box) throw new Error(`no resize handle for ${widgetId}`);

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;

  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Several steps: GridStack tracks the drag through `mousemove`, and a single
  // jump can be treated as a click rather than a drag.
  await page.mouse.move(startX + dx / 2, startY + dy / 2, { steps: 8 });
  await page.mouse.move(startX + dx, startY + dy, { steps: 8 });
  await page.mouse.up();
}

test.describe('resize', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('dragging the grip resizes the widget and fires resizestop', async ({ page }) => {
    // Record every `resizestop` the grid emits, so the assertion is that the
    // event fired with the right geometry — not merely that the tile changed.
    await page.evaluate(() => {
      window.__resizeStops = [];
      document.querySelector('.grid-stack').gridstack.on('resizestop', (event, el) => {
        const node = el?.gridstackNode;
        window.__resizeStops.push({ id: String(node?.id), w: node?.w, h: node?.h });
      });
    });

    await enterEditMode(page);

    const before = await geometryOf(page, 'clock-local');
    expect(before).not.toBeNull();

    // Roughly two columns wider and one row taller. Cell height is 90px and a
    // desktop column is ~1/12th of a 1440px viewport, so this comfortably
    // clears the threshold for a whole cell in each direction.
    await dragResizeHandle(page, 'clock-local', { dx: 240, dy: 95 });

    await expect
      .poll(async () => (await geometryOf(page, 'clock-local')).w, {
        message: 'the widget should have grown wider',
      })
      .toBeGreaterThan(before.w);

    const after = await geometryOf(page, 'clock-local');
    expect(after.h).toBeGreaterThan(before.h);

    const stops = await page.evaluate(() => window.__resizeStops);
    expect(stops.length, 'resizestop should have fired').toBeGreaterThan(0);

    const last = stops.at(-1);
    expect(last.id).toBe('clock-local');
    // The event must carry the *new* geometry — this is what the 3D widget
    // will read to call renderer.setSize(), so a stale value here is the bug.
    expect(last.w).toBe(after.w);
    expect(last.h).toBe(after.h);
  });

  test('onResize reaches the widget with the new cell geometry', async ({ page }) => {
    // The full contract path: grid `resizestop` → dashboard-grid → the host's
    // `onResize(w, h)`. Patching the host's method is what makes this an
    // assertion about the widget actually being told, rather than about the
    // grid having moved.
    await page.evaluate(() => {
      window.__onResizeCalls = [];
      const host = window.__haven?.dashboard?.host('torrents');
      if (!host) throw new Error('no host for torrents — is the app exposed on window.__haven?');
      const original = host.onResize.bind(host);
      host.onResize = (w, h) => {
        window.__onResizeCalls.push({ w, h });
        return original(w, h);
      };
    });

    await enterEditMode(page);

    const before = await geometryOf(page, 'torrents');
    await dragResizeHandle(page, 'torrents', { dx: 240, dy: 95 });

    await expect
      .poll(async () => (await page.evaluate(() => window.__onResizeCalls)).length, {
        message: 'the widget should have been told it resized',
      })
      .toBeGreaterThan(0);

    const calls = await page.evaluate(() => window.__onResizeCalls);
    const after = await geometryOf(page, 'torrents');

    expect(after.w).toBeGreaterThan(before.w);
    // The last call is the settled geometry, and it must match the grid.
    expect(calls.at(-1)).toEqual({ w: after.w, h: after.h });
  });

  test('a widget cannot be resized below its declared minimum', async ({ page }) => {
    // `minSize` maps to GridStack's minW/minH, which is what stops a widget
    // being shrunk below the size it can actually render at. Only a real drag
    // exercises the constraint.
    await enterEditMode(page);

    const limits = await page.evaluate(() => {
      const node = document.getElementById('calendar').closest('.grid-stack-item').gridstackNode;
      return { minW: node.minW, minH: node.minH };
    });
    expect(limits.minW, 'the calendar should declare a minimum width').toBeGreaterThan(0);

    // Drag far past the minimum in both directions.
    await dragResizeHandle(page, 'calendar', { dx: -900, dy: -600 });

    const after = await geometryOf(page, 'calendar');
    expect(after.w).toBeGreaterThanOrEqual(limits.minW);
    expect(after.h).toBeGreaterThanOrEqual(limits.minH);
  });
});
