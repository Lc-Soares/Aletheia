// Horário de expiração do ID token, só para mostrar na tela. O payload é lido SEM verificar a
// assinatura: não é decisão de segurança (quem verifica o token é o servidor, em toda chamada).

const MAX_TOKEN_LENGTH = 8 * 1024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** @param {string} part @returns {unknown} */
function decodePart(part) {
  if (!BASE64URL.test(part)) return null;
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return JSON.parse(globalThis.atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "=")));
  } catch {
    return null;
  }
}

/**
 * Lê só o campo exp. Qualquer coisa fora do formato devolve null, sem exceção.
 * @param {string} token
 * @returns {Date | null}
 */
export function expiryOf(token) {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const payload = decodePart(parts[1] ?? "");
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
  const exp = /** @type {{ exp?: unknown }} */ (payload).exp;
  if (typeof exp !== "number" || !Number.isFinite(exp) || exp <= 0) return null;
  return new Date(exp * 1000);
}

/** @param {Date} date */
export function formatExpiry(date) {
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}
