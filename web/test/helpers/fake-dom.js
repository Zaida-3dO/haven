/**
 * A minimal DOM double.
 *
 * The web workspace has no jsdom and the host only needs a handful of DOM
 * operations, so this implements exactly those: element creation, children,
 * `attachShadow`, `replaceChildren`, and a `customElements` registry with a
 * real `whenDefined` promise. Keeping it this small means a test failure points
 * at the host, not at a DOM emulation.
 *
 * Extended for the search UI with attributes, listeners, focus and
 * `querySelectorAll` — all additive, so the host and dashboard suites see
 * exactly the behaviour they saw before.
 */

class FakeElement {
  // The tag defaults so a custom-element subclass can be constructed with
  // `new Widget()`, which passes no arguments.
  constructor(tagName = 'div') {
    this.tagName = String(tagName).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.id = '';
    this._textContent = '';
    this.shadowRoot = null;
    this.parentNode = null;
    this.attributes = new Map();
    this.listeners = new Map();
    this.value = '';
    this.focused = false;
    // A plain bag, which is all any widget needs of `style`: setting an
    // inline property (a progress bar's width, a calendar feed's colour) and
    // reading it back.
    this.style = {};
    /**
     * `classList` is a stand-in kept in sync with `className`, so
     * `matches('.x')` and `querySelector('.x')` keep working exactly as
     * before. Additive: suites that never touch it are unaffected.
     */
    this.classList = {
      add: (...names) => {
        const present = this.className.split(/\s+/).filter(Boolean);
        for (const name of names) if (!present.includes(name)) present.push(name);
        this.className = present.join(' ');
      },
      remove: (...names) => {
        this.className = this.className
          .split(/\s+/)
          .filter((c) => c && !names.includes(c))
          .join(' ');
      },
      contains: (name) => this.className.split(/\s+/).includes(name),
    };
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  removeEventListener(type, handler) {
    const list = this.listeners.get(type) ?? [];
    const i = list.indexOf(handler);
    if (i >= 0) list.splice(i, 1);
  }

  /**
   * Dispatch to this element's own listeners. Deliberately not a real
   * bubbling implementation — the search UI listens directly on the elements
   * it created, so anything more would be emulation for its own sake.
   */
  dispatchEvent(event) {
    const list = this.listeners.get(event.type) ?? [];
    for (const handler of [...list]) handler({ target: this, ...event });
    return true;
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur() {
    this.focused = false;
    if (this.ownerDocument?.activeElement === this) this.ownerDocument.activeElement = null;
  }

  /** Walk up looking for an ancestor matching a `[data-*]` or `.class` selector. */
  closest(selector) {
    let node = this;
    while (node) {
      if (node.matches?.(selector)) return node;
      node = node.parentNode;
    }
    return null;
  }

  matches(selector) {
    const attr = selector.match(/^\[data-([\w-]+)\]$/);
    if (attr) {
      const key = attr[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      return this.dataset[key] !== undefined;
    }
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tagName === selector.toUpperCase();
  }

  /** Every descendant matching a class, `[data-*]`, `#id` or tag selector. */
  querySelectorAll(selector) {
    const found = [];
    for (const child of this.children) {
      if (child.matches?.(selector)) found.push(child);
      if (child.querySelectorAll) found.push(...child.querySelectorAll(selector));
    }
    return found;
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  /**
   * Append, MOVING the node if it is already somewhere.
   *
   * The real `appendChild` detaches first, which is precisely what lets a
   * keyed list reorder itself by re-appending existing nodes instead of
   * rebuilding them. A fake that merely pushed would duplicate the node and
   * quietly report a diff-and-patch widget as broken (or, worse, as working).
   */
  appendChild(child) {
    if (child.parentNode) {
      const siblings = child.parentNode.children;
      const at = siblings.indexOf(child);
      if (at >= 0) siblings.splice(at, 1);
    }
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  replaceChildren(...nodes) {
    this.children = [];
    for (const node of nodes) this.appendChild(node);
  }

  remove() {
    if (!this.parentNode) return;
    const i = this.parentNode.children.indexOf(this);
    if (i >= 0) this.parentNode.children.splice(i, 1);
    this.parentNode = null;
  }

  attachShadow() {
    this.shadowRoot = new FakeElement('#shadow-root');
    this.shadowRoot.host = this;
    return this.shadowRoot;
  }

  /** Depth-first search used by the assertions. */
  querySelector(className) {
    const want = className.replace(/^\./, '');
    for (const child of this.children) {
      // Token-aware: an element carrying `cal__event cal__event--allday` is
      // still found by `.cal__event`. An exact-string compare would miss it.
      const classes = (child.className ?? '').split(/\s+/).filter(Boolean);
      if (child.className === want || classes.includes(want)) return child;
      const found = child.querySelector?.(className);
      if (found) return found;
    }
    return null;
  }
}

export function createFakeDocument(elementFactories = new Map()) {
  const doc = {
    activeElement: null,
    listeners: new Map(),

    createElement(tag) {
      const factory = elementFactories.get(tag.toLowerCase());
      const el = factory ? factory() : new FakeElement(tag);
      // So `focus()` can report itself as the document's active element.
      if (el && typeof el === 'object') el.ownerDocument = doc;
      return el;
    },

    addEventListener(type, handler) {
      const list = doc.listeners.get(type) ?? [];
      list.push(handler);
      doc.listeners.set(type, list);
    },

    removeEventListener(type, handler) {
      const list = doc.listeners.get(type) ?? [];
      const i = list.indexOf(handler);
      if (i >= 0) list.splice(i, 1);
    },

    /** Fire a document-level event — how the tests press the global shortcut. */
    dispatchEvent(event) {
      for (const handler of [...(doc.listeners.get(event.type) ?? [])]) handler(event);
      return true;
    },
  };
  return doc;
}

/** A `customElements` double whose `whenDefined` really resolves on define. */
export function createCustomElements() {
  const defined = new Map();
  const waiters = new Map();

  return {
    define(tag, factory) {
      const key = tag.toLowerCase();
      defined.set(key, factory);
      const pending = waiters.get(key);
      if (pending) {
        for (const resolve of pending) resolve(factory);
        waiters.delete(key);
      }
    },
    get(tag) {
      return defined.get(tag.toLowerCase()) ?? undefined;
    },
    whenDefined(tag) {
      const key = tag.toLowerCase();
      if (defined.has(key)) return Promise.resolve(defined.get(key));
      return new Promise((resolve) => {
        const list = waiters.get(key) ?? [];
        list.push(resolve);
        waiters.set(key, list);
      });
    },
  };
}

export { FakeElement };
