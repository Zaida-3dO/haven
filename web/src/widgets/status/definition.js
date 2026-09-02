/**
 * The overall-status widget's registry entry.
 *
 * Separate from `element.js` on the same principle as every other widget here:
 * this module touches no DOM and extends no `HTMLElement`, so the contract
 * details worth testing are all assertable under `node --test`.
 *
 * ## What this counts, and why it is not the same probe as the cards
 *
 * The dashboard Haven replaces pins a "Server Status — N Online / N Offline"
 * card to the bottom of its sidebar, and that is the shape reproduced here.
 *
 * The count is derived from the SAME browser-side reachability probing that
 * drives the app cards' dots (`web/src/lib/status.js`), not from a second
 * server-side sweep. That matters for the reason the dots exist at all: on a
 * split LAN/VPN network a server-side count would confidently report "23
 * online" for services this browser cannot open. A count that disagrees with
 * the dots directly above it is worse than no count, because both look
 * authoritative.
 */

export const STATUS_WIDGET_TYPE = 'status';
export const STATUS_WIDGET_TAG = 'haven-widget-status';

/**
 * The apps registry, which is where the list of things to probe comes from.
 *
 * Deliberately the SAME url and fetch key the apps widget uses without
 * versions, so having both on the board costs one request rather than two —
 * the fetcher collapses them. Versions are not asked for: this widget counts
 * reachability and has no use for a version map.
 */
export const STATUS_ENDPOINT = '/api/apps/dashboard?versions=false';
export const STATUS_FETCH_KEY = 'apps:all:noversions';

/** Matches the apps widget: the host refetches the registry every 5 minutes. */
export const STATUS_REFRESH_MS = 5 * 60 * 1000;

export const statusWidget = {
  type: STATUS_WIDGET_TYPE,
  name: 'Server Status',
  tag: STATUS_WIDGET_TAG,
  defaultSize: { w: 3, h: 2 },
  minSize: { w: 2, h: 1 },
  mobileSize: { w: 4, h: 2 },
  refreshMs: STATUS_REFRESH_MS,
  // Nothing here is worth finding by name — the apps widget already indexes
  // every app, and indexing "23 Online" would only add noise to the palette.
  searchable: false,
  configVersion: 1,
  configSchema: [
    {
      key: 'statusTtlMs',
      type: 'number',
      label: 'Re-probe reachability after (ms)',
      default: 60_000,
      min: 5_000,
      max: 3_600_000,
      help: 'How long a reachability result is trusted before the next refresh re-probes.',
    },
  ],
  dataSource: () => ({ key: STATUS_FETCH_KEY, url: STATUS_ENDPOINT }),
  getStubConfig: () => ({ statusTtlMs: 60_000 }),
};

export default { statusWidget, STATUS_WIDGET_TYPE, STATUS_WIDGET_TAG };
