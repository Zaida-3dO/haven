/**
 * DOM helpers for authoring a custom page.
 *
 * These exist so that "author a page" does not mean "write an HTML string",
 * because an HTML string needs an `innerHTML` sink to render and that sink is
 * the one thing the shared widget test forbids outright — for good reason. See
 * the long note in `registry.js`.
 *
 * Every helper here builds real nodes and sets **`textContent`**, so there is
 * no parse step, no sanitiser to get wrong, and no path by which a string
 * becomes markup. A page that wants a `<strong>` inside a sentence composes
 * two nodes rather than writing tags — slightly more verbose, and structurally
 * incapable of executing anything.
 */

/**
 * Create an element.
 *
 * `text` is set with `textContent`. `children` are appended. Attributes go in
 * `attrs`. There is deliberately no `html` option.
 *
 * @param {string} tag
 * @param {{ class?: string, text?: string, attrs?: object, children?: Array }} [options]
 * @param {Document} [doc]
 */
export function el(tag, options = {}, doc = globalThis.document) {
  const node = doc.createElement(tag);

  if (options.class) node.className = options.class;
  if (options.text !== undefined && options.text !== null) node.textContent = String(options.text);

  for (const [name, value] of Object.entries(options.attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    node.setAttribute(name, String(value));
  }

  for (const child of options.children ?? []) {
    if (child) node.appendChild(child);
  }

  return node;
}

/** A `<section>` with an `<h2>` — the standard block on an authored page. */
export function section(title, children = [], doc = globalThis.document) {
  return el(
    'section',
    {
      class: 'page__section',
      children: [el('h2', { class: 'page__section-title', text: title }, doc), ...children],
    },
    doc
  );
}

/**
 * A labelled figure — the "big number" tile an analytics page is mostly made
 * of.
 */
export function stat(label, value, doc = globalThis.document) {
  return el(
    'div',
    {
      class: 'page__stat',
      children: [
        el('span', { class: 'page__stat-value', text: value }, doc),
        el('span', { class: 'page__stat-label', text: label }, doc),
      ],
    },
    doc
  );
}

/**
 * A table from headers and rows of plain values.
 *
 * Every cell is `textContent`, so a value containing `<script>` renders as the
 * literal characters — which is the correct and only behaviour for data.
 */
export function table(headers, rows, doc = globalThis.document) {
  const head = el(
    'thead',
    {
      children: [
        el(
          'tr',
          {
            children: headers.map((h) =>
              el('th', { class: 'page__th', text: h, attrs: { scope: 'col' } }, doc)
            ),
          },
          doc
        ),
      ],
    },
    doc
  );

  const body = el(
    'tbody',
    {
      children: rows.map((row) =>
        el(
          'tr',
          { children: row.map((cell) => el('td', { class: 'page__td', text: cell }, doc)) },
          doc
        )
      ),
    },
    doc
  );

  return el('table', { class: 'page__table', children: [head, body] }, doc);
}

/**
 * A link.
 *
 * External targets get `rel="noopener noreferrer"`, because a `target=_blank`
 * link without it hands the opened page a `window.opener` reference back to
 * the dashboard.
 */
export function link(text, href, { external = false } = {}, doc = globalThis.document) {
  return el(
    'a',
    {
      class: 'page__link',
      text,
      attrs: {
        href,
        ...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
      },
    },
    doc
  );
}
