import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import type { TokenVerifier } from "./auth.ts";
import type { CheckDeps } from "./check.ts";
import { createFactCheckClient, type FactCheckCall, type FactCheckOptions } from "./factcheck-client.ts";
import type { FetcherCall, FetcherOutcome } from "./fetcher-client.ts";
import { createApiServer, shutdown, type LogEntry } from "./server.ts";
import {
  FACT_CHECK_CLAIM_VIEW,
  factCheckResponseRaw,
  PAGE_URL,
  pageWithDownloads,
  sendJsonResponse,
  startFakeFetcher,
  TEST_FACTCHECK_KEY,
  testCheckDeps,
} from "./testing.ts";

const GOOD = "good.token.value";
const verifier: TokenVerifier = async (token) => {
  if (token === GOOD) return { email: "pessoa@example.com", sub: "sub-1" };
  throw new Error("recusado");
};

type Api = { base: string; logs: LogEntry[]; close: () => Promise<void> };
type Body = { factCheck: Record<string, unknown>; page: Record<string, unknown> };

async function withApi(deps: Partial<CheckDeps>, run: (api: Api) => Promise<void>): Promise<void> {
  const logs: LogEntry[] = [];
  const server = createApiServer({ verifier, log: (entry) => logs.push(entry), check: testCheckDeps(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const api = { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, logs, close: () => shutdown(server, 1000) };
  try {
    await run(api);
  } finally {
    await api.close();
  }
}

const post = (api: Api): Promise<Response> =>
  fetch(`${api.base}/api/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GOOD}` },
    body: JSON.stringify({ url: PAGE_URL }),
  });

// Página com uma mídia baixada e a manchete dada (título "Matéria").
function page(headline: string | null, title: string | null = "Matéria"): FetcherOutcome {
  const outcome = pageWithDownloads(1);
  if (outcome.kind !== "page") throw new Error("fixture");
  outcome.page.headline = headline;
  outcome.page.title = title;
  return outcome;
}

const returning =
  (outcome: FetcherOutcome): FetcherCall =>
  () =>
    Promise.resolve(outcome);

// Busca falsa que grava o texto recebido e as opções.
function recordingSearch(result: Awaited<ReturnType<FactCheckCall>>): { search: FactCheckCall; calls: Array<{ query: string; options: FactCheckOptions }> } {
  const calls: Array<{ query: string; options: FactCheckOptions }> = [];
  const search: FactCheckCall = (query, options) => {
    calls.push({ query, options });
    return Promise.resolve(result);
  };
  return { search, calls };
}

const waitFor = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
};

describe("POST /api/check: Fact Check Tools no relatório", () => {
  test("campo factCheck aditivo na raiz: ok com o texto enviado e a lista permitida", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [FACT_CHECK_CLAIM_VIEW] });
    await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks: search }, async (api) => {
      const res = await post(api);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Body;
      assert.deepEqual(Object.keys(body).sort(), ["factCheck", "media", "notices", "page"]);
      assert.deepEqual(body.factCheck, { status: "ok", query: "Manchete inventada", claims: [FACT_CHECK_CLAIM_VIEW] });
      assert.deepEqual(calls.map((call) => call.query), ["Manchete inventada"]);
      assert.equal(api.logs[0]?.outcome, "ok");
      assert.deepEqual(api.logs[0]?.factCheck, { ok: 1 });
    });
  });

  test("sem manchete, busca pelo título", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [] });
    await withApi({ callFetcher: returning(page(null, "Título da matéria")), searchFactChecks: search }, async (api) => {
      const body = (await (await post(api)).json()) as Body;
      assert.deepEqual(body.factCheck, { status: "ok", query: "Título da matéria", claims: [] });
      assert.deepEqual(calls.map((call) => call.query), ["Título da matéria"]);
    });
  });

  test("sem manchete nem título: skipped, sem chamar o Google", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [] });
    await withApi({ callFetcher: returning(page(null, null)), searchFactChecks: search }, async (api) => {
      const body = (await (await post(api)).json()) as Body;
      assert.deepEqual(body.factCheck, { status: "skipped", query: null, claims: [] });
      assert.equal(calls.length, 0);
      assert.deepEqual(api.logs[0]?.factCheck, { skipped: 1 });
    });
  });

  test("sem chave: not_configured e a checagem segue normal", async () => {
    await withApi({ callFetcher: returning(page("Manchete inventada")) }, async (api) => {
      const res = await post(api);
      assert.equal(res.status, 200);
      const body = (await res.json()) as Body & { media: unknown[] };
      assert.deepEqual(body.factCheck, { status: "not_configured", query: null, claims: [] });
      assert.equal(body.media.length, 1);
      assert.deepEqual(api.logs[0]?.factCheck, { not_configured: 1 });
    });
  });

  test("erro do Google: unavailable para o usuário, sem detalhe; a categoria só no log", async () => {
    for (const reason of ["http_400", "http_403", "http_429", "http_5xx", "timeout", "invalid"] as const) {
      const { search } = recordingSearch({ status: "unavailable", reason });
      await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks: search }, async (api) => {
        const res = await post(api);
        assert.equal(res.status, 200);
        const text = await res.text();
        assert.equal(text.includes(reason), false, `a resposta não pode citar ${reason}`);
        assert.deepEqual((JSON.parse(text) as Body).factCheck, { status: "unavailable", query: "Manchete inventada", claims: [] });
        assert.deepEqual(api.logs[0]?.factCheck, { [reason]: 1 });
      });
    }
  });

  test("busca que rejeita (inesperado) também vira unavailable, sem derrubar a checagem", async () => {
    const search: FactCheckCall = () => Promise.reject(new Error(`falha ${TEST_FACTCHECK_KEY}`));
    await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks: search }, async (api) => {
      const res = await post(api);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(text.includes(TEST_FACTCHECK_KEY), false);
      assert.equal((JSON.parse(text) as Body).factCheck["status"], "unavailable");
    });
  });
});

describe("POST /api/check: Fact Check Tools em paralelo e dentro do prazo", () => {
  test("a busca começa quando a linha page chega, antes de o fetcher terminar", async () => {
    let searchStarted = false;
    const search: FactCheckCall = () => {
      searchStarted = true;
      return Promise.resolve({ status: "ok", claims: [] });
    };
    let startedBeforeFetcherEnded = false;
    const callFetcher: FetcherCall = async (_url, _signal, onPage) => {
      const outcome = page("Manchete inventada");
      if (outcome.kind === "page") onPage?.(outcome.page);
      await waitFor(() => searchStarted);
      startedBeforeFetcherEnded = searchStarted;
      return outcome;
    };
    await withApi({ callFetcher, searchFactChecks: search }, async (api) => {
      assert.equal((await post(api)).status, 200);
      assert.equal(startedBeforeFetcherEnded, true);
    });
  });

  test("fetcher sem aviso da linha page (versão antiga dos fakes): a busca começa depois, uma vez só", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [] });
    await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks: search }, async (api) => {
      await post(api);
      assert.equal(calls.length, 1);
    });
  });

  test("aviso repetido da linha page não dispara uma segunda busca", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [] });
    const callFetcher: FetcherCall = (_url, _signal, onPage) => {
      const outcome = page("Manchete inventada");
      if (outcome.kind === "page") {
        onPage?.(outcome.page);
        onPage?.({ title: "outra", headline: "outra" });
      }
      return Promise.resolve(outcome);
    };
    await withApi({ callFetcher, searchFactChecks: search }, async (api) => {
      await post(api);
      assert.deepEqual(calls.map((call) => call.query), ["Manchete inventada"]);
    });
  });

  test("Google que não responde: a checagem sai no prazo da busca, com unavailable", async () => {
    const google = await startFakeFetcher(() => new Promise<void>(() => {}));
    try {
      const searchFactChecks = createFactCheckClient({ apiKey: TEST_FACTCHECK_KEY, endpoint: `${google.url}/v1alpha1/claims:search`, limits: { callTimeoutMs: 300 } });
      await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks }, async (api) => {
        const started = performance.now();
        const res = await post(api);
        const elapsed = performance.now() - started;
        assert.equal(res.status, 200);
        assert.equal(((await res.json()) as Body).factCheck["status"], "unavailable");
        assert.ok(elapsed < 2_000, `demorou ${elapsed} ms`);
        assert.deepEqual(api.logs[0]?.factCheck, { timeout: 1 });
      });
    } finally {
      await google.close();
    }
  });

  test("a busca recebe o prazo total da checagem e um sinal de cancelamento", async () => {
    const { search, calls } = recordingSearch({ status: "ok", claims: [] });
    await withApi({ callFetcher: returning(page("Manchete inventada")), searchFactChecks: search, totalDeadlineMs: 10_000 }, async (api) => {
      const before = performance.now();
      await post(api);
      const deadlineAt = calls[0]?.options.deadlineAt ?? 0;
      assert.ok(deadlineAt > before && deadlineAt <= before + 10_000 + 50, "prazo da checagem inteira, nunca maior");
      assert.ok(calls[0]?.options.signal instanceof AbortSignal);
    });
  });

  test("fetcher que falha depois da linha page: 502, a busca é abortada e o resultado descartado", async () => {
    let searchSignal: AbortSignal | null = null;
    const search: FactCheckCall = (_query, options) => {
      searchSignal = options.signal;
      return new Promise((resolve) => options.signal.addEventListener("abort", () => resolve({ status: "unavailable", reason: "aborted" })));
    };
    const callFetcher: FetcherCall = (_url, _signal, onPage) => {
      onPage?.({ title: "Matéria", headline: "Manchete inventada" });
      return Promise.resolve({ kind: "failed", reason: "malformed" });
    };
    await withApi({ callFetcher, searchFactChecks: search }, async (api) => {
      const res = await post(api);
      assert.equal(res.status, 502);
      assert.equal((await res.text()).includes("factCheck"), false);
      await waitFor(() => (searchSignal as AbortSignal | null)?.aborted === true);
      assert.equal((searchSignal as AbortSignal | null)?.aborted, true);
      assert.equal(api.logs[0]?.factCheck, null);
    });
  });
});

describe("POST /api/check: Fact Check Tools nos logs", () => {
  test("o log traz só a contagem por status: nunca o texto da busca, a chave nem as checagens", async () => {
    const google = await startFakeFetcher((_req, res) => sendJsonResponse(res, 200, factCheckResponseRaw()));
    try {
      const searchFactChecks = createFactCheckClient({ apiKey: TEST_FACTCHECK_KEY, endpoint: `${google.url}/v1alpha1/claims:search` });
      await withApi({ callFetcher: returning(page("Manchete-sentinela da página")), searchFactChecks }, async (api) => {
        const res = await post(api);
        const text = await res.text();
        assert.equal(text.includes(TEST_FACTCHECK_KEY), false, "a chave não pode ir na resposta");
        assert.equal(((JSON.parse(text) as Body).factCheck["claims"] as unknown[]).length, 1);
        assert.equal(google.requests[0]?.headers["x-goog-api-key"], TEST_FACTCHECK_KEY);
        const dump = JSON.stringify(api.logs);
        for (const fragment of [TEST_FACTCHECK_KEY, "Manchete-sentinela", "sentinela", "Crime has doubled", "John Doe", "Awesome", "awesomefactchecks", "Mostly false"]) {
          assert.equal(dump.includes(fragment), false, `log contém ${fragment}`);
        }
        assert.deepEqual(api.logs[0]?.factCheck, { ok: 1 });
      });
    } finally {
      await google.close();
    }
  });
});
