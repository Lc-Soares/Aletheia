// Agrupa as mídias do relatório: uma linha por imagem (docs/api.md pede para agrupar por `group`).
// O representante de cada grupo é o item com skipReason diferente de "variant"; o servidor garante
// exatamente um (fetcher/src/select.ts). Se faltar ou sobrar, usa o primeiro, sem derrubar o relatório.

/** @typedef {import("./report-parse.js").MediaItem} MediaItem */

/**
 * @typedef {object} MediaGroup
 * @property {number} position Posição na tela, a partir de 1.
 * @property {MediaItem} representative
 * @property {number} variantCount
 */

/** Grupos válidos (positivos) em ordem crescente; depois os inválidos (negativos), na ordem de entrada. */
const byGroupNumber = (/** @type {number} */ a, /** @type {number} */ b) => (a > 0 && b > 0 ? a - b : a > 0 ? -1 : b > 0 ? 1 : b - a);

/**
 * @param {MediaItem[]} media
 * @returns {MediaGroup[]}
 */
export function groupMedia(media) {
  /** @type {Map<number, MediaItem[]>} */
  const byGroup = new Map();
  for (const item of media) {
    const members = byGroup.get(item.group);
    if (members) members.push(item);
    else byGroup.set(item.group, [item]);
  }
  return [...byGroup.keys()]
    .sort(byGroupNumber)
    .map((key, index) => {
      const members = /** @type {MediaItem[]} */ (byGroup.get(key));
      const representative = members.find((item) => item.skipReason !== "variant") ?? /** @type {MediaItem} */ (members[0]);
      return { position: index + 1, representative, variantCount: members.length - 1 };
    });
}
