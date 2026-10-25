// Conteúdo do relatório como árvore de descritores {tag, text, attrs, children}: só dados, sem HTML
// cru. Quem cria elementos de verdade é o report-mount.js. Todo texto aqui já foi higienizado pelo
// report-parse.js. O href só é criado depois de conferir http(s) sem usuário e senha, para o mount
// nunca precisar recusar um dado real. Nada de miniatura nem <img>: a CSP (img-src 'self') e a
// privacidade (vazaria o IP) não deixam.

import { C, IDS } from "./report-classes.js";
import { groupMedia } from "./report-model.js";
import {
  C2PA_REASON_LABELS,
  C2PA_STATE_LABELS,
  DATE_LABELS,
  FIXED_NOTICE,
  IGNORED_NOTE,
  IGNORED_TEXT,
  METADATA_TEXT,
  TEXT,
  lookup,
} from "./report-text.js";
import { isSafeHttpUrl } from "./safe-url.js";

/**
 * @typedef {object} Descriptor
 * @property {string} tag
 * @property {string} [text]
 * @property {Record<string, string>} [attrs]
 * @property {Descriptor[]} [children]
 */

/** @typedef {import("./report-parse.js").Report} Report */
/** @typedef {import("./report-parse.js").MediaItem} MediaItem */
/** @typedef {import("./report-parse.js").Signals} Signals */
/** @typedef {import("./report-parse.js").C2pa} C2pa */

const LINK_REL = "noopener noreferrer nofollow";

/**
 * @param {string} tag
 * @param {{ text?: string, attrs?: Record<string, string>, children?: Descriptor[] }} [parts]
 * @returns {Descriptor}
 */
function node(tag, { text, attrs, children } = {}) {
  /** @type {Descriptor} */
  const descriptor = { tag };
  if (text !== undefined) descriptor.text = text;
  if (attrs !== undefined) descriptor.attrs = attrs;
  if (children !== undefined) descriptor.children = children;
  return descriptor;
}

/** @param {string} tag @param {string} text @param {string} [className] */
const textNode = (tag, text, className) => node(tag, className === undefined ? { text } : { text, attrs: { class: className } });

/** Linha de uma lista de fatos: rótulo e valor. O valor é texto ou um nó pronto. */
/** @param {string} label @param {string | Descriptor} value @returns {Descriptor[]} */
function row(label, value) {
  const dd = typeof value === "string" ? textNode("dd", value) : node("dd", { children: [value] });
  return [textNode("dt", label), dd];
}

/** @param {string} label @param {string | null} value @returns {Descriptor[]} */
const rowOrNotInformed = (label, value) => row(label, value ?? TEXT.notInformed);

/** @param {Descriptor[]} rows */
const facts = (rows) => node("dl", { attrs: { class: C.facts }, children: rows });

/** @param {string} text @returns {Descriptor} */
function urlTextNode(text) {
  return textNode("span", text, C.mono);
}

/** @param {string | null} url @returns {Descriptor[]} */
function finalUrlRow(url) {
  if (url === null) return row("Endereço final", TEXT.notInformed);
  if (!isSafeHttpUrl(url)) return row("Endereço final", urlTextNode(url));
  const link = node("a", { text: url, attrs: { class: C.link, href: url, rel: LINK_REL, target: "_blank" } });
  return row("Endereço final", link);
}

/** @param {Report["page"]} page @returns {Descriptor} */
function pageSection(page) {
  return node("section", {
    attrs: { class: C.section },
    children: [
      textNode("h3", TEXT.page),
      facts([...rowOrNotInformed("Título", page.title), ...rowOrNotInformed("Manchete", page.headline), ...finalUrlRow(page.finalUrl)]),
    ],
  });
}

/** @param {string[]} notices @returns {Descriptor} */
function noticesSection(notices) {
  return node("section", {
    attrs: { class: C.notices },
    children: [
      textNode("h3", TEXT.notices),
      textNode("p", FIXED_NOTICE, C.fixedNotice),
      ...(notices.length > 0 ? [node("ul", { children: notices.map((notice) => textNode("li", notice)) })] : []),
    ],
  });
}

/** @param {C2pa} c2pa @returns {Descriptor[]} */
function c2paRows(c2pa) {
  /** @type {Descriptor[]} */
  const rows = [];
  if (c2pa.state !== null) {
    const label = lookup(C2PA_STATE_LABELS, c2pa.state) ?? c2pa.state;
    const reason = c2pa.reason === null ? "" : ` (motivo: ${lookup(C2PA_REASON_LABELS, c2pa.reason) ?? c2pa.reason})`;
    rows.push(...row("Estado", `${label}${reason}`));
  }
  if (c2pa.signer !== null) rows.push(...row("Signatário", c2pa.signer));
  if (c2pa.signedAt !== null) rows.push(...row("Data da assinatura", c2pa.signedAt));
  if (c2pa.generator !== null) rows.push(...row("Gerador", c2pa.generator));
  if (c2pa.aiGenerated !== null) rows.push(...row("Marcação de IA", c2pa.aiGenerated ? TEXT.aiYes : TEXT.aiNo));
  if (c2pa.checks.length > 0) {
    const ok = c2pa.checks.filter((check) => check.outcome === "success").length;
    const failed = c2pa.checks.filter((check) => check.outcome === "failure").length;
    rows.push(...row("Verificações", `${ok} com sucesso, ${failed} com falha`));
  }
  return rows;
}

/** @param {C2pa | null | undefined} c2pa @returns {Descriptor[]} */
function c2paBlock(c2pa) {
  if (c2pa === undefined) return [];
  if (c2pa === null) return [textNode("p", TEXT.noC2pa, C.muted)];
  const rows = c2paRows(c2pa);
  return [textNode("h5", "Credenciais de conteúdo (C2PA)"), rows.length > 0 ? facts(rows) : textNode("p", TEXT.c2paEmpty, C.muted)];
}

/** @param {Signals} signals @returns {Descriptor[]} */
function signalRows(signals) {
  /** @type {Descriptor[]} */
  const rows = [];
  if (signals.fileType !== null) rows.push(...row("Tipo de arquivo", signals.fileType));
  if (signals.width !== null && signals.height !== null) rows.push(...row("Dimensões (largura x altura)", `${signals.width} x ${signals.height}`));
  if (signals.sha256 !== null) rows.push(...row("SHA-256", textNode("code", signals.sha256, C.mono)));
  if (signals.camera !== null) {
    const { make, model } = signals.camera;
    const parts = [make === null ? null : `Marca: ${make}`, model === null ? null : `Modelo: ${model}`].filter((part) => part !== null);
    rows.push(...row("Câmera", parts.join("; ")));
  }
  if (signals.software.length > 0) rows.push(...row("Software", signals.software.join("; ")));
  for (const date of signals.dates) rows.push(...row(lookup(DATE_LABELS, date.tag) ?? date.tag, date.value));
  if (signals.containsLocation !== null) rows.push(...row("Localização", signals.containsLocation ? TEXT.location.yes : TEXT.location.no));
  if (signals.containsAuthorship !== null) rows.push(...row("Autoria", signals.containsAuthorship ? TEXT.authorship.yes : TEXT.authorship.no));
  return rows;
}

/** @param {MediaItem} item @returns {Descriptor[]} */
function analysisBlock(item) {
  if (item.download?.status === "error") {
    const reason = item.download.message;
    return [textNode("p", reason === null ? TEXT.downloadFailed : `${TEXT.downloadFailed} Motivo informado pelo servidor: ${reason}`)];
  }
  const metadata = item.metadata;
  if (metadata === null) return [textNode("p", TEXT.noMetadata, C.muted)];
  if (metadata.status === "ok") {
    const rows = signalRows(metadata.signals);
    return [...(rows.length > 0 ? [textNode("h5", TEXT.signalsHeading), facts(rows)] : []), ...c2paBlock(metadata.signals.c2pa)];
  }
  const own = metadata.status === "unknown" ? undefined : lookup(METADATA_TEXT, metadata.status);
  return [textNode("p", own ?? metadata.message ?? METADATA_TEXT.error)];
}

/** @param {number} count @returns {string} */
const variantsText = (count) => `+${count} ${count === 1 ? "variante" : "variantes"}`;

/** @param {import("./report-model.js").MediaGroup} group @returns {Descriptor} */
function groupBlock({ position, representative, variantCount }) {
  const ignoredReason = representative.skipReason;
  return node("section", {
    attrs: { class: C.mediaGroup },
    children: [
      textNode("h4", `Mídia ${position}`),
      facts(row(TEXT.mediaLabel, urlTextNode(representative.url))),
      ...(variantCount > 0 ? [textNode("p", variantsText(variantCount), C.muted)] : []),
      ...(ignoredReason === null
        ? analysisBlock(representative)
        : [textNode("p", `Ignorada: ${lookup(IGNORED_TEXT, ignoredReason) ?? IGNORED_TEXT.other}`, C.ignored)]),
    ],
  });
}

/** @param {Report} report @returns {Descriptor} */
function mediaSection(report) {
  const groups = groupMedia(report.media);
  const ignored = groups.filter((group) => group.representative.skipReason !== null).length;
  /** @type {Descriptor[]} */
  const children = [textNode("h3", TEXT.media)];
  if (groups.length === 0) {
    children.push(textNode("p", TEXT.noMedia, C.empty));
  } else {
    children.push(textNode("p", `${groups.length} ${groups.length === 1 ? "mídia encontrada" : "mídias encontradas"}: ${groups.length - ignored} analisada(s), ${ignored} ignorada(s).`));
    if (ignored === groups.length) children.push(textNode("p", TEXT.allIgnored, C.empty));
    if (ignored > 0) children.push(textNode("p", IGNORED_NOTE, C.note));
    children.push(...groups.map(groupBlock));
  }
  return node("section", { attrs: { class: C.section }, children });
}

/**
 * @param {Report} report
 * @returns {Descriptor}
 */
export function describeReport(report) {
  return node("section", {
    attrs: { class: C.report, "aria-labelledby": IDS.title },
    children: [
      node("h2", { text: TEXT.title, attrs: { id: IDS.title, tabindex: "-1" } }),
      noticesSection(report.notices),
      pageSection(report.page),
      mediaSection(report),
    ],
  });
}
