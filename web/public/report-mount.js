// Converte a árvore de descritores em elementos do DOM. É a única porta de entrada do relatório na
// página, e é restrita de propósito:
//  - lista fechada de tags e de atributos; nunca on*, style, src nem srcdoc;
//  - href só http(s) sem usuário e senha, e todo link leva rel="noopener noreferrer nofollow" e target="_blank";
//  - usa só createElement, textContent, setAttribute e appendChild (nada que interprete HTML);
//  - descritor fora da regra LANÇA "Descritor inválido." (mensagem sem dados), antes de criar qualquer
//    elemento. Os dados nunca decidem tag nem atributo, então isso indica bug nosso; quem chama
//    (report-view.js) captura e mostra um texto fixo.
// A aparência (classes e CSS) fica fora do conteúdo: ver report-classes.js e style.css.

import { isSafeHttpUrl } from "./safe-url.js";

const MAX_DEPTH = 20;
const MAX_NODES = 20_000;
const LINK_REL = "noopener noreferrer nofollow";

const TAGS = new Set(["section", "div", "h2", "h3", "h4", "h5", "p", "ul", "li", "dl", "dt", "dd", "span", "strong", "a", "code"]);
const NODE_KEYS = new Set(["tag", "text", "attrs", "children"]);
const ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

/** Valida o valor de cada atributo permitido. */
/** @type {Record<string, (value: string) => boolean>} */
const ATTRIBUTES = {
  class: (value) => /^[A-Za-z0-9_ -]{1,100}$/u.test(value),
  id: (value) => ID_PATTERN.test(value),
  href: (value) => isSafeHttpUrl(value),
  rel: (value) => value === LINK_REL,
  target: (value) => value === "_blank",
  tabindex: (value) => value === "-1",
  "aria-label": (value) => value.length >= 1 && value.length <= 200 && !/\p{Cc}/u.test(value),
  "aria-labelledby": (value) => ID_PATTERN.test(value),
  "aria-describedby": (value) => ID_PATTERN.test(value),
  "aria-live": (value) => value === "polite" || value === "assertive" || value === "off",
};

/** @typedef {import("./report-describe.js").Descriptor} Descriptor */

function invalid() {
  return new Error("Descritor inválido.");
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isPlainObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * @param {unknown} value
 * @param {number} depth
 * @param {{ nodes: number }} budget
 */
function validate(value, depth, budget) {
  if (depth > MAX_DEPTH || ++budget.nodes > MAX_NODES || !isPlainObject(value)) throw invalid();
  for (const key of Object.keys(value)) if (!NODE_KEYS.has(key)) throw invalid();
  const { tag, text, attrs, children } = value;
  if (typeof tag !== "string" || !TAGS.has(tag)) throw invalid();
  if (text !== undefined && typeof text !== "string") throw invalid();
  validateAttributes(tag, attrs);
  if (children === undefined) return;
  if (!Array.isArray(children) || children.length > MAX_NODES) throw invalid();
  for (const child of children) validate(child, depth + 1, budget);
}

/** @param {string} tag @param {unknown} attrs */
function validateAttributes(tag, attrs) {
  if (attrs === undefined) {
    if (tag === "a") throw invalid();
    return;
  }
  if (!isPlainObject(attrs)) throw invalid();
  for (const [name, value] of Object.entries(attrs)) {
    const check = Object.hasOwn(ATTRIBUTES, name) ? ATTRIBUTES[name] : undefined;
    if (check === undefined || typeof value !== "string" || !check(value)) throw invalid();
    if ((name === "href" || name === "rel" || name === "target") && tag !== "a") throw invalid();
  }
  // Link só completo: href, rel e target juntos.
  if (tag === "a" && !(Object.hasOwn(attrs, "href") && Object.hasOwn(attrs, "rel") && Object.hasOwn(attrs, "target"))) throw invalid();
}

/**
 * O mínimo que o mount usa de um elemento e do document (sintaxe de método: o HTMLElement real serve).
 * @typedef {{ setAttribute(name: string, value: string): void, appendChild(child: MountElement): unknown, textContent: string | null, focus(): void }} MountElement
 * @typedef {{ createElement(tag: string): MountElement }} MountDocument
 */

/**
 * @param {Descriptor} descriptor
 * @param {MountDocument} doc
 * @param {Map<string, MountElement>} ids
 * @returns {MountElement}
 */
function build(descriptor, doc, ids) {
  const element = doc.createElement(descriptor.tag);
  for (const [name, value] of Object.entries(descriptor.attrs ?? {})) {
    element.setAttribute(name, value);
    if (name === "id") ids.set(value, element);
  }
  if (descriptor.text !== undefined) element.textContent = descriptor.text;
  for (const child of descriptor.children ?? []) element.appendChild(build(child, doc, ids));
  return element;
}

/**
 * @param {Descriptor} descriptor
 * @param {MountDocument} doc
 * @returns {{ root: MountElement, ids: Map<string, MountElement> }} `ids`: elementos criados que têm id (para o foco).
 */
export function mount(descriptor, doc) {
  validate(descriptor, 0, { nodes: 0 });
  /** @type {Map<string, MountElement>} */
  const ids = new Map();
  return { root: build(descriptor, doc, ids), ids };
}
