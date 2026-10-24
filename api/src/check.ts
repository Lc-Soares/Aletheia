// POST /api/check: autentica, confere a capacidade da instância, valida o corpo, consome o limite
// do plano, chama o fetcher e manda cada mídia baixada à ExifTools. Responde um único JSON no fim,
// com sinais e nunca veredito.
import type { IncomingMessage, ServerResponse } from "node:http";

import { type Analysis, analyzeDownloads, type MetadataView } from "./analyze.ts";
import type { TokenVerifier } from "./auth.ts";
import type { ExtractCall } from "./exiftools-client.ts";
import type { DownloadResult, FetchedPage } from "./fetcher-contract.ts";
import type { FetcherCall, FetcherOutcome } from "./fetcher-client.ts";
import { authenticate, domainHash, HttpError, sendJson } from "./http.ts";
import { fetchErrorView, NOTICES, rateLimitedMessage, USER_MESSAGES } from "./messages.ts";
import { type Plan, PLANS, resolvePlan } from "./plans.ts";
import { type RateLimiter, userKey } from "./rate-limit.ts";

export type CheckDeps = {
  callFetcher: FetcherCall;
  extract: ExtractCall;
  limiter: RateLimiter;
  maxInFlightChecks: number;
  totalDeadlineMs?: number; // só reduz o padrão (testes)
};
export type CheckState = { inFlight: number };
export type CheckLogFields = {
  outcome?: string;
  domainHash?: string | null;
  mediaCount?: number;
  analyzedCount?: number;
  exif?: Record<string, number>;
};

// Cada checagem pode segurar cerca de 110 MiB (docs/api.md); acima disso, 503.
export const DEFAULT_MAX_IN_FLIGHT_CHECKS = 4;
// Prazo total da checagem, desde a chegada da requisição: o Firebase Hosting corta em 60 s. A fase
// do fetcher tem prazo próprio de 40 s (fetcher-client.ts); a ExifTools fica com o que sobrar.
export const DEFAULT_TOTAL_DEADLINE_MS = 50_000;

const MAX_BODY_BYTES = 4 * 1024;
const MAX_URL_LENGTH = 2048;
const BUSY_RETRY_AFTER = "5";

const badRequest = (): HttpError => new HttpError(400, "bad_request", { error: "bad_request", message: "Requisição inválida." });
const tooLarge = (): HttpError =>
  new HttpError(413, "body_too_large", { error: "body_too_large", message: "Requisição grande demais." }, { Connection: "close" });
const busy = (outcome: string): HttpError =>
  new HttpError(503, outcome, { error: "busy", message: USER_MESSAGES.busy }, { "Retry-After": BUSY_RETRY_AFTER });

// Exatamente { "url": string }, com 1 a 2048 caracteres, num corpo JSON de até 4 KiB.
async function readCheckBody(req: IncomingMessage): Promise<string> {
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "bad_content_type", { error: "bad_content_type", message: "Envie o corpo como application/json." });
  }
  if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) throw tooLarge();
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) throw tooLarge();
    chunks.push(chunk as Buffer);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw badRequest();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw badRequest();
  const keys = Object.keys(parsed);
  const { url } = parsed as { url?: unknown };
  if (keys.length !== 1 || keys[0] !== "url" || typeof url !== "string") throw badRequest();
  if (url.length === 0 || url.length > MAX_URL_LENGTH) throw badRequest();
  return url;
}

function downloadView(download: DownloadResult | undefined): Record<string, unknown> | null {
  if (download === undefined) return null;
  if (download.ok) return { status: "ok", contentType: download.contentType, size: download.size, sha256: download.sha256 };
  return { status: "error", ...fetchErrorView(download.error, download.httpStatus) };
}

// Todas as mídias listadas, com a seleção, o resultado do download e, para as baixadas, a análise
// de metadados. Os bytes nunca saem daqui.
function buildReport(page: FetchedPage, metadata: Map<string, MetadataView>): Record<string, unknown> {
  const downloads = new Map(page.downloads.map((download) => [download.url, download]));
  const { finalUrl, title, headline, possiblyNeedsJavaScript } = page;
  const notices: string[] = [NOTICES.selection, NOTICES.c2paRevocation, NOTICES.c2paSigner];
  if (possiblyNeedsJavaScript) notices.push(NOTICES.javascript);
  return {
    page: { finalUrl, title, headline, possiblyNeedsJavaScript },
    media: page.media.map((ref) => ({
      ...ref,
      download: ref.selected ? downloadView(downloads.get(ref.url)) : null,
      metadata: metadata.get(ref.url) ?? null,
    })),
    notices,
  };
}

// A categoria exata vai só para o log; o usuário vê a mensagem unificada.
function respondReport(res: ServerResponse, page: FetchedPage, analysis: Analysis, note: (fields: CheckLogFields) => void): void {
  const mediaCount = page.downloads.filter((download) => download.ok).length;
  note({ outcome: "ok", mediaCount, analyzedCount: analysis.analyzed, exif: analysis.tally });
  sendJson(res, 200, buildReport(page, analysis.views));
}

// Uma falha da fase do fetcher: a categoria exata vai só para o log.
function respondFailure(res: ServerResponse, outcome: Exclude<FetcherOutcome, { kind: "page" }>, note: (fields: CheckLogFields) => void): void {
  const internal = { error: "internal", message: USER_MESSAGES.internal };
  switch (outcome.kind) {
    case "fetch_error":
      note({ outcome: `fetch_${outcome.category}` });
      return sendJson(res, 422, fetchErrorView(outcome.category, outcome.httpStatus));
    case "busy":
      note({ outcome: "fetcher_busy" });
      return sendJson(res, 503, { error: "busy", message: USER_MESSAGES.busy }, { "Retry-After": BUSY_RETRY_AFTER });
    case "unauthorized":
      note({ outcome: "fetcher_unauthorized" });
      return sendJson(res, 502, internal);
    case "failed":
      note({ outcome: `fetcher_${outcome.reason}` });
      return sendJson(res, 502, internal);
    case "timeout":
      note({ outcome: "fetcher_timeout" });
      return sendJson(res, 504, { error: "timeout", message: USER_MESSAGES.timeout });
    case "aborted":
      // Quem chamou fechou a conexão; o log já registrou client_closed.
      if (!res.destroyed) res.destroy();
      return;
  }
}

// Análise de metadados com o que sobrar do prazo total; o sinal também cai se o usuário desistir.
async function analyze(page: FetchedPage, plan: Plan, deps: CheckDeps, cancel: AbortSignal, deadlineAt: number): Promise<Analysis> {
  // AbortSignal.timeout exige inteiro; performance.now() dá frações.
  const remainingMs = Math.max(1, Math.floor(deadlineAt - performance.now()));
  const signal = AbortSignal.any([cancel, AbortSignal.timeout(remainingMs)]);
  return analyzeDownloads(page.downloads, { extract: deps.extract, maxMedia: plan.maxMediaPerCheck, signal, deadlineAt });
}

// Solta as referências aos bytes das mídias assim que a resposta sai (stateless).
function discard(outcome: FetcherOutcome): void {
  if (outcome.kind === "page") outcome.page.downloads.length = 0;
}

export async function handleCheck(
  req: IncomingMessage,
  res: ServerResponse,
  verifier: TokenVerifier,
  deps: CheckDeps,
  state: CheckState,
  note: (fields: CheckLogFields) => void,
): Promise<void> {
  const totalMs = Math.min(DEFAULT_TOTAL_DEADLINE_MS, deps.totalDeadlineMs ?? DEFAULT_TOTAL_DEADLINE_MS);
  const deadlineAt = performance.now() + totalMs;
  const identity = await authenticate(req, verifier);
  if (state.inFlight >= deps.maxInFlightChecks) throw busy("api_busy");
  state.inFlight++;
  try {
    const url = await readCheckBody(req); // corpo inválido não gasta cota
    note({ domainHash: domainHash(url) });
    const plan = PLANS[resolvePlan(identity)];
    const admission = deps.limiter.consume(userKey(identity.sub), plan.checksPerHour);
    if (!admission.allowed) {
      const message = rateLimitedMessage(plan.checksPerHour, admission.retryAfterSeconds);
      const outcome = admission.reason === "full" ? "limiter_full" : "rate_limited";
      throw new HttpError(429, outcome, { error: "rate_limited", message }, { "Retry-After": String(admission.retryAfterSeconds) });
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort()); // quem chamou desistiu: para o fetcher
    const outcome = await deps.callFetcher(url, controller.signal);
    try {
      if (outcome.kind !== "page") {
        if (outcome.kind === "busy") admission.release(); // nada foi buscado no alvo; a falta de vaga é nossa
        return respondFailure(res, outcome, note);
      }
      const analysis = await analyze(outcome.page, plan, deps, controller.signal, deadlineAt);
      if (controller.signal.aborted) return void res.destroy(); // quem chamou já foi embora
      respondReport(res, outcome.page, analysis, note);
    } finally {
      discard(outcome);
    }
  } finally {
    state.inFlight--;
  }
}
