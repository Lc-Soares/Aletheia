import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type CallerVerifier, extractBearerToken } from "./auth.ts";
import { FetchError, OverloadedError } from "./errors.ts";
import type { MediaDownload, PageResult } from "./fetch-page.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

// Só campos sem dado do usuário: no máximo um hash truncado do domínio, nunca URL ou caminho.
export type LogEntry = {
  method: string;
  route: string;
  status: number;
  durationMs: number;
  domainHash: string | null;
  outcome: string;
};

export type PageFetcher = (url: string, signal: AbortSignal) => Promise<PageResult>;
export type FetcherServerOptions = { verifier: CallerVerifier; fetchPage: PageFetcher; log: (entry: LogEntry) => void };

type InFlight = { count: number; readonly max: number };

const ROUTES = new Map([
  ["/healthz", "GET"],
  ["/fetch", "POST"],
]);
const MAX_BODY_BYTES = 4 * 1024;
const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

class HttpError extends Error {
  readonly status: number;
  readonly outcome: string;

  constructor(status: number, outcome: string, message: string) {
    super(message);
    this.status = status;
    this.outcome = outcome;
  }
}

// Chave aleatória gerada na inicialização e nunca gravada: sem ela, o hash dos domínios populares
// se reverte por dicionário. A correlação vale só dentro da mesma instância.
const LOG_HASH_KEY = randomBytes(32);

export function domainHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const { hostname } = new URL(raw);
    return hostname === "" ? null : createHmac("sha256", LOG_HASH_KEY).update(hostname).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

async function authenticate(req: IncomingMessage, verifier: CallerVerifier): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  try {
    if (token === null) throw new Error("sem token");
    await verifier(token);
  } catch {
    throw new HttpError(401, "unauthorized", "Não autorizado");
  }
}

async function readJsonUrl(req: IncomingMessage): Promise<string> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new HttpError(415, "bad_content_type", "Use application/json");
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "Corpo grande demais");

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw new HttpError(413, "body_too_large", "Corpo grande demais");
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_request", "Requisição inválida");
  }
  const url = (parsed as { url?: unknown } | null)?.url;
  if (typeof url !== "string" || url === "") throw new HttpError(400, "bad_request", "Requisição inválida");
  return url;
}

function mediaLine(download: MediaDownload): Record<string, unknown> {
  const { url, kind, source } = download;
  if (!download.ok) return { type: "media_error", url, kind, source, error: download.error };
  const { contentType, size, sha256, bytes } = download;
  return { type: "media", url, kind, source, contentType, size, sha256, data: bytes.toString("base64") };
}

async function writeLine(res: ServerResponse, value: unknown, signal: AbortSignal): Promise<void> {
  if (!res.write(`${JSON.stringify(value)}\n`)) await once(res, "drain", { signal });
}

// NDJSON em streaming: uma linha "page", uma por mídia e "done". Os bytes vão em base64.
async function streamResult(res: ServerResponse, result: PageResult, signal: AbortSignal): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", ...SECURITY_HEADERS });
  const { finalUrl, title, headline, media } = result;
  await writeLine(res, { type: "page", finalUrl, title, headline, media }, signal);
  for (const download of result.downloads) await writeLine(res, mediaLine(download), signal);
  await writeLine(res, { type: "done" }, signal);
  res.end();
}

const busy = (): HttpError => new HttpError(503, "busy", "Serviço ocupado");

async function fetchAndStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  const url = await readJsonUrl(req);
  note({ domainHash: domainHash(url) });

  const controller = new AbortController();
  res.on("close", () => controller.abort()); // quem chamou desistiu: para os downloads
  try {
    const result = await options.fetchPage(url, controller.signal);
    note({ outcome: "ok" });
    await streamResult(res, result, controller.signal);
  } catch (error) {
    if (error instanceof OverloadedError) throw busy();
    if (!(error instanceof FetchError)) throw error;
    note({ outcome: error.category });
    sendJson(res, 422, { error: error.category, message: error.message });
  }
}

// Teto de requisições em andamento por instância: cada uma pode segurar dezenas de MiB de mídia,
// e a segurança não pode depender do --concurrency do Cloud Run. A vaga só volta no fim do streaming.
async function handleFetch(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  inFlight: InFlight,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  await authenticate(req, options.verifier);
  if (inFlight.count >= inFlight.max) throw busy();
  inFlight.count++;
  try {
    await fetchAndStream(req, res, options, note);
  } finally {
    inFlight.count--;
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  inFlight: InFlight,
  path: string,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  const method = ROUTES.get(path);
  if (method === undefined) return sendJson(res, 404, { error: "Não encontrado" });
  if (req.method !== method) return sendJson(res, 405, { error: "Método não permitido" }, { Allow: method });
  if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
  try {
    await handleFetch(req, res, options, inFlight, note);
  } catch (error) {
    if (!(error instanceof HttpError)) throw error;
    note({ outcome: error.outcome });
    const extra: Record<string, string> = error.status === 401 ? { "WWW-Authenticate": "Bearer" } : {};
    if (error.status === 413) extra["Connection"] = "close";
    if (error.status === 503) extra["Retry-After"] = "1";
    sendJson(res, error.status, { error: error.message }, extra);
  }
}

export function createFetcherServer(options: FetcherServerOptions): Server {
  const inFlight: InFlight = { count: 0, max: DEFAULT_LIMITS.maxInFlightFetches };
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    const started = performance.now();
    const path = (req.url ?? "").split("?")[0] ?? "";
    const entry: Partial<LogEntry> = {};
    const note = (fields: Partial<LogEntry>): void => {
      Object.assign(entry, fields);
    };
    res.on("finish", () => {
      options.log({
        method: req.method ?? "",
        route: ROUTES.has(path) ? path : "(outra)",
        status: res.statusCode,
        durationMs: Math.round(performance.now() - started),
        domainHash: entry.domainHash ?? null,
        outcome: entry.outcome ?? "-",
      });
    });
    route(req, res, options, inFlight, path, note).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Erro interno" });
      else res.destroy();
    });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}

// Encerramento gracioso, igual ao da API.
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
