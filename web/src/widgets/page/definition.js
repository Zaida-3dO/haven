/**
 * The custom-page widget's registry entry.
 *
 * A page registered in `pages/registry.js` can be placed on the grid as a
 * widget as well as living at its own route (DESIGN §6.9: "author a page once,
 * then place it as a widget, give it its own subpage, or both"). This
 * definition is the widget half.
 *
 * Two modes, because the two useful placements have opposite requirements:
 *
 *  - **`summary`** (the default) — a tile showing the page title and summary
 *    that links through to the subpage. This is what Library Analytics wants:
 *    it is a full page with its own header and nav, and squeezing it into four
 *    grid cells would be worse than a link to it.
 *  - **`full`** — the page's own render, inline in the tile, for a page small
 *    enough to live on the grid.
 */

export const PAGE_WIDGET_TYPE = 'page';
export const PAGE_WIDGET_TAG = 'haven-widget-page';

export const MODES = Object.freeze({ SUMMARY: 'summary', FULL: 'full' });

export const pageWidget = {
  type: PAGE_WIDGET_TYPE,
  name: 'Page',
  tag: PAGE_WIDGET_TAG,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 1 },
  mobileSize: { w: 4, h: 2 },
  /**
   * No `dataSource`, `refreshMs: null`. A custom page renders authored content
   * and whatever its own render function pulls in; there is no dashboard-level
   * endpoint behind it.
   *
   * This is exactly the case DESIGN §5 and the search work flagged: a widget
   * with no `dataSource` never reaches `Dashboard#push`, so it would never be
   * indexed on a data change. `Dashboard#add` indexes such widgets on add
   * instead, which is what makes a page's title findable.
   */
  refreshMs: null,
  searchable: true,
  configVersion: 1,
  configSchema: [
    {
      key: 'pageId',
      type: 'text',
      label: 'Page',
      required: true,
      default: 'library-analytics',
    },
    {
      key: 'mode',
      type: 'select',
      label: 'Show',
      default: MODES.SUMMARY,
      options: [
        { value: MODES.SUMMARY, label: 'A summary tile linking to the page' },
        { value: MODES.FULL, label: 'The whole page, inline' },
      ],
    },
  ],
  getStubConfig: () => ({ pageId: 'library-analytics', mode: MODES.SUMMARY }),
};
