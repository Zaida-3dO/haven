/**
 * The iframe / embed widget — registration entry.
 *
 * Importing this module and calling `defineIframeWidget` defines the element
 * and registers the widget. Anything that only needs the definition or the URL
 * policy should import `./definition.js` or `./embed-url.js`, which touch no
 * DOM and load cleanly under `node --test`.
 */

import { HavenIframe } from './element.js';
import { IFRAME_WIDGET_TAG, iframeWidget } from './definition.js';

export { HavenIframe } from './element.js';
export {
  ALLOWED_PROTOCOLS,
  DEFAULT_SANDBOX,
  EmbedUrlError,
  OPTIONAL_SANDBOX_TOKENS,
  defeatsSandbox,
  isSafeEmbedUrl,
  parseEmbedUrl,
  sandboxTokens,
} from './embed-url.js';
export { RESIZE_MESSAGE_TYPE, frameOrigin, postGeometry, resizeMessage } from './geometry.js';
export { HOME_3D_URL, IFRAME_WIDGET_TAG, IFRAME_WIDGET_TYPE, iframeWidget } from './definition.js';

export function defineIframeWidget({
  registry,
  customElements: ce = globalThis.customElements,
} = {}) {
  if (ce && !ce.get(IFRAME_WIDGET_TAG)) {
    ce.define(IFRAME_WIDGET_TAG, HavenIframe);
  }
  if (registry && !registry.has(iframeWidget.type)) {
    registry.register(iframeWidget);
  }
  return iframeWidget;
}
