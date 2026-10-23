import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import type { CallerVerifier } from "./auth.ts";
import { FetchError } from "./errors.ts";
import { createWorkerExtractor } from "./extract-pool.ts";
import { fetchPage } from "./fetch-page.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { resolveLimits } from "./limits.ts";
import { createFetcherServer, domainHash, type LogEntry, type PageFetcher, shutdown } from "./server.ts";
import { fakeResolver, html, image, routeTransport } from "./testing.ts";

const GOOD_TOKEN = "good.token.value";
const verifier: CallerVerifier = async (token) => {
  if (token === GOOD_TOKEN) return { email: "api@projeto.iam.gserviceaccount.com" };
  throw new Error(`motivo interno com ${token}`);
};

// Página simulada de ponta a ponta, sem rede: fetchPage real com DNS e transporte falsos.
const transport = routeTransport({
  "https://noticias.example/materia-secreta": html(
    `<title>Título</title><img src="/a.jpg"><img src="http://169.254.169.254/x.jpg">`,
  ),
  "https://noticias.example/a.jpg": image("JPEG-BYTES"),
});
const realFetcher: PageFetcher = (url, signal) =>
  fetchPage(url, {
    resolver: fakeResolver({ "noticias.example": ["93.184.216.34"] }),
    transport,
    policy: isPublicAddress,
    limits: resolveLimits(),
    extract: createWorkerExtractor(resolveLimits()),
  }, signal);

type Started = { base: string; logs: LogEntry[]; close: () => Promise<void> };

async function start(fetcher: PageFetcher = realFetcher): Promise<Started> {
  const logs: LogEntry[] = [];
  const server = createFetcherServer({ verifier, fetchPage: fetcher, log: (entry) => logs.push(entry) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    logs,
    close: () => shutdown(server, 500),
  };
}

const post = (base: string, body: unknown, headers: Record<string, string> = {}, path = "/fetch") =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GOOD_TOKEN}`, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("serviço do fetcher", () => {
  let s: Started;
  before(async () => {
    s = await start();
  });
  after(() => s.close());

  test("GET /healthz é público", async () => {
    const res = await fetch(`${s.base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  for (const [name, headers] of [
    ["sem Authorization", { Authorization: "" }],
    ["esquema errado", { Authorization: `Basic ${GOOD_TOKEN}` }],
    ["token malformado", { Authorization: "Bearer abc" }],
    ["token recusado pelo verificador", { Authorization: "Bearer bad.token.value" }],
  ] as const) {
    test(`POST /fetch -> 401 genérico (${name})`, async () => {
      const res = await post(s.base, { url: "https://noticias.example/materia-secreta" }, headers);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: "Não autorizado" });
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
    });
  }

  test("rota desconhecida -> 404; GET /fetch -> 405", async () => {
    assert.equal((await fetch(`${s.base}/outra`)).status, 404);
    const res = await fetch(`${s.base}/fetch`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get("allow"), "POST");
  });

  test("Content-Type diferente de JSON -> 415", async () => {
    assert.equal((await post(s.base, "url=x", { "Content-Type": "application/x-www-form-urlencoded" })).status, 415);
  });

  test("corpo acima de 4 KiB -> 413", async () => {
    assert.equal((await post(s.base, { url: `https://noticias.example/${"a".repeat(5000)}` })).status, 413);
  });

  for (const [name, body] of [
    ["JSON inválido", "{url:"],
    ["sem url", {}],
    ["url vazia", { url: "" }],
    ["url não string", { url: ["https://noticias.example/"] }],
    ["null", "null"],
  ] as const) {
    test(`${name} -> 400`, async () => {
      assert.equal((await post(s.base, body)).status, 400);
    });
  }

  test("resposta NDJSON: page, media com bytes e SHA-256, media_error e done", async () => {
    const res = await post(s.base, { url: "https://noticias.example/materia-secreta" });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    const lines = (await res.text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.deepEqual(lines.map((l) => l["type"]), ["page", "media", "media_error", "done"]);
    assert.equal(lines[0]?.["title"], "Título");
    const media = lines[1] ?? {};
    const bytes = Buffer.from(String(media["data"]), "base64");
    assert.equal(bytes.toString(), "JPEG-BYTES");
    assert.equal(media["sha256"], createHash("sha256").update("JPEG-BYTES").digest("hex"));
    assert.equal(media["contentType"], "image/jpeg");
    assert.equal(lines[2]?.["error"], "blocked");
  });

  test("a URL na query string é ignorada; só vale a do corpo", async () => {
    const res = await post(s.base, { url: "http://10.0.0.1/" }, {}, "/fetch?url=https://noticias.example/materia-secreta");
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "blocked", message: "Destino bloqueado" });
  });

  test("falha da página -> 422 com categoria genérica", async () => {
    const res = await post(s.base, { url: "file:///etc/passwd" });
    assert.equal(res.status, 422);
    assert.deepEqual(await res.json(), { error: "blocked", message: "Destino bloqueado" });
  });

  test("logs não contêm URL, caminho, hostname, token nem corpo", async () => {
    s.logs.length = 0;
    await post(s.base, { url: "https://noticias.example/materia-secreta" });
    await post(s.base, { url: "http://interno-secreto.example/x" });
    await post(s.base, { url: "https://noticias.example/materia-secreta" }, { Authorization: "Bearer bad.token.value" });
    await fetch(`${s.base}/caminho/materia-secreta`);
    const dump = JSON.stringify(s.logs);
    assert.equal(s.logs.length, 4);
    for (const secret of ["noticias", "materia-secreta", "interno-secreto", "169.254", GOOD_TOKEN, "bad.token", "https://"]) {
      assert.equal(dump.includes(secret), false, `log vazou: ${secret}`);
    }
    assert.equal(s.logs[0]?.domainHash, domainHash("https://noticias.example/"));
    assert.match(s.logs[0]?.domainHash ?? "", /^[0-9a-f]{16}$/);
    assert.equal(s.logs[0]?.outcome, "ok");
    assert.equal(s.logs[2]?.outcome, "unauthorized");
    assert.equal(s.logs[2]?.domainHash, null);
  });
});

describe("serviço do fetcher: casos de erro e cancelamento", () => {
  test("erro inesperado -> 500 genérico, sem detalhe", async () => {
    const s = await start(async () => {
      throw new Error("detalhe interno 10.0.0.1");
    });
    try {
      const res = await post(s.base, { url: "https://noticias.example/" });
      assert.equal(res.status, 500);
      assert.deepEqual(await res.json(), { error: "Erro interno" });
    } finally {
      await s.close();
    }
  });

  test("FetchError do fetchPage vira 422", async () => {
    const s = await start(async () => {
      throw new FetchError("timeout");
    });
    try {
      const res = await post(s.base, { url: "https://noticias.example/" });
      assert.equal(res.status, 422);
      assert.deepEqual(await res.json(), { error: "timeout", message: "Tempo esgotado" });
    } finally {
      await s.close();
    }
  });

  test("cliente que desiste aborta os downloads em andamento", { timeout: 5_000 }, async () => {
    let onAbort = (): void => {};
    const aborted = new Promise<void>((resolve) => {
      onAbort = resolve;
    });
    const s = await start((_url, signal) => {
      signal.addEventListener("abort", onAbort);
      return new Promise<never>(() => {}); // download que nunca termina
    });
    try {
      const req = request({
        host: "127.0.0.1",
        port: new URL(s.base).port,
        path: "/fetch",
        method: "POST",
        headers: { Authorization: `Bearer ${GOOD_TOKEN}`, "Content-Type": "application/json" },
      });
      req.on("error", () => {});
      req.end(JSON.stringify({ url: "https://noticias.example/" }));
      await new Promise((resolve) => setTimeout(resolve, 100));
      req.destroy(); // o cliente desiste
      await aborted;
    } finally {
      await s.close();
    }
  });

  test("cabeçalho acima do limite -> 431", async () => {
    const s = await start();
    try {
      const { port } = new URL(s.base);
      const status = await new Promise<number>((resolve, reject) => {
        const req = request({ host: "127.0.0.1", port, path: "/healthz", headers: { "X-Grande": "a".repeat(20_000) } });
        req.on("response", (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 431);
    } finally {
      await s.close();
    }
  });
});
