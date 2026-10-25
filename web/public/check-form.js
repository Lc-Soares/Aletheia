// Formulário "Verificar": valida o link (só usabilidade; o servidor valida de verdade), trava o envio
// duplo, mostra o andamento numa região aria-live, chama o /api/check, mostra o relatório ou a
// mensagem de erro e leva o foco para o título do relatório ou para a mensagem. Tudo fica na memória
// da página: nada em storage, cookie, console nem URL. Os elementos chegam por injeção.

import { MESSAGES, postCheck } from "./check-client.js";
import { parseReport } from "./report-parse.js";
import { renderReport } from "./report-view.js";

export const MAX_LINK_LENGTH = 2048;

export const FORM_TEXT = {
  empty: "Cole o link da página que você quer verificar.",
  scheme: "O link precisa começar com http:// ou https://.",
  tooLong: `O link é longo demais (máximo de ${MAX_LINK_LENGTH} caracteres).`,
  progress: "Analisando... pode levar até 1 minuto",
  expired: "Sessão expirada, entre novamente",
  unexpected: "Resposta inesperada do servidor.",
};

/**
 * Checagem só de usabilidade. O servidor valida a URL de verdade (esquema, destino, tamanho).
 * @param {unknown} raw
 * @returns {{ ok: true, url: string } | { ok: false, message: string }}
 */
export function validateLink(raw) {
  const url = typeof raw === "string" ? raw.trim() : "";
  if (url === "") return { ok: false, message: FORM_TEXT.empty };
  if (url.length > MAX_LINK_LENGTH) return { ok: false, message: FORM_TEXT.tooLong };
  if (!/^https?:\/\//iu.test(url)) return { ok: false, message: FORM_TEXT.scheme };
  return { ok: true, url };
}

/**
 * @typedef {object} FlowElements
 * @property {{ hidden: boolean | string }} panel Seção inteira (aparece depois do login).
 * @property {{ hidden: boolean | string }} form
 * @property {{ value: string, focus(): void }} input
 * @property {{ disabled: boolean }} button
 * @property {{ textContent: string | null }} progress Região aria-live.
 * @property {{ textContent: string | null, hidden: boolean | string, focus(): void }} error
 * @property {import("./report-view.js").Container} report
 * @property {{ hidden: boolean | string }} download Botão "Baixar JSON": só aparece com um relatório na tela.
 */

/**
 * @param {object} deps
 * @param {FlowElements} deps.elements
 * @param {{ withToken: import("./session.js").Session["withToken"] }} deps.session
 * @param {(url: string, init: import("./check-client.js").CheckInit) => Promise<import("./check-client.js").CheckResponse>} deps.fetchFn
 * @param {import("./report-mount.js").MountDocument} deps.doc
 * @param {{ showLogin(): void }} deps.ui Reexibe o botão de login (sessão expirada).
 */
export function createCheckFlow({ elements, session, fetchFn, doc, ui }) {
  let busy = false;
  /** @type {{ report: import("./report-parse.js").Report, url: string } | null} */
  let current = null;

  function clearReport() {
    elements.report.replaceChildren();
    elements.download.hidden = true;
    current = null;
  }

  /** @param {string} message */
  function showError(message) {
    elements.error.textContent = message;
    elements.error.hidden = false;
    elements.error.focus();
  }

  function clearError() {
    elements.error.textContent = "";
    elements.error.hidden = true;
  }

  /**
   * @param {unknown} body
   * @param {string} url
   */
  function showReport(body, url) {
    const report = parseReport(body);
    if (report === null) {
      showError(FORM_TEXT.unexpected);
      return;
    }
    const rendered = renderReport(elements.report, report, doc);
    if (rendered.ok) {
      current = { report, url };
      elements.download.hidden = false;
    }
    rendered.focusTarget.focus();
  }

  /** @param {string} url */
  async function run(url) {
    const result = await postCheck(url, { session, fetchFn });
    if (result.status === "ok") showReport(result.body, url);
    else if (result.status === "error") showError(result.message);
    else {
      elements.form.hidden = true;
      ui.showLogin();
      showError(FORM_TEXT.expired);
    }
  }

  async function submit() {
    if (busy) return;
    const checked = validateLink(elements.input.value);
    if (!checked.ok) {
      showError(checked.message);
      return;
    }
    busy = true;
    elements.button.disabled = true;
    clearError();
    clearReport();
    elements.progress.textContent = FORM_TEXT.progress;
    try {
      await run(checked.url);
    } catch {
      // Nada do erro original é mostrado: pode trazer a URL ou dados da página.
      showError(MESSAGES.generic);
    } finally {
      busy = false;
      elements.button.disabled = false;
      elements.progress.textContent = "";
    }
  }

  return {
    submit,
    /** Painel visível (depois do login ou de uma sessão confirmada). */
    show() {
      elements.panel.hidden = false;
      elements.form.hidden = false;
    },
    hide() {
      elements.panel.hidden = true;
    },
    /** Novo login com token novo: limpa a mensagem, mostra o formulário e descarta o relatório antigo. */
    reset() {
      clearError();
      clearReport();
      elements.form.hidden = false;
    },
    /** O relatório mostrado agora e o link analisado, ou null. */
    getReport() {
      return current;
    },
  };
}
