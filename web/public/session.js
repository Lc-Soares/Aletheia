// Sessão em memória: o ID token vive só nesta variável (nunca em storage ou cookie).

/**
 * @typedef {object} Ui
 * @property {(email: string) => void} showEmail
 * @property {() => void} showExpired
 * @property {() => void} showError
 */

/**
 * @param {object} deps
 * @param {(url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean, status: number, json(): Promise<unknown> }>} deps.fetchFn
 * @param {() => Promise<string | null>} deps.renewToken
 * @param {Ui} deps.ui
 */
export function createSession({ fetchFn, renewToken, ui }) {
  /** @type {string | null} */
  let token = null;

  /** @param {string | null} value */
  function setToken(value) {
    token = value;
  }

  /** @param {boolean} canRenew */
  async function loadMe(canRenew = true) {
    if (token === null) return;
    let response;
    try {
      response = await fetchFn("/api/me", { headers: { Authorization: `Bearer ${token}` } });
    } catch {
      ui.showError();
      return;
    }
    if (response.status === 401) {
      token = null;
      const renewed = canRenew ? await renewToken() : null;
      if (renewed === null) {
        ui.showExpired();
        return;
      }
      token = renewed;
      await loadMe(false);
      return;
    }
    if (!response.ok) {
      ui.showError();
      return;
    }
    const body = /** @type {{ email?: unknown } | null} */ (await response.json().catch(() => null));
    if (typeof body?.email !== "string") {
      ui.showError();
      return;
    }
    ui.showEmail(body.email);
  }

  return { setToken, loadMe };
}
