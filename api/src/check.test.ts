import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { describe, mock, test } from "node:test";

import { createGoogleVerifier, type TokenVerifier } from "./auth.ts";
import type { CheckDeps } from "./check.ts";
import { createFetcherClient, type FetcherCall, type FetcherOutcome } from "./fetcher-client.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createApiServer, shutdown, type LogEntry } from "./server.ts";
import {
  CAPA_BYTES,
  FOTO_REF,
  generateTestKeys,
  ICONE_REF,
  OfflineOAuth2Client,
  PAGE_URL,
  sendNdjson,
  signToken,
  standardStream,
  startFakeFetcher,
  TEST_CLIENT_ID,
  TEST_SERVICE_TOKEN,
  testCheckDeps,
  validClaims,
} from "./testing.ts";

const GOOD = "good.token.value";
const OTHER = "other.token.value";

const verifier: TokenVerifier = async (token) => {
  if (token === GOOD) return { email: "pessoa@example.com", sub: "sub-1" };
  if (token === OTHER) return { email: "outra@example.com", sub: "sub-2" };
  throw new Error(`motivo interno com ${token}`);
};

type Api = { base: string; logs: LogEntry[]; close: () => Promise<void> };

async function startApi(deps: Partial<CheckDeps> = {}, verify: TokenVerifier = verifier): Promise<Api> {
  const logs: LogEntry[] = [];
  const server = createApiServer({ verifier: verify, log: (entry) => logs.push(entry), check: testCheckDeps(deps) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logs,
    close: () => shutdown(server, 1000),
  };
}

type PostOptions = { token?: string | null; contentType?: string; signal?: AbortSignal };

function post(api: Api, body: unknown, { token = GOOD, contentType = "application/json", signal }: PostOptions = {}): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (token !== null) headers["Authorization"] = `Bearer ${token}`;
  const payload = typeof body === "string" ? body : JSON.stringify(body);
  return fetch(`${api.base}/api/check`, { method: "POST", headers, body: payload, ...(signal ? { signal } : {}) });
}

async function withApi(deps: Partial<CheckDeps>, run: (api: Api) => Promise<void>, verify?: TokenVerifier): Promise<void> {
  const api = await startApi(deps, verify);
  try {
    await run(api);
  } finally {
    await api.close();
  }
}

function fetchedPage(): FetcherOutcome {
  return {
    kind: "page",
    page: {
      finalUrl: PAGE_URL,
      title: "Matéria de exemplo",
      headline: "Manchete inventada",
      possiblyNeedsJavaScript: false,
      media: [
        { url: "https://cdn.example/og/capa.jpg", kind: "image", source: "og:image", group: 1, score: 100, selected: true, skipReason: null },
        { url: String(FOTO_REF["url"]), kind: "image", source: "img", group: 2, score: 20, selected: true, skipReason: null },
        { url: String(ICONE_REF["url"]), kind: "image", source: "img", group: 3, score: -70, selected: false, skipReason: "icon" },
      ],
      downloads: [
        {
          url: "https://cdn.example/og/capa.jpg",
          kind: "image",
          source: "og:image",
          group: 1,
          ok: true,
          contentType: "image/jpeg",
          size: CAPA_BYTES.length,
          sha256: "a".repeat(64),
          bytes: CAPA_BYTES,
        },
        { url: String(FOTO_REF["url"]), kind: "image", source: "img", group: 2, ok: false, error: "upstream_status", httpStatus: 404 },
      ],
    },
  };
}

const returning =
  (outcome: FetcherOutcome | (() => FetcherOutcome)): FetcherCall =>
  () =>
    Promise.resolve(typeof outcome === "function" ? outcome() : outcome);

describe("POST /api/check: autenticação e método", () => {
  test("sem token ou com token recusado → 401 genérico, sem chamar o fetcher", async () => {
    let calls = 0;
    await withApi({ callFetcher: () => (calls++, Promise.resolve(fetchedPage())) }, async (api) => {
      for (const token of [null, "bad.token.value"]) {
        const res = await post(api, { url: PAGE_URL }, { token });
        assert.equal(res.status, 401);
        assert.deepEqual(await res.json(), { error: "Não autorizado" });
        assert.equal(res.headers.get("www-authenticate"), "Bearer");
      }
      assert.equal(calls, 0);
    });
  });

  test("token expirado ou com aud errada (verificador real com chave de teste) → 401", async () => {
    const keys = generateTestKeys();
    const real = createGoogleVerifier(TEST_CLIENT_ID, new OfflineOAuth2Client(keys.publicPem));
    const now = Math.floor(Date.now() / 1000);
    await withApi(
      { callFetcher: returning(fetchedPage()) },
      async (api) => {
        const expired = signToken(validClaims({ iat: now - 7200, exp: now - 3600 }), { keys });
        const wrongAud = signToken(validClaims({ aud: "outro-cliente" }), { keys });
        for (const token of [expired, wrongAud]) assert.equal((await post(api, { url: PAGE_URL }, { token })).status, 401);
        assert.equal((await post(api, { url: PAGE_URL }, { token: signToken(validClaims(), { keys }) })).status, 200);
      },
      real,
    );
  });

  test("GET /api/check → 405 com Allow: POST", async () => {
    await withApi({}, async (api) => {
      const res = await fetch(`${api.base}/api/check`, { headers: { Authorization: `Bearer ${GOOD}` } });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get("allow"), "POST");
    });
  });
});

describe("POST /api/check: corpo", () => {
  const invalid: Array<[string, unknown, number, string?]> = [
    ["JSON inválido", "{url:", 400],
    ["corpo vazio", "", 400],
    ["null", "null", 400],
    ["array", "[]", 400],
    ["campo extra", { url: PAGE_URL, outro: 1 }, 400],
    ["sem url", { link: PAGE_URL }, 400],
    ["url número", { url: 42 }, 400],
    ["url vazia", { url: "" }, 400],
    ["url longa demais", { url: `https://a.example/${"a".repeat(2048)}` }, 400],
    ["corpo acima de 4 KiB", { url: PAGE_URL, pad: "a".repeat(5000) }, 413],
    ["Content-Type text/plain", { url: PAGE_URL }, 415, "text/plain"],
  ];

  for (const [name, body, status, contentType] of invalid) {
    test(`${name} → ${status}`, async () => {
      let calls = 0;
      await withApi({ callFetcher: () => (calls++, Promise.resolve(fetchedPage())) }, async (api) => {
        const res = await post(api, body, contentType ? { contentType } : {});
        assert.equal(res.status, status);
        const json = (await res.json()) as { error: unknown };
        assert.equal(typeof json.error, "string");
        assert.equal(calls, 0);
      });
    });
  }

  test("url com exatamente 2048 caracteres é aceita", async () => {
    await withApi({ callFetcher: returning(fetchedPage()) }, async (api) => {
      const url = `https://a.example/${"a".repeat(2048 - "https://a.example/".length)}`;
      assert.equal(url.length, 2048);
      assert.equal((await post(api, { url })).status, 200);
    });
  });

  test("corpo inválido não gasta a cota do usuário", async () => {
    const limiter = new RateLimiter({ windowMs: 3_600_000 });
    await withApi({ limiter, callFetcher: returning(fetchedPage()) }, async (api) => {
      for (let i = 0; i < 12; i++) assert.equal((await post(api, { url: 42 })).status, 400);
      assert.equal((await post(api, { url: PAGE_URL }, { contentType: "text/plain" })).status, 415);
      assert.equal(limiter.trackedKeys, 0, "nenhuma chave criada por corpo inválido");
      for (let i = 0; i < 10; i++) assert.equal((await post(api, { url: PAGE_URL })).status, 200, `checagem ${i + 1}`);
      assert.equal((await post(api, { url: PAGE_URL })).status, 429);
    });
  });
});

describe("POST /api/check: limite por usuário e capacidade", () => {
  test("a 11ª checagem na hora → 429 com Retry-After e mensagem em português; outro usuário segue livre", async () => {
    await withApi({ callFetcher: returning(fetchedPage()) }, async (api) => {
      for (let i = 0; i < 10; i++) assert.equal((await post(api, { url: PAGE_URL })).status, 200);
      const res = await post(api, { url: PAGE_URL });
      assert.equal(res.status, 429);
      const retryAfter = Number(res.headers.get("retry-after"));
      assert.ok(Number.isInteger(retryAfter) && retryAfter > 0 && retryAfter <= 3600);
      const body = (await res.json()) as { error: string; message: string };
      assert.equal(body.error, "rate_limited");
      assert.match(body.message, /^Você atingiu o limite de 10 verificações por hora\. Tente novamente em \d+ minutos?\.$/);
      assert.equal((await post(api, { url: PAGE_URL }, { token: OTHER })).status, 200);
    });
  });

  test("fetcher ocupado → 503 com Retry-After e a vaga é devolvida", async () => {
    await withApi({ callFetcher: returning({ kind: "busy" }) }, async (api) => {
      for (let i = 0; i < 12; i++) {
        const res = await post(api, { url: PAGE_URL });
        assert.equal(res.status, 503);
        assert.equal(res.headers.get("retry-after"), "5");
        assert.deepEqual(await res.json(), { error: "busy", message: "Serviço ocupado, tente novamente em instantes." });
      }
    });
  });

  test("acima do teto de checagens em andamento → 503, sem gastar cota", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const limiter = new RateLimiter({ windowMs: 3_600_000 });
    await withApi(
      { maxInFlightChecks: 1, limiter, callFetcher: () => gate.then(() => fetchedPage()) },
      async (api) => {
        const first = post(api, { url: PAGE_URL });
        await new Promise((resolve) => setTimeout(resolve, 50));
        const second = await post(api, { url: PAGE_URL }, { token: OTHER });
        assert.equal(second.status, 503);
        assert.equal(second.headers.get("retry-after"), "5");
        assert.equal(((await second.json()) as { error: string }).error, "busy");
        release();
        assert.equal((await first).status, 200);
        assert.equal(limiter.trackedKeys, 1, "só a primeira checagem contou");
      },
    );
  });
});

describe("POST /api/check: mensagens unificadas", () => {
  async function errorResponse(outcome: FetcherOutcome): Promise<{ status: number; body: string; retryAfter: string | null }> {
    let result = { status: 0, body: "", retryAfter: null as string | null };
    await withApi({ callFetcher: returning(outcome) }, async (api) => {
      const res = await post(api, { url: PAGE_URL });
      result = { status: res.status, body: await res.text(), retryAfter: res.headers.get("retry-after") };
    });
    return result;
  }

  test("blocked, network e timeout respondem byte a byte igual", async () => {
    const responses = await Promise.all(
      (["blocked", "network", "timeout"] as const).map((category) => errorResponse({ kind: "fetch_error", category })),
    );
    for (const response of responses) assert.deepEqual(response, responses[0]);
    assert.equal(responses[0]?.status, 422);
    assert.deepEqual(JSON.parse(responses[0]?.body ?? ""), { error: "unreachable", message: "Não foi possível acessar este endereço." });
  });

  test("upstream_status mostra o código HTTP", async () => {
    const { status, body } = await errorResponse({ kind: "fetch_error", category: "upstream_status", httpStatus: 403 });
    assert.equal(status, 422);
    assert.deepEqual(JSON.parse(body), { error: "upstream_status", message: "O site respondeu com erro (HTTP 403).", httpStatus: 403 });
  });

  test("invalid_url tem mensagem própria", async () => {
    const { status, body } = await errorResponse({ kind: "fetch_error", category: "invalid_url" });
    assert.equal(status, 422);
    assert.deepEqual(JSON.parse(body), { error: "invalid_url", message: "Endereço inválido." });
  });

  test("401, erro e resposta malformada do fetcher → 502 genérico e igual", async () => {
    const outcomes: FetcherOutcome[] = [
      { kind: "unauthorized" },
      { kind: "failed", reason: "status" },
      { kind: "failed", reason: "network" },
      { kind: "failed", reason: "malformed" },
      { kind: "failed", reason: "token" },
    ];
    const responses = await Promise.all(outcomes.map(errorResponse));
    for (const response of responses) assert.deepEqual(response, responses[0]);
    assert.equal(responses[0]?.status, 502);
    assert.deepEqual(JSON.parse(responses[0]?.body ?? ""), {
      error: "internal",
      message: "Não foi possível concluir a análise. Tente novamente.",
    });
  });

  test("prazo esgotado → 504", async () => {
    const { status, body } = await errorResponse({ kind: "timeout" });
    assert.equal(status, 504);
    assert.deepEqual(JSON.parse(body), { error: "timeout", message: "A análise demorou demais. Tente novamente." });
  });
});

describe("POST /api/check: relatório", () => {
  test("devolve página, todas as mídias com a seleção e o resultado do download, sem bytes", async () => {
    await withApi({ callFetcher: returning(fetchedPage()) }, async (api) => {
      const res = await post(api, { url: PAGE_URL });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      const text = await res.text();
      assert.equal(text.includes(CAPA_BYTES.toString("base64")), false, "bytes em base64 não podem ir na resposta");
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), ["media", "notices", "page"]);
      assert.deepEqual(body["page"], {
        finalUrl: PAGE_URL,
        title: "Matéria de exemplo",
        headline: "Manchete inventada",
        possiblyNeedsJavaScript: false,
      });
      const media = body["media"] as Array<Record<string, unknown>>;
      assert.equal(media.length, 3);
      assert.deepEqual(media[0], {
        url: "https://cdn.example/og/capa.jpg",
        kind: "image",
        source: "og:image",
        group: 1,
        score: 100,
        selected: true,
        skipReason: null,
        download: { status: "ok", contentType: "image/jpeg", size: CAPA_BYTES.length, sha256: "a".repeat(64) },
      });
      assert.deepEqual(media[1]?.["download"], {
        status: "error",
        error: "upstream_status",
        message: "O site respondeu com erro (HTTP 404).",
        httpStatus: 404,
      });
      assert.equal(media[2]?.["download"], null);
      assert.equal(media[2]?.["skipReason"], "icon");
      const notices = body["notices"] as string[];
      assert.ok(notices.some((notice) => notice.includes("automática e heurística")));
    });
  });

  test("blocked, network e timeout de mídia aparecem iguais", async () => {
    for (const error of ["blocked", "network", "timeout"] as const) {
      const outcome = fetchedPage();
      if (outcome.kind !== "page") throw new Error("fixture");
      outcome.page.downloads[1] = { url: String(FOTO_REF["url"]), kind: "image", source: "img", group: 2, ok: false, error };
      await withApi({ callFetcher: returning(outcome) }, async (api) => {
        const body = (await (await post(api, { url: PAGE_URL })).json()) as { media: Array<Record<string, unknown>> };
        assert.deepEqual(body.media[1]?.["download"], { status: "error", error: "unreachable", message: "Não foi possível acessar este endereço." });
      });
    }
  });

  test("sinal de JavaScript vira aviso de possibilidade", async () => {
    const outcome: FetcherOutcome = {
      kind: "page",
      page: { finalUrl: PAGE_URL, title: null, headline: null, possiblyNeedsJavaScript: true, media: [], downloads: [] },
    };
    await withApi({ callFetcher: returning(outcome) }, async (api) => {
      const body = (await (await post(api, { url: PAGE_URL })).json()) as { page: Record<string, unknown>; notices: string[] };
      assert.equal(body.page["possiblyNeedsJavaScript"], true);
      assert.ok(body.notices.some((notice) => notice.includes("possivelmente depende de JavaScript")));
    });
  });

  test("ponta a ponta com o cliente real contra um fetcher falso", async () => {
    const fake = await startFakeFetcher((_req, res) => sendNdjson(res, standardStream()));
    try {
      const callFetcher = createFetcherClient({ fetcherUrl: fake.url, token: () => Promise.resolve(TEST_SERVICE_TOKEN) });
      await withApi({ callFetcher }, async (api) => {
        const res = await post(api, { url: PAGE_URL });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { media: Array<{ download: { status: string } | null }> };
        assert.deepEqual(
          body.media.map((item) => item.download?.status ?? null),
          ["ok", "error", null],
        );
        assert.equal(fake.requests[0]?.headers.authorization, `Bearer ${TEST_SERVICE_TOKEN}`);
        assert.deepEqual(JSON.parse(fake.requests[0]?.body ?? ""), { url: PAGE_URL });
      });
    } finally {
      await fake.close();
    }
  });

  test("usuário que fecha a conexão cancela a chamada ao fetcher", async () => {
    let aborted = false;
    const callFetcher: FetcherCall = (_url, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve({ kind: "aborted" });
        });
      });
    await withApi({ callFetcher }, async (api) => {
      const controller = new AbortController();
      const pending = post(api, { url: PAGE_URL }, { signal: controller.signal }).catch(() => null);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await pending;
      for (let i = 0; i < 50 && !aborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(aborted, true);
      for (let i = 0; i < 50 && api.logs.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(api.logs.at(-1)?.outcome, "client_closed");
    });
  });
});

describe("POST /api/check: logs e disco", () => {
  test("uma linha por requisição, com resultado, hash do domínio e mídias; sem URL, token, e-mail nem bytes", async () => {
    await withApi({ callFetcher: returning(fetchedPage()) }, async (api) => {
      await post(api, { url: PAGE_URL });
      await post(api, { url: "https://noticias.example/outra-materia?id=123" });
      assert.equal(api.logs.length, 2);
      const [first, second] = api.logs;
      assert.equal(first?.route, "/api/check");
      assert.equal(first?.status, 200);
      assert.equal(first?.outcome, "ok");
      assert.equal(first?.mediaCount, 1);
      assert.match(first?.domainHash ?? "", /^[0-9a-f]{16}$/);
      assert.equal(first?.domainHash, second?.domainHash, "mesmo domínio, mesmo hash");
      const dump = JSON.stringify(api.logs);
      for (const secret of [
        "noticias.example",
        "materia",
        "cdn.example",
        GOOD,
        "pessoa",
        "sub-1",
        CAPA_BYTES.toString("base64"),
        "Matéria",
      ]) {
        assert.equal(dump.includes(secret), false, `log vazou: ${secret}`);
      }
    });
  });

  test("a categoria interna vai só para o log", async () => {
    await withApi({ callFetcher: returning({ kind: "fetch_error", category: "blocked" }) }, async (api) => {
      const res = await post(api, { url: PAGE_URL });
      assert.equal((await res.text()).includes("blocked"), false);
      assert.equal(api.logs[0]?.outcome, "fetch_blocked");
    });
  });

  test("limite estourado e corpo inválido também têm resultado no log", async () => {
    const limiter = new RateLimiter({ windowMs: 3_600_000 });
    await withApi({ limiter, callFetcher: returning(fetchedPage()) }, async (api) => {
      await post(api, { url: 42 });
      for (let i = 0; i < 11; i++) await post(api, { url: PAGE_URL });
      assert.equal(api.logs[0]?.outcome, "bad_request");
      assert.equal(api.logs.at(-1)?.outcome, "rate_limited");
    });
  });

  test("nada é gravado em disco durante uma checagem", async () => {
    await withApi({ callFetcher: returning(fetchedPage()) }, async (api) => {
      const spies = [
        mock.method(fs, "writeFileSync"),
        mock.method(fs, "appendFileSync"),
        mock.method(fs, "createWriteStream"),
        mock.method(fs, "openSync"),
        mock.method(fsp, "writeFile"),
        mock.method(fsp, "appendFile"),
        mock.method(fsp, "open"),
      ];
      try {
        assert.equal((await post(api, { url: PAGE_URL })).status, 200);
        await post(api, { url: 42 });
        for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
      } finally {
        mock.restoreAll();
      }
    });
  });
});
