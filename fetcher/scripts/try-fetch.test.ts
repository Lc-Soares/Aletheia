import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, test } from "node:test";

import { isPublicAddress } from "../src/ip-policy.ts";
import { resolveLimits } from "../src/limits.ts";
import type { PageDeps } from "../src/fetch-page.ts";
import { fakeResolver, html, image, inlineExtractor, routeTransport, startFakeDnsServer } from "../src/testing.ts";
import { formatResult, formatSummary, main, parseUrlList, runOne, sanitize, summarize } from "./try-fetch.ts";

const MEDIA_BYTES = "BYTES-DA-MIDIA-QUE-NAO-PODEM-APARECER";

// Página simulada, sem internet: uma mídia que baixa, uma bloqueada e uma grande demais.
function pageDeps(title = "Título da página"): PageDeps & { transport: ReturnType<typeof routeTransport> } {
  const limits = resolveLimits({ maxMediaBytes: 1024 });
  const transport = routeTransport({
    "https://noticias.example/materia": html(
      `<title>${title}</title><meta property="og:title" content="Manchete">
       <img src="/a.jpg"><img src="http://169.254.169.254/x.jpg"><img src="/grande.jpg">`,
    ),
    "https://noticias.example/a.jpg": image(MEDIA_BYTES),
    "https://noticias.example/grande.jpg": image(Buffer.alloc(4096)),
  });
  return {
    resolver: fakeResolver({ "noticias.example": ["93.184.216.34"] }),
    transport,
    policy: isPublicAddress,
    limits,
    extract: inlineExtractor(limits),
  };
}

describe("try-fetch: resultado de uma URL", () => {
  test("página, mídias, hash de 12 caracteres, categorias de erro e tempos", async () => {
    const result = await runOne("https://noticias.example/materia", pageDeps());
    assert.ok(result.ok);
    assert.equal(result.finalUrl, "https://noticias.example/materia");
    assert.equal(result.title, "Título da página");
    assert.equal(result.headline, "Manchete");
    assert.equal(result.listed, 3);
    assert.equal(result.downloaded, 1);
    assert.deepEqual(
      result.media.map((m) => m.error ?? `${m.contentType} ${m.size} ${m.sha256}`),
      [`image/jpeg ${Buffer.byteLength(MEDIA_BYTES)} ${result.media[0]?.sha256}`, "blocked", "too_large"],
    );
    assert.match(result.media[0]?.sha256 ?? "", /^[0-9a-f]{12}$/);
    for (const ms of Object.values(result.timings)) assert.ok(ms >= 0);
  });

  test("a saída em texto mostra os dados e nunca os bytes", async () => {
    const text = formatResult(await runOne("https://noticias.example/materia", pageDeps()));
    for (const expected of ["https://noticias.example/materia", "Título da página", "Manchete", "image/jpeg", "blocked", "too_large"]) {
      assert.ok(text.includes(expected), expected);
    }
    assert.ok(!text.includes(MEDIA_BYTES), "bytes da mídia");
    assert.ok(!text.includes(Buffer.from(MEDIA_BYTES).toString("base64")), "bytes em base64");
  });

  test("falha da página inteira vira categoria, sem exceção", async () => {
    const result = await runOne("http://169.254.169.254/latest/meta-data/", pageDeps());
    assert.equal(result.ok, false);
    assert.equal(result.ok ? null : result.error, "blocked");
    assert.match(formatResult(result), /blocked/);
  });
});

describe("try-fetch: higienização de texto de terceiros", () => {
  const hostile = "a\u001b[31mb\u0007c\u009bd‮e​f⁦g﻿h";

  test("remove ANSI, controles C0/C1 e caracteres de formato Unicode (inclusive U+202E)", () => {
    assert.equal(sanitize(hostile), "abcdefgh");
    assert.equal(sanitize("linha 1\nlinha 2\ttab"), "linha 1 linha 2 tab");
  });

  test("título com U+202E: a saída não contém nenhum caractere de controle ou de formato", async () => {
    const text = formatResult(await runOne("https://noticias.example/materia", pageDeps(`gpj.exe‮título`)));
    assert.ok(text.includes("gpj.exetítulo"));
    for (const line of text.split("\n")) assert.doesNotMatch(line, /[\p{Cc}\p{Cf}]/u, JSON.stringify(line));
  });

  test("finalUrl, URL e content-type de mídia também são higienizados", () => {
    const text = formatResult({
      url: "https://x.example/‮",
      ok: true,
      finalUrl: "https://x.example/\u001b[2Jfinal",
      title: null,
      headline: null,
      listed: 1,
      attempted: 1,
      downloaded: 1,
      media: [{ url: "https://x.example/⁦a.jpg", kind: "image", contentType: "image/jpeg\u0007", size: 1, sha256: "0123456789ab" }],
      timings: { pageMs: 1, extractMs: 1, mediaMs: 1, totalMs: 3 },
    });
    for (const line of text.split("\n")) assert.doesNotMatch(line, /[\p{Cc}\p{Cf}]/u, JSON.stringify(line));
    assert.ok(text.includes("https://x.example/final"));
  });
});

describe("try-fetch: lista de URLs e resumo", () => {
  test("parseUrlList ignora linhas vazias e comentários, com espaços e CRLF", () => {
    assert.deepEqual(parseUrlList("# comentário\r\n\r\n  https://a.example/  \r\nhttps://b.example/\n   # outro\n\n"), [
      "https://a.example/",
      "https://b.example/",
    ]);
  });

  test("summarize conta sucessos e categorias de erro da página e das mídias", async () => {
    const deps = pageDeps();
    const results = [
      await runOne("https://noticias.example/materia", deps),
      await runOne("http://localhost/", deps),
      await runOne("http://127.0.0.1/", deps),
    ];
    const summary = summarize(results);
    assert.deepEqual(summary, {
      total: 3,
      ok: 1,
      pageErrors: { blocked: 2 },
      mediaErrors: { blocked: 1, too_large: 1 },
    });
    const text = formatSummary(summary);
    assert.match(text, /1 de 3/);
    assert.match(text, /blocked: 2/);
  });

  test("lista-exemplo.txt: as quatro URLs saem blocked e nenhuma conexão é aberta", async () => {
    const urls = parseUrlList(readFileSync(new URL("./lista-exemplo.txt", import.meta.url), "utf8"));
    assert.deepEqual(urls, ["http://localhost/", "http://127.0.0.1/", "http://169.254.169.254/", "http://[::1]/"]);
    const deps = pageDeps();
    const results = await Promise.all(urls.map((url) => runOne(url, deps)));
    assert.deepEqual(results.map((r) => (r.ok ? "ok" : r.error)), ["blocked", "blocked", "blocked", "blocked"]);
    assert.equal(deps.transport.calls.length, 0);
  });
});

describe("try-fetch: main", () => {
  const io = (deps: PageDeps, files: Record<string, string> = {}) => {
    let out = "";
    return {
      io: {
        deps: () => deps,
        readFile: async (path: string) => {
          const content = files[path];
          if (content === undefined) throw new Error("arquivo não existe");
          return content;
        },
        write: (text: string) => {
          out += text;
        },
      },
      output: () => out,
    };
  };

  test("sem argumento ou com --arquivo sem caminho: código 2 e uso", async () => {
    for (const argv of [[], ["--arquivo"], ["a", "b"], ["--desligar-protecao", "https://x.example/"]]) {
      const run = io(pageDeps());
      assert.equal(await main(argv, run.io), 2, JSON.stringify(argv));
      assert.match(run.output(), /Uso:/);
    }
  });

  test("-h mostra o uso e sai com 0", async () => {
    const run = io(pageDeps());
    assert.equal(await main(["-h"], run.io), 0);
    assert.match(run.output(), /Uso:/);
  });

  test("uma URL: imprime o resultado e sai com 0", async () => {
    const run = io(pageDeps());
    assert.equal(await main(["https://noticias.example/materia"], run.io), 0);
    assert.match(run.output(), /Título da página/);
  });

  test("--arquivo: lê a lista, roda uma por vez e imprime o resumo", async () => {
    const run = io(pageDeps(), { "lista.txt": "https://noticias.example/materia\n# x\nhttp://localhost/\n" });
    assert.equal(await main(["--arquivo", "lista.txt"], run.io), 0);
    assert.match(run.output(), /Resumo: 1 de 2/);
  });

  test("não grava nada em disco e não usa o console", async (t) => {
    const writers = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "open", "openSync"] as const;
    const mocked = [
      ...writers.map((name) => t.mock.method(fs, name)),
      ...(["writeFile", "appendFile", "open"] as const).map((name) => t.mock.method(fs.promises, name)),
    ];
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((name) => t.mock.method(console, name, () => {}));
    const run = io(pageDeps(), { "lista.txt": "https://noticias.example/materia\n" });
    await main(["--arquivo", "lista.txt"], run.io);
    for (const writer of mocked) assert.equal(writer.mock.callCount(), 0);
    for (const call of consoleCalls) assert.equal(call.mock.callCount(), 0);
  });
});

// Sem handles abertos: o main roda num processo-filho com worker de extração e resolvedor c-ares
// reais (contra um DNS local deste processo) e precisa sair sozinho, sem process.exit.
describe("try-fetch: termina sozinho", () => {
  test("worker e resolvedor não seguram o processo depois do resumo", { timeout: 30_000 }, async () => {
    const dns = await startFakeDnsServer({ "noticias.example": { A: ["93.184.216.34"] } });
    try {
      const src = (name: string) => JSON.stringify(new URL(`../src/${name}`, import.meta.url).href);
      const script = `
        import { Resolver } from "node:dns/promises";
        import { main } from ${JSON.stringify(new URL("./try-fetch.ts", import.meta.url).href)};
        import { createWorkerExtractor } from ${src("extract-pool.ts")};
        import { isPublicAddress } from ${src("ip-policy.ts")};
        import { resolveLimits } from ${src("limits.ts")};
        import { createDnsResolver, DNS_OPTIONS } from ${src("resolve.ts")};
        import { html, routeTransport } from ${src("testing.ts")};
        const limits = resolveLimits();
        const deps = () => ({
          resolver: createDnsResolver(() => { const c = new Resolver(DNS_OPTIONS); c.setServers([${JSON.stringify(dns.server)}]); return c; }),
          transport: routeTransport({ "https://noticias.example/": html("<title>ok</title>") }),
          policy: isPublicAddress,
          limits,
          extract: createWorkerExtractor(limits),
        });
        process.exitCode = await main(["--arquivo", "lista.txt"], {
          deps,
          readFile: async () => "https://noticias.example/\\nhttps://noticias.example/\\n",
          write: (text) => process.stdout.write(text),
        });`;
      const env: Record<string, string | undefined> = { ...process.env };
      delete env["NODE_TEST_CONTEXT"];
      delete env["NODE_OPTIONS"];
      const started = performance.now();
      const child = await new Promise<{ status: number | null; stdout: string }>((resolve) => {
        const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8", timeout: 15_000 });
        resolve({ status: result.status, stdout: result.stdout });
      });
      assert.equal(child.status, 0, `não saiu sozinho a tempo: ${child.stdout}`);
      assert.match(child.stdout, /Resumo: 2 de 2/);
      assert.ok(performance.now() - started < 15_000);
    } finally {
      await dns.close();
    }
  });
});

describe("try-fetch: fora da imagem e sem relaxar proteção", () => {
  const SCRIPT_SOURCE = readFileSync(new URL("./try-fetch.ts", import.meta.url), "utf8");

  test(".dockerignore remove fetcher/scripts inteiro", () => {
    const patterns = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    // Semântica do Docker: um padrão que casa com uma pasta remove tudo dentro dela.
    const excluded = (path: string): boolean =>
      patterns.some((pattern) => {
        const parts = path.split("/");
        return parts.some((_, i) => posix.matchesGlob(parts.slice(0, i + 1).join("/"), pattern));
      });
    for (const file of ["try-fetch.ts", "try-fetch.test.ts", "lista-exemplo.txt"]) {
      assert.ok(excluded(`fetcher/scripts/${file}`), file);
    }
  });

  test("nenhum módulo de produção importa algo de scripts/", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const production = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts");
    assert.ok(production.includes("main.ts"));
    for (const file of production) {
      assert.doesNotMatch(readFileSync(new URL(file, srcDir), "utf8"), /from\s+["'][^"']*scripts\//, file);
    }
  });

  test("o script não importa testing.ts, não lê variável de ambiente e não monta limites próprios", () => {
    assert.doesNotMatch(SCRIPT_SOURCE, /testing(\.ts)?["']/);
    assert.doesNotMatch(SCRIPT_SOURCE, /process\.env/);
    assert.doesNotMatch(SCRIPT_SOURCE, /limits\.ts|resolveLimits|DEFAULT_LIMITS/);
    assert.match(SCRIPT_SOURCE, /createProductionDeps\(\)/);
  });

  test("o tsconfig do fetcher inclui scripts/ (o script passa pelo typecheck)", () => {
    const tsconfig = readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8");
    assert.match(tsconfig, /"include":\s*\[[^\]]*"scripts"/);
  });
});
