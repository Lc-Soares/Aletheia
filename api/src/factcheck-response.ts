// Fact Check Tools (claims.search): o texto enviado na busca e a leitura da resposta pela lista
// permitida. Campos: docs/apis/fact-check.md e as páginas oficiais (claims/search e o recurso
// Claim). Nada do Google é repassado sem cópia campo a campo; campo desconhecido é ignorado (a API é
// alfa e pode ganhar campos), nunca repassado. Só propriedade própria é lida.

export const FACT_CHECK_LIMITS = Object.freeze({
  maxQueryLength: 200, // pontos de código do texto enviado
  maxClaims: 10, // o mesmo pageSize pedido
  maxReviewsPerClaim: 5,
  maxScannedItems: 50, // as listas nunca são percorridas inteiras
  maxTextLength: 300,
  maxDateLength: 64,
  maxLanguageLength: 35,
  maxSiteLength: 253,
  maxUrlLength: 2048,
});

export type FactCheckReview = {
  publisherName: string | null;
  publisherSite: string | null;
  url: string | null;
  title: string | null;
  reviewDate: string | null;
  textualRating: string | null; // o rótulo que o PUBLICADOR escreveu (ex.: "Mostly false")
  languageCode: string | null;
};

export type FactCheckClaim = {
  text: string | null;
  claimant: string | null;
  claimDate: string | null;
  reviews: FactCheckReview[];
};

type PlainObject = Record<string, unknown>;

// Controles viram espaço; formato (bidi, largura zero) e surrogate solto saem.
const CONTROLS = /\p{Cc}/gu;
const INVISIBLE = /[\p{Cf}\p{Cs}]/gu;
// RFC 3339 em UTC ("Zulu"), com até nove casas de fração, como a documentação descreve.
const RFC3339_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/;
const BCP47 = /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const own = (value: PlainObject, key: string): unknown => (Object.hasOwn(value, key) ? value[key] : undefined);

/** Espaços colapsados, corte em `max` unidades e texto bem formado; vazio vira null. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const collapsed = value.slice(0, max * 4 + 64).replace(/\s+/g, " ").trim().slice(0, max).toWellFormed().trim();
  return collapsed === "" ? null : collapsed;
}

const date = (value: unknown): string | null =>
  typeof value === "string" && value.length <= FACT_CHECK_LIMITS.maxDateLength && RFC3339_UTC.test(value) ? value : null;

const language = (value: unknown): string | null =>
  typeof value === "string" && value.length <= FACT_CHECK_LIMITS.maxLanguageLength && BCP47.test(value) ? value : null;

// Só http(s) absoluta, sem usuário e senha, guardada na forma normalizada. Nunca é buscada.
function reviewUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > FACT_CHECK_LIMITS.maxUrlLength || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    const safe = (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.hostname !== "";
    return safe && url.href.length <= FACT_CHECK_LIMITS.maxUrlLength ? url.href : null;
  } catch {
    return null;
  }
}

/** Primeiros itens de uma lista, sem percorrê-la inteira. */
function firstItems<T>(list: unknown[], read: (item: unknown) => T | null, keep: number): T[] {
  const found: T[] = [];
  const end = Math.min(list.length, FACT_CHECK_LIMITS.maxScannedItems);
  for (let i = 0; i < end && found.length < keep; i++) {
    const item = read(list[i]);
    if (item !== null) found.push(item);
  }
  return found;
}

// Revisão sem url, title e textualRating não diz nada: é descartada.
function toReview(value: unknown): FactCheckReview | null {
  if (!isPlainObject(value)) return null;
  const publisher = own(value, "publisher");
  const name = isPlainObject(publisher) ? text(own(publisher, "name"), FACT_CHECK_LIMITS.maxTextLength) : null;
  const site = isPlainObject(publisher) ? text(own(publisher, "site"), FACT_CHECK_LIMITS.maxSiteLength) : null;
  const review: FactCheckReview = {
    publisherName: name,
    publisherSite: site,
    url: reviewUrl(own(value, "url")),
    title: text(own(value, "title"), FACT_CHECK_LIMITS.maxTextLength),
    reviewDate: date(own(value, "reviewDate")),
    textualRating: text(own(value, "textualRating"), FACT_CHECK_LIMITS.maxTextLength),
    languageCode: language(own(value, "languageCode")),
  };
  return review.url === null && review.title === null && review.textualRating === null ? null : review;
}

// Afirmação sem nenhuma revisão válida é descartada.
function toClaim(value: unknown): FactCheckClaim | null {
  if (!isPlainObject(value)) return null;
  const list = own(value, "claimReview");
  const reviews = Array.isArray(list) ? firstItems(list, toReview, FACT_CHECK_LIMITS.maxReviewsPerClaim) : [];
  if (reviews.length === 0) return null;
  return {
    text: text(own(value, "text"), FACT_CHECK_LIMITS.maxTextLength),
    claimant: text(own(value, "claimant"), FACT_CHECK_LIMITS.maxTextLength),
    claimDate: date(own(value, "claimDate")),
    reviews,
  };
}

/**
 * Corpo de claims:search já lido como JSON. Sem `claims` (o Google manda {} quando não acha nada):
 * lista vazia. Raiz que não é objeto ou `claims` que não é lista: null (resposta descartada).
 */
export function parseSearchResponse(value: unknown): FactCheckClaim[] | null {
  if (!isPlainObject(value)) return null;
  if (!Object.hasOwn(value, "claims")) return [];
  const list = value["claims"];
  return Array.isArray(list) ? firstItems(list, toClaim, FACT_CHECK_LIMITS.maxClaims) : null;
}

function queryText(value: string | null): string | null {
  if (value === null) return null;
  const cleaned = value.replace(INVISIBLE, "").replace(CONTROLS, " ").replace(/\s+/g, " ").trim();
  const cut = Array.from(cleaned).slice(0, FACT_CHECK_LIMITS.maxQueryLength).join("").trim();
  return cut === "" ? null : cut;
}

/** Texto da busca: a manchete da página; sem ela (ou vazia depois da limpeza), o título. */
export function factCheckQuery(page: { headline: string | null; title: string | null }): string | null {
  return queryText(page.headline) ?? queryText(page.title);
}
