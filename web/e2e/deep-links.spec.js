/**
 * `#widget-id` deep links, against a live grid.
 *
 * ── Why this can only be tested in a browser ─────────────────────────────
 * `gs-id` is not a stable thing to select on. GridStack takes ownership of it
 * when it adopts an element: it reads the attribute into its internal node and
 * then rewrites the attribute from that node. What it writes back is whatever
 * the node's `id` actually is — so when the node was created without one, the
 * attribute vanished entirely and `[gs-id="…"]` matched nothing on a live
 * grid. That is what broke deep links, and what made Discard a no-op that
 * looked like it had worked.
 *
 * `findWidgetElement` therefore resolves the host's real `id` first and treats
 * `gs-id` only as a fallback for an element the grid has not adopted yet.
 * Nothing under `node --test` can prove that ordering matters, because the
 * fake DOM never rewrites anything — whatever `createTile` set is still
 * sitting there. So this file asserts against the live grid: the id lookup
 * resolves every widget, and the tile it lands on is the one GridStack owns.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { test, expect, waitForDashboard, WIDGET_IDS, tileFor } from './fixtures.js';

test.describe('deep links', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForDashboard(page);
  });

  test('the id lookup resolves every widget on a live grid', async ({ page }) => {
    // `findWidgetElement`'s primary lookup, exercised after adoption. The
    // element it must find is the host's div, and the tile it highlights is
    // that div's `.grid-stack-item` ancestor.
    const state = await page.evaluate((ids) => {
      const resolved = ids.map((id) => {
        const el = document.getElementById(id);
        return {
          id,
          found: Boolean(el),
          hasTile: Boolean(el?.closest('.grid-stack-item')),
          // The tile the id resolves to must be the one GridStack owns.
          tileIsAdopted: Boolean(el?.closest('.grid-stack-item')?.gridstackNode),
        };
      });
      return { resolved, items: document.querySelectorAll('.grid-stack-item').length };
    }, WIDGET_IDS);

    expect(state.items).toBe(WIDGET_IDS.length);
    for (const widget of state.resolved) {
      expect(widget.found, `${widget.id} should resolve by id`).toBe(true);
      expect(widget.hasTile, `${widget.id} should sit inside a tile`).toBe(true);
      expect(widget.tileIsAdopted, `${widget.id}'s tile should be a live grid node`).toBe(true);
    }
  });

  test('gs-id is rewritten by GridStack from the node, not left as authored', async ({ page }) => {
    // Why the id lookup is primary and `gs-id` only a fallback: the attribute
    // on a live grid is whatever GridStack decided to write back from its
    // node. It agrees here only because the node carries a real id — when the
    // node had none, the attribute disappeared and every `[gs-id]` selector
    // silently matched nothing. This pins the coupling so a regression in the
    // node id shows up as a failure here too.
    const pairs = await page.evaluate(() =>
      [...document.querySelectorAll('.grid-stack-item')].map((el) => ({
        attribute: el.getAttribute('gs-id'),
        nodeId: el.gridstackNode ? String(el.gridstackNode.id) : null,
      }))
    );

    expect(pairs).toHaveLength(WIDGET_IDS.length);
    for (const pair of pairs) {
      expect(pair.nodeId, 'a node must carry a real id').not.toBe('undefined');
      expect(pair.attribute).toBe(pair.nodeId);
    }
  });

  test('a hash in the URL at load highlights the widget', async ({ page }) => {
    // Deep-linked on first load — the case `installDeepLinks` handles by
    // running its handler once at install time rather than only on
    // `hashchange`.
    await page.goto('/#calendar');
    await waitForDashboard(page);

    await expect(tileFor(page, 'calendar')).toHaveClass(/haven-widget--deep-linked/);
  });

  test('changing the hash scrolls to and highlights the right widget', async ({ page }) => {
    const target = 'clock-tokyo';
    await page.evaluate((id) => {
      window.location.hash = `#${id}`;
    }, target);

    await expect(tileFor(page, target)).toHaveClass(/haven-widget--deep-linked/);

    // The highlight must land on the widget that was asked for, and on no
    // other — "it highlighted something" is not the assertion worth making.
    const highlighted = await page.evaluate(() =>
      [...document.querySelectorAll('.haven-widget--deep-linked')].map(
        (el) => el.querySelector('.haven-widget')?.id ?? el.id
      )
    );
    expect(highlighted).toEqual([target]);
  });

  test('the highlight clears itself so it cannot stick', async ({ page }) => {
    await page.evaluate(() => {
      window.location.hash = '#torrents';
    });
    const tile = tileFor(page, 'torrents');
    await expect(tile).toHaveClass(/haven-widget--deep-linked/);
    // DEEP_LINK_HIGHLIGHT_MS is 2s; the assertion waits on the class going
    // away rather than sleeping past it.
    await expect(tile).not.toHaveClass(/haven-widget--deep-linked/, { timeout: 6_000 });
  });

  test('every widget in the roster is reachable by its own link', async ({ page }) => {
    for (const id of WIDGET_IDS) {
      await page.evaluate((widgetId) => {
        window.location.hash = '';
        window.location.hash = `#${widgetId}`;
      }, id);

      await expect(tileFor(page, id), `#${id} should resolve to its tile`).toHaveClass(
        /haven-widget--deep-linked/
      );
    }
  });

  test('an unknown widget id is ignored rather than throwing', async ({ page }) => {
    await page.evaluate(() => {
      window.location.hash = '#no-such-widget';
    });
    // Nothing should be highlighted, and — via the console fixture — nothing
    // should have thrown.
    await expect(page.locator('.haven-widget--deep-linked')).toHaveCount(0);
  });
});
