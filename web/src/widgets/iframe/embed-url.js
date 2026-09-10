/**
 * URL safety and sandbox policy for the iframe widget.
 *
 * Everything here is pure, and it is separate from the element for the reason
 * `weather/definition.js` is separate from its element: this is the part worth
 * testing hardest, and a module that extends `HTMLElement` cannot be loaded
 * under `node --test`.
 *
 * ## The threat, stated plainly
 *
 * An embed URL is **user-supplied config**. It arrives from a settings form,
 * is stored, and is later written to an element attribute. That is the classic
 * shape of a stored-XSS sink: `javascript:` in an `iframe[src]` executes in
 * the *dashboard's* origin, not in a sandbox, so it reads every credential the
 * page can reach. `data:text/html` is the same hole wearing a different hat —
 * historically it inherited the embedder's origin, and it is still a way to
 * smuggle a document past a reviewer who only skims for `javascript:`.
 *
 * So the scheme allowlist is `http:`, `https:`, and same-origin relative paths.
 * Nothing else. It is an allowlist rather than a blocklist deliberately: a
 * blocklist of `javascript:` and `data:` misses `vbscript:`, `blob:`, and the
 * next scheme someone invents.
 */

/** Schemes an embed may use. Everything else is refused. */
export const ALLOWED_PROTOCOLS = Object.freeze(['http:', 'https:']);

/**
 * The default sandbox. **`allow-same-origin` is deliberately NOT here.**
 *
 * This is the decision in this file most worth arguing with, so here is the
 * reasoning in full.
 *
 * `sandbox="allow-scripts allow-same-origin"` on a frame loading a page from
 * the embedder's own origin is *equivalent to no sandbox at all*: the framed
 * document keeps its real origin, so its scripts can reach through
 * `parent.document`, read the dashboard's DOM, its storage, and its session.
 * The spec says so, and every security guide repeats it. Making that pairing
 * the default would mean every embed added by a user silently ran with the
 * dashboard's authority.
 *
 * The cost of leaving it out is real and worth naming: a sandboxed frame gets
 * an **opaque origin**, so the embedded page cannot use `localStorage`,
 * `IndexedDB`, cookies, or same-origin `fetch`. Plenty of pages need those.
 *
 * So it is offered as an explicit, per-embed opt-in (`allowSameOrigin`) whose
 * schema label says what it costs, rather than being on by default. The 3D
 * home preview — the first consumer — needs `allow-scripts` for WebGL and does
 * not need same-origin, so the default is exactly right for it.
 *
 * That consumer is now loaded **cross-origin** from a public host, which makes
 * the default more important rather than less. Cross-origin plus
 * `allow-same-origin` does not hand the frame the dashboard's origin, so it is
 * not the "no sandbox at all" case described above — but it would restore the
 * third-party page's own storage and credentialled fetches, and there is no
 * reason to grant a page that to embed a self-contained WebGL scene.
 *
 * `allow-scripts` IS on by default: an embed of a static document with no
 * scripts is not a use case anyone has, and a frame that renders blank by
 * default would just be reported as broken.
 */
export const DEFAULT_SANDBOX = Object.freeze(['allow-scripts']);

/**
 * Tokens a config may add, and what each is for.
 *
 * A closed list, not free text. Free text would let a config write
 * `allow-same-origin` into the token string and bypass the deliberate opt-in
 * above, which is the whole point of having it be an opt-in.
 */
export const OPTIONAL_SANDBOX_TOKENS = Object.freeze({
  allowForms: 'allow-forms',
  allowPopups: 'allow-popups',
  allowSameOrigin: 'allow-same-origin',
});

/** Thrown by `parseEmbedUrl`. A named type so callers can tell it apart. */
export class EmbedUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EmbedUrlError';
  }
}

/**
 * Validate an embed URL and return the string to put in `src`.
 *
 * Relative paths are allowed and returned unchanged, so any page Haven serves
 * itself can be embedded by path. (The first consumer, the 3D home, used to be
 * one of these; it is now an absolute public URL, but both forms are supported
 * and both are returned exactly as configured.)
 *
 * `base` exists so this is testable without a `window.location`; it is only
 * used to *resolve* a relative path for checking, never to rewrite the result.
 *
 * @param {string} raw the configured URL
 * @param {{ base?: string }} [options]
 * @returns {string} the URL to use as `src`
 * @throws {EmbedUrlError} on anything not http/https/relative
 */
export function parseEmbedUrl(raw, { base = 'https://haven.invalid/' } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new EmbedUrlError('An embed needs a URL.');
  }

  const value = raw.trim();

  // A protocol-relative URL (`//evil.invalid/x`) resolves to the page's own
  // scheme and is a perfectly ordinary cross-origin load, so it is fine — it
  // is caught by the protocol check below via `new URL`, not special-cased.
  let resolved;
  try {
    resolved = new URL(value, base);
  } catch {
    throw new EmbedUrlError(`"${value}" is not a URL.`);
  }

  if (!ALLOWED_PROTOCOLS.includes(resolved.protocol)) {
    // Named explicitly rather than a generic "invalid URL": a user who typed a
    // `javascript:` bookmarklet should be told why it was refused.
    throw new EmbedUrlError(
      `"${resolved.protocol}" embeds are not allowed — use http:// or https:// or a relative path.`
    );
  }

  // A relative path stays relative. Resolving it against the real origin would
  // work in a browser, but it would also mean the stored config and the live
  // `src` could disagree the moment the dashboard moved host.
  return value;
}

/** True when the configured URL is safe. Never throws — for form previews. */
export function isSafeEmbedUrl(raw, options) {
  try {
    parseEmbedUrl(raw, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build the `sandbox` attribute value from a config.
 *
 * Returns a space-separated token string, always including the defaults. The
 * order is stable so the attribute does not churn between renders — which
 * matters more than it sounds, because *setting `sandbox` on a live frame
 * reloads it*, and reloading is the one thing this widget must never do.
 */
export function sandboxTokens(config = {}) {
  const tokens = new Set(DEFAULT_SANDBOX);
  for (const [key, token] of Object.entries(OPTIONAL_SANDBOX_TOKENS)) {
    if (config[key] === true || config[key] === 'yes') tokens.add(token);
  }
  return [...tokens].sort().join(' ');
}

/**
 * Whether this config produces the sandbox-defeating pairing.
 *
 * Not an error — a user embedding their own trusted page on their own origin
 * may genuinely want it — but the settings form and the tile both surface it,
 * because "I ticked a box and silently lost all isolation" is not an
 * acceptable outcome.
 */
export function defeatsSandbox(config = {}) {
  const tokens = sandboxTokens(config).split(' ');
  return tokens.includes('allow-scripts') && tokens.includes('allow-same-origin');
}
