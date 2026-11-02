// Resumo dos sinais das mídias analisadas. Só conta o que o servidor já informou; não dá veredito.
// Cada linha é texto puro: quem monta os elementos é o report-describe.js / report-mount.js.

import { groupMedia } from "./report-model.js";

/** @param {number} count @param {string} one @param {string} many */
const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

/**
 * @param {import("./report-parse.js").Report} report
 * @returns {string[]} Linhas do resumo; vazio quando nenhuma mídia foi analisada.
 */
export function summarizeSignals(report) {
  let analyzed = 0;
  let withC2pa = 0;
  let declaredAi = 0;
  let withSoftware = 0;
  let withoutOrigin = 0;

  for (const { representative: item } of groupMedia(report.media)) {
    const meta = item.metadata;
    if (item.skipReason !== null || meta === null || meta.status !== "ok") continue;
    analyzed += 1;
    const s = meta.signals;
    if (s.c2pa !== null && s.c2pa !== undefined) {
      withC2pa += 1;
      if (s.c2pa.aiGenerated === true) declaredAi += 1;
    }
    if (s.software.length > 0) withSoftware += 1;
    // c2pa === null: o servidor confirmou que não há assinatura (undefined = ilegível, não conta).
    if (s.c2pa === null && s.camera === null && s.dates.length === 0 && s.software.length === 0) withoutOrigin += 1;
  }

  if (analyzed === 0) return [];

  /** @type {string[]} */
  const lines = [];
  if (withC2pa > 0) lines.push(`${plural(withC2pa, "mídia tem", "mídias têm")} assinatura C2PA.`);
  if (declaredAi > 0) lines.push(`${plural(declaredAi, "mídia declara", "mídias declaram")} geração por IA na marcação C2PA.`);
  if (withSoftware > 0) {
    lines.push(
      `${plural(withSoftware, "mídia cita", "mídias citam")} software nos metadados (pode ser edição ou só o programa que salvou o arquivo).`,
    );
  }
  if (withoutOrigin > 0) {
    lines.push(`${plural(withoutOrigin, "mídia não tem", "mídias não têm")} assinatura C2PA, câmera nem datas.`);
  }
  if (lines.length === 0) lines.push("As mídias analisadas não têm os sinais resumidos aqui. Veja os detalhes de cada mídia abaixo.");
  return lines;
}