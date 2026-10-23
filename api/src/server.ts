import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { extractBearerToken, type TokenVerifier } from "./auth.ts";

// Só campos sem dado do usuário: nada de token, e-mail, corpo, query ou caminho livre.
export type LogEntry = { method: string; route: string; status: number; durationMs: number };

export type ApiOptions = { verifier: TokenVerifier; log: (entry: LogEntry) => void };

const ROUTES = new Set(["/healthz", "/api/me"]);

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...extra,
  });
  res.end(JSON.stringify(body));
}

async function handleMe(req: IncomingMessage, res: ServerResponse, verifier: TokenVerifier): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  try {
    if (token === null) throw new Error("sem token");
    const { email } = await verifier(token);
    sendJson(res, 200, { email });
  } catch {
    sendJson(res, 401, { error: "Não autorizado" }, { "WWW-Authenticate": "Bearer" });
  }
}

async function route(req: IncomingMessage, res: ServerResponse, verifier: TokenVerifier, path: string): Promise<void> {
  if (!ROUTES.has(path)) return sendJson(res, 404, { error: "Não encontrado" });
  if (req.method !== "GET") return sendJson(res, 405, { error: "Método não permitido" }, { Allow: "GET" });
  if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
  return handleMe(req, res, verifier);
}

export function createApiServer({ verifier, log }: ApiOptions): Server {
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    const started = performance.now();
    const path = (req.url ?? "").split("?")[0] ?? "";
    res.on("finish", () => {
      log({
        method: req.method ?? "",
        route: ROUTES.has(path) ? path : "(outra)",
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    route(req, res, verifier, path).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Erro interno" });
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

// Encerramento gracioso: para de aceitar conexões, deixa terminar o que está em andamento
// e derruba o que sobrar depois do prazo.
export function shutdown(server: Server, graceMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => server.closeAllConnections(), graceMs);
    timer.unref();
    server.close(() => {
      clearTimeout(timer);
      resolve();
    });
    server.closeIdleConnections();
  });
}
