import { mountShell } from './shell/shell.js';
import { registry } from './shell/registry.js';
import { defineTorrentsWidget } from './widgets/torrents/index.js';

// Widgets register before the shell mounts. Late registration is handled by
// the host regardless, so this is ordering for clarity rather than necessity.
defineTorrentsWidget(registry);

mountShell(document.querySelector('#haven-shell'));
