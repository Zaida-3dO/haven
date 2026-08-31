/**
 * A minimal DOM double.
 *
 * The web workspace has no jsdom and the host only needs a handful of DOM
 * operations, so this implements exactly those: element creation, children,
 * `attachShadow`, `replaceChildren`, and a `customElements` registry with a
 * real `whenDefined` promise. Keeping it this small means a test failure points
 * at the host, not at a DOM emulation.
 */

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.id = '';
    this._textContent = '';
    this.shadowRoot = null;
    this.parentNode = null;
  }

  get textContent() {
    if (this.children.length === 0) return this._textContent;
    return this.children.map((c) => c.textContent).join('');
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  appendChild(child) {
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
      if (child.className === want) return child;
      const found = child.querySelector?.(className);
      if (found) return found;
    }
    return null;
  }
}

export function createFakeDocument(elementFactories = new Map()) {
  return {
    createElement(tag) {
      const factory = elementFactories.get(tag.toLowerCase());
      return factory ? factory() : new FakeElement(tag);
    },
  };
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
