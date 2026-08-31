/**
 * The dashboard boots, every widget renders, and nothing logs an error.
 *
 * The console assertion here is the one that carries the most weight: a
 * `TypeError` thrown inside a widget's render is caught by the host's error
 * boundary and never reaches a unit test, but in a browser it is the
 * difference between a tile and a blank rectangle. The fixture fails any test
 * whose page logged an error, so every test in the suite carries this check —
 * this file just makes it the explicit subject.
 *
 * The connectors are all unconfigured on purpose (see `server.js`), so this
 * also pins the "not configured" state, which is what an operator sees on
 * their first boot and therefore the state most worth knowing renders cleanly.
 */

import { test, expect, waitForDashboard, WIDGET_IDS, tileFor, widgetText } from './fixtures.js';

test.describe('boot', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('every widget in the roster gets a tile on the grid', async ({ page }) => {
    for (const id of WIDGET_IDS) {
      await expect(page.locator(`#${id}`), `widget ${id} should be mounted`).toHaveCount(1);
      // The tile is located through GridStack's own node id, so this also
      // asserts the grid actually adopted the element.
      await expect(tileFor(page, id), `widget ${id} should be on the grid`).toBeVisible();
    }
    await expect(page.locator('.grid-stack-item')).toHaveCount(WIDGET_IDS.length);
  });

  test('every tile is adopted by GridStack with its instance id', async ({ page }) => {
    // The regression this pins: `makeWidget` was called with an options object
    // carrying no `id`, so every node serialised as the string "undefined" and
    // both Save and Discard broke. A unit test could not see it — GridStack is
    // never loaded under `node --test`.
    const ids = await page.evaluate(() =>
      document.querySelector('.grid-stack').gridstack.engine.nodes.map((n) => String(n.id))
    );
    expect(ids.sort()).toEqual([...WIDGET_IDS].sort());
    expect(ids).not.toContain('undefined');
  });

  test('each widget mounts its custom element inside its own shadow root', async ({ page }) => {
    // Per the contract, every widget lives in a shadow root so broken markup
    // cannot reach the host layout. The nesting is host div → shadow root →
    // the widget's custom element → its own shadow root, and a widget that
    // mounted but never rendered shows up here as an element with no shadow.
    const rendered = await page.evaluate(
      (ids) =>
        ids.map((id) => {
          const el = document.getElementById(id);
          const custom = el?.shadowRoot?.firstElementChild ?? null;
          return {
            id,
            hasShadow: Boolean(el?.shadowRoot),
            tag: custom?.tagName ?? null,
            // A custom element that upgraded and rendered has a shadow root of
            // its own; one that silently failed to render does not.
            customRendered: Boolean(custom?.shadowRoot?.childElementCount),
          };
        }),
      WIDGET_IDS
    );

    for (const widget of rendered) {
      expect(widget.hasShadow, `${widget.id} should have a shadow root`).toBe(true);
      expect(widget.tag, `${widget.id} should mount a custom element`).toMatch(/^HAVEN-/);
      expect(widget.customRendered, `${widget.id} should render into its shadow root`).toBe(true);
    }
  });

  test('an unconfigured connector renders its tile rather than an error', async ({ page }) => {
    // No credentials are set, so this is the real first-boot state — what an
    // operator sees before configuring anything. The contract calls "not
    // configured" a notice, not an error: the tile must draw real copy, and
    // the widget must not be in the host's error state.
    //
    for (const id of ['torrents', 'calendar']) {
      await expect(page.locator(`#${id}`), `${id} should not be an error tile`).not.toHaveClass(
        /haven-widget--error/
      );
      // Non-empty rendered copy: a blank tile is the failure this catches.
      await expect
        .poll(async () => (await widgetText(page, id)).length, {
          message: `${id} should render some copy`,
        })
        .toBeGreaterThan(0);
    }

    // And the copy is the "not configured" state specifically — naming the
    // environment variable that would fix it, rather than a stack trace or a
    // bare empty tile.
    expect(await widgetText(page, 'torrents')).toMatch(/qBittorrent is not configured/i);
    expect(await widgetText(page, 'calendar')).toMatch(/No calendar connected yet/i);

    // The hero and apps widgets have no connector, but they have the same
    // "nothing here yet" state and it must render rather than blank.
    expect(await widgetText(page, 'hero-main')).toMatch(/Nothing featured yet/i);
    expect(await widgetText(page, 'apps-main')).toMatch(/No apps in this category/i);
  });

  test('a widget with no data source still renders live content', async ({ page }) => {
    // The clock is the worked example of a widget the host drives on a ticker
    // rather than a fetch. If the shared ticker were not running it would show
    // nothing at all, which no unit test of the clock alone would notice.
    const local = await widgetText(page, 'clock-local');
    expect(local).toMatch(/Local time/);
    expect(local, 'the clock should render a HH:MM time').toMatch(/\d{1,2}:\d{2}/);

    // Two clocks configured for different zones must not render the same time
    // — that is the assertion that the per-instance config actually reached
    // the widget rather than both falling back to a default.
    const tokyo = await widgetText(page, 'clock-tokyo');
    expect(tokyo).toMatch(/Tokyo/);
    expect(tokyo).toMatch(/\d{1,2}:\d{2}/);
  });

  test('the API reports connectors as unconfigured, not as failures', async ({ page }) => {
    // The server half of the same state: "not configured" is a 200 with a
    // status to branch on, never a 5xx. A 503 here would mean the shell was
    // being handed an error to render on a perfectly healthy deployment.
    const weather = await page.request.get('/api/widgets/weather');
    expect(weather.status()).toBe(200);
    expect((await weather.json()).status).toBe('not_configured');

    for (const path of ['/api/widgets/torrents', '/api/widgets/calendar']) {
      const res = await page.request.get(path);
      expect(res.status(), `${path} should answer 200`).toBe(200);
      expect((await res.json()).configured, `${path} should report unconfigured`).toBe(false);
    }
  });

  test('the toolbar starts in view mode with the grid locked', async ({ page }) => {
    const toggle = page.locator('.haven-toolbar__toggle');
    await expect(toggle).toHaveText('Edit dashboard');
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator('.haven-toolbar__save')).toBeHidden();
    await expect(page.locator('.haven-toolbar__discard')).toBeHidden();

    // View mode does not move: dragging is off until edit mode is entered.
    const locked = await page.evaluate(() => {
      const grid = document.querySelector('.grid-stack').gridstack;
      return { move: grid.opts.disableDrag, resize: grid.opts.disableResize };
    });
    expect(locked).toEqual({ move: true, resize: true });
  });
});
