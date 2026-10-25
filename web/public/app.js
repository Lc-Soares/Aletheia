import { createCheckFlow } from "./check-form.js";
import { GOOGLE_CLIENT_ID } from "./config.js";
import { createSessionCheckUi, createUi } from "./render.js";
import { saveReportJson } from "./report-json.js";
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
// O painel "Verificar sessão" e o formulário do link aparecem depois do primeiro login bem-sucedido.
const ui = {
  ...baseUi,
  /** @param {string} email */
  showEmail(email) {
    baseUi.showEmail(email);
    checkUi.show();
    flow.show();
  },
  showExpired() {
    baseUi.showExpired();
    flow.hide();
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

const checkForm = byId("check-form");
const flow = createCheckFlow({
  elements: {
    panel: byId("check-panel"),
    form: checkForm,
    input: /** @type {HTMLInputElement} */ (byId("check-url")),
    button: /** @type {HTMLButtonElement} */ (byId("check-submit")),
    progress: byId("check-progress"),
    error: byId("check-error"),
    report: byId("report"),
    download: byId("download-json"),
  },
  session,
  fetchFn: (url, init) => fetch(url, init),
  doc: document,
  ui: baseUi,
});

verifyButton.addEventListener("click", () => void session.verify());
checkForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void flow.submit();
});
// "Baixar JSON": gerado aqui, no navegador, a partir do relatório que está na tela.
byId("download-json").addEventListener("click", () => {
  const current = flow.getReport();
  if (current === null) return;
  saveReportJson(current, { doc: document, urlApi: URL, now: () => new Date(), schedule: (fn, ms) => setTimeout(fn, ms) });
});

/** @param {{ credential: string }} response */
function onCredential(response) {
  if (pendingRenewal) {
    pendingRenewal(response.credential);
    return;
  }
  // Login com token novo (não é renovação): limpa mensagens e relatório do usuário anterior.
  session.setToken(response.credential);
  flow.reset();
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
