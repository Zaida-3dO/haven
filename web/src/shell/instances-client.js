/**
 * Client for the widget instance API (`server/src/routes/instances.js`).
 *
 * The roster half of the dashboard's persisted state: which widgets exist,
 * what type each is, and its config. Geometry is `layout-client.js`; the two
 * are joined by instance id in `boot.js`.
 *
 * ── The sentinel ─────────────────────────────────────────────────────────
 * A `secret`-typed config field never comes back from the server. What comes
 * back in its place is `SECRET_SET`, a non-empty marker meaning "a value is
 * stored". That is deliberately the shape the settings panel already expects:
 * its `secretIsSet` is a presence test on the config it holds, so a sentinel
 * makes the help text say "A value is saved" without a credential ever
 * reaching the DOM.
 *
 * It also round-trips harmlessly. The panel omits an untouched secret from its
 * patch, so the sentinel survives in `{...current, ...patch}` and is sent back
 * unchanged — and the server reads an unchanged sentinel as "do not touch the
 * stored credential" rather than as a new value to encrypt.
 * ─────────────────────────────────────────────────────────────────────────
 */

/** Mirrors `SECRET_SET` in `server/src/db/instances-store.js`. */
export const SECRET_SET = '__haven_secret_set__';

/** The config keys a widget definition declares as `secret`. */
export function secretKeysOf(definition) {
  return (definition?.configSchema ?? [])
    .filter((field) => field?.type === 'secret')
    .map((field) => field.key);
}

/** Drops anything the server does not store, and normalises the shape. */
function toStoredInstance(instance) {
  return {
    id: instance.id,
    type: instance.type,
    config: instance.config ?? {},
    configVersion: instance.configVersion ?? instance.config?.configVersion ?? 1,
  };
}

export function createInstancesClient({ fetchImpl = globalThis.fetch, baseUrl = '/api' } = {}) {
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
      throw new Error(`Instances request failed (${res.status})${detail ? `: ${detail}` : ''}`);
    }
    // 204 has no body to parse.
    return res.status === 204 ? null : res.json();
  };

  const json = (method, body) => ({
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    /** @returns {Promise<Array<{id, type, config, configVersion}>>} */
    async load() {
      const body = await request('/instances', { headers: { Accept: 'application/json' } });
      return Array.isArray(body?.instances) ? body.instances : [];
    },

    /**
     * Creates an instance.
     *
     * `secretKeys` tells the server which config fields are credentials. The
     * server cannot work this out for itself — `configSchema` lives with the
     * widget definition in the browser, and duplicating it server-side would
     * create the second source of truth `schema.js` exists to prevent.
     */
    async create(instance, { secretKeys = [] } = {}) {
      return request('/instances', json('POST', { ...toStoredInstance(instance), secretKeys }));
    },

    async save(id, instance, { secretKeys = [] } = {}) {
      return request(
        `/instances/${encodeURIComponent(id)}`,
        json('PUT', { ...toStoredInstance(instance), secretKeys })
      );
    },

    async remove(id) {
      await request(`/instances/${encodeURIComponent(id)}`, { method: 'DELETE' });
      return true;
    },
  };
}
