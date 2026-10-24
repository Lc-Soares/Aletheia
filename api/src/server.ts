import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { TokenVerifier } from "./auth.ts";
import { type CheckDeps, type CheckLogFields, type CheckState, handleCheck } from "./check.ts";
import { authenticate, HttpError, sendJson } from "./http.ts";

// Só campos sem dado do usuário: nada de token, e-mail, corpo, query ou caminho livre. O domínio
// aparece no máximo como hash HMAC truncado.
export type LogEntry = {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  outcome: string;
  domainHash: string | null;
  mediaCount: number | null; // mídias baixadas
  analyzedCount: number | null; // mídias com sinais da ExifTools
  exif: Record<string, number> | null; // contagem por status da ExifTools (ok, unavailable, config_error...)
};

export type ApiOptions = { verifier: TokenVerifier; log: (entry: LogEntry) => void; check: CheckDeps };

const ROUTES = new Map([
  ["/healthz", "GET"],
  ["/api/me", "GET"],
  ["/api/check", "POST"],
]);

async function handleMe(req: IncomingMessage, res: ServerResponse, verifier: TokenVerifier): Promise<void> {
  const { email } = await authenticate(req, verifier);
  sendJson(res, 200, { email });
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: ApiOptions,
  state: CheckState,
  path: string,
  note: (fields: CheckLogFields) => void,
): Promise<void> {
  const method = ROUTES.get(path);
  if (method === undefined) return sendJson(res, 404, { error: "Não encontrado" });
  if (req.method !== method) return sendJson(res, 405, { error: "Método não permitido" }, { Allow: method });
  if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
  try {
    if (path === "/api/me") await handleMe(req, res, options.verifier);
    else await handleCheck(req, res, options.verifier, options.check, state, note);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    note({ outcome: error.outcome });
    sendJson(res, error.status, error.body, error.headers);
  }
}

export function createApiServer(options: ApiOptions): Server {
  const state: CheckState = { inFlight: 0 };
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    const started = performance.now();
    const path = (req.url ?? "").split("?")[0] ?? "";
    const entry: CheckLogFields = {};
    const note = (fields: CheckLogFields): void => {
      Object.assign(entry, fields);
    };
    // Exatamente uma linha por requisição: no finish (terminou) ou no close (não terminou).
    let logged = false;
    const writeLog = (status: number, outcome: string): void => {
      if (logged) return;
      logged = true;
      options.log({
        method: req.method ?? "",
        route: ROUTES.has(path) ? path : "(outra)",
        status,
        durationMs: Math.round(performance.now() - started),
        outcome,
        domainHash: entry.domainHash ?? null,
        mediaCount: entry.mediaCount ?? null,
        analyzedCount: entry.analyzedCount ?? null,
        exif: entry.exif ?? null,
      });
    };
    res.on("finish", () => writeLog(res.statusCode, entry.outcome ?? "-"));
    res.on("close", () => {
      if (res.writableFinished) return;
      writeLog(res.headersSent ? res.statusCode : 0, entry.outcome === "internal_error" ? "internal_error" : "client_closed");
    });
    route(req, res, options, state, path, note).catch(() => {
      if (!res.headersSent) {
        note({ outcome: "internal_error" });
        sendJson(res, 500, { error: "Erro interno" });
      } else if (!res.destroyed) {
        note({ outcome: "internal_error" }); // antes do destroy: não vira client_closed
        res.destroy();
      }
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
