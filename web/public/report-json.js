// "Baixar JSON": o relatório que está na tela, gerado no navegador (Blob). Nada vai para o servidor,
// nada fica guardado. Só entra o que a tela já mostra (o report-parse.js já descartou o resto);
// localização e autoria saem só como booleano, nunca com valores. O nome do arquivo não leva o domínio.

import { groupMedia } from "./report-model.js";
import { FIXED_NOTICE, IGNORED_TEXT, lookup } from "./report-text.js";
import { sanitizeText } from "./sanitize.js";

export const SCHEMA_VERSION = 1;
const REVOKE_DELAY_MS = 1_000;

/** @typedef {import("./report-parse.js").Report} Report */
/** @typedef {import("./report-parse.js").Signals} Signals */
/** @typedef {import("./report-parse.js").C2pa} C2pa */

/** @param {C2pa} c2pa */
function c2paJson(c2pa) {
  const success = c2pa.checks.filter((check) => check.outcome === "success").length;
  const failure = c2pa.checks.filter((check) => check.outcome === "failure").length;
  return {
    state: c2pa.state,
    reason: c2pa.reason,
    signer: c2pa.signer,
    signedAt: c2pa.signedAt,
    generator: c2pa.generator,
    aiGenerated: c2pa.aiGenerated,
    ...(c2pa.checks.length > 0 ? { checks: { success, failure } } : {}),
  };
}

/** @param {Signals} signals */
function signalsJson(signals) {
  return {
    fileType: signals.fileType,
    width: signals.width,
    height: signals.height,
    sha256: signals.sha256,
    dates: signals.dates,
    camera: signals.camera,
    software: signals.software,
    containsLocation: signals.containsLocation,
    containsAuthorship: signals.containsAuthorship,
    ...(signals.c2pa === undefined ? {} : { c2pa: signals.c2pa === null ? null : c2paJson(signals.c2pa) }),
  };
}

/** @param {import("./report-parse.js").Metadata | null} metadata */
function metadataJson(metadata) {
  if (metadata === null) return null;
  if (metadata.status === "ok") return { status: "ok", signals: signalsJson(metadata.signals) };
  return { status: metadata.status, message: metadata.message };
}

/**
 * @param {object} input
 * @param {Report} input.report
 * @param {string} input.analyzedUrl
 * @param {Date} input.now
 */
export function buildReportJson({ report, analyzedUrl, now }) {
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    analyzedUrl: sanitizeText(analyzedUrl, 2048),
    notices: [FIXED_NOTICE, ...report.notices],
    page: { ...report.page },
    mediaGroups: groupMedia(report.media).map(({ position, representative, variantCount }) => {
      const reason = representative.skipReason;
      return {
        position,
        url: representative.url,
        variantCount,
        ignored: reason === null ? null : { code: reason, text: lookup(IGNORED_TEXT, reason) ?? IGNORED_TEXT.other },
        download: reason === null ? representative.download : null,
        metadata: reason === null ? metadataJson(representative.metadata) : null,
      };
    }),
  };
}

/**
 * aletheia-relatorio-AAAAMMDD-HHMMSS.json (UTC). Sem domínio nem nada da URL analisada.
 * @param {Date} now
 */
export function reportFileName(now) {
  const stamp = now.toISOString().replace(/[-:]/gu, "");
  return `aletheia-relatorio-${stamp.slice(0, 8)}-${stamp.slice(9, 15)}.json`;
}

/**
 * @typedef {object} SaveDeps
 * @property {{ createElement(tag: string): { setAttribute(name: string, value: string): void, click(): void, remove(): void }, body: { appendChild(node: unknown): unknown } }} doc
 * @property {{ createObjectURL(blob: Blob): string, revokeObjectURL(url: string): void }} urlApi
 * @property {() => Date} now
 * @property {(fn: () => void, ms: number) => unknown} schedule
 */

/**
 * Baixa o relatório como arquivo JSON. O URL do Blob é revogado logo depois do clique (com um
 * pequeno atraso, para o download começar), mesmo se o clique lançar.
 * @param {{ report: Report, url: string }} current
 * @param {SaveDeps} deps
 */
export function saveReportJson(current, { doc, urlApi, now, schedule }) {
  const moment = now();
  const text = JSON.stringify(buildReportJson({ report: current.report, analyzedUrl: current.url, now: moment }), null, 2);
  const blobUrl = urlApi.createObjectURL(new globalThis.Blob([text], { type: "application/json;charset=utf-8" }));
  schedule(() => urlApi.revokeObjectURL(blobUrl), REVOKE_DELAY_MS);
  const anchor = doc.createElement("a");
  anchor.setAttribute("href", blobUrl);
  anchor.setAttribute("download", reportFileName(moment));
  doc.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
  }
}
