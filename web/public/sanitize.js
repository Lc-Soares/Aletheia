// Higienização de texto de terceiros (título, URLs, mensagens, metadados) antes de ir para a tela.
// Mesma regra de api/src/metadata-allowlist.ts e fetcher/scripts/try-fetch.ts, reescrita aqui
// para o front não importar código de outro pacote.
//
// Limitação conhecida: remover \p{Cf} também tira o ZWJ (U+200D, emojis compostos) e o ZWNJ
// (U+200C, persa e alguns scripts indianos). Decisão aceita: segurança antes de fidelidade em texto
// de terceiros. HTML continua sendo texto; quem exibe usa textContent.

const SEPARATORS = /[\r\n\t\u2028\u2029]/g;
// \p{Cs} com a flag u só casa surrogate solto (pares válidos são lidos como um ponto de código).
const REMOVED = /[\p{Cc}\p{Cf}\p{Cs}]/gu;

/**
 * Devolve o texto limpo e cortado em `max` pontos de código (com "…" no corte), ou null se não for
 * texto ou se nada restar.
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
export function sanitizeText(value, max) {
  if (typeof value !== "string") return null;
  // Corta antes de varrer: um texto de milhões de caracteres não precisa ser processado por inteiro.
  // A folga cobre o que será removido; o corte final é refeito depois da limpeza.
  const head = value.length > max * 4 + 64 ? value.slice(0, max * 4 + 64) : value;
  const cleaned = head.replace(SEPARATORS, " ").replace(REMOVED, "").replace(/ {2,}/g, " ").trim();
  if (cleaned === "") return null;
  const points = Array.from(cleaned);
  return points.length > max ? `${points.slice(0, max - 1).join("")}…` : cleaned;
}
