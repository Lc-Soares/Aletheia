import { createHmac, randomBytes } from "node:crypto";
import { once } from "node:events";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { type CallerVerifier, extractBearerToken } from "./auth.ts";
import { FetchError, OverloadedError } from "./errors.ts";
import type { MediaDownload, PageResult } from "./fetch-page.ts";
import { type Limits, resolveLimits } from "./limits.ts";

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
export type FetcherServerOptions = {
  verifier: CallerVerifier;
  fetchPage: PageFetcher;
  log: (entry: LogEntry) => void;
  limits?: Partial<Limits>; // passa por resolveLimits: só reduz (testes); produção usa os padrões
};

// Vagas de /fetch em andamento e limites da instância.
type ServerState = { inFlight: number; readonly limits: Limits };

// Cada linha sai em fatias de 64 KiB, para que "sem progresso" seja medido de verdade: com um único
// write de ~20 MiB (mídia em base64), um drain mediria o tempo de enviar tudo, não a inatividade.
const WRITE_SLICE_BYTES = 64 * 1024;

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
  const { url, kind, source, group } = download;
  if (!download.ok) {
    const { error, httpStatus } = download;
    const line = { type: "media_error", url, kind, source, group, error };
    return httpStatus === undefined ? line : { ...line, httpStatus };
  }
  const { contentType, size, sha256, bytes } = download;
  return { type: "media", url, kind, source, group, contentType, size, sha256, data: bytes.toString("base64") };
}

// Respostas que o PRÓPRIO fetcher destruiu. A categoria é registrada antes do destroy(), então o
// listener de close nunca a confunde com client_closed (ver createFetcherServer).
type StreamDeadlineOutcome = "stream_idle_timeout" | "stream_total_timeout";
const SERVER_DESTROYED_OUTCOMES: ReadonlySet<string> = new Set(["stream_idle_timeout", "stream_total_timeout", "internal_error"]);

class StreamDeadline extends Error {
  readonly outcome: StreamDeadlineOutcome;

  constructor(outcome: StreamDeadlineOutcome) {
    super(outcome);
    this.outcome = outcome;
  }
}

type StreamSignals = { request: AbortSignal; total: AbortSignal; idleMs: number };

// O prazo de inatividade só corre enquanto se espera o drain (quem chamou não está lendo).
// As fatias são cortadas nos bytes, não na string, para não partir caracteres UTF-8.
async function writeLine(res: ServerResponse, value: unknown, signals: StreamSignals): Promise<void> {
  const line = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  for (let offset = 0; offset < line.length; offset += WRITE_SLICE_BYTES) {
    if (res.write(line.subarray(offset, offset + WRITE_SLICE_BYTES))) continue;
    const idle = AbortSignal.timeout(signals.idleMs);
    try {
      await once(res, "drain", { signal: AbortSignal.any([signals.request, signals.total, idle]) });
    } catch (error) {
      // Classifica pelo estado dos sinais: um prazo do fetcher, ou então quem chamou fechou.
      if (signals.total.aborted) throw new StreamDeadline("stream_total_timeout");
      if (idle.aborted) throw new StreamDeadline("stream_idle_timeout");
      throw error;
    }
  }
}

// NDJSON em streaming: uma linha "page", uma por mídia e "done". Os bytes vão em base64.
// Prazos: total desde o writeHead e inatividade em cada espera de drain. Esgotado qualquer um, a
// resposta é destruída e a vaga volta pelo finally de handleFetch (achado 1 da terceira revisão).
async function streamResult(
  res: ServerResponse,
  result: PageResult,
  request: AbortSignal,
  limits: Limits,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  const signals: StreamSignals = { request, total: AbortSignal.timeout(limits.streamTotalMs), idleMs: limits.streamIdleMs };
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", ...SECURITY_HEADERS });
  try {
    const { finalUrl, title, headline, media, possiblyNeedsJavaScript } = result;
    await writeLine(res, { type: "page", finalUrl, title, headline, possiblyNeedsJavaScript, media }, signals);
    for (const download of result.downloads) await writeLine(res, mediaLine(download), signals);
    await writeLine(res, { type: "done" }, signals);
    res.end();
  } catch (error) {
    // Antes do destroy: prazo do fetcher, ou erro interno se não foi quem chamou que fechou.
    if (error instanceof StreamDeadline) note({ outcome: error.outcome });
    else if (!request.aborted) note({ outcome: "internal_error" });
    res.destroy();
    throw error;
  }
}

const busy = (): HttpError => new HttpError(503, "busy", "Serviço ocupado");

async function fetchAndStream(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  limits: Limits,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  const url = await readJsonUrl(req);
  note({ domainHash: domainHash(url) });

  const controller = new AbortController();
  res.on("close", () => controller.abort()); // quem chamou desistiu: para os downloads
  try {
    const result = await options.fetchPage(url, controller.signal);
    note({ outcome: "ok" });
    await streamResult(res, result, controller.signal, limits, note);
  } catch (error) {
    if (error instanceof OverloadedError) throw busy();
    if (!(error instanceof FetchError)) throw error;
    note({ outcome: error.category });
    const { category, message, httpStatus } = error;
    sendJson(res, 422, httpStatus === undefined ? { error: category, message } : { error: category, message, httpStatus });
  }
}

// Teto de requisições em andamento por instância: cada uma pode segurar dezenas de MiB de mídia,
// e a segurança não pode depender do --concurrency do Cloud Run. A vaga só volta no fim do streaming.
async function handleFetch(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  state: ServerState,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  await authenticate(req, options.verifier);
  if (state.inFlight >= state.limits.maxInFlightFetches) throw busy();
  state.inFlight++;
  try {
    await fetchAndStream(req, res, options, state.limits, note);
  } finally {
    state.inFlight--;
  }
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: FetcherServerOptions,
  state: ServerState,
  path: string,
  note: (fields: Partial<LogEntry>) => void,
): Promise<void> {
  const method = ROUTES.get(path);
  if (method === undefined) return sendJson(res, 404, { error: "Não encontrado" });
  if (req.method !== method) return sendJson(res, 405, { error: "Método não permitido" }, { Allow: method });
  if (path === "/healthz") return sendJson(res, 200, { status: "ok" });
  try {
    await handleFetch(req, res, options, state, note);
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
  const state: ServerState = { inFlight: 0, limits: resolveLimits(options.limits) };
  const server = createServer({ maxHeaderSize: 8 * 1024 }, (req, res) => {
    const started = performance.now();
    const path = (req.url ?? "").split("?")[0] ?? "";
    const entry: Partial<LogEntry> = {};
    const note = (fields: Partial<LogEntry>): void => {
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
        domainHash: entry.domainHash ?? null,
        outcome,
      });
    };
    res.on("finish", () => writeLog(res.statusCode, entry.outcome ?? "-"));
    // Fechou sem terminar: se o fetcher destruiu, a categoria já foi registrada antes do destroy();
    // senão, quem chamou fechou. Status 0 quando nada foi enviado.
    res.on("close", () => {
      if (res.writableFinished) return;
      const outcome = entry.outcome !== undefined && SERVER_DESTROYED_OUTCOMES.has(entry.outcome) ? entry.outcome : "client_closed";
      writeLog(res.headersSent ? res.statusCode : 0, outcome);
    });
    route(req, res, options, state, path, note).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "Erro interno" });
      else if (!res.destroyed) {
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
