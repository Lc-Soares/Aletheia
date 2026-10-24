// Document falso, só com o que os testes do mount usam: createElement e, nos elementos,
// setAttribute, appendChild, textContent, replaceChildren e focus. Qualquer outro acesso (por
// exemplo innerHTML, outerHTML, insertAdjacentHTML, onclick) lança, e o teste falha.

const ALLOWED = new Set(["setAttribute", "appendChild", "textContent", "replaceChildren", "focus"]);

/**
 * @typedef {object} Record_
 * @property {string} tag
 * @property {Map<string, string>} attributes
 * @property {Array<FakeElement>} children
 * @property {string} text
 * @property {number} focused
 */

/** @typedef {object} FakeElement */

/** @type {WeakMap<object, Record_>} */
const records = new WeakMap();

/** @param {string} tag @returns {FakeElement} */
function makeElement(tag) {
  /** @type {Record_} */
  const record = { tag, attributes: new Map(), children: [], text: "", focused: 0 };
  const methods = {
    /** @param {string} name @param {string} value */
    setAttribute(name, value) {
      record.attributes.set(name, String(value));
    },
    /** @param {FakeElement} child */
    appendChild(child) {
      record.children.push(child);
      return child;
    },
    /** @param {FakeElement[]} nodes */
    replaceChildren(...nodes) {
      record.text = "";
      record.children = [...nodes];
    },
    focus() {
      record.focused++;
    },
  };
  const proxy = new Proxy(/** @type {object} */ ({}), {
    get(_target, prop) {
      if (prop === "textContent") return record.text;
      if (typeof prop === "string" && ALLOWED.has(prop)) return methods[/** @type {keyof typeof methods} */ (prop)];
      throw new Error(`acesso não permitido ao elemento falso: ${String(prop)}`);
    },
    set(_target, prop, value) {
      if (prop !== "textContent") throw new Error(`escrita não permitida no elemento falso: ${String(prop)}`);
      record.text = String(value);
      record.children = [];
      return true;
    },
  });
  records.set(proxy, record);
  return proxy;
}

export function createFakeDocument() {
  /** @type {FakeElement[]} */
  const created = [];
  const doc = new Proxy(/** @type {object} */ ({}), {
    get(_target, prop) {
      if (prop === "createElement") {
        return (/** @type {string} */ tag) => {
          const element = makeElement(tag);
          created.push(element);
          return element;
        };
      }
      throw new Error(`acesso não permitido ao document falso: ${String(prop)}`);
    },
  });
  return { doc, created };
}

/** Elemento solto, para servir de contêiner nos testes. */
export const createFakeElement = makeElement;

/**
 * @typedef {object} Snapshot
 * @property {string} tag
 * @property {Record<string, string>} attributes
 * @property {string} text
 * @property {Snapshot[]} children
 * @property {number} focused
 */

/** @param {FakeElement} element @returns {Snapshot} */
export function snapshot(element) {
  const record = /** @type {Record_} */ (records.get(element));
  return {
    tag: record.tag,
    attributes: Object.fromEntries(record.attributes),
    text: record.text,
    children: record.children.map(snapshot),
    focused: record.focused,
  };
}
