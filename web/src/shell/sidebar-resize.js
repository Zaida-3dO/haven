/**
 * The sidebar's resize gestures: dragging the column wider, and dragging a
 * card taller or shorter.
 *
 * ── Why this is hand-rolled ──────────────────────────────────────────────
 * Nothing else in this shell hand-rolls a drag. GridStack owned every one, and
 * the sidebar is deliberately not GridStack (DESIGN §3.1) — so this is the
 * first, and it is written to be operable WITHOUT a pointer. A resize
 * affordance that exists only for a mouse is one a keyboard user cannot reach
 * at all, which is why both handles are real buttons with arrow-key handling
 * rather than bare divs with a `mousedown`.
 *
 * Pointer events rather than mouse events, so touch and pen work through one
 * code path. `setPointerCapture` keeps the gesture attached to the handle once
 * the pointer leaves it — the normal case at the extremes of a drag. Without
 * it the resize stops dead the moment the cursor crosses into the grid.
 *
 * ── Why drag-END notifies the widget hosts ───────────────────────────────
 * `iframe/element.js` implements `onResize(w, h)` and forwards the new
 * geometry into the frame, so an embedded scene can call `renderer.setSize()`
 * and `camera.updateProjectionMatrix()`. `grid.js` fires that from GridStack's
 * `resizestop`. The sidebar has no GridStack, so nothing would fire it here:
 * a resized 3D embed would keep its load-time drawing buffer and render
 * stretched, with no error anywhere. Hence `notify()`.
 *
 * Fired once at the END of a gesture, never per tick — the same reason
 * `grid.js` uses `resizestop` rather than `resize`: a WebGL scene must not be
 * thrashed for the whole duration of a drag.
 *
 * Kept out of `boot.js` because that file imports GridStack and therefore
 * cannot be loaded under `node --test`.
 */

/**
 * Installs the gestures. Returns a teardown that removes every listener.
 *
 * @param {object} deps
 * @param {object} deps.sidebar       handle from `createSidebar`
 * @param {object} deps.sidebarSizing controller from `createSidebarSizing`
 * @param {object} [deps.dashboard]   used to notify hosts that they resized
 * @param {HTMLElement} [deps.layoutEl] carries the `--resizing` class
 * @returns {() => void}
 */
export function installSidebarResize({ sidebar, sidebarSizing, dashboard, layoutEl } = {}) {
  if (!sidebar || !sidebarSizing) return () => {};

  /**
   * Tells one card's widget that its box changed.
   *
   * Measured off the BODY rather than the card, because the body is the box
   * the widget actually renders into — the card additionally carries the
   * heading, so passing the card's height would tell an embed it has more
   * room than it does.
   */
  const notify = (id) => {
    const body = sidebar.bodies.get(id);
    const host = dashboard?.host?.(id);
    if (!host || !body) return;
    const rect = body.getBoundingClientRect?.();
    host.onResize?.(Math.round(rect?.width ?? 0), Math.round(rect?.height ?? 0));
  };

  /** Notifies every card — used after a WIDTH change, which resizes them all. */
  const notifyAll = () => {
    for (const id of sidebar.cards.keys()) notify(id);
  };

  /**
   * Wires one handle as a drag along a single axis.
   *
   * `toValue` maps the pointer's travel onto the new size, which keeps each
   * axis's sign convention at the call site rather than in here. That matters
   * for the width: the sidebar is on the RIGHT, so dragging LEFT makes it
   * WIDER, and burying that inversion in shared code is how it gets reversed
   * by a later well-meaning edit.
   */
  const drag = (handle, { start, toValue, apply, end }) => {
    if (!handle?.addEventListener) return () => {};

    let origin = null;

    const onMove = (event) => {
      if (!origin) return;
      apply(toValue(origin, event));
    };

    const finish = (event) => {
      if (!origin) return;
      try {
        handle.releasePointerCapture?.(event.pointerId);
      } catch {
        // Releasing a capture that was never taken is not worth failing over.
      }
      origin = null;
      layoutEl?.classList?.remove('haven-layout--resizing');
      end?.();
    };

    const onDown = (event) => {
      // Primary button only — a right-click must not begin a resize.
      if (event.button !== undefined && event.button !== 0) return;
      origin = start(event);
      handle.setPointerCapture?.(event.pointerId);
      // Stops the gesture also selecting text or starting a native drag.
      event.preventDefault?.();
      layoutEl?.classList?.add('haven-layout--resizing');
    };

    handle.addEventListener('pointerdown', onDown);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', finish);
    handle.addEventListener('pointercancel', finish);

    return () => {
      handle.removeEventListener('pointerdown', onDown);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', finish);
      handle.removeEventListener('pointercancel', finish);
    };
  };

  /**
   * Arrow keys drive the same setter the drag does.
   *
   * Shift multiplies the step, matching the coarse/fine convention most
   * editors use. The step is in pixels because the sizes are: there is no cell
   * grid in this zone to count in (DESIGN §3.1).
   */
  const keys = (handle, { get, set, decrease, increase, after, step = 16 }) => {
    if (!handle?.addEventListener) return () => {};

    const onKey = (event) => {
      let next = null;
      const magnitude = step * (event.shiftKey ? 4 : 1);

      if (event.key === decrease) next = get() - magnitude;
      else if (event.key === increase) next = get() + magnitude;
      if (next === null) return;

      event.preventDefault?.();
      set(next);
      after?.();
    };

    handle.addEventListener('keydown', onKey);
    return () => handle.removeEventListener('keydown', onKey);
  };

  const teardowns = [];

  // ── The column's width ──────────────────────────────────────────────────
  // The sidebar sits on the RIGHT of the layout, so LEFTWARD travel (a
  // negative dx) makes it wider. Getting this backwards makes the handle feel
  // like it is fighting the user, which is why it is stated explicitly.
  teardowns.push(
    drag(sidebar.widthHandle, {
      start: (event) => ({ x: event.clientX, width: sidebarSizing.width }),
      toValue: (origin, event) => origin.width - (event.clientX - origin.x),
      apply: (width) => sidebarSizing.setWidth(width),
      end: notifyAll,
    })
  );

  teardowns.push(
    keys(sidebar.widthHandle, {
      get: () => sidebarSizing.width,
      set: (width) => sidebarSizing.setWidth(width),
      // Left widens, matching the drag direction above.
      increase: 'ArrowLeft',
      decrease: 'ArrowRight',
      after: notifyAll,
    })
  );

  // ── Each card's height ──────────────────────────────────────────────────
  for (const [id, card] of sidebar.cards) {
    // The pinned card has no grip: it is the sidebar's own child, so a fixed
    // height on it takes space FROM the scrollport rather than being absorbed
    // by it. See the note at the top of `sidebar-size.js`.
    if (!card.grip) continue;

    /**
     * The height to start a gesture from.
     *
     * A card with no drafted height yet is content-sized, so its current
     * RENDERED height is the only sensible starting point — beginning from a
     * constant would make the first drag jump.
     */
    const current = () =>
      sidebarSizing.heightFor(id) ?? Math.round(card.body?.getBoundingClientRect?.().height ?? 0);

    teardowns.push(
      drag(card.grip, {
        start: (event) => ({ y: event.clientY, height: current() }),
        toValue: (origin, event) => origin.height + (event.clientY - origin.y),
        apply: (height) => sidebarSizing.setHeight(id, height),
        end: () => notify(id),
      })
    );

    teardowns.push(
      keys(card.grip, {
        get: current,
        set: (height) => sidebarSizing.setHeight(id, height),
        decrease: 'ArrowUp',
        increase: 'ArrowDown',
        after: () => notify(id),
      })
    );
  }

  return () => {
    for (const teardown of teardowns) teardown();
  };
}

export default { installSidebarResize };
