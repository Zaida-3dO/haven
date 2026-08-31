/**
 * Layout storage — one row per breakpoint.
 *
 * DESIGN §3 settles this: desktop and mobile are arranged separately and
 * neither is derived from the other. There is deliberately no "collapse the
 * desktop layout for mobile" path anywhere in this file, because auto-reflow
 * produces a phone view nobody chose.
 */

/** The breakpoints Haven persists. Anything else is rejected, not created. */
export const BREAKPOINTS = Object.freeze(['desktop', 'mobile']);

export class LayoutValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LayoutValidationError';
    this.code = 'INVALID_LAYOUT';
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Grid coordinates: non-negative integers. Sizes must additionally be >= 1. */
const isGridInt = (v, { min }) => Number.isInteger(v) && v >= min;

/**
 * Validates one GridStack node.
 *
 * Only the geometry fields Haven relies on are required; unknown keys are
 * dropped rather than stored, so a future GridStack version cannot smuggle
 * arbitrary content into the database through this endpoint.
 */
function validateNode(node, index, breakpoint) {
  const where = `${breakpoint}[${index}]`;

  if (!isPlainObject(node)) {
    throw new LayoutValidationError(`${where} must be an object.`);
  }

  if (typeof node.id !== 'string' || node.id.trim() === '') {
    throw new LayoutValidationError(`${where}.id must be a non-empty string.`);
  }

  for (const [field, min] of [
    ['x', 0],
    ['y', 0],
    ['w', 1],
    ['h', 1],
  ]) {
    if (!isGridInt(node[field], { min })) {
      throw new LayoutValidationError(
        `${where}.${field} must be an integer >= ${min} (got ${JSON.stringify(node[field])}).`
      );
    }
  }

  const clean = { id: node.id, x: node.x, y: node.y, w: node.w, h: node.h };

  // A node may point at a widget instance; the id is opaque here.
  if (node.widgetId !== undefined) {
    if (typeof node.widgetId !== 'string' || node.widgetId.trim() === '') {
      throw new LayoutValidationError(`${where}.widgetId must be a non-empty string when present.`);
    }
    clean.widgetId = node.widgetId;
  }

  return clean;
}

/** Validates one breakpoint's node array, returning the normalised copy. */
export function validateNodes(nodes, breakpoint) {
  if (!Array.isArray(nodes)) {
    throw new LayoutValidationError(`Layout for "${breakpoint}" must be an array of nodes.`);
  }

  const cleaned = nodes.map((node, i) => validateNode(node, i, breakpoint));

  const ids = new Set();
  for (const node of cleaned) {
    if (ids.has(node.id)) {
      throw new LayoutValidationError(`Duplicate node id "${node.id}" in "${breakpoint}".`);
    }
    ids.add(node.id);
  }

  return cleaned;
}

/**
 * Validates a whole `{ desktop: [...], mobile: [...] }` payload.
 *
 * Both breakpoints are optional — saving only the one you just edited is the
 * normal case, and requiring both would mean the mobile editor had to send a
 * desktop layout it never looked at.
 */
export function validateLayout(payload) {
  if (!isPlainObject(payload)) {
    throw new LayoutValidationError('Layout payload must be an object keyed by breakpoint.');
  }

  const keys = Object.keys(payload);

  if (keys.length === 0) {
    throw new LayoutValidationError(
      `Layout payload is empty — expected at least one of: ${BREAKPOINTS.join(', ')}.`
    );
  }

  const unknown = keys.filter((k) => !BREAKPOINTS.includes(k));
  if (unknown.length > 0) {
    throw new LayoutValidationError(
      `Unknown breakpoint(s): ${unknown.join(', ')}. Expected: ${BREAKPOINTS.join(', ')}.`
    );
  }

  const validated = {};
  for (const breakpoint of keys) {
    validated[breakpoint] = validateNodes(payload[breakpoint], breakpoint);
  }

  return validated;
}

export function createLayoutStore(db) {
  const upsert = db.prepare(`
    INSERT INTO layout (breakpoint, nodes)
    VALUES (@breakpoint, @nodes)
    ON CONFLICT (breakpoint) DO UPDATE SET
      nodes      = excluded.nodes,
      updated_at = datetime('now')
  `);

  const selectAll = db.prepare('SELECT breakpoint, nodes, updated_at FROM layout');
  const selectOne = db.prepare(
    'SELECT breakpoint, nodes, updated_at FROM layout WHERE breakpoint = ?'
  );

  return {
    /**
     * Every breakpoint, with an empty array for any never saved — so a fresh
     * install returns a usable shape rather than `{}` the client must special-case.
     */
    getAll() {
      const rows = new Map(selectAll.all().map((r) => [r.breakpoint, r]));

      const layout = {};
      const updatedAt = {};
      for (const breakpoint of BREAKPOINTS) {
        const row = rows.get(breakpoint);
        layout[breakpoint] = row ? JSON.parse(row.nodes) : [];
        updatedAt[breakpoint] = row ? row.updated_at : null;
      }

      return { layout, updatedAt };
    },

    get(breakpoint) {
      const row = selectOne.get(breakpoint);
      return row ? JSON.parse(row.nodes) : [];
    },

    /**
     * Writes the validated breakpoints in one transaction, so a two-breakpoint
     * save cannot land half-applied.
     *
     * @param {object} validated output of {@link validateLayout}
     */
    save(validated) {
      const write = db.transaction((entries) => {
        for (const [breakpoint, nodes] of entries) {
          upsert.run({ breakpoint, nodes: JSON.stringify(nodes) });
        }
      });

      write(Object.entries(validated));
      return this.getAll();
    },
  };
}
