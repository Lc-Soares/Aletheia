import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { FetchError, OverloadedError } from "./errors.ts";
import { createWorkerExtractor } from "./extract-pool.ts";
import { type MediaDownload, fetchPage, type PageDeps } from "./fetch-page.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { type Limits, resolveLimits } from "./limits.ts";
import {
  collectUnhandledRejections,
  type FakeResponse,
  fakeResolver,
  fakeTransport,
  html,
  image,
  inlineExtractor,
  redirect,
  routeTransport,
  slowWorker,
} from "./testing.ts";
import type { Transport } from "./transport.ts";

const DNS = fakeResolver({
  "noticias.example": ["93.184.216.34"],
  "cdn.example": ["93.184.216.35"],
  "interno.example": ["10.1.2.3"],
});

function deps(transport: Transport, overrides: Partial<Limits> = {}): PageDeps {
  const limits = resolveLimits(overrides);
  return { resolver: DNS, transport, policy: isPublicAddress, limits, extract: createWorkerExtractor(limits) };
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const ok = (d: MediaDownload | undefined) => (d?.ok ? d : assert.fail(`esperava sucesso: ${JSON.stringify(d)}`));
const failed = (d: MediaDownload | undefined) => (d && !d.ok ? d.error : assert.fail("esperava falha"));

describe("fetchPage", () => {
  test("página completa: título, manchete, mídias e SHA-256 de cada uma", async () => {
    const transport = routeTransport({
      "https://noticias.example/materia": html(
        `<title>Título</title><meta property="og:title" content="Manchete">
         <meta property="og:image" content="https://cdn.example/capa.jpg">
         <img src="/foto.png" srcset="/foto-2x.webp 2x"><video src="https://cdn.example/v.mp4"></video>`,
      ),
      "https://cdn.example/capa.jpg": image("JPEG", "image/jpeg"),
      "https://noticias.example/foto.png": image("PNG", "image/png"),
      "https://noticias.example/foto-2x.webp": image("WEBP", "image/webp"),
      "https://cdn.example/v.mp4": image("MP4", "video/mp4"),
    });
    const result = await fetchPage("https://noticias.example/materia", deps(transport));
    assert.equal(result.title, "Título");
    assert.equal(result.headline, "Manchete");
    assert.equal(result.finalUrl, "https://noticias.example/materia");
    assert.equal(result.media.length, 4);
    assert.deepEqual(
      result.downloads.map((d) => [d.url, ok(d).contentType, ok(d).sha256, ok(d).size]),
      [
        ["https://cdn.example/capa.jpg", "image/jpeg", sha256("JPEG"), 4],
        ["https://noticias.example/foto.png", "image/png", sha256("PNG"), 3],
        ["https://noticias.example/foto-2x.webp", "image/webp", sha256("WEBP"), 4],
        ["https://cdn.example/v.mp4", "video/mp4", sha256("MP4"), 3],
      ],
    );
    assert.equal(ok(result.downloads[0]).bytes.toString(), "JPEG");
  });

  test("mídias com destino interno são bloqueadas uma a uma, sem conexão", async () => {
    const transport = routeTransport({
      "https://noticias.example/": html(
        `<img src="http://169.254.169.254/latest/meta-data/x.jpg"><img src="http://interno.example/a.jpg">
         <img src="http://[::1]/b.jpg"><img src="http://localhost/c.jpg"><img src="https://cdn.example/ok.jpg">
         <img src="https://cdn.example/redir.jpg">`,
      ),
      "https://cdn.example/ok.jpg": image("ok"),
      "https://cdn.example/redir.jpg": redirect("http://169.254.169.254/computeMetadata/v1/"),
    });
    const result = await fetchPage("https://noticias.example/", deps(transport));
    assert.deepEqual(
      result.downloads.map((d) => (d.ok ? "ok" : d.error)),
      ["blocked", "blocked", "blocked", "blocked", "ok", "blocked"],
    );
    const contacted = transport.calls.map((c) => c.url.hostname);
    assert.ok(contacted.every((host) => host === "noticias.example" || host === "cdn.example"));
  });

  test("userinfo e porta não padrão: listadas na forma normalizada e bloqueadas sem conexão", async () => {
    const transport = routeTransport({
      "https://noticias.example/": html(
        `<img src="http://u:p@10.0.0.1:22/x"><img src="http://u:p@cdn.example/a.jpg"><img src="http://cdn.example:22/b.jpg">`,
      ),
    });
    const result = await fetchPage("https://noticias.example/", deps(transport));
    assert.deepEqual(
      result.media.map((m) => m.url),
      ["http://u:p@10.0.0.1:22/x", "http://u:p@cdn.example/a.jpg", "http://cdn.example:22/b.jpg"],
    );
    assert.deepEqual(
      result.downloads.map((d) => (d.ok ? "ok" : d.error)),
      ["blocked", "blocked", "blocked"],
    );
    assert.deepEqual(transport.calls.map((c) => c.url.href), ["https://noticias.example/"]);
  });

  test("mais de 20 mídias: lista todas, baixa só 20", async () => {
    const routes: Record<string, FakeResponse> = {
      "https://noticias.example/": html(Array.from({ length: 25 }, (_, i) => `<img src="/m${i}.jpg">`).join("")),
    };
    for (let i = 0; i < 25; i++) routes[`https://noticias.example/m${i}.jpg`] = image(`m${i}`);
    const transport = routeTransport(routes);
    const result = await fetchPage("https://noticias.example/", deps(transport));
    assert.equal(result.media.length, 25);
    assert.equal(result.downloads.length, 20);
    assert.equal(transport.calls.length, 21);
  });

  test("mídia acima do limite vira item com erro; as outras seguem", async () => {
    const transport = routeTransport({
      "https://noticias.example/": html(`<img src="/grande.jpg"><img src="/pequena.jpg">`),
      "https://noticias.example/grande.jpg": image(Buffer.alloc(2048)),
      "https://noticias.example/pequena.jpg": image("p"),
    });
    const result = await fetchPage("https://noticias.example/", deps(transport, { maxMediaBytes: 1024 }));
    assert.equal(failed(result.downloads[0]), "too_large");
    assert.equal(ok(result.downloads[1]).size, 1);
  });

  test("orçamento agregado: depois de estourado, as próximas mídias são recusadas", async () => {
    const routes: Record<string, FakeResponse> = {
      "https://noticias.example/": html([1, 2, 3, 4].map((i) => `<img src="/m${i}.jpg">`).join("")),
    };
    for (const i of [1, 2, 3, 4]) routes[`https://noticias.example/m${i}.jpg`] = image(Buffer.alloc(40));
    const result = await fetchPage(
      "https://noticias.example/",
      deps(routeTransport(routes), { maxAggregateMediaBytes: 100, mediaConcurrency: 1 }),
    );
    assert.deepEqual(
      result.downloads.map((d) => (d.ok ? "ok" : d.error)),
      ["ok", "ok", "too_large", "too_large"],
    );
  });

  test("respeita a concorrência máxima", async () => {
    let inFlight = 0;
    let peak = 0;
    const transport = fakeTransport(async (req) => {
      if (req.url.pathname === "/") return html(Array.from({ length: 12 }, (_, i) => `<img src="/m${i}.jpg">`).join(""));
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight--;
      return image("x");
    });
    await fetchPage("https://noticias.example/", deps(transport, { mediaConcurrency: 3 }));
    assert.equal(peak, 3);
  });

  test("prazo da página esgota durante as mídias: itens com tempo esgotado", async () => {
    const transport = fakeTransport((req) =>
      req.url.pathname === "/" ? html(`<img src="/lenta.jpg">`) : new Promise<never>(() => {}),
    );
    // Extrator imediato: com o worker, subir a thread pode passar dos 150 ms (aconteceu no CI) e o
    // prazo esgotaria na extração, que é outro caso (teste seguinte).
    const pageDeps = { ...deps(transport, { pageTotalMs: 150 }), extract: inlineExtractor() };
    const started = performance.now();
    const result = await fetchPage("https://noticias.example/", pageDeps);
    assert.equal(failed(result.downloads[0]), "timeout");
    assert.ok(performance.now() - started < 2_000);
  });

  test("prazo da página esgota durante a extração: timeout, worker encerrado, sem rejeição solta", async () => {
    const transport = routeTransport({ "https://noticias.example/": html("<title>x</title>") });
    const limits = resolveLimits({ pageTotalMs: 150 });
    const extract = createWorkerExtractor(limits, slowWorker(1_000)); // responde muito depois do prazo
    const started = performance.now();
    const seen = await collectUnhandledRejections(async () => {
      await assert.rejects(
        fetchPage("https://noticias.example/", { ...deps(transport), limits, extract }),
        (error: unknown) => error instanceof FetchError && error.category === "timeout",
      );
    });
    assert.ok(performance.now() - started < 1_000);
    assert.deepEqual(seen, []);
    assert.equal(extract.active, 0);
  });

  test("extrator sem vaga (OverloadedError) passa direto, sem virar categoria", async () => {
    const transport = routeTransport({ "https://noticias.example/": html("<title>x</title>") });
    const extract = Object.assign(() => Promise.reject(new OverloadedError()), { active: 0 });
    await assert.rejects(fetchPage("https://noticias.example/", { ...deps(transport), extract }), OverloadedError);
  });

  test("mídia com erro HTTP: upstream_status com o código; outras falhas sem código", async () => {
    const transport = routeTransport({
      "https://noticias.example/": html(`<img src="/sumiu.jpg"><img src="http://interno.example/b.jpg">`),
    });
    const result = await fetchPage("https://noticias.example/", deps(transport));
    assert.deepEqual(
      result.downloads.map((d) => (d.ok ? "ok" : [d.error, d.httpStatus])),
      [
        ["upstream_status", 404],
        ["blocked", undefined],
      ],
    );
  });

  test("página com erro HTTP: upstream_status com o código", async () => {
    const transport = routeTransport({ "https://noticias.example/": { status: 503, headers: { "content-type": "text/html" } } });
    await assert.rejects(
      fetchPage("https://noticias.example/", deps(transport)),
      (error: unknown) => error instanceof FetchError && error.category === "upstream_status" && error.httpStatus === 503,
    );
  });

  test("falha da página inteira lança erro com categoria", async () => {
    await assert.rejects(
      fetchPage("http://interno.example/", deps(routeTransport({}))),
      (error: unknown) => error instanceof FetchError && error.category === "blocked",
    );
  });

  test("decodifica o HTML pelo charset declarado", async () => {
    const latin1 = Buffer.from("<title>Notícia</title>", "latin1");
    const transport = routeTransport({
      "https://noticias.example/": { status: 200, headers: { "content-type": "text/html; charset=ISO-8859-1" }, body: latin1 },
    });
    assert.equal((await fetchPage("https://noticias.example/", deps(transport))).title, "Notícia");
  });

  test("charset desconhecido cai para UTF-8", async () => {
    const transport = routeTransport({ "https://noticias.example/": html("<title>ok</title>", { "content-type": "text/html; charset=x-inventado" }) });
    assert.equal((await fetchPage("https://noticias.example/", deps(transport))).title, "ok");
  });
});

describe("não retenção", () => {
  test("um fetchPage completo não grava nada em disco nem escreve no console", async (t) => {
    const syncWriters = [
      "writeFile",
      "writeFileSync",
      "appendFile",
      "appendFileSync",
      "createWriteStream",
      "open",
      "openSync",
      "mkdir",
      "mkdirSync",
      "copyFile",
      "copyFileSync",
      "rename",
      "renameSync",
    ] as const;
    const promiseWriters = ["writeFile", "appendFile", "open", "mkdir", "copyFile", "rename"] as const;
    const writers = [
      ...syncWriters.map((name) => t.mock.method(fs, name)),
      ...promiseWriters.map((name) => t.mock.method(fs.promises, name)),
    ];
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((name) =>
      t.mock.method(console, name, () => {}),
    );
    const transport = routeTransport({
      "https://noticias.example/segredo-da-pessoa": html(`<img src="/a.jpg"><img src="http://interno.example/b.jpg">`),
      "https://noticias.example/a.jpg": image("a"),
    });
    await fetchPage("https://noticias.example/segredo-da-pessoa", deps(transport));
    for (const writer of writers) assert.equal(writer.mock.callCount(), 0);
    for (const call of consoleCalls) assert.equal(call.mock.callCount(), 0);
  });

  test("nenhum módulo de produção importa node:fs", () => {
    const dir = new URL(".", import.meta.url);
    const production = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts");
    assert.ok(production.length > 5);
    for (const file of production) {
      const source = readFileSync(new URL(file, dir), "utf8");
      assert.doesNotMatch(source, /from\s+["'](node:)?fs(\/promises)?["']/, file);
      assert.doesNotMatch(source, /import\(\s*["'](node:)?fs/, file);
    }
  });
});
