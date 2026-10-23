import assert from "node:assert/strict";
import { describe, test } from "node:test";

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
