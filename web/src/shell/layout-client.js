/**
 * Client for the layout API (`server/src/routes/layout.js`).
 *
 * Two things about that endpoint shape the code here:
 *
 *  - `GET /api/layout` always returns every breakpoint, using `[]` for one
 *    never saved. So there is no "missing breakpoint" case to special-case.
 *  - `PUT /api/layout` accepts a partial payload and leaves any breakpoint it
 *    was not given untouched, replying with `saved: [...]`. That is what lets
 *    the editor save only the breakpoint actually edited, which matters
 *    because deriving one breakpoint from the other is rejected outright by
 *    DESIGN §3.
 */

/** The breakpoints Haven persists, mirroring `BREAKPOINTS` on the server. */
export const BREAKPOINTS = Object.freeze(['desktop', 'mobile']);

/** Geometry fields the server stores. Anything else it drops, so don't send it. */
function toStoredNode(node) {
  const clean = {
    id: node.id,
    x: node.x ?? 0,
    y: node.y ?? 0,
    w: node.w ?? 1,
    h: node.h ?? 1,
  };
  if (node.widgetId !== undefined) clean.widgetId = node.widgetId;
  return clean;
}

/**
 * Normalises a breakpoint's nodes into exactly what the server validator
 * accepts. Sending a raw GridStack node fails validation on `undefined` x/y,
 * which GridStack legitimately produces for an auto-positioned widget.
 */
export function normaliseNodes(nodes) {
  if (!Array.isArray(nodes)) return [];
  return nodes.map(toStoredNode);
}

export function createLayoutClient({ fetchImpl = globalThis.fetch, baseUrl = '/api' } = {}) {
  const request = async (path, init) => {
    const res = await fetchImpl(`${baseUrl}${path}`, init);
    if (!res.ok) {
      let detail = '';
      try {
        const body = await res.json();
        detail = body?.message || body?.error || '';
      } catch {
        // A non-JSON error body is not worth failing twice over.
      }
      throw new Error(`Layout request failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    return res.json();
  };

  return {
    /** @returns {Promise<{layout: object, updatedAt: object}>} */
    async load() {
      const body = await request('/layout', { headers: { Accept: 'application/json' } });
      const layout = {};
      for (const breakpoint of BREAKPOINTS) {
        layout[breakpoint] = Array.isArray(body?.layout?.[breakpoint])
          ? body.layout[breakpoint]
          : [];
      }
      return { layout, updatedAt: body?.updatedAt ?? {} };
    },

    /**
     * Saves one or more breakpoints.
     *
     * Deliberately refuses an empty payload rather than sending one: the
     * server answers 400 for it, and a silent no-op would be worse than a
     * throw at the call site that built nothing.
     */
    async save(partial) {
      const payload = {};
      for (const breakpoint of BREAKPOINTS) {
        if (partial?.[breakpoint] !== undefined) {
          payload[breakpoint] = normaliseNodes(partial[breakpoint]);
        }
      }
      if (Object.keys(payload).length === 0) {
        throw new Error('save: nothing to save — expected at least one breakpoint.');
      }

      return request('/layout', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });
    },
  };
}
