/**
 * The `home3d.visibility` handshake — the host half of it.
 *
 * A WebGL scene inside an iframe cannot see whether it is on screen: an
 * iframe is never the IntersectionObserver target of its own parent. So the
 * embedded 3D home asks to be *told*. Its contract
 * (3dhome's docs/url-parameters.md, "Embedding the preview tile") is a
 * versioned, origin-checked postMessage protocol:
 *
 *   frame → host  { proto, v, type: 'hello-from-frame' }   "I am here"
 *   host  → frame { proto, v, type: 'hello' }              "I am your host"
 *   frame → host  { proto, v, type: 'ready' }              "start sending"
 *   host  → frame { proto, v, type: 'visibility', visible }
 *
 * Without it the scene renders at full rate forever, including while its tile
 * sits behind another page, inside a closed drawer, or on a dashboard left
 * open all day — which for the 3D home is real GPU and main-thread time
 * spent on nobody looking (measured: ~1 s of render work per frame cycle on
 * a software-GL test run). With it, an off-screen tile is genuinely idle.
 *
 * Same rules this module's sibling `geometry.js` holds: never post to `'*'`,
 * and verify `event.origin` (and `event.source`) against the frame's
 * *configured* origin before acting on a message. The frame's own half
 * trust-on-first-pins this host's origin, so an unrelated script cannot
 * impersonate the dashboard.
 */

export const VISIBILITY_PROTOCOL = 'home3d.visibility';
export const VISIBILITY_VERSION = 1;

/**
 * Attach the host side of the protocol to a frame element.
 *
 * @param frame           the iframe element (must already carry its `src`)
 * @param origin          the frame's expected origin (from its configured src)
 * @param initialVisible  what to report once the frame says `ready`
 * @returns {{ report(visible: boolean): void, detach(): void }}
 */
export function attachVisibilityHost(frame, origin, { initialVisible = true } = {}) {
  let ready = false;
  let visible = initialVisible;
  let detached = false;

  const send = (message) => {
    const target = frame?.contentWindow;
    if (!target?.postMessage || !origin) return;
    target.postMessage({ ...message, proto: VISIBILITY_PROTOCOL, v: VISIBILITY_VERSION }, origin);
  };

  const onMessage = (event) => {
    // Both halves of the origin check, exactly as the contract's host-side
    // sample does them: the sender's origin, and that the message came from
    // the frame we configured rather than from some window that borrowed it.
    if (!origin || event.origin !== origin) return;
    if (event.source !== frame?.contentWindow) return;
    const data = event.data;
    if (!data || data.proto !== VISIBILITY_PROTOCOL || data.v !== VISIBILITY_VERSION) return;

    if (data.type === 'hello-from-frame') {
      send({ type: 'hello' });
    } else if (data.type === 'ready') {
      ready = true;
      send({ type: 'visibility', visible });
    }
    // A frame that never sends `hello-from-frame` (every other embed) simply
    // never gets a message back: the widget stays silent toward documents
    // that did not ask.
  };

  const add = globalThis.window?.addEventListener;
  if (add) globalThis.window.addEventListener('message', onMessage);

  return {
    /** Push a visibility change; queued until the frame says `ready`. */
    report(next) {
      visible = !!next;
      if (ready) send({ type: 'visibility', visible });
    },
    detach() {
      if (detached) return;
      detached = true;
      ready = false;
      const remove = globalThis.window?.removeEventListener;
      if (remove) globalThis.window.removeEventListener('message', onMessage);
    },
  };
}
