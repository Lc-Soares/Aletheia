// Coloca o relatório na página. Quem chama o mount tem try/catch: se o describe ou o mount lançarem,
// a tela mostra um texto fixo, sem dado da página e sem usar o console

import { C, IDS } from "./report-classes.js";
import { describeReport } from "./report-describe.js";
import { mount } from "./report-mount.js";

export const RENDER_ERROR_TEXT = "Não foi possível exibir o relatório.";

/** @typedef {import("./report-mount.js").MountElement} MountElement */
// unknown[]: o HTMLElement real recebe Node, o falso dos testes recebe o que o mount criou.
/** @typedef {{ replaceChildren(...nodes: unknown[]): void }} Container */

/**
 * Troca o conteúdo do contêiner pelo relatório e devolve o elemento que deve receber o foco:
 * o título do relatório, ou a mensagem de erro.
 * @param {Container} container
 * @param {import("./report-parse.js").Report} report
 * @param {import("./report-mount.js").MountDocument} doc
 * @param {{ describe?: (report: import("./report-parse.js").Report) => import("./report-describe.js").Descriptor }} [options]
 * @returns {{ ok: boolean, focusTarget: MountElement }}
 */
export function renderReport(container, report, doc, { describe = describeReport } = {}) {
  try {
    const { root, ids } = mount(describe(report), doc);
    container.replaceChildren(root);
    return { ok: true, focusTarget: ids.get(IDS.title) ?? root };
  } catch {
    // O erro original é descartado de propósito: pode carregar texto da página.
    const { root } = mount({ tag: "p", text: RENDER_ERROR_TEXT, attrs: { class: C.error, id: IDS.error, tabindex: "-1" } }, doc);
    container.replaceChildren(root);
    return { ok: false, focusTarget: root };
  }
}
