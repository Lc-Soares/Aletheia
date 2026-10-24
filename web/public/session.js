// Sessão em memória: o ID token vive só nesta variável (nunca em storage ou cookie).

import { expiryOf, formatExpiry } from "./token-info.js";

// Prazo próprio da renovação. O renewToken de app.js já desiste em 15 s, mas a trava do botão não
// pode depender disso: se o Google nunca chamar o callback, a verificação termina como expirada.
const RENEW_DEADLINE_MS = 15_000;

/**
 * @typedef {object} Ui
 * @property {(email: string) => void} showEmail
 * @property {() => void} showExpired
 * @property {() => void} showError
 */

/** @typedef {ReturnType<typeof createSession>} Session */

/** @typedef {"active" | "renewed" | "expired" | "error"} CheckResult */
/** @typedef {CheckResult | "none"} LoadResult */

/**
 * @typedef {object} CheckUi
 * @property {() => void} show
 * @property {(busy: boolean) => void} setBusy
 * @property {(kind: CheckResult) => void} showResult
 * @property {(date: Date | null) => void} showExpiry
 * @property {() => void} clearResult
 */

/** @type {CheckUi} */
const NO_CHECK_UI = { show() {}, setBusy() {}, showResult() {}, showExpiry() {}, clearResult() {} };

/** Resultado de uma tentativa que levou 401: pede renovação do token. */
export const UNAUTHORIZED = Symbol("unauthorized");

/**
 * Resolve com null se a promessa não responder dentro do prazo (ou rejeitar).
 * @param {Promise<string | null>} promise
 * @param {number} ms
 * @returns {Promise<string | null>}
 */
function withDeadline(promise, ms) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return /** @type {Promise<string | null>} */ (
    Promise.race([promise.catch(() => null), deadline]).finally(() => clearTimeout(timer))
  );
}

/**
 * @param {object} deps
 * @param {(url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>} deps.fetchFn
 * @param {() => Promise<string | null>} deps.renewToken
 * @param {Ui} deps.ui
 * @param {CheckUi} [deps.checkUi]
 * @param {(message: string) => void} [deps.log] Só eventos de renovação; nunca token, e-mail ou payload.
 */
export function createSession({ fetchFn, renewToken, ui, checkUi = NO_CHECK_UI, log = (message) => console.info(message) }) {
  /** @type {string | null} */
  let token = null;
  let verifying = false;

  /** @param {string | null} value */
  function storeToken(value) {
    token = value;
    checkUi.showExpiry(value === null ? null : expiryOf(value));
  }

  // Token novo vindo do login: o resultado antigo do painel ("Sessão expirada...") deixa de valer.
  // A renovação interna usa storeToken e não passa por aqui.
  /** @param {string | null} value */
  function setToken(value) {
    storeToken(value);
    if (value !== null) checkUi.clearResult();
  }

  /** @returns {Promise<string | null>} */
  async function doRenew() {
    log("[sessão] renovação iniciada");
    const renewed = await withDeadline(renewToken(), RENEW_DEADLINE_MS);
    if (renewed === null) {
      log("[sessão] renovação falhou");
      return null;
    }
    const expiry = expiryOf(renewed);
    log(expiry === null ? "[sessão] renovação concluída" : `[sessão] renovação concluída; o novo token expira às ${formatExpiry(expiry)}`);
    return renewed;
  }

  // Renovação de voo único: o app só tem um espaço para o callback do Google (pendingRenewal em
  // app.js). Duas chamadas que levam 401 ao mesmo tempo esperam a mesma renovação.
  /** @type {Promise<string | null> | null} */
  let renewing = null;
  /** @returns {Promise<string | null>} */
  function renew() {
    renewing ??= doRenew().finally(() => {
      renewing = null;
    });
    return renewing;
  }

  /**
   * Chamada autenticada com o fluxo único de renovação: tenta com o token em memória; se a tentativa
   * devolver UNAUTHORIZED, renova e repete UMA vez. Exceções da tentativa (rede) passam adiante.
   * @template T
   * @param {(token: string) => Promise<T | typeof UNAUTHORIZED>} attempt
   * @returns {Promise<{ ok: true, value: T, renewed: boolean } | { ok: false }>}
   */
  async function withToken(attempt) {
    if (token === null) return { ok: false };
    const first = await attempt(token);
    if (first !== UNAUTHORIZED) return { ok: true, value: first, renewed: false };
    storeToken(null);
    const renewed = await renew();
    if (renewed === null) return { ok: false };
    storeToken(renewed);
    const second = await attempt(renewed);
    if (second === UNAUTHORIZED) {
      storeToken(null);
      return { ok: false };
    }
    return { ok: true, value: second, renewed: true };
  }

  /**
   * @param {string} current
   * @returns {Promise<"active" | "error" | typeof UNAUTHORIZED>}
   */
  async function requestMe(current) {
    let response;
    try {
      response = await fetchFn("/api/me", { headers: { Authorization: `Bearer ${current}` } });
    } catch {
      ui.showError();
      return "error";
    }
    if (response.status === 401) return UNAUTHORIZED;
    if (!response.ok) {
      ui.showError();
      return "error";
    }
    const body = /** @type {{ email?: unknown } | null} */ (await response.json().catch(() => null));
    if (typeof body?.email !== "string") {
      ui.showError();
      return "error";
    }
    ui.showEmail(body.email);
    return "active";
  }

  /** @returns {Promise<LoadResult>} */
  async function loadMe() {
    if (token === null) return "none";
    const outcome = await withToken(requestMe);
    if (!outcome.ok) {
      ui.showExpired();
      return "expired";
    }
    return outcome.value === "active" && outcome.renewed ? "renewed" : outcome.value;
  }

  // Botão "Verificar sessão": repete /api/me pelo mesmo fluxo (no máximo uma renovação).
  // Cliques durante uma verificação em andamento são ignorados.
  async function verify() {
    if (verifying) return;
    verifying = true;
    checkUi.setBusy(true);
    try {
      const result = await loadMe();
      checkUi.showResult(result === "none" ? "expired" : result);
    } finally {
      verifying = false;
      checkUi.setBusy(false);
    }
  }

  return { setToken, loadMe, verify, withToken };
}
