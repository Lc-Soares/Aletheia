import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { TokenVerifier } from "./auth.ts";
import type { CheckDeps } from "./check.ts";
import { createExifToolsClient, type ExtractCall, type ExtractResult } from "./exiftools-client.ts";
import { createFetcherClient, type FetcherOutcome } from "./fetcher-client.ts";
import { createApiServer, shutdown, type LogEntry } from "./server.ts";
import {
  contentCredentials,
  DONE_LINE,
  exifSuccess,
  mediaLine,
  mediaRef,
  ndjson,
  PAGE_URL,
  pageLine,
  pageWithDownloads,
  parseMultipart,
  sendJsonResponse,
  sendNdjson,
  startFakeExifTools,
  startFakeFetcher,
  TEST_EXIFTOOLS_KEY,
  TEST_SERVICE_TOKEN,
  testCheckDeps,
} from "./testing.ts";

const GOOD = "good.token.value";
const verifier: TokenVerifier = async (token) => {
  if (token === GOOD) return { email: "pessoa@example.com", sub: "sub-1" };
  throw new Error("token recusado");
};

type Api = { base: string; logs: LogEntry[]; close: () => Promise<void> };
type Report = { media: Array<Record<string, unknown>>; notices: string[] };

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

function post(api: Api, signal?: AbortSignal): Promise<Response> {
  return fetch(`${api.base}/api/check`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${GOOD}` },
    body: JSON.stringify({ url: PAGE_URL }),
    ...(signal ? { signal } : {}),
  });
}

async function report(api: Api): Promise<Report> {
  const res = await post(api);
  assert.equal(res.status, 200);
  return (await res.json()) as Report;
}

const returning = (outcome: FetcherOutcome) => () => Promise.resolve(outcome);
const metadataOf = (body: Report): unknown[] => body.media.map((item) => item["metadata"]);

// ExifTools falsa em memória: a resposta depende dos bytes ("midia-<i>").
function extractBy(results: Record<string, ExtractResult>): ExtractCall {
  return (media) => Promise.resolve(results[media.bytes.toString()] ?? { status: "ok", response: exifSuccess() });
}

const UNAVAILABLE = { status: "unavailable", message: "Análise de metadados indisponível no momento." };

describe("POST /api/check: sinais por mídia", () => {
  test("falha em uma mídia não derruba as outras: cada mídia tem o próprio status", async () => {
    const extract = extractBy({
      "midia-2": { status: "unavailable" },
      "midia-3": { status: "unsupported" },
      "midia-4": { status: "too_large" },
      "midia-5": { status: "invalid" },
    });
    await withApi({ callFetcher: returning(pageWithDownloads(5)), extract }, async (api) => {
      const metadata = metadataOf(await report(api));
      assert.equal((metadata[0] as { status: string }).status, "ok");
      assert.deepEqual(metadata.slice(1), [
        UNAVAILABLE,
        { status: "unsupported", message: "Formato não suportado pela análise de metadados." },
        { status: "too_large", message: "Arquivo grande demais para a análise de metadados." },
        { status: "error", message: "Não foi possível analisar os metadados deste arquivo." },
      ]);
    });
  });

  test("os sinais usam o SHA-256 conferido pela API", async () => {
    const outcome = pageWithDownloads(1);
    await withApi({ callFetcher: returning(outcome) }, async (api) => {
      const [first] = metadataOf(await report(api)) as Array<{ signals: { sha256: string } }>;
      assert.ok(outcome.kind === "page" && outcome.page.media[0] !== undefined);
      assert.match(first?.signals.sha256 ?? "", /^[0-9a-f]{64}$/);
      assert.notEqual(first?.signals.sha256, "a5e50cbe66078249973d9a71230c4a8edbaedc26af11204042d3bce1f9ed4409");
    });
  });

  test("chave inválida (config_error): mensagem genérica, chamadas restantes puladas, motivo só no log", async () => {
    let calls = 0;
    const extract: ExtractCall = async () => {
      calls++;
      await sleep(10);
      return { status: "config_error" };
    };
    await withApi({ callFetcher: returning(pageWithDownloads(6)), extract }, async (api) => {
      const body = await report(api);
      assert.ok(calls <= 2, `${calls} chamadas com chave inválida`);
      for (const metadata of metadataOf(body)) assert.deepEqual(metadata, UNAVAILABLE);
      assert.equal(JSON.stringify(body).includes("config"), false);
      assert.ok((api.logs[0]?.exif?.["config_error"] ?? 0) >= 1);
    });
  });

  test("respeita maxMediaPerCheck do plano (8): as demais ficam sem análise, com o motivo", async () => {
    let calls = 0;
    const extract: ExtractCall = () => {
      calls++;
      return Promise.resolve({ status: "ok", response: exifSuccess() });
    };
    await withApi({ callFetcher: returning(pageWithDownloads(10)), extract }, async (api) => {
      const metadata = metadataOf(await report(api));
      assert.equal(calls, 8);
      assert.deepEqual(metadata.slice(8), [
        { status: "not_analyzed", message: "Fora do limite de mídias analisadas por verificação." },
        { status: "not_analyzed", message: "Fora do limite de mídias analisadas por verificação." },
      ]);
    });
  });

  test("no máximo 2 chamadas simultâneas à ExifTools", async () => {
    let active = 0;
    let peak = 0;
    const extract: ExtractCall = async () => {
      active++;
      peak = Math.max(peak, active);
      await sleep(20);
      active--;
      return { status: "ok", response: exifSuccess() };
    };
    await withApi({ callFetcher: returning(pageWithDownloads(6)), extract }, async (api) => {
      await report(api);
      assert.equal(peak, 2);
    });
  });

  test("prazo total esgotado durante a ExifTools: resposta parcial, pendentes como indisponíveis", { timeout: 10_000 }, async () => {
    const seen: number[] = [];
    const extract: ExtractCall = (media, { signal, deadlineAt }) => {
      seen.push(deadlineAt - performance.now());
      if (media.bytes.toString() === "midia-1") return Promise.resolve({ status: "ok", response: exifSuccess() });
      return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ status: "unavailable" })));
    };
    await withApi({ callFetcher: returning(pageWithDownloads(3)), extract, totalDeadlineMs: 300 }, async (api) => {
      const started = performance.now();
      const metadata = metadataOf(await report(api));
      assert.ok(performance.now() - started < 3_000, "a resposta sai depois do prazo, sem esperar");
      assert.equal((metadata[0] as { status: string }).status, "ok");
      assert.deepEqual(metadata.slice(1), [UNAVAILABLE, UNAVAILABLE]);
      for (const remaining of seen) assert.ok(remaining <= 300, `prazo repassado: ${remaining}`);
    });
  });

  test("usuário que fecha a conexão cancela as chamadas à ExifTools", { timeout: 10_000 }, async () => {
    let aborted = 0;
    let entered = (): void => {};
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const extract: ExtractCall = (_media, { signal }) =>
      new Promise((resolve) => {
        entered();
        signal.addEventListener("abort", () => {
          aborted++;
          resolve({ status: "unavailable" });
        });
      });
    await withApi({ callFetcher: returning(pageWithDownloads(2)), extract }, async (api) => {
      const controller = new AbortController();
      const pending = post(api, controller.signal).catch(() => null);
      await inside;
      controller.abort();
      await pending;
      for (let i = 0; i < 50 && aborted < 2; i++) await sleep(10);
      assert.equal(aborted, 2);
    });
  });

  test("resposta hostil: sem coordenadas nem nomes; GPS e autoria só como booleanos", async () => {
    const hostile = exifSuccess({
      author: "Fulano de Tal",
      metadata: {
        GPS: { GPSLatitude: "23 deg 33' S", GPSLongitude: "46 deg 38' W" },
        Composite: { GPSPosition: "23.5501 S, 46.6339 W" },
        IPTC: { "By-line": "Fulano de Tal" },
        EXIF: { SerialNumber: "SN-998877" },
      },
      contentCredentials: contentCredentials({ creator: ["Fulano de Tal"] }),
    });
    await withApi({ callFetcher: returning(pageWithDownloads(1)), extract: () => Promise.resolve({ status: "ok", response: hostile }) }, async (api) => {
      const body = await report(api);
      const text = JSON.stringify(body);
      for (const secret of ["Fulano", "23.5501", "23 deg", "SN-998877", "manifest", "123e4567"]) {
        assert.equal(text.includes(secret), false, `vazou: ${secret}`);
      }
      const [first] = metadataOf(body) as Array<{ signals: { containsLocation: boolean; containsAuthorship: boolean } }>;
      assert.equal(first?.signals.containsLocation, true);
      assert.equal(first?.signals.containsAuthorship, true);
    });
  });

  test("log: mídias analisadas e contagem por status da ExifTools", async () => {
    const extract = extractBy({ "midia-2": { status: "unavailable" }, "midia-3": { status: "unsupported" } });
    await withApi({ callFetcher: returning(pageWithDownloads(3)), extract }, async (api) => {
      await report(api);
      const [entry] = api.logs;
      assert.equal(entry?.outcome, "ok");
      assert.equal(entry?.mediaCount, 3);
      assert.equal(entry?.analyzedCount, 1);
      assert.deepEqual(entry?.exif, { ok: 1, unavailable: 1, unsupported: 1 });
    });
  });

  test("sem mídia baixada: ExifTools não é chamada", async () => {
    let calls = 0;
    const outcome: FetcherOutcome = {
      kind: "page",
      page: { finalUrl: PAGE_URL, title: null, headline: null, possiblyNeedsJavaScript: true, media: [], downloads: [] },
    };
    await withApi({ callFetcher: returning(outcome), extract: () => (calls++, Promise.resolve({ status: "unavailable" })) }, async (api) => {
      await report(api);
      assert.equal(calls, 0);
      assert.equal(api.logs[0]?.analyzedCount, 0);
    });
  });
});

describe("POST /api/check: ponta a ponta com fetcher e ExifTools falsos e os clientes reais", () => {
  test("três mídias (500, 415 e ok): um status por mídia, só multipart, chave só no cabeçalho", async () => {
    const refs = [1, 2, 3].map((i) => mediaRef({ url: `https://cdn.example/f${i}.jpg`, source: "img", group: i, score: 20 }));
    const bytes = [1, 2, 3].map((i) => Buffer.from(`arquivo-${i}`));
    const stream = ndjson([pageLine({ media: refs }), ...refs.map((ref, i) => mediaLine(ref, bytes[i] ?? Buffer.alloc(0))), DONE_LINE]);
    const fetcher = await startFakeFetcher((_req, res) => sendNdjson(res, stream));
    const exiftools = await startFakeExifTools(async (req, res) => {
      const file = (await parseMultipart(req)).get("file");
      const content = file instanceof File ? Buffer.from(await file.arrayBuffer()).toString() : "";
      if (content === "arquivo-1") return sendJsonResponse(res, 500, { success: false, error: `falha ${TEST_EXIFTOOLS_KEY}` }, { "Retry-After": "0" });
      if (content === "arquivo-2") return sendJsonResponse(res, 415, { success: false, error: "File format not supported" });
      return sendJsonResponse(res, 200, exifSuccess());
    });
    try {
      const deps = {
        callFetcher: createFetcherClient({ fetcherUrl: fetcher.url, token: () => Promise.resolve(TEST_SERVICE_TOKEN) }),
        extract: createExifToolsClient({ apiKey: TEST_EXIFTOOLS_KEY, endpoint: exiftools.endpoint }),
      };
      await withApi(deps, async (api) => {
        const res = await post(api);
        const text = await res.text();
        assert.equal(res.status, 200);
        assert.equal(text.includes(TEST_EXIFTOOLS_KEY), false, "a chave não pode aparecer na resposta");
        const body = JSON.parse(text) as Report;
        assert.deepEqual(
          metadataOf(body).map((m) => (m as { status: string }).status),
          ["unavailable", "unsupported", "ok"],
        );
        assert.equal(exiftools.requests.length, 4, "a mídia com 500 teve uma única nova tentativa");
        assert.ok(exiftools.maxConcurrent() <= 2);
        for (const req of exiftools.requests) {
          assert.equal(req.headers["x-api-key"], TEST_EXIFTOOLS_KEY);
          assert.equal(req.path, "/api/v1/extract");
          assert.deepEqual([...(await parseMultipart(req)).keys()], ["file"]);
          assert.equal(req.rawBody.includes("cdn.example"), false, "a URL da mídia não vai para a ExifTools");
          assert.equal(req.rawBody.includes("noticias.example"), false, "a URL da página não vai para a ExifTools");
        }
        assert.equal(JSON.stringify(api.logs).includes(TEST_EXIFTOOLS_KEY), false, "a chave não pode aparecer no log");
      });
    } finally {
      await fetcher.close();
      await exiftools.close();
    }
  });
});
