// Todo texto que vem da API entra na página por textContent, nunca como HTML.

import { formatExpiry } from "./token-info.js";

/** @type {Record<import("./session.js").CheckResult, string>} */
const CHECK_TEXT = {
  active: "Sessão ativa",
  renewed: "Token renovado",
  expired: "Sessão expirada, entre novamente",
  error: "Não foi possível verificar a sessão",
};

/**
 * Painel do botão "Verificar sessão".
 * @param {{
 *   panel: { hidden: boolean | string },
 *   button: { disabled: boolean },
 *   status: { textContent: string | null },
 *   expiry: { textContent: string | null },
 * }} elements
 * @returns {import("./session.js").CheckUi}
 */
export function createSessionCheckUi({ panel, button, status, expiry }) {
  return {
    show() {
      panel.hidden = false;
    },
    setBusy(busy) {
      button.disabled = busy;
    },
    showResult(kind) {
      status.textContent = CHECK_TEXT[kind];
    },
    clearResult() {
      status.textContent = "";
    },
    showExpiry(date) {
      expiry.textContent = date === null ? "" : `Token expira às ${formatExpiry(date)}`;
    },
  };
}

/**
 * @param {{ status: { textContent: string | null }, signin: { hidden: boolean | string } }} elements
 */
export function createUi({ status, signin }) {
  return {
    /** @param {string} email */
    showEmail(email) {
      status.textContent = `Conectado como ${email}`;
      signin.hidden = true;
    },
    showExpired() {
      status.textContent = "Sua sessão expirou. Entre novamente com o Google.";
      signin.hidden = false;
    },
    showError() {
      status.textContent = "Não foi possível concluir a verificação. Tente novamente.";
    },
  };
}
