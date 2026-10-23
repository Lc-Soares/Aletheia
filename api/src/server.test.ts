import assert from "node:assert/strict";
import fs from "node:fs";
import { request } from "node:http";
import fsp from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { readdirSync, readFileSync } from "node:fs";
import { after, before, describe, mock, test } from "node:test";

import type { TokenVerifier } from "./auth.ts";
import { createApiServer, shutdown, type LogEntry } from "./server.ts";

const GOOD_TOKEN = "good.token.value";
const GENERIC_401 = { error: "Não autorizado" };

const verifier: TokenVerifier = async (token) => {
  if (token === GOOD_TOKEN) return { email: "pessoa@example.com" };
  throw new Error(`motivo interno com ${token}`);
};

describe("API HTTP", () => {
  const logs: LogEntry[] = [];
  const server = createApiServer({ verifier, log: (entry) => logs.push(entry) });
  let base = "";

  before(async () => {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => shutdown(server, 1000));

  test("GET /healthz é público e não devolve dados", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  const unauthorized: Array<[string, Record<string, string>]> = [
    ["sem Authorization", {}],
    ["esquema errado", { Authorization: `Basic ${GOOD_TOKEN}` }],
    ["Bearer vazio", { Authorization: "Bearer " }],
    ["token malformado", { Authorization: "Bearer abc" }],
    ["token recusado pelo verificador", { Authorization: "Bearer bad.token.value" }],
  ];

  for (const [name, headers] of unauthorized) {
    test(`GET /api/me → 401 genérico (${name})`, async () => {
      const res = await fetch(`${base}/api/me`, { headers });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), GENERIC_401);
      assert.equal(res.headers.get("www-authenticate"), "Bearer");
    });
  }

  test("GET /api/me com token válido devolve apenas { email }", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { email: "pessoa@example.com" });
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("rota desconhecida → 404 e método errado → 405", async () => {
    assert.equal((await fetch(`${base}/outra`)).status, 404);
    const post = await fetch(`${base}/api/me`, { method: "POST", body: "x" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET");
  });

  test("log não contém token, corpo, query nem e-mail", async () => {
    logs.length = 0;
    const marker = "CORPO-SECRETO-123";
    await fetch(`${base}/api/me?url=https://alvo.example/pagina`, {
      method: "POST",
      body: marker,
      headers: { Authorization: `Bearer ${GOOD_TOKEN}` },
    });
    await fetch(`${base}/api/me?url=https://alvo.example/pagina`, {
      headers: { Authorization: `Bearer ${GOOD_TOKEN}` },
    });
    await fetch(`${base}/caminho/${marker}`);
    const dump = JSON.stringify(logs);
    assert.ok(logs.length >= 3);
    for (const secret of [GOOD_TOKEN, marker, "alvo.example", "pessoa", "example.com"]) {
      assert.equal(dump.includes(secret), false, `log vazou: ${secret}`);
    }
  });

  test("nada é gravado em disco durante as requisições", async () => {
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
      await fetch(`${base}/healthz`);
      await fetch(`${base}/api/me`, { headers: { Authorization: `Bearer ${GOOD_TOKEN}` } });
      await fetch(`${base}/api/me`);
      for (const spy of spies) assert.equal(spy.mock.callCount(), 0);
    } finally {
      mock.restoreAll();
    }
  });

  test("o código da API não importa módulos de arquivo", () => {
    const dir = new URL(".", import.meta.url);
    const sources = readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts");
    assert.ok(sources.length > 0);
    for (const file of sources) {
      assert.doesNotMatch(readFileSync(new URL(file, dir), "utf8"), /node:fs|from "fs"/, file);
    }
  });
});

describe("endurecimento do servidor", () => {
  test("define limites de tempo e de cabeçalho", () => {
    const server = createApiServer({ verifier, log: () => {} });
    assert.ok(server.headersTimeout > 0 && server.headersTimeout <= 10_000);
    assert.ok(server.requestTimeout > 0 && server.requestTimeout <= 30_000);
  });

  test("cabeçalho acima do limite é recusado (431)", async () => {
    const server = createApiServer({ verifier, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
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
      await shutdown(server, 1000);
    }
  });

  test("shutdown fecha o servidor e resolve", async () => {
    const server = createApiServer({ verifier, log: () => {} });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await shutdown(server, 1000);
    assert.equal(server.listening, false);
  });
});
