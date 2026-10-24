import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FORM_TEXT, MAX_LINK_LENGTH, createCheckFlow, validateLink } from "../public/check-form.js";
import { MESSAGES } from "../public/check-client.js";
import { createSessionCheckUi } from "../public/render.js";
import { RENDER_ERROR_TEXT } from "../public/report-view.js";
import { createSession } from "../public/session.js";
import { createFakeDocument, createFakeElement, snapshot } from "./fake-dom.js";
import { apiExample } from "./fixtures/report-fixtures.js";

const TOKEN_1 = "tok-1";
const TOKEN_2 = "tok-2";
const LINK = "https://exemplo.com.br/materia";
const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

/** @param {number} code @param {unknown} [body] @param {Record<string, string>} [headers] */
function response(code, body, headers = {}) {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: { get: (/** @type {string} */ name) => headers[name] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError("corpo não é JSON");
      return body;
    },
  };
}

/** @returns {{ promise: Promise<ReturnType<typeof response>>, resolve: (r: ReturnType<typeof response>) => void }} */
function deferred() {
  /** @type {(r: ReturnType<typeof response>) => void} */
  let resolve = () => {};
  const promise = new Promise((res) => (resolve = res));
  return { promise, resolve };
}

/**
 * @param {{ fetchFn?: (url: string, init: { headers: Record<string, string>, body: string, signal: AbortSignal }) => Promise<ReturnType<typeof response>>, renewToken?: () => Promise<string | null>, token?: string | null, session?: unknown }} [options]
 */
function setup({ fetchFn, renewToken = async () => null, token = TOKEN_1, session: custom } = {}) {
  const events = /** @type {string[]} */ ([]);
  const input = { value: LINK, focused: 0, focus() { this.focused++; } };
  const error = { textContent: "", hidden: true, focused: 0, focus() { this.focused++; } };
  const elements = {
    panel: { hidden: true },
    form: { hidden: false },
    input,
    button: { disabled: false },
    progress: { textContent: "" },
    error,
    report: createFakeElement("div"),
    download: { hidden: true },
  };
  const sessionElements = { panel: { hidden: true }, button: { disabled: false }, status: { textContent: "" }, expiry: { textContent: "" } };
  const session =
    custom ??
    createSession({
      fetchFn: async () => response(200, { email: "a@b.c" }),
      renewToken: async () => {
        events.push("renew");
        return renewToken();
      },
      ui: { showEmail() {}, showExpired() {}, showError() {} },
      checkUi: createSessionCheckUi(sessionElements),
      log: () => {},
    });
  if (token !== null && "setToken" in /** @type {object} */ (session)) /** @type {{ setToken(t: string): void }} */ (session).setToken(token);
  const { doc } = createFakeDocument();
  const calls = /** @type {Array<{ url: string, auth: string | undefined, body: string }>} */ ([]);
  const flow = createCheckFlow({
    elements: /** @type {never} */ (elements),
    session: /** @type {never} */ (session),
    fetchFn: async (url, init) => {
      calls.push({ url, auth: init.headers["Authorization"], body: init.body });
      return fetchFn ? fetchFn(url, init) : response(200, apiExample());
    },
    doc: /** @type {never} */ (doc),
    ui: { showLogin: () => events.push("login") },
  });
  return { flow, elements, calls, events, session, sessionElements, error, input };
}

const headingOf = (/** @type {ReturnType<typeof snapshot>} */ shot) => {
  /** @type {ReturnType<typeof snapshot>[]} */
  const stack = [shot];
  while (stack.length > 0) {
    const current = /** @type {ReturnType<typeof snapshot>} */ (stack.shift());
    if (current.tag === "h2") return current;
    stack.push(...current.children);
  }
  return undefined;
};

describe("validateLink", () => {
  test("aceita http e https, com trim e sem diferenciar maiúsculas", () => {
    for (const raw of [LINK, `  ${LINK}\n`, "http://exemplo.com", "HTTPS://EXEMPLO.COM/x", "HtTp://a"]) {
      const result = validateLink(raw);
      assert.deepEqual(result, { ok: true, url: raw.trim() }, raw);
    }
  });

  test("vazio ou só espaços", () => {
    for (const raw of ["", "   ", "\n\t"]) assert.deepEqual(validateLink(raw), { ok: false, message: FORM_TEXT.empty });
  });

  test("não começa com http:// ou https://", () => {
    for (const raw of ["exemplo.com", "ftp://exemplo.com", "javascript:alert(1)", "//exemplo.com", "https:/exemplo.com", "ahttps://exemplo.com", "data:text/html,x", "file:///etc/passwd"]) {
      assert.deepEqual(validateLink(raw), { ok: false, message: FORM_TEXT.scheme }, raw);
    }
  });

  test("limite de 2048 caracteres depois do trim", () => {
    const base = "https://exemplo.com/";
    const at = base + "a".repeat(MAX_LINK_LENGTH - base.length);
    assert.equal(at.length, 2048);
    assert.deepEqual(validateLink(at), { ok: true, url: at });
    assert.deepEqual(validateLink(`${at}a`), { ok: false, message: FORM_TEXT.tooLong });
    assert.deepEqual(validateLink(`   ${at}   `), { ok: true, url: at });
  });

  test("não é texto", () => {
    for (const raw of [undefined, null, 5, {}]) assert.equal(validateLink(raw).ok, false);
  });

  test("mensagens combinadas", () => {
    assert.equal(FORM_TEXT.progress, "Analisando... pode levar até 1 minuto");
    assert.equal(FORM_TEXT.expired, "Sessão expirada, entre novamente");
    assert.equal(FORM_TEXT.unexpected, "Resposta inesperada do servidor.");
  });
});

describe("fluxo: envio e travas", () => {
  test("link inválido: não chama a API, mostra o erro, foca nele e deixa o botão livre", async () => {
    const { flow, elements, calls, error } = setup();
    elements.input.value = "exemplo.com";
    await flow.submit();
    assert.equal(calls.length, 0);
    assert.equal(elements.error.textContent, FORM_TEXT.scheme);
    assert.equal(elements.error.hidden, false);
    assert.equal(error.focused, 1);
    assert.equal(elements.button.disabled, false);
  });

  test("envia o link com trim, só no corpo, com o token em memória", async () => {
    const { flow, elements, calls } = setup();
    elements.input.value = `  ${LINK}  `;
    await flow.submit();
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.url, "/api/check");
    assert.equal(calls[0]?.body, JSON.stringify({ url: LINK }));
    assert.equal(calls[0]?.auth, `Bearer ${TOKEN_1}`);
  });

  test("durante a checagem: botão desabilitado e 'Analisando...' na região viva; ao fim, tudo volta", async () => {
    const pending = deferred();
    const { flow, elements } = setup({ fetchFn: () => pending.promise });
    const running = flow.submit();
    await flush();
    assert.equal(elements.button.disabled, true);
    assert.equal(elements.progress.textContent, "Analisando... pode levar até 1 minuto");
    assert.equal(elements.error.hidden, true);
    pending.resolve(response(200, apiExample()));
    await running;
    assert.equal(elements.button.disabled, false);
    assert.equal(elements.progress.textContent, "");
  });

  test("segundo envio durante a checagem é ignorado (sem envio duplo)", async () => {
    const pending = deferred();
    const { flow, calls } = setup({ fetchFn: () => pending.promise });
    const first = flow.submit();
    await flush();
    await flow.submit();
    await flow.submit();
    assert.equal(calls.length, 1);
    pending.resolve(response(200, apiExample()));
    await first;
    await flow.submit();
    assert.equal(calls.length, 2, "depois de terminar, um novo envio vale");
  });

  test("o botão volta a habilitar mesmo se algo lançar por dentro", async () => {
    const session = { withToken: async () => { throw new Error("falha inesperada com dados"); } };
    const { flow, elements } = setup({ session, token: null });
    await flow.submit();
    assert.equal(elements.button.disabled, false);
    assert.equal(elements.progress.textContent, "");
    assert.equal(elements.error.textContent, MESSAGES.generic);
    assert.equal(JSON.stringify(elements.error).includes("dados"), false);
  });

  test("começar uma nova checagem limpa o relatório e o erro anteriores", async () => {
    const pending = deferred();
    let calls = 0;
    const { flow, elements } = setup({ fetchFn: () => (++calls === 1 ? Promise.resolve(response(200, apiExample())) : pending.promise) });
    await flow.submit();
    assert.equal(snapshot(elements.report).children.length, 1);
    elements.error.textContent = "erro antigo";
    elements.error.hidden = false;
    const second = flow.submit();
    await flush();
    assert.equal(snapshot(elements.report).children.length, 0);
    assert.equal(flow.getReport(), null);
    assert.equal(elements.error.hidden, true);
    assert.equal(elements.error.textContent, "");
    pending.resolve(response(200, apiExample()));
    await second;
  });
});

describe("fluxo: resultado e foco", () => {
  test("sucesso: relatório na página e foco no título do relatório", async () => {
    const { flow, elements, error } = setup();
    await flow.submit();
    const shot = snapshot(elements.report);
    assert.equal(shot.children[0]?.tag, "section");
    const heading = headingOf(shot);
    assert.equal(heading?.text, "Relatório de sinais");
    assert.equal(heading?.focused, 1);
    assert.equal(error.focused, 0);
    assert.equal(flow.getReport()?.url, LINK);
  });

  test("a nova checagem substitui o relatório (não acumula)", async () => {
    const { flow, elements } = setup();
    await flow.submit();
    await flow.submit();
    assert.equal(snapshot(elements.report).children.length, 1);
  });

  /** @type {Array<[string, ReturnType<typeof response>, string]>} */
  const errors = [
    ["400", response(400, { message: "x" }), MESSAGES.badRequest],
    ["422", response(422, { message: "O site respondeu com erro (HTTP 403)." }), "O site respondeu com erro (HTTP 403)."],
    ["429", response(429, { message: "Você atingiu o limite de 10 verificações por hora. Tente novamente em 12 minutos." }), "Você atingiu o limite de 10 verificações por hora. Tente novamente em 12 minutos."],
    ["503", response(503, {}), MESSAGES.busy],
    ["504", response(504, {}), MESSAGES.timeout],
    ["502", response(502, "<html>"), MESSAGES.internal],
  ];
  for (const [name, reply, expected] of errors) {
    test(`erro ${name}: mensagem como texto, foco na mensagem, nenhum relatório`, async () => {
      const { flow, elements, error } = setup({ fetchFn: async () => reply });
      await flow.submit();
      assert.equal(elements.error.textContent, expected);
      assert.equal(elements.error.hidden, false);
      assert.equal(error.focused, 1);
      assert.equal(snapshot(elements.report).children.length, 0);
      assert.equal(elements.button.disabled, false);
      assert.equal(flow.getReport(), null);
    });
  }

  test("falha de rede", async () => {
    const { flow, elements } = setup({ fetchFn: async () => { throw new TypeError("Failed to fetch"); } });
    await flow.submit();
    assert.equal(elements.error.textContent, MESSAGES.network);
  });

  test("prazo de 65 s: 'A análise demorou demais'", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { flow, elements } = setup({
      fetchFn: (_url, init) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(Object.assign(new Error("abortado"), { name: "AbortError" })));
        }),
    });
    const running = flow.submit();
    await flush();
    t.mock.timers.tick(65_000);
    await running;
    assert.equal(elements.error.textContent, MESSAGES.timeout);
    assert.equal(elements.button.disabled, false);
  });

  test("200 fora do formato: 'Resposta inesperada do servidor.', sem relatório", async () => {
    for (const body of [{}, null, [], "texto", { page: {}, media: "x" }]) {
      const { flow, elements, error } = setup({ fetchFn: async () => response(200, body) });
      await flow.submit();
      assert.equal(elements.error.textContent, FORM_TEXT.unexpected);
      assert.equal(error.focused, 1);
      assert.equal(snapshot(elements.report).children.length, 0);
      assert.equal(flow.getReport(), null);
    }
  });

  test("200 com campos de tipo errado ainda renderiza o que dá", async () => {
    const body = apiExample();
    body.page.title = 42;
    /** @type {Record<string, unknown>} */ (body).notices = "aviso";
    const { flow, elements } = setup({ fetchFn: async () => response(200, body) });
    await flow.submit();
    assert.equal(snapshot(elements.report).children.length, 1);
  });

  test("se o mount falhar, o texto fixo aparece e o foco vai para ele", async () => {
    const { elements } = setup();
    const fake = /** @type {{ createElement(tag: string): unknown }} */ (createFakeDocument().doc);
    const broken = createCheckFlow({
      elements: /** @type {never} */ (elements),
      session: /** @type {never} */ ({ withToken: async (/** @type {(t: string) => Promise<unknown>} */ attempt) => ({ ok: true, value: await attempt("t"), renewed: false }) }),
      fetchFn: async () => response(200, apiExample()),
      doc: /** @type {never} */ ({
        createElement: (/** @type {string} */ tag) => {
          if (tag === "h2") throw new Error("falha");
          return fake.createElement(tag);
        },
      }),
      ui: { showLogin() {} },
    });
    await broken.submit();
    assert.equal(snapshot(elements.report).children[0]?.text, RENDER_ERROR_TEXT);
    assert.equal(broken.getReport(), null);
  });
});

describe("fluxo: sessão", () => {
  test("401 com renovação ok: repete uma vez e mostra o relatório; o 'Analisando...' continua durante a renovação", async () => {
    /** @type {string[]} */
    const progressDuringRenewal = [];
    /** @type {{ progress: { textContent: string | null } } | null} */
    let elementsRef = null;
    let first = true;
    const { flow, elements, calls, events } = setup({
      fetchFn: async () => (first ? ((first = false), response(401)) : response(200, apiExample())),
      renewToken: async () => {
        progressDuringRenewal.push(String(elementsRef?.progress.textContent));
        return TOKEN_2;
      },
    });
    elementsRef = elements;
    await flow.submit();
    assert.deepEqual(progressDuringRenewal, ["Analisando... pode levar até 1 minuto"]);
    assert.deepEqual(calls.map((c) => c.auth), [`Bearer ${TOKEN_1}`, `Bearer ${TOKEN_2}`]);
    assert.deepEqual(events, ["renew"]);
    assert.equal(snapshot(elements.report).children.length, 1);
    assert.equal(elements.progress.textContent, "");
  });

  test("401 e renovação que falha: volta ao login com 'Sessão expirada, entre novamente'", async () => {
    const { flow, elements, events, error } = setup({ fetchFn: async () => response(401), renewToken: async () => null });
    await flow.submit();
    assert.equal(elements.error.textContent, "Sessão expirada, entre novamente");
    assert.equal(elements.error.hidden, false);
    assert.equal(error.focused, 1);
    assert.equal(elements.form.hidden, true);
    assert.deepEqual(events, ["renew", "login"]);
    assert.equal(elements.button.disabled, false);
    assert.equal(snapshot(elements.report).children.length, 0);
  });

  test("401 de novo depois de renovar: mesmo caminho do login", async () => {
    const { flow, elements, calls } = setup({ fetchFn: async () => response(401), renewToken: async () => TOKEN_2 });
    await flow.submit();
    assert.equal(calls.length, 2);
    assert.equal(elements.error.textContent, "Sessão expirada, entre novamente");
    assert.equal(elements.form.hidden, true);
  });

  test("reset (novo login): limpa a mensagem, mostra o formulário e descarta o relatório antigo", async () => {
    const { flow, elements } = setup({ fetchFn: async () => response(401) });
    await flow.submit();
    flow.reset();
    assert.equal(elements.error.textContent, "");
    assert.equal(elements.error.hidden, true);
    assert.equal(elements.form.hidden, false);
    const ok = setup();
    await ok.flow.submit();
    ok.flow.reset();
    assert.equal(snapshot(ok.elements.report).children.length, 0);
    assert.equal(ok.flow.getReport(), null);
  });

  test("show/hide do painel: aparece depois do login", () => {
    const { flow, elements } = setup();
    flow.show();
    assert.equal(elements.panel.hidden, false);
    assert.equal(elements.form.hidden, false);
    flow.hide();
    assert.equal(elements.panel.hidden, true);
  });
});

describe("fluxo: botão Baixar JSON", () => {
  test("aparece só com um relatório na tela", async () => {
    const { flow, elements } = setup();
    assert.equal(elements.download.hidden, true);
    await flow.submit();
    assert.equal(elements.download.hidden, false);
    assert.equal(flow.getReport()?.url, LINK);
  });

  test("some ao começar outra checagem, em erro, resposta inesperada, renderização falha e novo login", async () => {
    const pending = deferred();
    let calls = 0;
    const { flow, elements } = setup({ fetchFn: () => (++calls === 1 ? Promise.resolve(response(200, apiExample())) : pending.promise) });
    await flow.submit();
    assert.equal(elements.download.hidden, false);
    const second = flow.submit();
    await flush();
    assert.equal(elements.download.hidden, true);
    pending.resolve(response(503, {}));
    await second;
    assert.equal(elements.download.hidden, true);

    const unexpected = setup({ fetchFn: async () => response(200, {}) });
    await unexpected.flow.submit();
    assert.equal(unexpected.elements.download.hidden, true);

    const ok = setup();
    await ok.flow.submit();
    ok.flow.reset();
    assert.equal(ok.elements.download.hidden, true);
  });

  test("o relatório guardado para o download é o da tela (já higienizado)", async () => {
    const body = apiExample();
    body.page.title = "Título‮oculto";
    const { flow } = setup({ fetchFn: async () => response(200, body) });
    await flow.submit();
    assert.equal(flow.getReport()?.report.page.title, "Títulooculto");
  });
});

describe("renovação no meio não apaga 'Analisando...' nem o relatório", () => {
  test("'Verificar sessão' com renovação enquanto há relatório na tela: o relatório e a mensagem ficam", async () => {
    let calls = 0;
    const sessionElements = { panel: { hidden: true }, button: { disabled: false }, status: { textContent: "" }, expiry: { textContent: "" } };
    const session = createSession({
      fetchFn: async () => (++calls === 1 ? response(401) : response(200, { email: "a@b.c" })),
      renewToken: async () => TOKEN_2,
      ui: { showEmail() {}, showExpired() {}, showError() {} },
      checkUi: createSessionCheckUi(sessionElements),
      log: () => {},
    });
    const { flow, elements } = setup({ session });
    await flow.submit();
    elements.progress.textContent = "Analisando... pode levar até 1 minuto"; // simula uma checagem em andamento
    const before = JSON.stringify(snapshot(elements.report));
    await session.verify();
    assert.equal(sessionElements.status.textContent, "Token renovado");
    assert.equal(JSON.stringify(snapshot(elements.report)), before);
    assert.equal(elements.progress.textContent, "Analisando... pode levar até 1 minuto");
    assert.equal(flow.getReport()?.url, LINK);
  });

  test("renovação disparada por uma checagem não limpa o resultado do painel de sessão", async () => {
    const sessionElements = { panel: { hidden: true }, button: { disabled: false }, status: { textContent: "" }, expiry: { textContent: "" } };
    let first = true;
    const session = createSession({
      fetchFn: async () => response(200, { email: "a@b.c" }),
      renewToken: async () => TOKEN_2,
      ui: { showEmail() {}, showExpired() {}, showError() {} },
      checkUi: createSessionCheckUi(sessionElements),
      log: () => {},
    });
    const { flow, elements } = setup({
      session,
      fetchFn: async () => (first ? ((first = false), response(401)) : response(200, apiExample())),
    });
    sessionElements.status.textContent = "Sessão ativa"; // depois do setToken do login
    await flow.submit();
    // A renovação interna não é um login: o resultado do painel continua.
    assert.equal(sessionElements.status.textContent, "Sessão ativa");
    assert.equal(snapshot(elements.report).children.length, 1);
  });
});
