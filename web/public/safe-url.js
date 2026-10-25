// Decide se um texto pode virar link: só http(s) absoluto, sem espaços e sem usuário e senha.
// Usado pelo describe (antes de criar o link) e pelo mount (que recusa o que não passar aqui).

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isSafeHttpUrl(value) {
  if (typeof value !== "string" || value === "" || /\s/u.test(value)) return false;
  if (!/^https?:\/\//iu.test(value)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && url.hostname !== "";
  } catch {
    return false;
  }
}
