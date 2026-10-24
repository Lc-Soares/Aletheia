import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, mock, test } from "node:test";

import {
  createExifToolsClient,
  EXIFTOOLS_EXTRACT_URL,
  type ExifToolsLimits,
  type ExtractResult,
} from "./exiftools-client.ts";
import {
  CAPA_BYTES,
  exifSuccess,
  type FakeExifToolsHandler,
  parseMultipart,
  sendJsonResponse,
  startFakeExifTools,
  startFakeFetcher,
  TEST_EXIFTOOLS_KEY,
} from "./testing.ts";

// Prazos curtos nos testes; produção usa os padrões (os limites só podem ser reduzidos).
const FAST: Partial<ExifToolsLimits> = { callTimeoutMs: 1_000, maxRetryWaitMs: 50, retryReserveMs: 0 };
const MEDIA = { bytes: CAPA_BYTES, contentType: "image/jpeg" };

type RunOptions = { limits?: Partial<ExifToolsLimits>; apiKey?: string; budgetMs?: number; signal?: AbortSignal };

async function run(
  handler: FakeExifToolsHandler,
  { limits = FAST, apiKey = TEST_EXIFTOOLS_KEY, budgetMs = 5_000, signal = new AbortController().signal }: RunOptions = {},
): Promise<{ result: ExtractResult; requests: number; elapsedMs: number }> {
  const fake = await startFakeExifTools(handler);
  try {
    const extract = createExifToolsClient({ apiKey, endpoint: fake.endpoint, limits });
    const started = performance.now();
    const result = await extract(MEDIA, { signal, deadlineAt: performance.now() + budgetMs });
    return { result, requests: fake.requests.length, elapsedMs: performance.now() - started };
  } finally {
    await fake.close();
  }
}

const reply =
  (status: number, body: unknown = {}, headers: Record<string, string> = {}): FakeExifToolsHandler =>
  (_req, res) =>
    sendJsonResponse(res, status, body, headers);

describe("cliente ExifTools: requisição", () => {
  test("o endereço de produção é a constante documentada", () => {
    assert.equal(EXIFTOOLS_EXTRACT_URL, "https://exiftools.com/api/v1/extract");
  });

  test("envia só o arquivo, em multipart, num único campo file com nome genérico", async () => {
    const fake = await startFakeExifTools(reply(200, exifSuccess()));
    try {
      const extract = createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: fake.endpoint, limits: FAST });
      await extract(MEDIA, { signal: new AbortController().signal, deadlineAt: performance.now() + 5_000 });
      const [req] = fake.requests;
      assert.ok(req);
      assert.equal(req.method, "POST");
      assert.match(String(req.headers["content-type"]), /^multipart\/form-data; boundary=/);
      const form = await parseMultipart(req);
      assert.deepEqual([...form.keys()], ["file"]);
      const file = form.get("file");
      assert.ok(file instanceof File);
      assert.equal(file.name, "media.jpg");
      assert.equal(file.type, "image/jpeg");
      assert.ok(Buffer.from(await file.arrayBuffer()).equals(CAPA_BYTES));
      assert.equal(form.has("url"), false);
      assert.equal(form.has("data_url"), false);
      assert.equal(req.rawBody.includes("http"), false, "nenhuma URL no corpo");
    } finally {
      await fake.close();
    }
  });

  test("a chave vai só no cabeçalho X-API-Key: nunca na query nem no corpo", async () => {
    const fake = await startFakeExifTools(reply(200, exifSuccess()));
    try {
      const extract = createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: fake.endpoint, limits: FAST });
      await extract(MEDIA, { signal: new AbortController().signal, deadlineAt: performance.now() + 5_000 });
      const [req] = fake.requests;
      assert.equal(req?.headers["x-api-key"], TEST_EXIFTOOLS_KEY);
      assert.equal(req?.path, "/api/v1/extract");
      assert.equal(req?.path.includes("?"), false);
      assert.equal(req?.rawBody.includes(TEST_EXIFTOOLS_KEY), false);
      assert.equal(req?.headers.authorization, undefined);
    } finally {
      await fake.close();
    }
  });

  for (const [contentType, name] of [
    ["image/png", "media.png"],
    ["image/webp", "media.webp"],
    ["video/mp4", "media.mp4"],
    ["video/quicktime", "media.mov"],
    ["image/x-desconhecido", "media.bin"],
  ]) {
    test(`nome genérico derivado do content-type: ${contentType} → ${name}`, async () => {
      const fake = await startFakeExifTools(reply(200, exifSuccess()));
      try {
        const extract = createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: fake.endpoint, limits: FAST });
        await extract({ bytes: CAPA_BYTES, contentType: contentType ?? "" }, { signal: new AbortController().signal, deadlineAt: performance.now() + 5_000 });
        const file = (await parseMultipart(fake.requests[0] ?? assert.fail("sem requisição"))).get("file");
        assert.ok(file instanceof File);
        assert.equal(file.name, name);
      } finally {
        await fake.close();
      }
    });
  }

  test("não segue redirecionamento (a chave iria junto para outro host)", async () => {
    const other = await startFakeFetcher((_req, res) => sendJsonResponse(res, 200, exifSuccess()));
    try {
      const { result, requests } = await run((_req, res) => void res.writeHead(307, { Location: `${other.url}/roubo` }).end());
      assert.deepEqual(result, { status: "invalid" });
      assert.equal(requests, 1, "sem nova tentativa");
      assert.equal(other.requests.length, 0, "o outro host não recebeu nada");
    } finally {
      await other.close();
    }
  });

  test("sem chave configurada: config_error sem fazer requisição", async () => {
    const { result, requests } = await run(reply(200, exifSuccess()), { apiKey: "" });
    assert.deepEqual(result, { status: "config_error" });
    assert.equal(requests, 0);
  });
});

describe("cliente ExifTools: respostas", () => {
  test("sucesso devolve o JSON para a lista permitida", async () => {
    const { result } = await run(reply(200, exifSuccess()));
    assert.equal(result.status, "ok");
    assert.ok(result.status === "ok" && typeof result.response === "object");
  });

  test("200 sem success: true é resposta inválida", async () => {
    assert.deepEqual((await run(reply(200, { success: false }))).result, { status: "invalid" });
    assert.deepEqual((await run(reply(200, [1, 2]))).result, { status: "invalid" });
    assert.deepEqual((await run((_req, res) => void res.writeHead(200).end("<html>não é json"))).result, { status: "invalid" });
  });

  const statuses: Array<[number, ExtractResult["status"]]> = [
    [400, "invalid"],
    [401, "config_error"],
    [403, "config_error"],
    [404, "invalid"],
    [413, "too_large"],
    [415, "unsupported"],
  ];
  for (const [status, expected] of statuses) {
    test(`${status} → ${expected}, sem nova tentativa`, async () => {
      const { result, requests } = await run(reply(status, { success: false, error: `erro ${TEST_EXIFTOOLS_KEY}` }));
      assert.deepEqual(result, { status: expected });
      assert.equal(requests, 1);
    });
  }

  for (const status of [429, 500, 502, 503]) {
    test(`${status} → unavailable depois de no máximo uma nova tentativa`, async () => {
      const { result, requests } = await run(reply(status, { success: false }, { "Retry-After": "0" }));
      assert.deepEqual(result, { status: "unavailable" });
      assert.equal(requests, 2);
    });
  }

  test("a nova tentativa pode dar certo", async () => {
    let calls = 0;
    const { result, requests } = await run((_req, res) => {
      calls++;
      if (calls === 1) return sendJsonResponse(res, 429, { success: false }, { "Retry-After": "0" });
      return sendJsonResponse(res, 200, exifSuccess());
    });
    assert.equal(result.status, "ok");
    assert.equal(requests, 2);
  });

  test("sem nova tentativa quando não cabe no prazo total", async () => {
    const { result, requests } = await run(reply(503, {}, { "Retry-After": "1" }), {
      limits: { ...FAST, retryReserveMs: 10_000 },
      budgetMs: 2_000,
    });
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(requests, 1);
  });

  test("Retry-After absurdo não faz esperar além do teto", async () => {
    const { result, elapsedMs } = await run(reply(429, {}, { "Retry-After": "86400" }));
    assert.deepEqual(result, { status: "unavailable" });
    assert.ok(elapsedMs < 1_000, `esperou ${Math.round(elapsedMs)} ms`);
  });
});

describe("cliente ExifTools: prazo, rede e tamanho", () => {
  test("ExifTools que não responde: unavailable no prazo da chamada", async () => {
    const { result, elapsedMs, requests } = await run(() => {}, { limits: { ...FAST, callTimeoutMs: 200 }, budgetMs: 300 });
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(requests, 1, "a segunda tentativa não cabe no prazo");
    assert.ok(elapsedMs < 2_000, `levou ${Math.round(elapsedMs)} ms`);
  });

  test("o prazo total encurta o prazo da chamada", async () => {
    const { result, elapsedMs } = await run(() => {}, { limits: { ...FAST, callTimeoutMs: 1_000 }, budgetMs: 150 });
    assert.deepEqual(result, { status: "unavailable" });
    assert.ok(elapsedMs < 900, `levou ${Math.round(elapsedMs)} ms`);
  });

  test("prazo total já esgotado: unavailable sem requisição", async () => {
    const { result, requests } = await run(reply(200, exifSuccess()), { budgetMs: -1 });
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(requests, 0);
  });

  test("cancelamento de quem chamou: unavailable e sem nova tentativa", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const { result, requests } = await run(() => {}, { signal: controller.signal });
    assert.deepEqual(result, { status: "unavailable" });
    assert.equal(requests, 1);
  });

  test("conexão recusada: unavailable", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const extract = createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: `http://127.0.0.1:${port}/api/v1/extract`, limits: FAST });
    assert.deepEqual(await extract(MEDIA, { signal: new AbortController().signal, deadlineAt: performance.now() + 5_000 }), {
      status: "unavailable",
    });
  });

  test("resposta gigante pelo Content-Length: invalid sem ler o corpo", async () => {
    const { result } = await run(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json", "Content-Length": String(10 * 1024 * 1024) });
        res.write("{");
      },
      { limits: { ...FAST, maxResponseBytes: 64 * 1024 } },
    );
    assert.deepEqual(result, { status: "invalid" });
  });

  test("resposta gigante em fluxo (sem Content-Length): invalid assim que passa do teto", async () => {
    const { result } = await run(
      (_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.write(`{"success":true,"x":"`);
        const chunk = "a".repeat(16 * 1024);
        const timer = setInterval(() => res.write(chunk), 1);
        res.on("close", () => clearInterval(timer));
      },
      { limits: { ...FAST, maxResponseBytes: 64 * 1024 } },
    );
    assert.deepEqual(result, { status: "invalid" });
  });
});

describe("cliente ExifTools: a chave nunca vaza", () => {
  test("nenhum resultado e nenhuma saída de console contém a chave", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      mock.method(console, name, (...args: unknown[]) => logged.push(args.map(String).join(" "))),
    );
    try {
      const handlers: FakeExifToolsHandler[] = [
        reply(200, exifSuccess()),
        reply(401, { success: false, error: `Invalid API key ${TEST_EXIFTOOLS_KEY}` }),
        reply(500, { error: TEST_EXIFTOOLS_KEY }),
        reply(415, {}),
        (_req, res) => void res.writeHead(200).end(`não-json ${TEST_EXIFTOOLS_KEY}`),
        (_req, res) => res.destroy(),
      ];
      for (const handler of handlers) {
        const { result } = await run(handler);
        if (result.status !== "ok") assert.equal(JSON.stringify(result).includes(TEST_EXIFTOOLS_KEY), false);
      }
      assert.equal(logged.join("\n").includes(TEST_EXIFTOOLS_KEY), false);
    } finally {
      for (const spy of spies) spy.mock.restore();
    }
  });

  test("o cliente nunca lança: falhas viram status", async () => {
    const extract = createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: "http://127.0.0.1:1/api/v1/extract", limits: FAST });
    const result = await extract(MEDIA, { signal: new AbortController().signal, deadlineAt: performance.now() + 1_000 });
    assert.deepEqual(result, { status: "unavailable" });
  });
});
