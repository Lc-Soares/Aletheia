// Cliente de POST /api/check. Autentica pelo fluxo de renovação da sessão (um 401 renova e repete
// UMA vez; o 401 vem antes de o servidor consumir o limite do plano, então repetir é seguro).
// Nunca devolve status HTTP cru, corpo desconhecido nem texto de cabeçalho: só as mensagens abaixo
// ou a `message` do servidor, higienizada. Não escreve em console.

import { sanitizeText } from "./sanitize.js";
import { UNAUTHORIZED } from "./session.js";

// O servidor corta em 50 s e o Firebase Hosting em 60 s (docs/api.md); o navegador desiste em 65 s.
export const CHECK_TIMEOUT_MS = 65_000;
const MAX_SERVER_MESSAGE = 200;

export const MESSAGES = {
  badRequest: "Requisição inválida. Verifique o link e tente novamente.",
  busy: "Serviço ocupado, tente novamente em instantes.",
  internal: "Não foi possível concluir a análise. Tente novamente.",
  timeout: "A análise demorou demais. Tente novamente.",
  network: "Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.",
  rateLimited: "Limite de verificações atingido. Tente novamente mais tarde.",
  generic: "Não foi possível concluir a análise. Tente novamente.",
};

/**
 * @typedef {object} CheckResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {{ get(name: string): string | null }} headers
 * @property {() => Promise<unknown>} json
 */

/**
 * @typedef {object} CheckInit
 * @property {string} method
 * @property {Record<string, string>} headers
 * @property {string} body
 * @property {AbortSignal} signal
 */

/**
 * @typedef {{ status: "ok", body: unknown } | { status: "expired" } | { status: "error", message: string }} CheckResult
 */

/** @param {unknown} body @returns {string | null} */
function serverMessage(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  return sanitizeText(/** @type {{ message?: unknown }} */ (body).message, MAX_SERVER_MESSAGE);
}

/** @param {string | null} header @returns {string} */
function rateLimitedText(header) {
  if (header === null || !/^\d{1,6}$/.test(header)) return MESSAGES.rateLimited;
  const minutes = Math.max(1, Math.ceil(Number(header) / 60));
  return `Limite de verificações atingido. Tente novamente em cerca de ${minutes} ${minutes === 1 ? "minuto" : "minutos"}.`;
}

/**
 * @param {CheckResponse} response
 * @param {() => Promise<unknown>} readBody
 * @returns {Promise<string>}
 */
async function errorMessage(response, readBody) {
  switch (response.status) {
    case 400:
    case 413:
    case 415:
      return MESSAGES.badRequest;
    case 422:
      return serverMessage(await readBody()) ?? MESSAGES.generic;
    case 429:
      return serverMessage(await readBody()) ?? rateLimitedText(response.headers.get("Retry-After"));
    case 502:
      return MESSAGES.internal;
    case 503:
      return MESSAGES.busy;
    case 504:
      return MESSAGES.timeout;
    default:
      return MESSAGES.generic;
  }
}

/**
 * @param {string} url Link digitado pelo usuário (só vai no corpo do POST).
 * @param {object} deps
 * @param {{ withToken: import("./session.js").Session["withToken"] }} deps.session
 * @param {(url: string, init: CheckInit) => Promise<CheckResponse>} deps.fetchFn
 * @param {number} [deps.timeoutMs]
 * @returns {Promise<CheckResult>}
 */
export async function postCheck(url, { session, fetchFn, timeoutMs = CHECK_TIMEOUT_MS }) {
  const payload = JSON.stringify({ url });

  /** @param {string} token */
  async function attempt(token) {
    const controller = new globalThis.AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    /** @type {() => Promise<unknown>} */
    const readBody = async () => (await response?.json().catch(() => null)) ?? null;
    /** @type {CheckResponse | undefined} */
    let response;
    try {
      response = await fetchFn("/api/check", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: payload,
        signal: controller.signal,
      });
      if (response.status === 401) return UNAUTHORIZED;
      if (response.ok) {
        const body = await readBody();
        return timedOut ? timeoutResult() : /** @type {CheckResult} */ ({ status: "ok", body });
      }
      const message = await errorMessage(response, readBody);
      return timedOut ? timeoutResult() : /** @type {CheckResult} */ ({ status: "error", message });
    } catch {
      // O erro original (rede, abort) é descartado: pode trazer a URL ou detalhes internos.
      return /** @type {CheckResult} */ ({ status: "error", message: timedOut ? MESSAGES.timeout : MESSAGES.network });
    } finally {
      clearTimeout(timer);
    }
  }

  const outcome = await session.withToken(attempt);
  return outcome.ok ? outcome.value : { status: "expired" };
}

/** @returns {CheckResult} */
function timeoutResult() {
  return { status: "error", message: MESSAGES.timeout };
}
