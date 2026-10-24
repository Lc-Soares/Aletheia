import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { createSessionCheckUi } from "../public/render.js";
import { createSession } from "../public/session.js";

/** @typedef {{ ok: boolean, status: number, json(): Promise<unknown> }} FakeResponse */

/** @param {{ responses: FakeResponse[], renewed?: string | null }} options */
function setup({ responses, renewed = null }) {
  /** @type {Array<{ url: string, auth: string | undefined }>} */
  const calls = [];
  /** @type {string[]} */
  const events = [];
  const queue = [...responses];
  const session = createSession({
    fetchFn: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return /** @type {FakeResponse} */ (queue.shift());
    },
    renewToken: async () => {
      events.push("renew");
      return renewed;
    },
    ui: {
      showEmail: (email) => events.push(`email:${email}`),
      showExpired: () => events.push("expired"),
      showError: () => events.push("error"),
    },
  });
  return { session, calls, events };
}

/** @param {unknown} body @returns {FakeResponse} */
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
/** @param {number} code @returns {FakeResponse} */
const status = (code) => ({ ok: false, status: code, json: async () => ({}) });

describe("sessão", () => {
  test("chama /api/me com Bearer e mostra o e-mail", async () => {
    const { session, calls, events } = setup({ responses: [ok({ email: "a@b.c" })] });
    session.setToken("tok1");
    await session.loadMe();
    assert.deepEqual(calls, [{ url: "/api/me", auth: "Bearer tok1" }]);
    assert.deepEqual(events, ["email:a@b.c"]);
  });

  test("401 → pede novo token e repete uma vez com o token novo", async () => {
    const { session, calls, events } = setup({
      responses: [status(401), ok({ email: "a@b.c" })],
      renewed: "tok2",
    });
    session.setToken("tok1");
    await session.loadMe();
    assert.deepEqual(
      calls.map((c) => c.auth),
      ["Bearer tok1", "Bearer tok2"],
    );
    assert.deepEqual(events, ["renew", "email:a@b.c"]);
  });

  test("401 sem novo token → mostra sessão expirada e não tenta de novo", async () => {
    const { session, calls, events } = setup({ responses: [status(401)], renewed: null });
    session.setToken("tok1");
    await session.loadMe();
    assert.equal(calls.length, 1);
    assert.deepEqual(events, ["renew", "expired"]);
  });

  test("401 de novo depois da renovação → expirado, sem laço infinito", async () => {
    const { session, calls, events } = setup({ responses: [status(401), status(401)], renewed: "tok2" });
    session.setToken("tok1");
    await session.loadMe();
    assert.equal(calls.length, 2);
    assert.deepEqual(events, ["renew", "expired"]);
  });

  test("outros erros e resposta fora do formato mostram erro genérico", async () => {
    for (const response of [status(500), ok({ email: 42 }), ok(null)]) {
      const { session, events } = setup({ responses: [response] });
      session.setToken("tok1");
      await session.loadMe();
      assert.deepEqual(events, ["error"]);
    }
  });

  test("falha de rede mostra erro genérico", async () => {
    /** @type {string[]} */
    const events = [];
    const session = createSession({
      fetchFn: async () => {
        throw new TypeError("rede");
      },
      renewToken: async () => null,
      ui: { showEmail() {}, showExpired() {}, showError: () => events.push("error") },
    });
    session.setToken("tok1");
    await session.loadMe();
    assert.deepEqual(events, ["error"]);
  });

  test("sem token, não chama a API", async () => {
    const { session, calls } = setup({ responses: [] });
    await session.loadMe();
    assert.equal(calls.length, 0);
  });
});

// Botão "Verificar sessão": usa o painel real (render.js) com elementos falsos.
/** Elemento falso; innerHTML proibido. */
function fakeElement() {
  return {
    textContent: "",
    hidden: true,
    disabled: false,
    set innerHTML(/** @type {string} */ _value) {
      throw new Error("innerHTML não pode ser usado");
    },
  };
}

/** @param {unknown} payload */
const b64url = (payload) => Buffer.from(JSON.stringify(payload)).toString("base64url");
const EMAIL = "pessoa@exemplo.com";
/** @param {string} sub */
const jwt = (sub) => `${b64url({ alg: "RS256" })}.${b64url({ sub, email: EMAIL, exp: 2_000_000_000 })}.assinatura-${sub}`;
const TOKEN_1 = jwt("1");
const TOKEN_2 = jwt("2");
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {{ fetchFn?: () => Promise<FakeResponse>, responses?: FakeResponse[], renewToken?: () => Promise<string | null> }} options
 */
function setupCheck({ fetchFn, responses = [], renewToken = async () => null }) {
  /** @type {string[]} */
  const calls = [];
  /** @type {string[]} */
  const logs = [];
  let renewals = 0;
  const queue = [...responses];
  const elements = { panel: fakeElement(), button: fakeElement(), status: fakeElement(), expiry: fakeElement() };
  const session = createSession({
    fetchFn: async (_url, init) => {
      calls.push(init.headers.Authorization ?? "");
      return fetchFn ? fetchFn() : /** @type {FakeResponse} */ (queue.shift());
    },
    renewToken: () => {
      renewals++;
      return renewToken();
    },
    ui: { showEmail() {}, showExpired() {}, showError() {} },
    checkUi: createSessionCheckUi(elements),
    log: (message) => logs.push(message),
  });
  return { session, calls, logs, elements, renewals: () => renewals };
}

describe("verificar sessão", () => {
  test("200 direto: Sessão ativa, com o horário de expiração", async () => {
    const { session, calls, elements } = setupCheck({ responses: [ok({ email: EMAIL })] });
    session.setToken(TOKEN_1);
    await session.verify();
    assert.equal(elements.status.textContent, "Sessão ativa");
    assert.match(elements.expiry.textContent, /^Token expira às \d{2}:\d{2}$/);
    assert.equal(calls.length, 1);
  });

  test("401 e renovação bem-sucedida: Token renovado, com uma só nova chamada", async () => {
    const { session, calls, elements, renewals } = setupCheck({
      responses: [status(401), ok({ email: EMAIL })],
      renewToken: async () => TOKEN_2,
    });
    session.setToken(TOKEN_1);
    await session.verify();
    assert.equal(elements.status.textContent, "Token renovado");
    assert.deepEqual(calls, [`Bearer ${TOKEN_1}`, `Bearer ${TOKEN_2}`]);
    assert.equal(renewals(), 1);
  });

  test("401 e renovação que falha ou é cancelada: Sessão expirada, entre novamente", async () => {
    const { session, calls, elements, renewals } = setupCheck({ responses: [status(401)], renewToken: async () => null });
    session.setToken(TOKEN_1);
    await session.verify();
    assert.equal(elements.status.textContent, "Sessão expirada, entre novamente");
    assert.equal(calls.length, 1);
    assert.equal(renewals(), 1);
  });

  test("401 de novo depois de renovar: expirada, sem segunda renovação", async () => {
    const { session, calls, elements, renewals } = setupCheck({
      responses: [status(401), status(401)],
      renewToken: async () => TOKEN_2,
    });
    session.setToken(TOKEN_1);
    await session.verify();
    assert.equal(elements.status.textContent, "Sessão expirada, entre novamente");
    assert.equal(calls.length, 2);
    assert.equal(renewals(), 1);
  });

  test("erro que não é 401: Não foi possível verificar a sessão", async () => {
    const { session, elements } = setupCheck({ responses: [status(500)] });
    session.setToken(TOKEN_1);
    await session.verify();
    assert.equal(elements.status.textContent, "Não foi possível verificar a sessão");
  });

  test("clique duplo durante a verificação: uma só execução, botão desabilitado enquanto isso", async () => {
    /** @type {(response: FakeResponse) => void} */
    let answer = () => {};
    const { session, calls, elements } = setupCheck({
      fetchFn: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
    });
    session.setToken(TOKEN_1);
    const first = session.verify();
    const second = session.verify();
    await flush();
    assert.equal(elements.button.disabled, true);
    answer(ok({ email: EMAIL }));
    await Promise.all([first, second]);
    assert.equal(calls.length, 1);
    assert.equal(elements.button.disabled, false);
    assert.equal(elements.status.textContent, "Sessão ativa");
  });

  test("renovação que nunca responde: após 15 s, expirada, botão volta a habilitar e novo clique executa", async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { session, calls, elements } = setupCheck({
      responses: [status(401), ok({ email: EMAIL })],
      renewToken: () => new Promise(() => {}), // o Google nunca chama o callback
    });
    session.setToken(TOKEN_1);
    const pending = session.verify();
    await flush();
    assert.equal(elements.button.disabled, true);
    t.mock.timers.tick(14_999);
    await flush();
    assert.equal(elements.button.disabled, true);
    t.mock.timers.tick(1);
    await pending;
    assert.equal(elements.status.textContent, "Sessão expirada, entre novamente");
    assert.equal(elements.button.disabled, false);
    session.setToken(TOKEN_2);
    await session.verify();
    assert.equal(elements.status.textContent, "Sessão ativa");
    assert.equal(calls.length, 2);
  });

  test("payload ilegível: Sessão ativa, sem horário e sem exceção", async () => {
    const { session, elements } = setupCheck({ responses: [ok({ email: EMAIL })] });
    session.setToken("token-sem-formato-jwt");
    await session.verify();
    assert.equal(elements.status.textContent, "Sessão ativa");
    assert.equal(elements.expiry.textContent, "");
  });

  test("logs de renovação (início, sucesso, falha) sem token, e-mail nem payload", async () => {
    const renewed = setupCheck({ responses: [status(401), ok({ email: EMAIL })], renewToken: async () => TOKEN_2 });
    renewed.session.setToken(TOKEN_1);
    await renewed.session.verify();
    const failed = setupCheck({ responses: [status(401)], renewToken: async () => null });
    failed.session.setToken(TOKEN_1);
    await failed.session.verify();
    assert.equal(renewed.logs.length, 2);
    assert.match(renewed.logs[0] ?? "", /renovação iniciada/);
    assert.match(renewed.logs[1] ?? "", /renovação concluída; o novo token expira às \d{2}:\d{2}/);
    assert.equal(failed.logs.length, 2);
    assert.match(failed.logs[1] ?? "", /renovação falhou/);
    const forbidden = [TOKEN_1, TOKEN_2, EMAIL, "pessoa", "assinatura", ...TOKEN_1.split("."), ...TOKEN_2.split(".")];
    for (const line of [...renewed.logs, ...failed.logs]) {
      for (const secret of forbidden) assert.equal(line.includes(secret), false, `log vazou: ${secret}`);
    }
  });

  test("nada vai para localStorage, sessionStorage, IndexedDB ou cookie", async () => {
    /** @type {string[]} */
    const touched = [];
    /** @param {string} name */
    const spy = (name) =>
      new Proxy(
        {},
        {
          get: (_target, prop) => {
            touched.push(`${name}.${String(prop)}`);
            return () => {};
          },
          set: (_target, prop) => {
            touched.push(`${name}.${String(prop)}=`);
            return true;
          },
        },
      );
    const names = ["localStorage", "sessionStorage", "indexedDB", "document"];
    const saved = names.map((name) => /** @type {const} */ ([name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    for (const name of names) Object.defineProperty(globalThis, name, { value: spy(name), configurable: true, writable: true });
    try {
      /** @type {Array<[FakeResponse[], string | null]>} */
      const flows = [
        [[ok({ email: EMAIL })], null],
        [[status(401), ok({ email: EMAIL })], TOKEN_2],
        [[status(401)], null],
      ];
      for (const [responses, renewedToken] of flows) {
        const { session } = setupCheck({ responses, renewToken: async () => renewedToken });
        session.setToken(TOKEN_1);
        await session.verify();
      }
    } finally {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    }
    assert.deepEqual(touched, []);
  });
});
