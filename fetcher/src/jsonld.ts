// Leitura de ClaimReview em JSON-LD (Fase 5a, ver docs/fetcher.md, "ClaimReview"). Roda dentro do
// worker de extração, sobre o texto dos <script type="application/ld+json"> que o extract.ts já
// separou. Não busca nada: nem a url da checagem, nem o @context. Só importa media.ts (o grafo de
// imports do worker é conferido em extract-pool.test.ts).
//
// Campos e formato vêm da página oficial do Google (docs/apis/fact-check.md, seção 2): ClaimReview
// com claimReviewed, reviewRating (Rating: alternateName, ou name na falta dele; ratingValue,
// bestRating, worstRating), url, author e datePublished. Todo o resto é ignorado.
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

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

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

// Só http(s) absoluta, sem usuário e senha, na forma normalizada. Nunca é buscada.
function reviewUrl(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxLength) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href.length > maxLength ? null : url.href;
  } catch {
    return null;
  }
}

function toMark(review: JsonObject, maxUrlLength: number): ClaimReviewMark {
  const rating = firstObject(own(review, "reviewRating"));
  const ratingOwn = (key: string): unknown => (rating === null ? undefined : own(rating, key));
  return {
    claimReviewed: text(own(review, "claimReviewed")),
    ratingLabel: text(ratingOwn("alternateName")) ?? text(ratingOwn("name")),
    ratingValue: finite(ratingOwn("ratingValue")),
    bestRating: finite(ratingOwn("bestRating")),
    worstRating: finite(ratingOwn("worstRating")),
    url: reviewUrl(own(review, "url"), maxUrlLength),
    authorName: authorName(own(review, "author")),
    datePublished: text(own(review, "datePublished"), MAX_DATE_LENGTH),
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
// até maxClaimReviews no total. Só os primeiros maxJsonLdBlocks blocos são lidos.
export function readClaimReviews(blocks: readonly string[], limits: JsonLdLimits): ClaimReviewMark[] {
  const found: ClaimReviewMark[] = [];
  const seen = new Set<string>();
  const onFound = (review: JsonObject): boolean => {
    const mark = toMark(review, limits.maxUrlLength);
    const key = JSON.stringify(mark);
    if (!seen.has(key)) {
      seen.add(key);
      found.push(mark);
    }
    return found.length < limits.maxClaimReviews;
  };
  for (const block of blocks.slice(0, limits.maxJsonLdBlocks)) {
    if (found.length >= limits.maxClaimReviews) break;
    visitClaimReviews(parseBlock(block, limits), limits, onFound);
  }
  return found;
}
