import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { FetchError, type FetchErrorCategory, OverloadedError } from "./errors.ts";
import { createSemaphore, createWorkerExtractor } from "./extract-pool.ts";
import { extractPage } from "./extract.ts";
import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";
import { formattingBomb, legitNewsPage, orphanEndTags } from "./testing.ts";

const PAGE = "https://noticias.example/";
const never = () => new AbortController().signal;

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

describe("extrator em worker", () => {
  test("devolve o mesmo resultado que extractPage", async () => {
    const htmlText = `<title>T</title><meta property="og:image" content="/capa.jpg"><img srcset="a.jpg 1x, b.jpg 2x">`;
    const extract = createWorkerExtractor(resolveLimits());
    assert.deepEqual(await extract(htmlText, PAGE, never()), extractPage(htmlText, PAGE));
    assert.equal(extract.active, 0);
  });

  test("repassa os limites de extração ao worker", async () => {
    const tags = Array.from({ length: 50 }, (_, i) => `<img src="/i${i}.jpg">`).join("");
    const page = await createWorkerExtractor(resolveLimits({ maxMediaRefs: 3 }))(tags, PAGE, never());
    assert.equal(page.media.length, 3);
  });

  test("página legítima de 2 MiB cabe com folga no prazo de produção", { timeout: 30_000 }, async (t) => {
    const htmlText = legitNewsPage(2 * 1024 * 1024);
    const extract = createWorkerExtractor(resolveLimits());
    const times: number[] = [];
    for (let i = 0; i < 3; i++) {
      const started = performance.now();
      const page = await extract(htmlText, PAGE, never());
      times.push(Math.round(performance.now() - started));
      assert.equal(page.title, "Notícia");
      assert.equal(page.media.length, DEFAULT_LIMITS.maxMediaRefs);
    }
    t.diagnostic(`${Buffer.byteLength(htmlText)} bytes, extração em ${times.join(", ")} ms (prazo ${DEFAULT_LIMITS.extractTotalMs} ms)`);
  });

  test("estouro de memória do parse5 vira too_large e encerra o worker", { timeout: 30_000 }, async () => {
    const extract = createWorkerExtractor(resolveLimits());
    const started = performance.now();
    await assertRejects(extract(formattingBomb(3000), PAGE, never()), "too_large");
    assert.ok(performance.now() - started < 10_000);
    assert.equal(extract.active, 0);
  });

  test("CPU sem fim vira timeout no prazo e encerra o worker", { timeout: 30_000 }, async () => {
    const extract = createWorkerExtractor(resolveLimits({ extractTotalMs: 500 }));
    const started = performance.now();
    await assertRejects(extract(orphanEndTags(300_000), PAGE, never()), "timeout"); // 3 MB: minutos sem o prazo
    assert.ok(performance.now() - started < 5_000);
    assert.equal(extract.active, 0);
  });

  test("requisição cancelada encerra o worker na hora", { timeout: 30_000 }, async () => {
    const extract = createWorkerExtractor(resolveLimits());
    const controller = new AbortController();
    const pending = extract(orphanEndTags(300_000), PAGE, controller.signal);
    setTimeout(() => controller.abort(), 100);
    const started = performance.now();
    await assertRejects(pending, "timeout");
    assert.ok(performance.now() - started < 2_000);
    assert.equal(extract.active, 0);
  });

  test("respeita a concorrência configurada; a fila espera e desiste pelo sinal", { timeout: 30_000 }, async () => {
    const extract = createWorkerExtractor(resolveLimits({ extractTotalMs: 400 }));
    assert.equal(DEFAULT_LIMITS.extractConcurrency, 2);
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, extract.active);
    }, 5);
    try {
      const hostile = orphanEndTags(300_000);
      const running = Array.from({ length: 5 }, () => assertRejects(extract(hostile, PAGE, never()), "timeout"));
      const queued = extract(hostile, PAGE, AbortSignal.timeout(50)); // desiste ainda na fila
      await assertRejects(queued, "timeout");
      assert.ok(extract.active <= 2);
      await Promise.all(running);
    } finally {
      clearInterval(sampler);
    }
    assert.equal(peak, 2);
    assert.equal(extract.active, 0);
  });

  test("fila limitada a 2 × extractConcurrency: a excedente recebe OverloadedError na hora", { timeout: 30_000 }, async () => {
    const extract = createWorkerExtractor(resolveLimits({ extractTotalMs: 300 }));
    const hostile = orphanEndTags(300_000);
    const accepted = Array.from({ length: 6 }, () => assertRejects(extract(hostile, PAGE, never()), "timeout")); // 2 rodando + 4 na fila
    const started = performance.now();
    await assert.rejects(extract(hostile, PAGE, never()), OverloadedError);
    assert.ok(performance.now() - started < 200);
    await Promise.all(accepted);
    assert.equal(extract.active, 0);
    // Com a fila vazia de novo, volta a aceitar.
    assert.equal((await extract("<title>ok</title>", PAGE, never())).title, "ok");
  });

  test("nenhum limite de extração pode ser aumentado", () => {
    const limits = resolveLimits({ extractTotalMs: 1e9, extractHeapMb: 1e6, extractConcurrency: 64 });
    assert.equal(limits.extractTotalMs, DEFAULT_LIMITS.extractTotalMs);
    assert.equal(limits.extractHeapMb, DEFAULT_LIMITS.extractHeapMb);
    assert.equal(limits.extractConcurrency, DEFAULT_LIMITS.extractConcurrency);
  });
});

// Worker falso numa URL data: (nenhum arquivo extra na imagem) que posta a expressão dada.
const fakeWorker = (message: string): URL =>
  new URL(
    `data:text/javascript,${encodeURIComponent(`import { parentPort } from "node:worker_threads"; parentPort.postMessage(${message});`)}`,
  );

describe("mensagem do worker é validada no processo principal", () => {
  const run = (message: string) => createWorkerExtractor(resolveLimits(), fakeWorker(message))("<p></p>", PAGE, never());

  test("mensagem bem formada passa", async () => {
    const page = { title: "T", headline: null, media: [{ url: "https://cdn.example/a.jpg", kind: "image", source: "img" }] };
    assert.deepEqual(await run(JSON.stringify(page)), page);
  });

  const malformed: [string, string][] = [
    ["sem mensagem útil (undefined)", "undefined"],
    ["título acima de 300 caracteres", `{ title: "a".repeat(301), headline: null, media: [] }`],
    ["esquema perigoso na mídia", `{ title: null, headline: null, media: [{ url: "file:///etc/passwd", kind: "image", source: "img" }] }`],
    [
      "mídias demais",
      `{ title: null, headline: null, media: Array.from({ length: 201 }, (_, i) => ({ url: "https://x.example/" + i, kind: "image", source: "img" })) }`,
    ],
    ["source desconhecido", `{ title: null, headline: null, media: [{ url: "https://x.example/a", kind: "image", source: "iframe" }] }`],
  ];
  for (const [name, message] of malformed) {
    test(`${name}: FetchError network e worker encerrado`, async () => {
      const extract = createWorkerExtractor(resolveLimits(), fakeWorker(message));
      await assertRejects(extract("<p></p>", PAGE, never()), "network");
      assert.equal(extract.active, 0);
    });
  }
});

describe("semáforo da fila", () => {
  test("abort tardio de quem já recebeu a vaga não tira outro da fila (indexOf = -1)", { timeout: 5_000 }, async () => {
    const slots = createSemaphore(1, 4);
    await slots.acquire(never()); // ocupa a única vaga
    // Sinal cujo removeEventListener não remove: o abort chega depois que a vaga já foi dada.
    let fireLateAbort = (): void => {};
    const sticky = {
      aborted: false,
      addEventListener: (_type: string, listener: () => void) => {
        fireLateAbort = listener;
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const first = slots.acquire(sticky); // A na fila
    const second = slots.acquire(never()); // B na fila
    slots.release(); // A recebe a vaga
    await first;
    fireLateAbort(); // onAbort de A, com A fora da fila
    slots.release(); // a vaga precisa ir para B
    await second; // antes da correção, B saía da fila e nunca recebia a vaga
  });

  test("abort de quem está na fila remove só ele", async () => {
    const slots = createSemaphore(1, 4);
    await slots.acquire(never());
    const controller = new AbortController();
    const leaving = slots.acquire(controller.signal);
    const staying = slots.acquire(never());
    controller.abort();
    await assertRejects(leaving, "timeout");
    slots.release();
    await staying;
  });
});

// Percorre os imports estáticos e dinâmicos a partir do worker, incluindo parse5 e suas dependências.
function importGraph(entry: URL): { files: string[]; builtins: Set<string> } {
  const builtins = new Set<string>();
  const seen = new Set<string>();
  const pending = [entry.href];
  const pattern = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;
  for (let href = pending.pop(); href !== undefined; href = pending.pop()) {
    if (seen.has(href)) continue;
    seen.add(href);
    const source = readFileSync(fileURLToPath(href), "utf8");
    for (const [, specifier = ""] of source.matchAll(pattern)) {
      const bare = specifier.replace(/^node:/, "");
      if (specifier.startsWith("node:") || builtinModules.includes(bare)) builtins.add(`node:${bare}`);
      else if (specifier.startsWith(".")) pending.push(new URL(specifier, href).href);
      else pending.push(import.meta.resolve(specifier));
    }
  }
  return { files: [...seen], builtins };
}

describe("isolamento do worker", () => {
  test("o worker e tudo o que ele importa não usam módulos de rede, disco ou processo", () => {
    const { files, builtins } = importGraph(new URL("./extract-worker.ts", import.meta.url));
    assert.ok(files.some((f) => f.includes("/parse5/")), "o grafo deve incluir o parse5");
    assert.ok(files.some((f) => f.includes("/entities/")), "o grafo deve incluir o entities");
    assert.deepEqual([...builtins], ["node:worker_threads"]);
  });
});
