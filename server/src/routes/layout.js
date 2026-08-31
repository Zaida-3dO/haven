import { createLayoutStore, LayoutValidationError, validateLayout } from '../db/layout.js';

/**
 * GET  /api/layout — every breakpoint's layout.
 * PUT  /api/layout — save one or both breakpoints.
 *
 * Layouts are stored per breakpoint and never derived from one another
 * (DESIGN §3). A PUT containing only `mobile` leaves `desktop` untouched,
 * which is what editing one breakpoint at a time actually needs.
 */
export async function registerLayoutRoutes(app) {
  const store = createLayoutStore(app.db);

  app.get('/api/layout', async () => {
    const { layout, updatedAt } = store.getAll();
    return { layout, updatedAt };
  });

  app.put('/api/layout', async (request, reply) => {
    let validated;

    try {
      // Validate before touching the database: a malformed layout is
      // rejected, never stored and cleaned up later.
      validated = validateLayout(request.body);
    } catch (err) {
      if (err instanceof LayoutValidationError) {
        return reply.code(400).send({ error: 'INVALID_LAYOUT', message: err.message });
      }
      throw err;
    }

    const { layout, updatedAt } = store.save(validated);
    return reply.code(200).send({ layout, updatedAt, saved: Object.keys(validated) });
  });
}
