import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { after, before, describe, test } from "node:test";
import { gzipSync } from "node:zlib";

import { FetchError, type FetchErrorCategory } from "./errors.ts";
import { type AddressPolicy, isPublicAddress } from "./ip-policy.ts";
import { type Limits, resolveLimits } from "./limits.ts";
import { type FetcherDeps, type FetchKind, safeFetch, USER_AGENT } from "./safe-fetch.ts";
import {
  type FakeTransport,
  fakeResolver,
  fakeTransport,
  html,
  image,
  type LocalServer,
  portMappingTransport,
  redirect,
  startLocalServer,
  TEST_LOOPBACK_POLICY,
} from "./testing.ts";
import { createNodeTransport, type Transport } from "./transport.ts";

const PUBLIC_IP = "93.184.216.34";
const DNS = fakeResolver({
  "noticias.example": [PUBLIC_IP],
  "cdn.example": ["93.184.216.35"],
  "outro.example": ["93.184.216.36"],
  "interno.example": ["10.0.0.5"],
  "metadados.example": ["169.254.169.254"],
  "misto.example": [PUBLIC_IP, "127.0.0.1"],
  "v6-privado.example": ["fd00::1"],
});

function makeDeps(
  transport: Transport,
  limits: Partial<Limits> = {},
  policy: AddressPolicy = isPublicAddress,
  resolver = DNS,
): FetcherDeps {
  return { resolver, transport, policy, limits: resolveLimits(limits) };
}

function run(raw: string, deps: FetcherDeps, kind: FetchKind = "html") {
  return safeFetch(raw, kind, deps, { signal: new AbortController().signal });
}

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

const okPage = (): FakeTransport => fakeTransport(() => html("<title>ok</title>"));

describe("safeFetch: bateria de SSRF (nada chega ao transporte)", () => {
  for (const [raw, category] of [
    ["http://127.0.0.1/", "blocked"],
    ["http://localhost/", "blocked"],
    ["http://intranet/", "blocked"],
    ["http://2130706433/", "blocked"],
    ["http://0177.0.0.1/", "blocked"],
    ["http://0x7f.1/", "blocked"],
    ["http://0x7f000001/", "blocked"],
    ["http://127.1/", "blocked"],
    ["http://0.0.0.0/", "blocked"],
    ["http://10.0.0.1/", "blocked"],
    ["http://172.16.0.1/", "blocked"],
    ["http://192.168.1.1/", "blocked"],
    ["http://100.64.0.1/", "blocked"],
    ["http://169.254.169.254/latest/meta-data/", "blocked"],
    ["http://169.254.43518/", "blocked"],
    ["http://metadata.google.internal/computeMetadata/v1/", "blocked"],
    ["http://metadata/computeMetadata/v1/", "blocked"],
    ["http://[::1]/", "blocked"],
    ["http://[::]/", "blocked"],
    ["http://[::ffff:127.0.0.1]/", "blocked"],
    ["http://[::ffff:a9fe:a9fe]/", "blocked"],
    ["http://[fd00::1]/", "blocked"],
    ["http://[fe80::1]/", "blocked"],
    ["http://[64:ff9b::a00:1]/", "blocked"],
    ["http://[2002:7f00:1::1]/", "blocked"],
    ["http://interno.example/", "blocked"],
    ["http://metadados.example/", "blocked"],
    ["http://misto.example/", "blocked"],
    ["http://v6-privado.example/", "blocked"],
    ["http://user:pass@noticias.example/", "blocked"],
    ["http://user@noticias.example/", "blocked"],
    ["file:///etc/passwd", "blocked"],
    ["ftp://noticias.example/", "blocked"],
    ["gopher://noticias.example/", "blocked"],
    ["http://noticias.example:8080/", "blocked"],
    ["https://noticias.example:22/", "blocked"],
    ["não é url", "invalid_url"],
  ] as const) {
    test(`${raw} -> ${category}`, async () => {
      const transport = okPage();
      await assertRejects(run(raw, makeDeps(transport)), category);
      assert.equal(transport.calls.length, 0);
    });
  }

  test("a mensagem do erro não vaza o IP interno nem a URL", async () => {
    try {
      await run("http://interno.example/segredo", makeDeps(okPage()));
      assert.fail("deveria ter lançado");
    } catch (error) {
      assert.ok(error instanceof FetchError);
      assert.doesNotMatch(error.message, /10\.0\.0\.5|interno|segredo/);
    }
  });
});

describe("safeFetch: DNS rebinding", () => {
  test("resolve uma vez e conecta exatamente no IP validado", async () => {
    // 1ª resposta pública, 2ª privada: se alguém resolvesse de novo, cairia no 127.0.0.1.
    const resolver = fakeResolver({ "rebind.example": (call) => (call === 1 ? [PUBLIC_IP] : ["127.0.0.1"]) });
    const transport = okPage();
    const result = await run("http://rebind.example/", makeDeps(transport, {}, isPublicAddress, resolver));
    assert.equal(result.contentType, "text/html");
    assert.deepEqual(resolver.calls, ["rebind.example"]);
    assert.equal(transport.calls.length, 1);
    assert.deepEqual(transport.calls[0]?.address, { address: PUBLIC_IP, family: 4 });
    assert.equal(transport.calls[0]?.hostname, "rebind.example");
    assert.equal(transport.calls[0]?.hostHeader, "rebind.example");
  });

  test("redirecionamento para o mesmo host resolve de novo e bloqueia a troca para IP privado", async () => {
    const resolver = fakeResolver({ "rebind.example": (call) => (call === 1 ? [PUBLIC_IP] : ["127.0.0.1"]) });
    const transport = fakeTransport(() => redirect("/de-novo"));
    await assertRejects(run("http://rebind.example/", makeDeps(transport, {}, isPublicAddress, resolver)), "blocked");
    assert.equal(resolver.calls.length, 2);
    assert.equal(transport.calls.length, 1);
  });
});

describe("safeFetch: redirecionamentos", () => {
  test("para 169.254.169.254: bloqueia antes de conectar", async () => {
    const transport = fakeTransport(() => redirect("http://169.254.169.254/latest/meta-data/"));
    await assertRejects(run("http://noticias.example/", makeDeps(transport)), "blocked");
    assert.equal(transport.calls.length, 1);
  });

  test("para metadata.google.internal: bloqueia", async () => {
    const transport = fakeTransport(() => redirect("http://metadata.google.internal/computeMetadata/v1/"));
    await assertRejects(run("http://noticias.example/", makeDeps(transport)), "blocked");
  });

  test("em cadeia público -> público -> privado: bloqueia no último salto", async () => {
    const transport = fakeTransport((req) =>
      req.url.hostname === "noticias.example" ? redirect("https://outro.example/b") : redirect("http://interno.example/c"),
    );
    await assertRejects(run("http://noticias.example/a", makeDeps(transport)), "blocked");
    assert.deepEqual(
      transport.calls.map((c) => c.url.href),
      ["http://noticias.example/a", "https://outro.example/b"],
    );
  });

  for (const location of ["file:///etc/passwd", "gopher://noticias.example/_x", "ftp://noticias.example/", "javascript:alert(1)", "http://[::1]/", "http://0x7f.1/", "http://noticias.example:6379/"]) {
    test(`para ${location}: bloqueia`, async () => {
      const transport = fakeTransport(() => redirect(location));
      await assertRejects(run("http://noticias.example/", makeDeps(transport)), "blocked");
      assert.equal(transport.calls.length, 1);
    });
  }

  test("5 redirecionamentos: aceita", async () => {
    const transport = fakeTransport((req) => {
      const step = Number(req.url.searchParams.get("n") ?? "0");
      return step < 5 ? redirect(`/r?n=${step + 1}`, 301) : html("<p>fim</p>");
    });
    const result = await run("http://noticias.example/r?n=0", makeDeps(transport));
    assert.equal(result.finalUrl, "http://noticias.example/r?n=5");
    assert.equal(transport.calls.length, 6);
  });

  test("6 redirecionamentos: recusa", async () => {
    const transport = fakeTransport((req) => redirect(`/r?n=${Number(req.url.searchParams.get("n") ?? "0") + 1}`, 307));
    await assertRejects(run("http://noticias.example/r?n=0", makeDeps(transport)), "too_many_redirects");
    assert.equal(transport.calls.length, 6);
  });

  test("Location relativo é resolvido pela URL atual", async () => {
    const transport = fakeTransport((req) => (req.url.pathname === "/a/b" ? redirect("../c", 308) : html("ok")));
    const result = await run("http://noticias.example/a/b", makeDeps(transport));
    assert.equal(result.finalUrl, "http://noticias.example/c");
  });

  test("redirecionamento sem Location: erro do site", async () => {
    await assertRejects(run("http://noticias.example/", makeDeps(fakeTransport(() => ({ status: 302 })))), "upstream_status");
  });

  test("corpo do redirecionamento é descartado", async () => {
    const body = Readable.from([Buffer.from("x")]);
    const transport = fakeTransport((req) =>
      req.url.pathname === "/" ? { status: 302, headers: { location: "/fim" }, body } : html("ok"),
    );
    await run("http://noticias.example/", makeDeps(transport));
    assert.ok(body.destroyed);
  });
});

describe("safeFetch: content-type", () => {
  for (const contentType of ["image/png", "application/octet-stream", "application/json", "text/plain", undefined]) {
    test(`HTML com ${String(contentType)}: tipo não suportado`, async () => {
      const transport = fakeTransport(() => ({ headers: contentType ? { "content-type": contentType } : {}, body: "<p>" }));
      await assertRejects(run("http://noticias.example/", makeDeps(transport)), "unsupported_type");
    });
  }

  for (const contentType of ["text/html", "image/svg+xml", "application/octet-stream", "application/pdf", "audio/mpeg", undefined]) {
    test(`mídia com ${String(contentType)}: tipo não suportado`, async () => {
      const transport = fakeTransport(() => ({ headers: contentType ? { "content-type": contentType } : {}, body: "x" }));
      await assertRejects(run("http://cdn.example/a.jpg", makeDeps(transport), "media"), "unsupported_type");
    });
  }

  test("aceita maiúsculas e parâmetros", async () => {
    const transport = fakeTransport(() => html("ok", { "content-type": "TEXT/HTML; charset=ISO-8859-1" }));
    assert.equal((await run("http://noticias.example/", makeDeps(transport))).contentType, "text/html");
  });

  for (const contentType of ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif", "image/heic", "video/mp4", "video/webm", "video/quicktime"]) {
    test(`mídia ${contentType}: aceita`, async () => {
      const transport = fakeTransport(() => image("bytes", contentType));
      const result = await run("http://cdn.example/m", makeDeps(transport), "media");
      assert.equal(result.contentType, contentType);
      assert.equal(result.body.toString(), "bytes");
    });
  }
});

describe("safeFetch: limites", () => {
  test("HTML acima do limite: conteúdo grande demais", async () => {
    const transport = fakeTransport(() => html("a".repeat(3 * 1024 * 1024)));
    await assertRejects(run("http://noticias.example/", makeDeps(transport)), "too_large");
  });

  test("Content-Length declarado acima do limite: recusa sem ler o corpo", async () => {
    let pulled = false;
    const body = new Readable({
      read() {
        pulled = true;
        this.push(null);
      },
    });
    const transport = fakeTransport(() => ({ headers: { "content-type": "image/jpeg", "content-length": String(16 * 1024 * 1024) }, body }));
    await assertRejects(run("http://cdn.example/a.jpg", makeDeps(transport), "media"), "too_large");
    assert.equal(pulled, false);
    assert.ok(body.destroyed);
  });

  test("mídia acima do limite sem Content-Length: aborta no stream", async () => {
    const transport = fakeTransport(() => image(Buffer.alloc(16 * 1024 * 1024)));
    await assertRejects(run("http://cdn.example/a.jpg", makeDeps(transport), "media"), "too_large");
  });

  test("gzip bomb no HTML: conteúdo grande demais", async () => {
    const bomb = gzipSync(Buffer.alloc(100 * 1024 * 1024));
    const transport = fakeTransport(() => ({ headers: { "content-type": "text/html", "content-encoding": "gzip" }, body: bomb }));
    await assertRejects(run("http://noticias.example/", makeDeps(transport)), "too_large");
  });

  test("transporte que nunca responde: tempo esgotado pelo prazo total", async () => {
    const transport = fakeTransport(() => new Promise<never>(() => {}));
    const started = performance.now();
    await assertRejects(run("http://noticias.example/", makeDeps(transport, { htmlTotalMs: 100 })), "timeout");
    assert.ok(performance.now() - started < 2_000);
  });

  test("corpo que nunca termina: tempo esgotado", async () => {
    const endless = new Readable({ read() {} });
    const transport = fakeTransport(() => ({ headers: { "content-type": "text/html" }, body: endless }));
    await assertRejects(run("http://noticias.example/", makeDeps(transport, { htmlTotalMs: 100 })), "timeout");
    assert.ok(endless.destroyed);
  });

  test("status 304/404/500: erro do site", async () => {
    for (const status of [304, 404, 500]) {
      const transport = fakeTransport(() => ({ status, headers: { "content-type": "text/html" }, body: "x" }));
      await assertRejects(run("http://noticias.example/", makeDeps(transport)), "upstream_status");
    }
  });

  test("upstream_status traz só o código HTTP, sem corpo nem cabeçalhos", async () => {
    const secret = "SEGREDO-DO-SITE";
    const transport = fakeTransport(() => ({
      status: 403,
      headers: { "content-type": "text/html", "x-detalhe": secret, "set-cookie": `s=${secret}` },
      body: `<h1>${secret}</h1>`,
    }));
    const error = await run("http://noticias.example/", makeDeps(transport)).then(
      () => assert.fail("esperava erro"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof FetchError);
    assert.equal(error.category, "upstream_status");
    assert.equal(error.httpStatus, 403);
    assert.deepEqual(Object.keys(error).sort(), ["category", "httpStatus", "name"]);
    assert.equal(`${error.message}${error.stack ?? ""}${JSON.stringify(error)}`.includes(secret), false);
  });

  test("redirecionamento sem Location: upstream_status com o código 3xx", async () => {
    const error = await run("http://noticias.example/", makeDeps(fakeTransport(() => ({ status: 307 })))).then(
      () => assert.fail("esperava erro"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof FetchError);
    assert.equal(error.httpStatus, 307);
  });

  test("outras categorias não carregam código HTTP", async () => {
    const transport = fakeTransport(() => ({ status: 200, headers: { "content-type": "application/pdf" }, body: "x" }));
    const error = await run("http://noticias.example/", makeDeps(transport)).then(
      () => assert.fail("esperava erro"),
      (e: unknown) => e,
    );
    assert.ok(error instanceof FetchError);
    assert.equal(error.category, "unsupported_type");
    assert.equal(error.httpStatus, undefined);
  });
});

describe("safeFetch: cabeçalhos enviados", () => {
  test("User-Agent próprio, sem cookie nem credenciais", async () => {
    const transport = okPage();
    await run("http://noticias.example/", makeDeps(transport));
    const headers = transport.calls[0]?.headers ?? {};
    assert.equal(headers["User-Agent"], USER_AGENT);
    const names = Object.keys(headers).map((name) => name.toLowerCase());
    for (const forbidden of ["cookie", "authorization", "referer", "proxy-authorization"]) {
      assert.ok(!names.includes(forbidden), forbidden);
    }
  });
});

describe("safeFetch com transporte real e servidor local", () => {
  let local: LocalServer;
  const loopback = fakeResolver({ "noticias.example": ["127.0.0.1"] });
  const deps = (limits: Partial<Limits> = {}) =>
    makeDeps(portMappingTransport(createNodeTransport(), local.port), limits, TEST_LOOPBACK_POLICY, loopback);

  before(async () => {
    local = await startLocalServer((req, res) => {
      switch (req.url) {
        case "/gzip":
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
          return res.end(gzipSync("<title>compactado</title>"));
        case "/bomba":
          res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" });
          return res.end(gzipSync(Buffer.alloc(50 * 1024 * 1024)));
        case "/metadados":
          res.writeHead(302, { Location: "http://169.254.169.254/computeMetadata/v1/" });
          return res.end();
        case "/cabecalhos":
          res.writeHead(200, { "Content-Type": "text/html", "X-Lixo": "a".repeat(20 * 1024) });
          return res.end();
        default:
          res.writeHead(200, { "Content-Type": "text/html" });
          return res.end("<title>local</title>");
      }
    });
  });

  after(() => local.close());

  test("baixa e descompacta, com Host do hostname original", async () => {
    const result = await run("http://noticias.example/gzip", deps());
    assert.equal(result.body.toString(), "<title>compactado</title>");
    assert.equal(local.requests.at(-1)?.headers.host, "noticias.example");
  });

  test("a política de produção bloqueia o mesmo servidor local", async () => {
    const production = makeDeps(portMappingTransport(createNodeTransport(), local.port), {}, isPublicAddress, loopback);
    const before = local.connections.length;
    await assertRejects(run("http://noticias.example/", production), "blocked");
    assert.equal(local.connections.length, before);
  });

  test("redirecionamento real para o servidor de metadados: bloqueia", async () => {
    await assertRejects(run("http://noticias.example/metadados", deps()), "blocked");
  });

  test("bomba gzip real: conteúdo grande demais", async () => {
    await assertRejects(run("http://noticias.example/bomba", deps()), "too_large");
  });

  test("cabeçalhos de resposta grandes demais: recusa", async () => {
    await assertRejects(run("http://noticias.example/cabecalhos", deps()), "too_large");
  });
});
