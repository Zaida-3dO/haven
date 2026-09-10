/**
 * A `fetch`-shaped adapter over Fastify's `app.inject`.
 *
 * The seeding CLI talks to Haven over HTTP and nothing else — that is what
 * makes it trustworthy, because every write goes through the real route
 * handlers and the real validators rather than a second, weaker copy of them
 * in the tool. Testing it therefore has to exercise those handlers.
 *
 * Binding a port to do that would make the suite flaky and slow for no gain,
 * so this adapter gives the client a `fetch` that dispatches straight into the
 * server in-process. The CLI cannot tell the difference, which is the point:
 * the tests below are testing the same code path production uses, not a mock
 * of it.
 *
 * Multipart bodies (icon upload) are handled by letting `Request` serialise
 * the `FormData` — writing a multipart encoder by hand here would be a second
 * implementation of something the platform already does correctly, and it
 * would be the encoder under test rather than the upload.
 */

export function injectFetch(app) {
  return async function fetchImpl(url, init = {}) {
    const path = new URL(url, 'http://haven.invalid').pathname;

    let payload = init.body;
    let headers = { ...(init.headers ?? {}) };

    if (payload instanceof FormData) {
      // Let the platform encode it, then hand Fastify the bytes plus the
      // boundary header it needs to parse them.
      const encoded = new Request('http://haven.invalid', { method: 'POST', body: payload });
      payload = Buffer.from(await encoded.arrayBuffer());
      headers = { ...headers, 'content-type': encoded.headers.get('content-type') };
    }

    const response = await app.inject({
      method: init.method ?? 'GET',
      url: path,
      payload,
      headers,
    });

    return {
      status: response.statusCode,
      ok: response.statusCode >= 200 && response.statusCode < 300,
      async text() {
        return response.body;
      },
      async json() {
        return JSON.parse(response.body);
      },
    };
  };
}
