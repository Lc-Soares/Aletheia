// Auxiliares para os testes olharem a árvore de descritores por tag e texto, nunca por classe.

/** @typedef {import("../public/report-describe.js").Descriptor} Descriptor */

/** @param {Descriptor} node @returns {Descriptor[]} */
export function flatten(node) {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

/** @param {Descriptor} root @param {string} tag */
export const byTag = (root, tag) => flatten(root).filter((node) => node.tag === tag);

/** Texto de todos os nós, na ordem do documento, separado por quebra de linha. */
export const allText = (/** @type {Descriptor} */ root) =>
  flatten(root)
    .map((node) => node.text ?? "")
    .filter((text) => text !== "")
    .join("\n");

/** @param {Descriptor} root @param {string} fragment */
export const nodesWithText = (root, fragment) => flatten(root).filter((node) => (node.text ?? "").includes(fragment));

/** Tags usadas, sem repetição. */
export const tagsOf = (/** @type {Descriptor} */ root) => [...new Set(flatten(root).map((node) => node.tag))].sort();

/** Todos os pares [tag, atributo, valor]. */
export const attributesOf = (/** @type {Descriptor} */ root) =>
  flatten(root).flatMap((node) => Object.entries(node.attrs ?? {}).map(([name, value]) => /** @type {const} */ ([node.tag, name, value])));
