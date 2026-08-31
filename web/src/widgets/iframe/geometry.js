/**
 * Forwarding grid geometry into an embedded frame.
 *
 * ## The failure this exists to prevent
 *
 * An embedded WebGL scene sizes its drawing buffer once, at load, from its own
 * `window.innerWidth`. Resize the *widget* and the frame element changes size,
 * but nothing tells the scene: the canvas keeps its old buffer and the browser
 * stretches it. You get a blurry, wrongly-proportioned 3D house. The frame is
 * a separate document, so the parent cannot call `renderer.setSize()` itself —
 * the only channel is `postMessage`.
 *
 * DESIGN §3 and the widget contract both call this out under "Resize + WebGL:
 * hook `resizestop` to `renderer.setSize()` and
 * `camera.updateProjectionMatrix()`". This module is the parent half of that.
 *
 * ## Why `resizestop` and not every resize tick
 *
 * `grid.js` fires its resize listeners on `resizestop` only, and says why:
 * firing on every tick would thrash a 3D scene for the whole drag. So a
 * message goes out once, with the final geometry. Nothing here needs to
 * debounce, because the grid already did.
 */

/**
 * The message type embedded pages listen for.
 *
 * Namespaced because a frame's `message` handler sees every message posted to
 * it, from any embedder and any script on the page. An embed that keys off a
 * bare `{ width, height }` would react to anything.
 */
export const RESIZE_MESSAGE_TYPE = 'haven:resize';

/**
 * Build the resize message.
 *
 * Pixels, not grid cells: `renderer.setSize()` wants pixels, and grid cells
 * are meaningless inside the frame. `cells` rides along because a page may
 * reasonably want to switch layout at a size the pixel count alone does not
 * imply.
 */
export function resizeMessage({ width, height, cells } = {}) {
  return {
    type: RESIZE_MESSAGE_TYPE,
    width: Math.max(0, Math.round(width ?? 0)),
    height: Math.max(0, Math.round(height ?? 0)),
    cells: { w: cells?.w ?? 0, h: cells?.h ?? 0 },
  };
}

/**
 * Post geometry into a frame.
 *
 * ## targetOrigin
 *
 * A cross-origin embed gets its own origin as `targetOrigin`, never `'*'`.
 * `'*'` means "deliver this to whatever document happens to be in the frame
 * now" — if the frame navigated, the message goes to the new page. Geometry is
 * not a secret, but the habit of posting to `'*'` is what leaks the ones that
 * are, and there is no reason to form it here.
 *
 * A relative URL is same-origin by definition, so it gets the embedder's own
 * origin. When that cannot be determined (no `location`, as in a test), the
 * message is skipped rather than broadcast.
 *
 * A frame that has not loaded yet has no `contentWindow`; that is not an
 * error, it is the lazy-load path, and the next resize after load will carry
 * the geometry.
 *
 * @returns {boolean} whether a message was actually posted
 */
export function postGeometry(frame, geometry, { origin = null } = {}) {
  const target = frame?.contentWindow;
  if (!target?.postMessage) return false;

  const targetOrigin = origin ?? frameOrigin(frame);
  if (!targetOrigin) return false;

  target.postMessage(resizeMessage(geometry), targetOrigin);
  return true;
}

/**
 * The origin to address a frame's document by.
 *
 * Derived from the frame's *configured* `src`, not from `contentWindow.origin`
 * — a sandboxed frame has an opaque origin and reading through to it would
 * throw, and a frame that navigated itself should not get to redirect our
 * messages by changing where they are addressed.
 */
export function frameOrigin(frame, { pageOrigin = globalThis.location?.origin } = {}) {
  const src = frame?.getAttribute?.('src') ?? frame?.src ?? '';
  if (!src) return null;

  if (/^https?:\/\//i.test(src) || src.startsWith('//')) {
    try {
      return new URL(src, pageOrigin ?? undefined).origin;
    } catch {
      return null;
    }
  }

  // Relative: same origin as the dashboard.
  return pageOrigin ?? null;
}
