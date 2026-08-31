import { mountShell } from './shell/shell.js';
import { registerAppsWidget } from './widgets/apps/apps-widget.js';

// Widgets register before the shell mounts. Order is not actually load-bearing
// — the host waits out a grace period on `customElements.whenDefined` so a
// late-registering widget never flashes an error card — but registering first
// is the simple case and keeps the boot path obvious.
registerAppsWidget();

mountShell(document.querySelector('#haven-shell'), {
  // One apps widget on the grid. Persisted layouts land in a later milestone;
  // until then this is the default view, and it is the widget that replaces
  // the old dashboard's whole front page.
  layout: [{ id: 'apps-main', type: 'apps', config: { configVersion: 1 } }],
});
