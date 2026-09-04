/**
 * Shared fixtures: a console-error guard, and helpers for driving a real grid.
 *
 * The console guard is the point of the whole file. A silent `TypeError` in a
 * widget is invisible to the unit suite — the fake DOM has no console and a
 * throw inside an error boundary is caught by design — but it is exactly the
 * class of bug that reaches a user as a blank tile. So every test in this
 * suite fails if the page logged an error or threw, unless it opts out by
 * declaring the errors it expects.
 */

import { test as base, expect } from '@playwright/test';

/**
 * Console output a test may legitimately produce.
 *
 * Deliberately empty by default: an allowance belongs in the one test that
 * needs it, named and justified there, rather than as a blanket filter here
 * that would quietly swallow a real regression in every other test.
 */
const ALWAYS_ALLOWED = [];

export const test = base.extend({
  /**
   * Patterns a test expects to see logged. Override per test with
   * `test.use({ allowedConsoleErrors: [/…/] })`.
   */
  allowedConsoleErrors: [ALWAYS_ALLOWED, { option: true }],

  /**
   * Wraps every test so that a console error or an uncaught exception fails
   * it, whatever else the test asserted.
   */
  page: async ({ page, allowedConsoleErrors }, use, testInfo) => {
    const problems = [];
    const allowed = [...ALWAYS_ALLOWED, ...allowedConsoleErrors];
    const isAllowed = (text) => allowed.some((pattern) => pattern.test(text));

    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const text = message.text();
      if (isAllowed(text)) return;
      problems.push(`console.error: ${text}`);
    });

    page.on('pageerror', (error) => {
      const text = `${error.name}: ${error.message}`;
      if (isAllowed(text)) return;
      problems.push(`uncaught: ${text}\n${error.stack ?? ''}`);
    });

    await use(page);

    // Only assert on a test that was otherwise going to pass — a failing test
    // has usually already logged something, and reporting the console noise
    // instead of the real assertion buries the cause.
    if (testInfo.status === testInfo.expectedStatus && problems.length > 0) {
      throw new Error(
        `The page reported ${problems.length} console error(s):\n\n${problems.join('\n\n')}`
      );
    }
  },
});

export { expect };

/**
 * The ids the server seeds, in roster order.
 *
 * This mirrors `DEFAULT_INSTANCES` in `server/src/db/instances-store.js` — the
 * SERVER's list, not the `FALLBACK_INSTANCES` copy in `web/src/shell/boot.js`.
 * The two differ (the web copy carries an extra `page-library` entry) and only
 * the server's applies here, because the harness boots a real database that
 * gets seeded. The web fallback is used only when `GET /api/instances` fails,
 * which it does not in these tests.
 *
 * `render-smoke.spec.js` asserts this list against the live endpoint, so it
 * cannot silently drift out of step and quietly test fewer widgets.
 */
export const WIDGET_IDS = [
  'hero-main',
  'apps-main',
  'clock-local',
  'torrents',
  'calendar',
  'clock-tokyo',
];

/**
 * Widgets mounted into the SIDEBAR rather than onto the grid.
 *
 * These are real widget hosts with the same two-shadow-root structure, but no
 * GridStack node — so anything selecting `.grid-stack-item` will never see
 * them. They are listed separately for that reason.
 *
 * `sidebar-home3d` is deliberately excluded: the iframe widget lazy-loads its
 * document on visibility, so what it has rendered at boot is a function of
 * scroll position rather than of correctness, and asserting on it would be
 * flaky by construction.
 */
export const SIDEBAR_WIDGET_IDS = ['sidebar-weather', 'sidebar-calendar', 'sidebar-status'];

/**
 * Waits until the dashboard has booted and every widget tile is on the grid.
 *
 * Waits on the grid having adopted the tiles rather than on a timeout: an
 * element is `.grid-stack-item` only once GridStack has made it one, so this
 * is the observable signal that the async boot in `boot.js` has finished.
 */
export async function waitForDashboard(page, expectedCount = WIDGET_IDS.length) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.grid-stack-item.grid-stack-item').length >= count,
    expectedCount
  );
  // The layout fetch resolves before the widgets are placed, so also wait for
  // the host's tiles — the widget bodies — to exist.
  await expect(page.locator('.haven-widget__body').first()).toBeVisible();
}

/**
 * The `.grid-stack-item` tile a widget lives in.
 *
 * Resolved through GridStack's own node ids rather than by walking ancestors:
 * the tile contains a nested `.grid-stack-item-content`, so an ancestor query
 * matches two elements and trips strict mode.
 */
export function tileFor(page, widgetId) {
  return page.locator(`.grid-stack-item[gs-id="${widgetId}"]`);
}

/**
 * The text a widget actually renders, walking through nested shadow roots.
 *
 * A widget sits two shadow roots deep — the host's div wraps the widget's own
 * custom element, which has a root of its own — and `textContent` does not
 * cross either boundary, so it reads as empty for every tile. This walks both,
 * skipping `<style>` so the assertion is about copy rather than about CSS
 * source text (which is otherwise the bulk of what a root contains).
 */
export function widgetText(page, widgetId) {
  return page.evaluate((id) => {
    const host = document.getElementById(id);
    if (!host?.shadowRoot) return '';
    let out = '';
    const walk = (node) => {
      for (const child of node.childNodes) {
        if (child.nodeType === Node.TEXT_NODE) out += `${child.nodeValue} `;
        else if (child.nodeType === Node.ELEMENT_NODE) {
          if (child.tagName === 'STYLE') continue;
          if (child.shadowRoot) walk(child.shadowRoot);
          walk(child);
        }
      }
    };
    walk(host.shadowRoot);
    return out.replace(/\s+/g, ' ').trim();
  }, widgetId);
}

/** Reads a widget's live geometry straight off its GridStack node. */
export async function geometryOf(page, widgetId) {
  return page.evaluate((id) => {
    const el = document.getElementById(id)?.closest('.grid-stack-item');
    const node = el?.gridstackNode;
    if (!node) return null;
    return { x: node.x, y: node.y, w: node.w, h: node.h };
  }, widgetId);
}

/** Reads the whole current layout as `{ id: {x,y,w,h} }`, for comparing states. */
export async function layoutSnapshot(page) {
  return page.evaluate(() => {
    const out = {};
    for (const el of document.querySelectorAll('.grid-stack-item')) {
      const node = el.gridstackNode;
      if (!node) continue;
      out[String(node.id)] = { x: node.x, y: node.y, w: node.w, h: node.h };
    }
    return out;
  });
}

/** The saved layout as the server holds it, per breakpoint. */
export async function savedLayout(page) {
  const res = await page.request.get('/api/layout');
  expect(res.ok()).toBeTruthy();
  return (await res.json()).layout;
}

/** Clears the persisted layout so a test starts from a known-empty state. */
export async function resetSavedLayout(page) {
  const res = await page.request.put('/api/layout', {
    data: { desktop: [], mobile: [] },
  });
  expect(res.ok()).toBeTruthy();
}
