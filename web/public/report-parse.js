// Validação defensiva da resposta 200 de POST /api/check. Lê SÓ os campos conhecidos (lista
// permitida), com o tipo conferido: campo com tipo errado vira ausente e não derruba o resto. Todo
// texto de terceiros passa por sanitizeText aqui, na entrada, então a tela e o JSON baixado só
// recebem texto já limpo. Resposta fora do formato devolve null.
// Contrato: docs/api.md ("Resposta 200" e "Sinais por mídia").

import { sanitizeText } from "./sanitize.js";

const MAX_MEDIA = 200;
const MAX_NOTICES = 20;
const MAX_DATES = 10;
const MAX_SOFTWARE = 10;
const MAX_CHECKS = 50;
const MAX_DIMENSION = 100_000;
const LIMITS = { url: 2048, title: 300, headline: 300, notice: 500, message: 300, short: 64, software: 128, code: 128 };

const SKIP_REASONS = ["variant", "icon", "unsupported_format", "low_score", "limit", "other"];
const FAILED_METADATA = ["unavailable", "unsupported", "too_large", "error", "not_analyzed"];

/**
 * @typedef {object} C2pa
 * @property {string | null} state
 * @property {string | null} reason
 * @property {string | null} signer
 * @property {string | null} signedAt
 * @property {string | null} generator
 * @property {boolean | null} aiGenerated
 * @property {Array<{ code: string, outcome: string | null }>} checks
 */

/**
 * `c2pa`: null = nenhuma assinatura encontrada; undefined = campo ilegível (não se sabe).
 * `containsLocation` e `containsAuthorship`: null = ilegível (não se sabe).
 * @typedef {object} Signals
 * @property {string | null} fileType
 * @property {number | null} width
 * @property {number | null} height
 * @property {string | null} sha256
 * @property {Array<{ tag: string, value: string }>} dates
 * @property {{ make: string | null, model: string | null } | null} camera
 * @property {string[]} software
 * @property {boolean | null} containsLocation
 * @property {boolean | null} containsAuthorship
 * @property {C2pa | null | undefined} c2pa
 */

/** @typedef {{ status: "ok" } | { status: "error", message: string | null }} Download */

/**
 * @typedef {{ status: "ok", signals: Signals }
 *   | { status: "unavailable" | "unsupported" | "too_large" | "error" | "not_analyzed" | "unknown", message: string | null }} Metadata
 */

/**
 * @typedef {object} MediaItem
 * @property {string} url
 * @property {number} group Número do grupo; negativo quando o servidor mandou um valor inválido (grupo próprio).
 * @property {string | null} skipReason null = analisada
 * @property {Download | null} download
 * @property {Metadata | null} metadata
 */

/**
 * @typedef {object} Report
 * @property {{ finalUrl: string | null, title: string | null, headline: string | null }} page
 * @property {string[]} notices
 * @property {MediaItem[]} media
 */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

/** @param {unknown} value @returns {boolean | null} */
const bool = (value) => (typeof value === "boolean" ? value : null);

/** @param {unknown} value @returns {number | null} */
const dimension = (value) => (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_DIMENSION ? value : null);

/** @param {unknown} value @param {number} max @param {number} limit @returns {string[]} */
function textList(value, max, limit) {
  if (!Array.isArray(value)) return [];
  /** @type {string[]} */
  const found = [];
  for (const item of value) {
    const text = sanitizeText(item, limit);
    if (text !== null && !found.includes(text)) found.push(text);
    if (found.length >= max) break;
  }
  return found;
}

/** @param {unknown} value @returns {Signals["dates"]} */
function dates(value) {
  if (!Array.isArray(value)) return [];
  /** @type {Signals["dates"]} */
  const found = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const tag = sanitizeText(item["tag"], LIMITS.short);
    const text = sanitizeText(item["value"], LIMITS.short);
    if (tag !== null && text !== null) found.push({ tag, value: text });
    if (found.length >= MAX_DATES) break;
  }
  return found;
}

/** @param {unknown} value @returns {Signals["camera"]} */
function camera(value) {
  if (!isObject(value)) return null;
  const make = sanitizeText(value["make"], LIMITS.short);
  const model = sanitizeText(value["model"], LIMITS.short);
  return make === null && model === null ? null : { make, model };
}

/** @param {unknown} value @returns {C2pa["checks"]} */
function checks(value) {
  if (!Array.isArray(value)) return [];
  /** @type {C2pa["checks"]} */
  const found = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const code = sanitizeText(item["code"], LIMITS.code);
    if (code !== null) found.push({ code, outcome: sanitizeText(item["outcome"], LIMITS.short) });
    if (found.length >= MAX_CHECKS) break;
  }
  return found;
}

/** Só os campos que a tela mostra; manifestUrl, creator, title e ingredients nunca são lidos. */
/** @param {unknown} value @returns {C2pa | null | undefined} */
function c2pa(value) {
  if (value === null) return null;
  if (!isObject(value)) return undefined;
  return {
    state: sanitizeText(value["state"], LIMITS.short),
    reason: sanitizeText(value["reason"], LIMITS.short),
    signer: sanitizeText(value["signer"], LIMITS.message),
    signedAt: sanitizeText(value["signedAt"], LIMITS.short),
    generator: sanitizeText(value["generator"], LIMITS.message),
    aiGenerated: bool(value["aiGenerated"]),
    checks: checks(value["checks"]),
  };
}

/** @param {Record<string, unknown>} raw @returns {Signals} */
function signals(raw) {
  const sha = raw["sha256"];
  return {
    fileType: sanitizeText(raw["fileType"], LIMITS.short),
    width: dimension(raw["width"]),
    height: dimension(raw["height"]),
    sha256: typeof sha === "string" && /^[0-9a-fA-F]{64}$/u.test(sha) ? sha : null,
    dates: dates(raw["dates"]),
    camera: camera(raw["camera"]),
    software: textList(raw["software"], MAX_SOFTWARE, LIMITS.software),
    containsLocation: bool(raw["containsLocation"]),
    containsAuthorship: bool(raw["containsAuthorship"]),
    c2pa: c2pa(raw["c2pa"]),
  };
}

/** @param {unknown} value @returns {Download | null} */
function download(value) {
  if (!isObject(value)) return null;
  if (value["status"] === "ok") return { status: "ok" };
  if (value["status"] === "error") return { status: "error", message: sanitizeText(value["message"], LIMITS.message) };
  return null;
}

/** @param {unknown} value @returns {Metadata | null} */
function metadata(value) {
  if (!isObject(value)) return null;
  const status = value["status"];
  const message = sanitizeText(value["message"], LIMITS.message);
  if (status === "ok" && isObject(value["signals"])) return { status: "ok", signals: signals(value["signals"]) };
  if (typeof status === "string" && FAILED_METADATA.includes(status)) {
    return { status: /** @type {"unavailable"} */ (status), message };
  }
  return { status: "unknown", message };
}

// Motivo ausente (ou de tipo errado) só vale "analisada" se o servidor marcou selected: true.
/** @param {unknown} reason @param {unknown} selected @returns {string | null} */
function skipReason(reason, selected) {
  if (typeof reason === "string") return SKIP_REASONS.includes(reason) ? reason : "other";
  return selected === true ? null : "other";
}

/** @param {unknown} raw @param {number} index @returns {MediaItem | null} */
function mediaItem(raw, index) {
  if (!isObject(raw)) return null;
  const url = sanitizeText(raw["url"], LIMITS.url);
  if (url === null) return null;
  const group = raw["group"];
  return {
    url,
    group: typeof group === "number" && Number.isInteger(group) && group >= 1 ? group : -(index + 1),
    skipReason: skipReason(raw["skipReason"], raw["selected"]),
    download: download(raw["download"]),
    metadata: metadata(raw["metadata"]),
  };
}

/**
 * @param {unknown} json Corpo da resposta 200, como veio do servidor.
 * @returns {Report | null} null quando fora do formato.
 */
export function parseReport(json) {
  if (!isObject(json) || !isObject(json["page"]) || !Array.isArray(json["media"])) return null;
  const page = json["page"];
  /** @type {MediaItem[]} */
  const media = [];
  for (const [index, raw] of json["media"].slice(0, MAX_MEDIA).entries()) {
    const item = mediaItem(raw, index);
    if (item !== null) media.push(item);
  }
  return {
    page: {
      finalUrl: sanitizeText(page["finalUrl"], LIMITS.url),
      title: sanitizeText(page["title"], LIMITS.title),
      headline: sanitizeText(page["headline"], LIMITS.headline),
    },
    notices: textList(json["notices"], MAX_NOTICES, LIMITS.notice),
    media,
  };
}
