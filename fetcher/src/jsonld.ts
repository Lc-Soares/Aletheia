// Leitura de ClaimReview em JSON-LD (Fase 5a, ver docs/fetcher.md, "ClaimReview"). Roda dentro do
// worker de extração, sobre o texto dos <script type="application/ld+json"> que o extract.ts já
// separou. Não busca nada: nem a url da checagem, nem o @context. Só importa media.ts (o grafo de
// imports do worker é conferido em extract-pool.test.ts).
//
// Campos e formato vêm da página oficial do Google (docs/apis/fact-check.md, seção 2): ClaimReview
// com claimReviewed, reviewRating (Rating: alternateName, ou name na falta dele; ratingValue,
// bestRating, worstRating), url, author e datePublished. Todo o resto é ignorado.
// Fase 5a-2 (marcação real): a url pode vir relativa (resolvida contra a base da página, a mesma
// das mídias) e as notas podem vir como texto numérico simples (a doc oficial pede só que "possam
// ser avaliadas como número").
import { type ClaimReviewMark, MAX_DATE_LENGTH, MAX_TEXT_LENGTH, normalizeText } from "./media.ts";

export type JsonLdLimits = {
  maxJsonLdBlocks: number;
  maxJsonLdBlockChars: number;
  maxJsonLdNodes: number;
  maxJsonLdDepth: number;
  maxClaimReviews: number;
  maxUrlLength: number;
};

// @type exato (maiúsculas contam): o termo curto e o IRI completo do schema.org.
const CLAIM_REVIEW_TYPES: ReadonlySet<string> = new Set(["ClaimReview", "https://schema.org/ClaimReview", "http://schema.org/ClaimReview"]);
// Em listas (@type, author, reviewRating), só os primeiros itens são considerados.
const MAX_LIST_ITEMS = 10;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

// Só propriedade própria: nada é lido do protótipo, nem por uma chave "__proto__" ou "constructor".
const own = (object: JsonObject, key: string): unknown => (Object.hasOwn(object, key) ? object[key] : undefined);

const CHAR_QUOTE = 0x22;
const CHAR_BACKSLASH = 0x5c;
const OPENERS = new Set([0x5b, 0x7b]); // [ {
const CLOSERS = new Set([0x5d, 0x7d]); // ] }

// Pré-varredura linear da profundidade de [ e { fora de strings, antes do JSON.parse: um bloco
// fundo demais é ignorado sem montar a estrutura. Texto inválido é problema do JSON.parse.
export function exceedsDepth(text: string, maxDepth: number): boolean {
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (inString) {
      if (code === CHAR_BACKSLASH) i++;
      else if (code === CHAR_QUOTE) inString = false;
    } else if (code === CHAR_QUOTE) inString = true;
    else if (OPENERS.has(code)) {
      if (++depth > maxDepth) return true;
    } else if (CLOSERS.has(code)) depth--;
  }
  return false;
}

// Bloco grande demais, fundo demais ou inválido vira undefined: ignorado sem derrubar nada.
function parseBlock(text: string, limits: JsonLdLimits): unknown {
  if (text.length > limits.maxJsonLdBlockChars || exceedsDepth(text, limits.maxJsonLdDepth)) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function isClaimReview(object: JsonObject): boolean {
  const type = own(object, "@type");
  const types = Array.isArray(type) ? type.slice(0, MAX_LIST_ITEMS) : [type];
  return types.some((item) => typeof item === "string" && CLAIM_REVIEW_TYPES.has(item));
}

const text = (value: unknown, max: number = MAX_TEXT_LENGTH): string | null => (typeof value === "string" ? normalizeText(value, max) : null);

// Nota: number finito, ou texto numérico simples (sinal opcional, até 15 dígitos e 15 decimais com
// ponto, só ASCII). Vírgula decimal, expoente, hexadecimal, NaN e Infinity ficam de fora.
const MAX_NUMBER_TEXT = 32;
const NUMBER_TEXT = /^[+-]?\d{1,15}(\.\d{1,15})?$/;
function ratingNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.length > MAX_NUMBER_TEXT) return null;
  const trimmed = value.trim();
  if (!NUMBER_TEXT.test(trimmed)) return null;
  const number = Number(trimmed);
  return Number.isFinite(number) ? number : null;
}

// Valor cru da nota para o rascunho: número, ou texto curto (o corte mantém o texto grande inválido).
const rawNumber = (value: unknown): number | string | null =>
  typeof value === "number" ? value : typeof value === "string" ? value.slice(0, MAX_NUMBER_TEXT + 1) : null;

// O objeto, ou o primeiro objeto de uma lista.
function firstObject(value: unknown): JsonObject | null {
  if (isObject(value)) return value;
  if (!Array.isArray(value)) return null;
  for (const item of value.slice(0, MAX_LIST_ITEMS)) if (isObject(item)) return item;
  return null;
}

// author: texto simples, objeto com name, ou lista deles (vale o primeiro que tiver nome).
function authorName(value: unknown): string | null {
  for (const item of Array.isArray(value) ? value.slice(0, MAX_LIST_ITEMS) : [value]) {
    const name = isObject(item) ? text(own(item, "name")) : text(item);
    if (name !== null) return name;
  }
  return null;
}

// Resolvida contra a base da página (absoluta, relativa ou de protocolo relativo, como no
// navegador); só http(s), sem usuário e senha, na forma normalizada. Nunca é buscada.
function reviewUrl(value: string | null, base: string, maxLength: number): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxLength) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href.length > maxLength ? null : url.href;
  } catch {
    return null;
  }
}

// Rascunho barato de uma marca: textos já normalizados, url e notas ainda cruas (cortadas). Serve
// para descartar repetidas sem resolver url nem converter notas.
type Draft = Omit<ClaimReviewMark, "url" | "ratingValue" | "bestRating" | "worstRating"> & {
  url: string | null;
  ratingValue: number | string | null;
  bestRating: number | string | null;
  worstRating: number | string | null;
};

function toDraft(review: JsonObject, maxUrlLength: number): Draft {
  const rating = firstObject(own(review, "reviewRating"));
  const ratingOwn = (key: string): unknown => (rating === null ? undefined : own(rating, key));
  const url = own(review, "url");
  return {
    claimReviewed: text(own(review, "claimReviewed")),
    ratingLabel: text(ratingOwn("alternateName")) ?? text(ratingOwn("name")),
    ratingValue: rawNumber(ratingOwn("ratingValue")),
    bestRating: rawNumber(ratingOwn("bestRating")),
    worstRating: rawNumber(ratingOwn("worstRating")),
    // O corte em maxUrlLength + 1 mantém a url longa demais como longa demais.
    url: typeof url === "string" ? url.slice(0, maxUrlLength + 1) : null,
    authorName: authorName(own(review, "author")),
    // Só a data da raiz: a de itemReviewed é a da afirmação, não a da checagem.
    datePublished: text(own(review, "datePublished"), MAX_DATE_LENGTH),
  };
}

// A parte que custa: resolver a url e converter as notas. Só roda nas marcas que podem entrar.
function toMark(draft: Draft, base: string, maxUrlLength: number): ClaimReviewMark {
  return {
    ...draft,
    ratingValue: ratingNumber(draft.ratingValue),
    bestRating: ratingNumber(draft.bestRating),
    worstRating: ratingNumber(draft.worstRating),
    url: reviewUrl(draft.url, base, maxUrlLength),
  };
}

// Percorre o valor com pilha explícita (sem recursão), no máximo maxJsonLdNodes objetos e listas
// por bloco, sem passar de maxJsonLdDepth. Não desce dentro de um ClaimReview já encontrado.
// onFound devolve false para parar.
function visitClaimReviews(root: unknown, limits: JsonLdLimits, onFound: (review: JsonObject) => boolean): void {
  const values: unknown[] = [root];
  const depths: number[] = [1];
  let visited = 0;
  while (values.length > 0 && visited < limits.maxJsonLdNodes) {
    const value = values.pop();
    const depth = depths.pop() ?? 1;
    if (typeof value !== "object" || value === null) continue;
    visited++;
    if (isObject(value) && isClaimReview(value)) {
      if (!onFound(value)) return;
      continue;
    }
    if (depth >= limits.maxJsonLdDepth) continue;
    const children = Array.isArray(value) ? value : Object.values(value);
    for (let i = children.length - 1; i >= 0; i--) {
      const child: unknown = children[i];
      if (typeof child === "object" && child !== null) {
        values.push(child);
        depths.push(depth + 1);
      }
    }
  }
}

// Marcações ClaimReview dos blocos, na ordem do documento: sem repetidas (todos os campos iguais),
// até maxClaimReviews no total. Só os primeiros maxJsonLdBlocks blocos são lidos. `base` é a base
// da página (o <base href> válido, senão a URL final), a mesma que resolve as mídias.
// Teto antes do trabalho: um rascunho repetido é descartado sem resolver nada, e no máximo
// maxClaimReviews marcas são finalizadas (url resolvida e notas convertidas). Rascunhos diferentes
// que dão a mesma marca (por exemplo "/c/" e a mesma url absoluta) gastam uma vaga e saem repetidos.
export function readClaimReviews(blocks: readonly string[], base: string, limits: JsonLdLimits): ClaimReviewMark[] {
  const found: ClaimReviewMark[] = [];
  const seenDrafts = new Set<string>();
  const seenMarks = new Set<string>();
  let finished = 0;
  const onFound = (review: JsonObject): boolean => {
    const draft = toDraft(review, limits.maxUrlLength);
    const draftKey = JSON.stringify(draft);
    if (seenDrafts.has(draftKey)) return true;
    seenDrafts.add(draftKey);
    finished++;
    const mark = toMark(draft, base, limits.maxUrlLength);
    const key = JSON.stringify(mark);
    if (!seenMarks.has(key)) {
      seenMarks.add(key);
      found.push(mark);
    }
    return finished < limits.maxClaimReviews;
  };
  for (const block of blocks.slice(0, limits.maxJsonLdBlocks)) {
    if (finished >= limits.maxClaimReviews) break;
    visitClaimReviews(parseBlock(block, limits), limits, onFound);
  }
  return found;
}
