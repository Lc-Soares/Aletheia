import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MESSAGES, postCheck } from "../public/check-client.js";
import { createSession } from "../public/session.js";

const TOKEN_1 = "tok-1";
const TOKEN_2 = "tok-2";
const URL_TO_CHECK = "https://exemplo.com/materia";
const abortError = () => Object.assign(new Error("abortado"), { name: "AbortError" });
const flush = () => new Promise((resolve) => globalThis.setImmediate(resolve));

/**
 * @typedef {object} FakeResponse
 * @property {boolean} ok
 * @property {number} status
 * @property {{ get(name: string): string | null }} headers
 * @property {() => Promise<unknown>} json
 */

/**
 * @param {number} code
 * @param {unknown} [body] Se for undefined, o corpo não é JSON.
 * @param {Record<string, string>} [headers]
 * @returns {FakeResponse}
 */
function response(code, body, headers = {}) {
  return {
    ok: code >= 200 && code < 300,
    status: code,
    headers: { get: (name) => headers[name] ?? null },
    json: async () => {
      if (body === undefined) throw new SyntaxError("corpo não é JSON");
      return body;
    },
  };
}

/**
 * @typedef {object} Call
 * @property {string} url
 * @property {{ method?: string, headers: Record<string, string>, body?: string, signal?: AbortSignal }} init
 */

/**
 * @param {{ replies?: Array<FakeResponse | Error>, renewed?: string | null, fetchFn?: (call: Call) => Promise<FakeResponse> }} options
 */
function setup({ replies = [], renewed = null, fetchFn } = {}) {
  /** @type {Call[]} */
  const calls = [];
  const queue = [...replies];
  let renewals = 0;
  /** @type {(url: string, init: Call["init"]) => Promise<FakeResponse>} */
  const send = async (url, init) => {
    const call = { url, init };
    calls.push(call);
    if (fetchFn) return fetchFn(call);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return /** @type {FakeResponse} */ (next);
  };
  const session = createSession({
    fetchFn: async () => {
      throw new Error("não usado");
    },
    renewToken: async () => {
      renewals++;
      return renewed;
    },
    ui: { showEmail() {}, showExpired() {}, showError() {} },
    log: () => {},
  });
  session.setToken(TOKEN_1);
  const run = (url = URL_TO_CHECK) => postCheck(url, { session, fetchFn: send });
  return { run, calls, renewals: () => renewals, session };
}

describe("postCheck: requisição", () => {
  test("POST /api/check com Bearer, JSON e corpo exatamente {url}", async () => {
    const { run, calls } = setup({ replies: [response(200, { page: {} })] });
    await run();
    assert.equal(calls.length, 1);
    const call = /** @type {Call} */ (calls[0]);
    assert.equal(call.url, "/api/check");
    assert.equal(call.init.method, "POST");
    assert.equal(call.init.headers["Authorization"], `Bearer ${TOKEN_1}`);
    assert.equal(call.init.headers["Content-Type"], "application/json");
    assert.equal(call.init.body, JSON.stringify({ url: URL_TO_CHECK }));
    assert.deepEqual(Object.keys(JSON.parse(String(call.init.body))), ["url"]);
  });

  test("a URL do usuário não vai na query string nem no caminho", async () => {
    const { run, calls } = setup({ replies: [response(200, {})] });
    await run("https://exemplo.com/?segredo=1");
    const call = /** @type {Call} */ (calls[0]);
    assert.equal(call.url.includes("?"), false);
    assert.equal(call.url.includes("exemplo"), false);
  });

  test("200 devolve o corpo como veio (a validação é de outro módulo)", async () => {
    const body = { page: { title: "t" }, media: [], notices: [] };
    const { run } = setup({ replies: [response(200, body)] });
    assert.deepEqual(await run(), { status: "ok", body });
  });

  test("200 com corpo que não é JSON: ok com body null", async () => {
    const { run } = setup({ replies: [response(200)] });
    assert.deepEqual(await run(), { status: "ok", body: null });
  });
});

describe("postCheck: 401 e renovação", () => {
  test("401 com renovação ok: repete UMA vez com o token novo e devolve o relatório", async () => {
    const { run, calls, renewals } = setup({ replies: [response(401), response(200, { ok: 1 })], renewed: TOKEN_2 });
    assert.deepEqual(await run(), { status: "ok", body: { ok: 1 } });
    assert.deepEqual(
      calls.map((c) => c.init.headers["Authorization"]),
      [`Bearer ${TOKEN_1}`, `Bearer ${TOKEN_2}`],
    );
    assert.equal(renewals(), 1);
  });

  test("a repetição leva o mesmo corpo e um AbortSignal novo", async () => {
    const { run, calls } = setup({ replies: [response(401), response(200, {})], renewed: TOKEN_2 });
    await run();
    const [first, second] = /** @type {[Call, Call]} */ (calls);
    assert.equal(first.init.body, second.init.body);
    assert.notEqual(first.init.signal, second.init.signal);
  });

  test("401 e renovação que falha: expired, sem repetir", async () => {
    const { run, calls } = setup({ replies: [response(401)], renewed: null });
    assert.deepEqual(await run(), { status: "expired" });
    assert.equal(calls.length, 1);
  });

  test("401 de novo depois de renovar: expired, sem segunda renovação", async () => {
    const { run, calls, renewals } = setup({ replies: [response(401), response(401)], renewed: TOKEN_2 });
    assert.deepEqual(await run(), { status: "expired" });
    assert.equal(calls.length, 2);
    assert.equal(renewals(), 1);
  });

  test("sem token: expired, sem chamar a API", async () => {
    const { run, calls, session } = setup();
    session.setToken(null);
    assert.deepEqual(await run(), { status: "expired" });
    assert.equal(calls.length, 0);
  });

  test("só o 401 dispara repetição: 429, 502, 503 e 504 não repetem", async () => {
    for (const code of [429, 503, 504, 502]) {
      const { run, calls, renewals } = setup({ replies: [response(code, {})] });
      await run();
      assert.equal(calls.length, 1);
      assert.equal(renewals(), 0);
    }
  });
});

describe("postCheck: mapa de erros", () => {
  /** @type {Array<[string, FakeResponse, string]>} */
  const cases = [
    ["400", response(400, { error: "bad_request", message: "Requisição inválida." }), MESSAGES.badRequest],
    ["413", response(413, { error: "body_too_large", message: "Requisição grande demais." }), MESSAGES.badRequest],
    ["415", response(415, { error: "bad_content_type", message: "Envie o corpo como application/json." }), MESSAGES.badRequest],
    ["422 com mensagem", response(422, { error: "unreachable", message: "Não foi possível acessar este endereço." }), "Não foi possível acessar este endereço."],
    ["422 upstream_status", response(422, { error: "upstream_status", httpStatus: 403, message: "O site respondeu com erro (HTTP 403)." }), "O site respondeu com erro (HTTP 403)."],
    ["422 sem mensagem", response(422, { error: "unreachable" }), MESSAGES.generic],
    ["422 mensagem que não é texto", response(422, { message: { a: 1 } }), MESSAGES.generic],
    [
      "429 com mensagem",
      response(429, { error: "rate_limited", message: "Você atingiu o limite de 10 verificações por hora. Tente novamente em 12 minutos." }, { "Retry-After": "720" }),
      "Você atingiu o limite de 10 verificações por hora. Tente novamente em 12 minutos.",
    ],
    ["502", response(502, { error: "internal", message: "texto do servidor" }), MESSAGES.internal],
    ["503", response(503, { error: "busy", message: "texto do servidor" }, { "Retry-After": "5" }), MESSAGES.busy],
    ["504", response(504, { error: "timeout" }), MESSAGES.timeout],
    ["500", response(500, { error: "x", message: "stack trace" }), MESSAGES.generic],
    ["404", response(404), MESSAGES.generic],
    ["403", response(403, { message: "bloqueado" }), MESSAGES.generic],
  ];
  for (const [name, reply, expected] of cases) {
    test(`${name} → mensagem em português, sem número de status próprio`, async () => {
      const { run } = setup({ replies: [reply] });
      assert.deepEqual(await run(), { status: "error", message: expected });
      assert.doesNotMatch(expected.replace("(HTTP 403)", ""), /\b(400|413|415|429|502|503|504|500|404)\b/);
    });
  }

  test("mensagens fixas: textos combinados", () => {
    assert.equal(MESSAGES.timeout, "A análise demorou demais. Tente novamente.");
    assert.equal(MESSAGES.busy, "Serviço ocupado, tente novamente em instantes.");
    assert.equal(MESSAGES.internal, "Não foi possível concluir a análise. Tente novamente.");
  });

  test("429 sem mensagem: usa o Retry-After lido como inteiro, em minutos", async () => {
    /** @type {Array<[string, string]>} */
    const table = [
      ["720", "Limite de verificações atingido. Tente novamente em cerca de 12 minutos."],
      ["61", "Limite de verificações atingido. Tente novamente em cerca de 2 minutos."],
      ["1", "Limite de verificações atingido. Tente novamente em cerca de 1 minuto."],
      ["0", "Limite de verificações atingido. Tente novamente em cerca de 1 minuto."],
    ];
    for (const [header, expected] of table) {
      const { run } = setup({ replies: [response(429, {}, { "Retry-After": header })] });
      assert.deepEqual(await run(), { status: "error", message: expected });
    }
  });

  test("429 com Retry-After hostil ou ausente: nunca ecoa o cabeçalho", async () => {
    for (const header of ["<script>alert(1)</script>", "Wed, 21 Oct 2026 07:28:00 GMT", "-5", "1e9", "99999999999", "12 minutos", ""]) {
      const { run } = setup({ replies: [response(429, undefined, { "Retry-After": header })] });
      assert.deepEqual(await run(), { status: "error", message: MESSAGES.rateLimited });
    }
    const { run } = setup({ replies: [response(429, [])] });
    assert.deepEqual(await run(), { status: "error", message: MESSAGES.rateLimited });
  });

  test("corpo inesperado vira a mensagem genérica, sem exibir o corpo", async () => {
    /** @type {unknown[]} */
    const bodies = ["<html><body>Bad Gateway segredo-interno</body></html>", [1, 2], 42, null, true, { message: 7 }, { error: { message: "x" } }];
    for (const body of bodies) {
      const { run } = setup({ replies: [response(422, body)] });
      assert.deepEqual(await run(), { status: "error", message: MESSAGES.generic });
    }
    const { run } = setup({ replies: [response(502, "<html>nginx</html>")] });
    assert.deepEqual(await run(), { status: "error", message: MESSAGES.internal });
  });

  test("mensagem do servidor com HTML, bidi e controles vira texto limpo e cortado", async () => {
    const hostile = `<img src=x onerror=alert(1)>\u202E\u0007${"a".repeat(1000)}`;
    const { run } = setup({ replies: [response(422, { message: hostile })] });
    const result = /** @type {{ status: "error", message: string }} */ (await run());
    assert.equal(result.status, "error");
    assert.ok(result.message.startsWith("<img src=x onerror=alert(1)>"));
    assert.equal(result.message.includes("\u202E") || result.message.includes("\u0007"), false);
    assert.ok(Array.from(result.message).length <= 200);
  });

  test("falha de rede: mensagem de conexão, sem detalhes do erro", async () => {
    const { run } = setup({ replies: [new TypeError("Failed to fetch https://exemplo.com/materia")] });
    assert.deepEqual(await run(), { status: "error", message: MESSAGES.network });
  });

  test("a mensagem de erro nunca contém o token nem a URL enviada", async () => {
    const { run } = setup({ replies: [new Error(`falhou ${TOKEN_1} ${URL_TO_CHECK}`)] });
    const result = /** @type {{ message: string }} */ (await run());
    assert.equal(result.message.includes(TOKEN_1), false);
    assert.equal(result.message.includes("exemplo.com"), false);
  });
});

describe("postCheck: prazo de 65 s", () => {
  /** @param {import("node:test").TestContext} t */
  const useTimers = (t) => t.mock.timers.enable({ apis: ["setTimeout"] });

  /** Fetch que só termina quando o sinal é abortado, como o fetch real. */
  const hangUntilAborted = (/** @type {Call} */ { init }) =>
    /** @type {Promise<FakeResponse>} */ (
      new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(abortError()));
      })
    );

  test("sem resposta em 65 s: aborta e mostra 'A análise demorou demais'", async (t) => {
    useTimers(t);
    const { run, calls } = setup({ fetchFn: hangUntilAborted });
    const pending = run();
    await flush();
    t.mock.timers.tick(64_999);
    await flush();
    assert.equal(calls[0]?.init.signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { status: "error", message: MESSAGES.timeout });
    assert.equal(calls[0]?.init.signal?.aborted, true);
  });

  test("o prazo cobre também a leitura do corpo", async (t) => {
    useTimers(t);
    const { run } = setup({
      fetchFn: async ({ init }) => ({
        ...response(200, {}),
        json: () =>
          new Promise((_, reject) => {
            init.signal?.addEventListener("abort", () => reject(abortError()));
          }),
      }),
    });
    const pending = run();
    await flush();
    t.mock.timers.tick(65_000);
    assert.deepEqual(await pending, { status: "error", message: MESSAGES.timeout });
  });

  test("resposta a tempo não deixa timer pendente nem aborta depois", async (t) => {
    useTimers(t);
    const { run, calls } = setup({ replies: [response(200, { a: 1 })] });
    assert.deepEqual(await run(), { status: "ok", body: { a: 1 } });
    t.mock.timers.tick(120_000);
    assert.equal(calls[0]?.init.signal?.aborted, false);
  });

  test("a segunda tentativa, depois do 401, ganha prazo de 65 s próprio", async (t) => {
    useTimers(t);
    /** @type {Call[]} */
    const seen = [];
    const { run } = setup({
      renewed: TOKEN_2,
      fetchFn: async (call) => {
        seen.push(call);
        return seen.length === 1 ? response(401) : hangUntilAborted(call);
      },
    });
    const pending = run();
    await flush();
    await flush();
    t.mock.timers.tick(64_999);
    await flush();
    assert.equal(seen[1]?.init.signal?.aborted, false);
    t.mock.timers.tick(1);
    assert.deepEqual(await pending, { status: "error", message: MESSAGES.timeout });
  });

  test("falha de rede antes do prazo continua sendo falha de rede", async (t) => {
    useTimers(t);
    const { run } = setup({ replies: [new TypeError("rede")] });
    assert.deepEqual(await run(), { status: "error", message: MESSAGES.network });
  });
});

describe("postCheck: sem rastros", () => {
  test("não escreve em console, mesmo nos erros", async () => {
    /** @type {string[]} */
    const written = [];
    /** @type {Record<string, unknown>} */
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (console));
    /** @type {Record<string, unknown>} */
    const saved = {};
    for (const name of ["log", "info", "warn", "error", "debug"]) {
      saved[name] = target[name];
      target[name] = () => written.push(name);
    }
    try {
      for (const reply of [response(200, {}), response(401), response(422, { message: "x" }), response(500), new TypeError("rede")]) {
        await setup({ replies: [reply] }).run();
      }
    } finally {
      for (const name of Object.keys(saved)) target[name] = saved[name];
    }
    assert.deepEqual(written, []);
  });
});
