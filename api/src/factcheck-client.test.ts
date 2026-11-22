import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import {
  createFactCheckClient,
  DEFAULT_FACTCHECK_LIMITS,
  FACTCHECK_SEARCH_URL,
  type FactCheckLimits,
  type FactCheckResult,
} from "./factcheck-client.ts";
import {
  FACT_CHECK_CLAIM_VIEW,
  factCheckResponseRaw,
  type FakeFetcherHandler,
  type FakeFetcherRequest,
  sendJsonResponse,
  startFakeFetcher,
  TEST_FACTCHECK_KEY,
} from "./testing.ts";

// Prazos curtos nos testes; produção usa os padrões (os limites só podem ser reduzidos).
const FAST: Partial<FactCheckLimits> = { callTimeoutMs: 1_000 };
const QUERY = "Manchete inventada";
const PATH = "/v1alpha1/claims:search";

type RunOptions = { limits?: Partial<FactCheckLimits>; apiKey?: string | null; budgetMs?: number; signal?: AbortSignal; query?: string };
type Run = { result: FactCheckResult; requests: FakeFetcherRequest[]; elapsedMs: number };

async function run(
  handler: FakeFetcherHandler,
  { limits = FAST, apiKey = TEST_FACTCHECK_KEY, budgetMs = 5_000, signal = new AbortController().signal, query = QUERY }: RunOptions = {},
): Promise<Run> {
  const fake = await startFakeFetcher(handler);
  try {
    const search = createFactCheckClient({ apiKey, endpoint: `${fake.url}${PATH}`, limits });
    const started = performance.now();
    const result = await search(query, { signal, deadlineAt: performance.now() + budgetMs });
    return { result, requests: fake.requests, elapsedMs: performance.now() - started };
  } finally {
    await fake.close();
  }
}

const reply =
  (status: number, body: unknown = factCheckResponseRaw(), headers: Record<string, string> = {}): FakeFetcherHandler =>
  (_req, res) =>
    sendJsonResponse(res, status, body, headers);

const never: FakeFetcherHandler = () => new Promise<void>(() => {});

const paramsOf = (req: FakeFetcherRequest | undefined): URLSearchParams => new URL(req?.path ?? "/", "http://fake.invalid").searchParams;

function assertUnavailable(result: FactCheckResult, reason: string): void {
  assert.deepEqual(result, { status: "unavailable", reason });
}

describe("cliente Fact Check Tools: requisição", () => {
  test("o endereço de produção é a constante documentada", () => {
    assert.equal(FACTCHECK_SEARCH_URL, "https://factchecktools.googleapis.com/v1alpha1/claims:search");
  });

  test("limites de produção congelados: 5 s por chamada e 512 KiB de resposta", () => {
    assert.deepEqual({ ...DEFAULT_FACTCHECK_LIMITS }, { callTimeoutMs: 5_000, maxResponseBytes: 512 * 1024 });
    assert.ok(Object.isFrozen(DEFAULT_FACTCHECK_LIMITS));
  });

  test("GET claims:search com corpo vazio, só query e pageSize=10, sem filtro de idioma", async () => {
    const { requests } = await run(reply(200));
    assert.equal(requests.length, 1);
    const [req] = requests;
    assert.equal(req?.method, "GET");
    assert.equal(new URL(req?.path ?? "/", "http://fake.invalid").pathname, PATH);
    assert.equal(req?.body, "");
    assert.deepEqual([...paramsOf(req).keys()].sort(), ["pageSize", "query"]);
    assert.equal(paramsOf(req).get("query"), QUERY);
    assert.equal(paramsOf(req).get("pageSize"), "10");
    assert.equal(req?.headers.accept, "application/json");
  });

  test("a chave vai só no cabeçalho X-Goog-Api-Key: nunca na URL", async () => {
    const { requests } = await run(reply(200));
    const [req] = requests;
    assert.equal(req?.headers["x-goog-api-key"], TEST_FACTCHECK_KEY);
    assert.equal(req?.path.includes(TEST_FACTCHECK_KEY), false);
    assert.equal(paramsOf(req).has("key"), false);
  });

  test("a consulta é codificada na URL: acentos, &, #, +, % e espaços chegam intactos", async () => {
    const query = "ação & reação #1 + 100% ¿ qué? a=b";
    const { requests } = await run(reply(200), { query });
    const [req] = requests;
    assert.equal(paramsOf(req).get("query"), query);
    assert.equal(req?.path.includes("#"), false);
    assert.equal(req?.path.split("&").length, 2, "só o & que separa os dois parâmetros");
  });

  test("sem chave (null ou vazia): not_configured, sem requisição", async () => {
    for (const apiKey of [null, ""]) {
      const { result, requests } = await run(reply(200), { apiKey });
      assert.deepEqual(result, { status: "not_configured" });
      assert.equal(requests.length, 0);
    }
  });
});

describe("cliente Fact Check Tools: respostas", () => {
  test("200 com o exemplo oficial: ok com a lista permitida", async () => {
    const { result } = await run(reply(200));
    assert.deepEqual(result, { status: "ok", claims: [FACT_CHECK_CLAIM_VIEW] });
  });

  test("200 sem resultados ({}): ok com lista vazia", async () => {
    assert.deepEqual((await run(reply(200, {}))).result, { status: "ok", claims: [] });
  });

  test("200 com JSON inválido ou fora do formato: unavailable (invalid)", async () => {
    const invalidJson: FakeFetcherHandler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{claims: [");
    };
    assertUnavailable((await run(invalidJson)).result, "invalid");
    for (const body of [[], "texto", { claims: "x" }, null]) assertUnavailable((await run(reply(200, body))).result, "invalid");
  });

  test("corpo acima do teto: unavailable (too_large), com Content-Length ou em fluxo", async () => {
    const limits = { ...FAST, maxResponseBytes: 1024 };
    const big = factCheckResponseRaw([{ text: "x".repeat(5_000) }]);
    assertUnavailable((await run(reply(200, big), { limits })).result, "too_large");
    const streamed: FakeFetcherHandler = async (_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      for (let i = 0; i < 10; i++) {
        res.write(" ".repeat(512));
        await new Promise((resolve) => setImmediate(resolve));
      }
      res.end("{}");
    };
    assertUnavailable((await run(streamed, { limits })).result, "too_large");
  });

  const errors: Array<[number, string]> = [
    [400, "http_400"],
    [401, "http_other"],
    [403, "http_403"],
    [404, "http_other"],
    [429, "http_429"],
    [500, "http_5xx"],
    [503, "http_5xx"],
    [302, "http_other"],
  ];
  for (const [status, reason] of errors) {
    test(`HTTP ${status}: unavailable (${reason}), sem nova tentativa`, async () => {
      const headers: Record<string, string> = status === 302 ? { Location: "https://outro.example/" } : { "Retry-After": "0" };
      const { result, requests } = await run(reply(status, { error: { message: `detalhe ${TEST_FACTCHECK_KEY}` } }, headers));
      assertUnavailable(result, reason);
      assert.equal(requests.length, 1);
    });
  }
});

describe("cliente Fact Check Tools: prazos e falhas de rede", () => {
  test("Google que não responde: unavailable (timeout) dentro do prazo da chamada", async () => {
    const { result, elapsedMs, requests } = await run(never, { limits: { callTimeoutMs: 200 } });
    assertUnavailable(result, "timeout");
    assert.ok(elapsedMs < 1_500, `demorou ${elapsedMs} ms`);
    assert.equal(requests.length, 1);
  });

  test("o prazo total de quem chama encurta a chamada", async () => {
    const { result, elapsedMs } = await run(never, { limits: { callTimeoutMs: 5_000 }, budgetMs: 200 });
    assertUnavailable(result, "timeout");
    assert.ok(elapsedMs < 1_500, `demorou ${elapsedMs} ms`);
  });

  test("prazo já esgotado: timeout sem requisição", async () => {
    const { result, requests } = await run(reply(200), { budgetMs: -1 });
    assertUnavailable(result, "timeout");
    assert.equal(requests.length, 0);
  });

  test("quem chama cancelou: aborted, sem requisição; cancelamento no meio também vira aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const before = await run(reply(200), { signal: controller.signal });
    assertUnavailable(before.result, "aborted");
    assert.equal(before.requests.length, 0);
    const later = new AbortController();
    setTimeout(() => later.abort(), 100);
    assertUnavailable((await run(never, { signal: later.signal })).result, "aborted");
  });

  test("conexão recusada: unavailable (network)", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const { port } = closed.address() as AddressInfo;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const search = createFactCheckClient({ apiKey: TEST_FACTCHECK_KEY, endpoint: `http://127.0.0.1:${port}${PATH}`, limits: FAST });
    const result = await search(QUERY, { signal: new AbortController().signal, deadlineAt: performance.now() + 2_000 });
    assertUnavailable(result, "network");
  });

  test("nunca lança: endereço inválido vira unavailable", async () => {
    const search = createFactCheckClient({ apiKey: TEST_FACTCHECK_KEY, endpoint: "não é url", limits: FAST });
    const result = await search(QUERY, { signal: new AbortController().signal, deadlineAt: performance.now() + 1_000 });
    assert.equal(result.status, "unavailable");
  });
});

describe("cliente Fact Check Tools: nada vaza no resultado", () => {
  test("a chave e a consulta nunca aparecem no resultado, com sucesso ou erro", async () => {
    const handlers: FakeFetcherHandler[] = [reply(200), reply(403, { error: TEST_FACTCHECK_KEY }), reply(500), never];
    for (const handler of handlers) {
      const { result } = await run(handler, { limits: { callTimeoutMs: 200 }, query: "consulta-sentinela" });
      const dump = JSON.stringify(result);
      assert.equal(dump.includes(TEST_FACTCHECK_KEY), false);
      assert.equal(dump.includes("consulta-sentinela"), false);
    }
  });
});
