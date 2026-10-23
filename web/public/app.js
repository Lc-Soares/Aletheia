import { GOOGLE_CLIENT_ID } from "./config.js";
import { createUi } from "./render.js";
import { createSession } from "./session.js";

const RENEW_TIMEOUT_MS = 15_000;

const signin = /** @type {HTMLElement} */ (document.getElementById("signin"));
const ui = createUi({
  status: /** @type {HTMLElement} */ (document.getElementById("status")),
  signin,
});

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
});

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
