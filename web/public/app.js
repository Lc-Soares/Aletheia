import { GOOGLE_CLIENT_ID } from "./config.js";
import { createSessionCheckUi, createUi } from "./render.js";
import { createSession } from "./session.js";

const RENEW_TIMEOUT_MS = 15_000;

/** @param {string} id */
const byId = (id) => /** @type {HTMLElement} */ (document.getElementById(id));

const signin = byId("signin");
const verifyButton = /** @type {HTMLButtonElement} */ (byId("verify-session"));
const checkUi = createSessionCheckUi({
  panel: byId("session-check"),
  button: verifyButton,
  status: byId("session-status"),
  expiry: byId("session-expiry"),
});
const baseUi = createUi({ status: byId("status"), signin });
// O painel "Verificar sessão" aparece depois do primeiro login bem-sucedido.
const ui = {
  ...baseUi,
  /** @param {string} email */
  showEmail(email) {
    baseUi.showEmail(email);
    checkUi.show();
  },
};

/** @type {((token: string | null) => void) | null} */
let pendingRenewal = null;

// O GIS não tem uma chamada de "renovar": a documentação diz que o ID token dura 1 hora e que a sessão
// é responsabilidade do app. O que ela oferece é google.accounts.id.prompt(), que devolve um novo
// credential pelo mesmo callback (sem interação se o usuário já deu consentimento).
/** @returns {Promise<string | null>} */
function renewToken() {
  return new Promise((resolve) => {
    /** @param {string | null} token */
    function settle(token) {
      clearTimeout(timer);
      pendingRenewal = null;
      resolve(token);
    }
    const timer = setTimeout(() => settle(null), RENEW_TIMEOUT_MS);
    pendingRenewal = settle;
    google.accounts.id.prompt((notification) => {
      if (notification.isNotDisplayed() || notification.isSkippedMoment() || notification.isDismissedMoment()) {
        settle(null);
      }
    });
  });
}

const session = createSession({
  fetchFn: (url, init) => fetch(url, init),
  renewToken,
  ui,
  checkUi,
});

verifyButton.addEventListener("click", () => void session.verify());

/** @param {{ credential: string }} response */
function onCredential(response) {
  if (pendingRenewal) {
    pendingRenewal(response.credential);
    return;
  }
  session.setToken(response.credential);
  void session.loadMe();
}

function start() {
  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: onCredential,
    auto_select: true,
  });
  google.accounts.id.renderButton(signin, {
    type: "standard",
    theme: "outline",
    size: "large",
    text: "signin_with",
    locale: "pt-BR",
  });
}

if (window.google?.accounts?.id) start();
else window.onGoogleLibraryLoad = start;
