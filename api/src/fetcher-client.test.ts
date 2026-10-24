import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";

import { createFetcherClient, type FetcherClientLimits, type FetcherOutcome } from "./fetcher-client.ts";
import {
  CAPA_BYTES,
  CAPA_REF,
  DONE_LINE,
  FOTO_BYTES,
  FOTO_REF,
  ICONE_REF,
  mediaErrorLine,
  mediaLine,
  ndjson,
  PAGE_URL,
  pageLine,
  sendJsonResponse,
  sendNdjson,
  standardStream,
  startFakeFetcher,
  TEST_SERVICE_TOKEN,
  type FakeFetcherHandler,
} from "./testing.ts";

// Prazos curtos nos testes; produção usa os padrões (os limites só podem ser reduzidos).
const FAST: Partial<FetcherClientLimits> = { deadlineMs: 1_500, retryReserveMs: 0, maxRetryWaitMs: 50 };

async function run(
  handler: FakeFetcherHandler,
  limits: Partial<FetcherClientLimits> = FAST,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ outcome: FetcherOutcome; requests: number; elapsedMs: number }> {
  const fake = await startFakeFetcher(handler);
  try {
    const call = createFetcherClient({ fetcherUrl: `${fake.url}/`, token: () => Promise.resolve(TEST_SERVICE_TOKEN), limits });
    const started = performance.now();
    const outcome = await call(PAGE_URL, signal);
    return { outcome, requests: fake.requests.length, elapsedMs: performance.now() - started };
  } finally {
    await fake.close();
  }
}

// Página só com o ícone ignorado: o grupo precisa estar entre 1 e o número de itens.
const ONLY_ICON = { ...ICONE_REF, group: 1 };

const respond =
  (body: string | Buffer, chunkBytes = 0): FakeFetcherHandler =>
  (_req, res) =>
    sendNdjson(res, body, chunkBytes);

function assertMalformed(outcome: FetcherOutcome, label: string): void {
  assert.deepEqual(outcome, { kind: "failed", reason: "malformed" }, label);
}

describe("cliente do fetcher: resposta válida", () => {
  test("lê o NDJSON inteiro: página, mídias, bytes e erros por mídia", async () => {
    const { outcome } = await run(respond(standardStream()));
    assert.equal(outcome.kind, "page");
    if (outcome.kind !== "page") return;
    const { page } = outcome;
    assert.equal(page.finalUrl, PAGE_URL);
    assert.equal(page.title, "Matéria de exemplo");
    assert.equal(page.headline, "Manchete inventada");
    assert.equal(page.possiblyNeedsJavaScript, false);
    assert.deepEqual(page.media, [CAPA_REF, FOTO_REF, ICONE_REF]);
    assert.equal(page.downloads.length, 2);
    const [capa, foto] = page.downloads;
    assert.ok(capa?.ok);
    assert.ok(capa.bytes.equals(CAPA_BYTES));
    assert.equal(capa.size, CAPA_BYTES.length);
    assert.equal(capa.contentType, "image/jpeg");
    assert.match(capa.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(foto, { url: FOTO_REF["url"], kind: "image", source: "img", group: 2, ok: false, error: "blocked" });
  });

  test("aceita o corpo em fatias que cortam linhas e caracteres UTF-8", async () => {
    const { outcome } = await run(respond(standardStream(), 7));
    assert.equal(outcome.kind, "page");
    if (outcome.kind !== "page") return;
    assert.equal(outcome.page.title, "Matéria de exemplo");
    const [capa] = outcome.page.downloads;
    assert.ok(capa?.ok && capa.bytes.equals(CAPA_BYTES));
  });

  test("upstream_status em mídia guarda só o código HTTP válido", async () => {
    const body = ndjson([pageLine(), mediaErrorLine(CAPA_REF, "upstream_status", 404), mediaLine(FOTO_REF, FOTO_BYTES), DONE_LINE]);
    const { outcome } = await run(respond(body));
    assert.ok(outcome.kind === "page");
    assert.deepEqual(outcome.page.downloads[0], {
      url: CAPA_REF["url"],
      kind: "image",
      source: "og:image",
      group: 1,
      ok: false,
      error: "upstream_status",
      httpStatus: 404,
    });
  });

  test("página sem mídias selecionadas", async () => {
    const { outcome } = await run(respond(ndjson([pageLine({ media: [ONLY_ICON] }), DONE_LINE])));
    assert.ok(outcome.kind === "page");
    assert.deepEqual(outcome.page.downloads, []);
  });

  test("envia POST /fetch com a URL no corpo JSON e o ID token de serviço no cabeçalho", async () => {
    const fake = await startFakeFetcher(respond(standardStream()));
    try {
      const call = createFetcherClient({ fetcherUrl: fake.url, token: () => Promise.resolve(TEST_SERVICE_TOKEN), limits: FAST });
      await call(PAGE_URL, new AbortController().signal);
      const [req] = fake.requests;
      assert.equal(req?.method, "POST");
      assert.equal(req?.path, "/fetch");
      assert.equal(req?.headers.authorization, `Bearer ${TEST_SERVICE_TOKEN}`);
      assert.equal(req?.headers["content-type"], "application/json");
      assert.deepEqual(JSON.parse(req?.body ?? ""), { url: PAGE_URL });
    } finally {
      await fake.close();
    }
  });

  test("o resultado nunca contém o token de serviço", async () => {
    const { outcome } = await run(respond(standardStream()));
    assert.equal(JSON.stringify(outcome).includes(TEST_SERVICE_TOKEN), false);
  });
});

describe("cliente do fetcher: 503 e novas tentativas", () => {
  test("tenta de novo depois de 503 com Retry-After e segue quando o fetcher libera", async () => {
    let calls = 0;
    const { outcome, requests } = await run((_req, res) => {
      calls++;
      if (calls <= 2) return sendJsonResponse(res, 503, { error: "Serviço ocupado" }, { "Retry-After": "0" });
      return sendNdjson(res, standardStream());
    });
    assert.equal(outcome.kind, "page");
    assert.equal(requests, 3);
  });

  test("esgota as 2 novas tentativas e devolve busy", async () => {
    const { outcome, requests } = await run((_req, res) =>
      sendJsonResponse(res, 503, { error: "Serviço ocupado" }, { "Retry-After": "1" }),
    );
    assert.deepEqual(outcome, { kind: "busy" });
    assert.equal(requests, 3);
  });

  test("não tenta de novo se a espera não couber no prazo", async () => {
    const { outcome, requests } = await run(
      (_req, res) => sendJsonResponse(res, 503, { error: "Serviço ocupado" }, { "Retry-After": "1" }),
      { ...FAST, retryReserveMs: 60_000 },
    );
    assert.deepEqual(outcome, { kind: "busy" });
    assert.equal(requests, 1);
  });

  test("Retry-After absurdo não faz esperar além do teto", async () => {
    const { outcome, elapsedMs } = await run((_req, res) => sendJsonResponse(res, 503, {}, { "Retry-After": "86400" }));
    assert.deepEqual(outcome, { kind: "busy" });
    assert.ok(elapsedMs < 1_000, `esperou ${Math.round(elapsedMs)} ms`);
  });
});

describe("cliente do fetcher: erros do fetcher", () => {
  for (const category of ["invalid_url", "blocked", "timeout", "too_large", "unsupported_type", "too_many_redirects", "network"]) {
    test(`422 ${category} vira fetch_error sem o corpo cru`, async () => {
      const { outcome } = await run((_req, res) =>
        sendJsonResponse(res, 422, { error: category, message: "detalhe interno 10.0.0.5 intranet.corp" }),
      );
      assert.deepEqual(outcome, { kind: "fetch_error", category });
    });
  }

  test("422 upstream_status mantém só o httpStatus válido", async () => {
    const ok = await run((_req, res) => sendJsonResponse(res, 422, { error: "upstream_status", message: "x", httpStatus: 403 }));
    assert.deepEqual(ok.outcome, { kind: "fetch_error", category: "upstream_status", httpStatus: 403 });
    const bad = await run((_req, res) => sendJsonResponse(res, 422, { error: "upstream_status", message: "x", httpStatus: 9999 }));
    assert.deepEqual(bad.outcome, { kind: "fetch_error", category: "upstream_status" });
  });

  test("422 com categoria desconhecida ou corpo inválido é resposta malformada", async () => {
    assertMalformed((await run((_req, res) => sendJsonResponse(res, 422, { error: "outra" }))).outcome, "categoria");
    assertMalformed((await run((_req, res) => void res.writeHead(422).end("<html>"))).outcome, "corpo");
  });

  test("401 do fetcher vira unauthorized (erro de configuração nosso)", async () => {
    const { outcome } = await run((_req, res) => sendJsonResponse(res, 401, { error: "Não autorizado" }));
    assert.deepEqual(outcome, { kind: "unauthorized" });
  });

  for (const status of [400, 404, 500]) {
    test(`status ${status} vira failed/status`, async () => {
      const { outcome } = await run((_req, res) => sendJsonResponse(res, status, { error: "x" }));
      assert.deepEqual(outcome, { kind: "failed", reason: "status" });
    });
  }

  test("conexão recusada vira failed/network", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const call = createFetcherClient({
      fetcherUrl: `http://127.0.0.1:${port}`,
      token: () => Promise.resolve(TEST_SERVICE_TOKEN),
      limits: FAST,
    });
    assert.deepEqual(await call(PAGE_URL, new AbortController().signal), { kind: "failed", reason: "network" });
  });

  test("falha ao obter o token vira failed/token e não chama o fetcher", async () => {
    const fake = await startFakeFetcher(respond(standardStream()));
    try {
      const call = createFetcherClient({ fetcherUrl: fake.url, token: () => Promise.reject(new Error("sem credencial")), limits: FAST });
      assert.deepEqual(await call(PAGE_URL, new AbortController().signal), { kind: "failed", reason: "token" });
      assert.equal(fake.requests.length, 0);
    } finally {
      await fake.close();
    }
  });
});

describe("cliente do fetcher: prazo", () => {
  test("fetcher que não responde os cabeçalhos: timeout dentro do prazo", async () => {
    const { outcome, elapsedMs } = await run(() => {}, { ...FAST, deadlineMs: 300 });
    assert.deepEqual(outcome, { kind: "timeout" });
    assert.ok(elapsedMs < 2_000, `levou ${Math.round(elapsedMs)} ms`);
  });

  test("stream que trava depois da linha page: timeout", async () => {
    const { outcome, elapsedMs } = await run(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        res.write(ndjson([pageLine()]));
      },
      { ...FAST, deadlineMs: 300 },
    );
    assert.deepEqual(outcome, { kind: "timeout" });
    assert.ok(elapsedMs < 2_000, `levou ${Math.round(elapsedMs)} ms`);
  });

  test("stream gotejando (um byte por vez) não escapa do prazo total", async () => {
    const { outcome, elapsedMs } = await run(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/x-ndjson" });
        const timer = setInterval(() => res.write(" "), 20);
        res.on("close", () => clearInterval(timer));
      },
      { ...FAST, deadlineMs: 300 },
    );
    assert.deepEqual(outcome, { kind: "timeout" });
    assert.ok(elapsedMs < 2_000, `levou ${Math.round(elapsedMs)} ms`);
  });

  test("cancelamento de quem chamou vira aborted", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { outcome } = await run(() => {}, FAST, controller.signal);
    assert.deepEqual(outcome, { kind: "aborted" });
  });
});

describe("cliente do fetcher: resposta malformada", () => {
  const capaOk = (): Record<string, unknown> => mediaLine(CAPA_REF, CAPA_BYTES);
  const fotoBlocked = (): Record<string, unknown> => mediaErrorLine(FOTO_REF, "blocked");
  const cases: Array<[string, () => string | Buffer]> = [
    ["JSON inválido", () => `${JSON.stringify(pageLine())}\n{nao-e-json\n`],
    ["sem a linha done", () => ndjson([pageLine(), capaOk(), fotoBlocked()])],
    ["primeira linha não é page", () => ndjson([capaOk(), pageLine(), DONE_LINE])],
    ["conteúdo depois de done", () => ndjson([pageLine({ media: [ONLY_ICON] }), DONE_LINE, DONE_LINE])],
    ["linha page duplicada", () => ndjson([pageLine({ media: [ONLY_ICON] }), pageLine({ media: [ONLY_ICON] }), DONE_LINE])],
    ["campo desconhecido na página", () => ndjson([pageLine({ extra: 1 }), DONE_LINE])],
    ["skipReason desconhecido", () => ndjson([pageLine({ media: [{ ...ONLY_ICON, skipReason: "outro" }] }), DONE_LINE])],
    ["selected sem coerência com skipReason", () => ndjson([pageLine({ media: [{ ...ONLY_ICON, selected: true }] }), DONE_LINE])],
    ["título longo demais", () => ndjson([pageLine({ title: "a".repeat(301), media: [] }), DONE_LINE])],
    ["finalUrl que não é http(s)", () => ndjson([pageLine({ finalUrl: "javascript:alert(1)", media: [] }), DONE_LINE])],
    ["tipo de linha desconhecido", () => ndjson([pageLine(), { type: "outra" }, DONE_LINE])],
    ["size diferente dos bytes", () => ndjson([pageLine(), mediaLine(CAPA_REF, CAPA_BYTES, { size: 1 }), fotoBlocked(), DONE_LINE])],
    [
      "SHA-256 que não confere",
      () => ndjson([pageLine(), mediaLine(CAPA_REF, CAPA_BYTES, { sha256: "0".repeat(64) }), fotoBlocked(), DONE_LINE]),
    ],
    ["base64 inválido", () => ndjson([pageLine(), mediaLine(CAPA_REF, CAPA_BYTES, { data: "!!!*" }), fotoBlocked(), DONE_LINE])],
    [
      "content-type fora da lista",
      () => ndjson([pageLine(), mediaLine(CAPA_REF, CAPA_BYTES, { contentType: "text/html" }), fotoBlocked(), DONE_LINE]),
    ],
    ["mídia que não foi selecionada", () => ndjson([pageLine(), mediaLine(ICONE_REF, CAPA_BYTES), fotoBlocked(), DONE_LINE])],
    ["mídia repetida", () => ndjson([pageLine(), capaOk(), capaOk(), DONE_LINE])],
    ["grupo diferente do da página", () => ndjson([pageLine(), mediaLine({ ...CAPA_REF, group: 2 }, CAPA_BYTES), fotoBlocked(), DONE_LINE])],
    ["faltou o resultado de uma selecionada", () => ndjson([pageLine(), capaOk(), DONE_LINE])],
    ["categoria de erro desconhecida", () => ndjson([pageLine(), capaOk(), mediaErrorLine(FOTO_REF, "outra"), DONE_LINE])],
    ["httpStatus fora de upstream_status", () => ndjson([pageLine(), capaOk(), mediaErrorLine(FOTO_REF, "blocked", 404), DONE_LINE])],
    [
      "UTF-8 inválido",
      () => {
        const [before, after] = ndjson([pageLine({ media: [] }), DONE_LINE]).split("Matéria");
        return Buffer.concat([Buffer.from(before ?? ""), Buffer.from([0xff, 0xfe]), Buffer.from(after ?? "")]);
      },
    ],
  ];

  for (const [name, body] of cases) {
    test(name, async () => {
      assertMalformed((await run(respond(body()))).outcome, name);
    });
  }

  test("Content-Type diferente de application/x-ndjson", async () => {
    const { outcome } = await run((_req, res) => void res.writeHead(200, { "Content-Type": "text/html" }).end(standardStream()));
    assertMalformed(outcome, "content-type");
  });

  test("linha acima do limite é recusada", async () => {
    const huge = ndjson([pageLine(), mediaLine(CAPA_REF, Buffer.alloc(4096, 1)), fotoBlocked(), DONE_LINE]);
    assertMalformed((await run(respond(huge), { ...FAST, maxLineBytes: 2048 })).outcome, "linha");
  });

  test("resposta acima do teto total é recusada", async () => {
    const big = ndjson([pageLine(), mediaLine(CAPA_REF, Buffer.alloc(3000, 1)), mediaLine(FOTO_REF, Buffer.alloc(3000, 2)), DONE_LINE]);
    assertMalformed((await run(respond(big), { ...FAST, maxTotalBytes: 6000 })).outcome, "total");
  });
});
