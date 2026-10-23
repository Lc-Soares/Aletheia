import assert from "node:assert/strict";
import { connect } from "node:net";
import { after, before, describe, test } from "node:test";

import { FetchError, type FetchErrorCategory } from "./errors.ts";
import { type LocalServer, startLocalServer } from "./testing.ts";
import { createNodeTransport, type TransportRequest } from "./transport.ts";

function requestFor(port: number, overrides: Partial<TransportRequest> = {}): TransportRequest {
  return {
    url: new URL("http://noticias.example/materia?id=1"),
    hostname: "noticias.example",
    hostHeader: "noticias.example",
    port,
    address: { address: "127.0.0.1", family: 4 },
    headers: { "User-Agent": "AletheiaFetcher/teste" },
    maxHeaderBytes: 16 * 1024,
    headersTimeoutMs: 2_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

async function readAll(body: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

describe("nodeTransport com servidor local", () => {
  let local: LocalServer;

  before(async () => {
    local = await startLocalServer((req, res) => {
      if (req.url === "/lento") return; // nunca responde
      if (req.url === "/cabecalho-enorme") {
        res.writeHead(200, { "X-Grande": "a".repeat(20 * 1024) });
        return res.end();
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
    });
  });

  after(() => local.close());

  test("conecta no IP fixado sem resolver o nome e mantém o Host original", async () => {
    // "noticias.example" não existe no DNS: se o transporte resolvesse o nome, falharia.
    const response = await createNodeTransport()(requestFor(local.port));
    assert.equal(response.status, 200);
    assert.equal(await readAll(response.body), "ok");
    const received = local.requests.at(-1);
    assert.ok(received);
    assert.equal(received.headers.host, "noticias.example");
    assert.equal(received.url, "/materia?id=1");
    assert.equal(received.headers["user-agent"], "AletheiaFetcher/teste");
    assert.equal(received.headers.cookie, undefined);
    assert.equal(received.headers.authorization, undefined);
    assert.equal(received.headers.connection, "close");
  });

  test("remoteAddress diferente do IP validado: aborta antes de enviar qualquer byte", async () => {
    const before = local.requests.length;
    const connectionsBefore = local.connections.length;
    // Abridor adulterado (só no teste): conecta em 127.0.0.1 embora o IP validado seja outro.
    const tampered = createNodeTransport({ openSocket: (_address, port) => connect({ host: "127.0.0.1", port }) });
    await assertRejects(tampered(requestFor(local.port, { address: { address: "203.0.113.5", family: 4 } })), "blocked");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(local.requests.length, before);
    const connection = local.connections[connectionsBefore];
    assert.ok(connection, "a conexão TCP chegou ao servidor");
    assert.equal(connection.bytesRead, 0);
  });

  test("cabeçalhos acima do limite: conteúdo grande demais", async () => {
    const url = new URL("http://noticias.example/cabecalho-enorme");
    await assertRejects(createNodeTransport()(requestFor(local.port, { url })), "too_large");
  });

  test("servidor que não responde: tempo esgotado no prazo do salto", async () => {
    const url = new URL("http://noticias.example/lento");
    const started = performance.now();
    await assertRejects(createNodeTransport()(requestFor(local.port, { url, headersTimeoutMs: 100 })), "timeout");
    assert.ok(performance.now() - started < 1_500);
  });

  test("sinal já abortado: tempo esgotado sem conectar", async () => {
    const connectionsBefore = local.connections.length;
    await assertRejects(createNodeTransport()(requestFor(local.port, { signal: AbortSignal.abort() })), "timeout");
    assert.equal(local.connections.length, connectionsBefore);
  });

  test("conexão recusada: falha de rede genérica", async () => {
    const closed = await startLocalServer(() => {});
    const port = closed.port;
    await closed.close();
    await assertRejects(createNodeTransport()(requestFor(port)), "network");
  });
});
