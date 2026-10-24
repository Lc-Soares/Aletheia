// Cliente de POST /fetch. O endereço vem da config (serviço nosso), nunca do usuário; a URL do
// usuário só vai no corpo. A resposta é lida inteira para a memória, o mais rápido possível e com
// prazo próprio, desacoplada do ritmo do usuário final (requisito 4 de docs/fetcher.md).
import { setTimeout as sleep } from "node:timers/promises";

import {
  CONTRACT_LIMITS,
  type FetchedPage,
  type FetcherCategory,
  FetcherStreamParser,
  isFetcherCategory,
  isHttpStatus,
  MalformedResponse,
} from "./fetcher-contract.ts";
import type { ServiceTokenSource } from "./service-token.ts";

export type FetcherClientLimits = {
  deadlineMs: number; // prazo total da fase do fetcher, com novas tentativas e leitura do stream
  maxRetries: number; // novas tentativas depois de 503
  maxRetryWaitMs: number; // teto da espera entre tentativas, qualquer que seja o Retry-After
  retryReserveMs: number; // só tenta de novo se sobrar pelo menos isto do prazo depois da espera
  maxLineBytes: number; // uma mídia de 15 MiB em base64 (20 MiB) mais o JSON da linha
  maxTotalBytes: number; // 60 MiB de mídia em base64 (80 MiB) mais a linha page
  maxErrorBodyBytes: number;
};

export const DEFAULT_FETCHER_CLIENT_LIMITS: Readonly<FetcherClientLimits> = Object.freeze({
  deadlineMs: 40_000,
  maxRetries: 2,
  maxRetryWaitMs: 2_000,
  retryReserveMs: 5_000,
  maxLineBytes: 21 * 1024 * 1024,
  maxTotalBytes: 85 * 1024 * 1024,
  maxErrorBodyBytes: 4 * 1024,
});

export type FetcherOutcome =
  | { kind: "page"; page: FetchedPage }
  | { kind: "fetch_error"; category: FetcherCategory; httpStatus?: number }
  | { kind: "busy" }
  | { kind: "unauthorized" }
  | { kind: "failed"; reason: "status" | "network" | "malformed" | "token" }
  | { kind: "timeout" }
  | { kind: "aborted" };

export type FetcherCall = (url: string, signal: AbortSignal) => Promise<FetcherOutcome>;
export type FetcherClientOptions = { fetcherUrl: string; token: ServiceTokenSource; limits?: Partial<FetcherClientLimits> };

const MAX_RETRY_AFTER_SECONDS = 5;
const DEFAULT_RETRY_WAIT_MS = 1_000;
const NEWLINE = 0x0a;

// Os limites só podem ser reduzidos (testes); produção usa os padrões.
function resolveLimits(overrides: Partial<FetcherClientLimits> = {}): FetcherClientLimits {
  const limits = { ...DEFAULT_FETCHER_CLIENT_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof FetcherClientLimits>) {
    const value = overrides[key];
    if (value !== undefined && value >= 0) limits[key] = Math.min(limits[key], value);
  }
  return limits;
}

// Retry-After em segundos inteiros, de 0 a 5; qualquer outra coisa vira 1 s. Sempre com teto.
function retryWaitMs(header: string | null, maxWaitMs: number): number {
  const seconds = header !== null && /^\d{1,2}$/.test(header) ? Number(header) : Number.NaN;
  const wait = seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1000 : DEFAULT_RETRY_WAIT_MS;
  return Math.min(wait, maxWaitMs);
}

// Rejeita quando o sinal abortar, mesmo que a promessa ignore o sinal (por exemplo, o token).
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function mediaType(response: Response): string {
  return (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

async function readLimited(body: ReadableStream<Uint8Array>, maxBytes: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > maxBytes) throw new MalformedResponse();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Corta o stream em linhas sem juntar tudo antes: cada linha tem teto próprio e a resposta inteira
// também. Cada linha vai para o parser assim que chega, e o base64 é descartado depois de decodificado.
async function readNdjson(body: ReadableStream<Uint8Array>, limits: FetcherClientLimits): Promise<FetchedPage> {
  const parser = new FetcherStreamParser(CONTRACT_LIMITS);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const acceptLine = (line: Buffer): void => {
    let value: unknown;
    try {
      value = JSON.parse(decoder.decode(line));
    } catch {
      throw new MalformedResponse();
    }
    parser.accept(value);
  };
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let total = 0;
  for await (const chunk of body) {
    total += chunk.length;
    if (total > limits.maxTotalBytes) throw new MalformedResponse();
    let start = 0;
    for (let end = chunk.indexOf(NEWLINE); end !== -1; end = chunk.indexOf(NEWLINE, start)) {
      if (pendingBytes + end - start > limits.maxLineBytes) throw new MalformedResponse();
      const line = Buffer.concat([...pending, chunk.subarray(start, end)]);
      pending = [];
      pendingBytes = 0;
      acceptLine(line);
      start = end + 1;
    }
    if (pendingBytes + chunk.length - start > limits.maxLineBytes) throw new MalformedResponse();
    if (start < chunk.length) {
      pending.push(chunk.slice(start));
      pendingBytes += chunk.length - start;
    }
  }
  if (pendingBytes > 0) throw new MalformedResponse(); // última linha sem quebra: corte no meio
  return parser.finish();
}

// Do 422 só aproveita a categoria conhecida e o httpStatus válido; o resto do corpo é descartado.
async function readFetchError(body: ReadableStream<Uint8Array> | null, limits: FetcherClientLimits): Promise<FetcherOutcome> {
  if (body === null) throw new MalformedResponse();
  let parsed: unknown;
  try {
    parsed = JSON.parse((await readLimited(body, limits.maxErrorBodyBytes)).toString("utf8"));
  } catch {
    throw new MalformedResponse();
  }
  const { error, httpStatus } = (parsed ?? {}) as { error?: unknown; httpStatus?: unknown };
  if (!isFetcherCategory(error)) throw new MalformedResponse();
  if (error === "upstream_status" && isHttpStatus(httpStatus)) return { kind: "fetch_error", category: error, httpStatus };
  return { kind: "fetch_error", category: error };
}

async function interpret(response: Response, limits: FetcherClientLimits): Promise<FetcherOutcome> {
  if (response.status === 200) {
    if (mediaType(response) !== "application/x-ndjson" || response.body === null) throw new MalformedResponse();
    return { kind: "page", page: await readNdjson(response.body, limits) };
  }
  if (response.status === 422) return readFetchError(response.body, limits);
  await response.body?.cancel();
  if (response.status === 401) return { kind: "unauthorized" };
  return { kind: "failed", reason: "status" };
}

export function createFetcherClient(options: FetcherClientOptions): FetcherCall {
  const limits = resolveLimits(options.limits);
  const endpoint = new URL("/fetch", options.fetcherUrl);

  return async (url, signal) => {
    const deadline = AbortSignal.timeout(limits.deadlineMs);
    const combined = AbortSignal.any([signal, deadline]);
    const deadlineAt = performance.now() + limits.deadlineMs;
    try {
      let token: string;
      try {
        token = await untilAborted(options.token(), combined);
      } catch (error) {
        if (combined.aborted) throw error;
        return { kind: "failed", reason: "token" };
      }
      for (let attempt = 0; ; attempt++) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/x-ndjson" },
          body: JSON.stringify({ url }),
          redirect: "error",
          signal: combined,
        });
        if (response.status !== 503) return await interpret(response, limits);
        await response.body?.cancel();
        const wait = retryWaitMs(response.headers.get("retry-after"), limits.maxRetryWaitMs);
        if (attempt >= limits.maxRetries || deadlineAt - performance.now() < wait + limits.retryReserveMs) return { kind: "busy" };
        await sleep(wait, undefined, { signal: combined });
      }
    } catch (error) {
      // Classifica pelo estado dos sinais; o erro original (que pode citar endereços) é descartado.
      if (signal.aborted) return { kind: "aborted" };
      if (deadline.aborted) return { kind: "timeout" };
      if (error instanceof MalformedResponse) return { kind: "failed", reason: "malformed" };
      return { kind: "failed", reason: "network" };
    }
  };
}
