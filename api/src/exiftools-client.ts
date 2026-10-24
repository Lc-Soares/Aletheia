// Cliente de POST /extract da ExifTools (docs/apis/documentacao-exif.md). Regras:
// - envia SEMPRE o arquivo, em multipart, num único campo "file" com nome genérico. Nunca "url"
//   nem "data_url": a ExifTools não pode buscar nada por conta própria (contornaria o fetcher e
//   vazaria a URL do usuário). Esta função nem recebe URL;
// - chave só no cabeçalho X-API-Key, nunca em ?key=, e nunca em log, resultado ou erro;
// - nunca lança: toda falha vira um status, e o erro original é descartado.
import { setTimeout as sleep } from "node:timers/promises";

// Endereço fixo: sem variável de ambiente para trocar o destino (a chave iria junto). Os testes
// passam o endereço do servidor falso pelas opções.
export const EXIFTOOLS_EXTRACT_URL = "https://exiftools.com/api/v1/extract";

export type ExifToolsLimits = {
  callTimeoutMs: number; // por chamada, limitado também pelo prazo total de quem chama
  maxResponseBytes: number;
  maxRetryWaitMs: number; // teto da espera antes da única nova tentativa
  retryReserveMs: number; // só tenta de novo se sobrar pelo menos isto do prazo depois da espera
};

export const DEFAULT_EXIFTOOLS_LIMITS: Readonly<ExifToolsLimits> = Object.freeze({
  callTimeoutMs: 15_000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxRetryWaitMs: 2_000,
  retryReserveMs: 5_000,
});

export type ExtractStatus = "ok" | "unavailable" | "unsupported" | "too_large" | "invalid" | "config_error";
export type ExtractResult =
  | { status: "ok"; response: Record<string, unknown> }
  | { status: Exclude<ExtractStatus, "ok"> };
export type MediaFile = { bytes: Buffer; contentType: string };
// deadlineAt: instante-limite da checagem inteira, na escala de performance.now().
export type ExtractOptions = { signal: AbortSignal; deadlineAt: number };
export type ExtractCall = (media: MediaFile, options: ExtractOptions) => Promise<ExtractResult>;
export type ExifToolsClientOptions = { apiKey: string; endpoint?: string; limits?: Partial<ExifToolsLimits> };

type Attempt = ExtractResult | { status: "retry"; waitMs: number };

const DEFAULT_RETRY_WAIT_MS = 1_000;
const UNAVAILABLE: ExtractResult = { status: "unavailable" };
const INVALID: ExtractResult = { status: "invalid" };

// Nome genérico, derivado só do content-type: nunca o nome original (pode revelar o caminho).
const EXTENSIONS: ReadonlyMap<string, string> = new Map([
  ["image/jpeg", "jpg"],
  ["image/jpg", "jpg"],
  ["image/png", "png"],
  ["image/gif", "gif"],
  ["image/webp", "webp"],
  ["image/avif", "avif"],
  ["image/heic", "heic"],
  ["image/heif", "heif"],
  ["image/tiff", "tiff"],
  ["video/mp4", "mp4"],
  ["video/webm", "webm"],
  ["video/quicktime", "mov"],
]);

// Os limites só podem ser reduzidos (testes); produção usa os padrões.
function resolveLimits(overrides: Partial<ExifToolsLimits> = {}): ExifToolsLimits {
  const limits = { ...DEFAULT_EXIFTOOLS_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof ExifToolsLimits>) {
    const value = overrides[key];
    if (value !== undefined && value >= 0) limits[key] = Math.min(limits[key], value);
  }
  return limits;
}

function retryWaitMs(header: string | null, maxWaitMs: number): number {
  const wait = header !== null && /^\d{1,2}$/.test(header) ? Number(header) * 1000 : DEFAULT_RETRY_WAIT_MS;
  return Math.min(wait, maxWaitMs);
}

function multipart(media: MediaFile): FormData {
  const form = new FormData();
  const name = `media.${EXTENSIONS.get(media.contentType) ?? "bin"}`;
  form.append("file", new Blob([new Uint8Array(media.bytes)], { type: media.contentType }), name);
  return form;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

// Corpo de sucesso com teto: Content-Length acima do limite é recusado sem ler; em fluxo, a
// leitura para no primeiro pedaço que passa do limite.
async function readSuccess(response: Response, maxBytes: number): Promise<ExtractResult> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes || response.body === null) {
    await response.body?.cancel().catch(() => {});
    return INVALID;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) return INVALID; // sair do laço cancela o stream
      chunks.push(chunk);
    }
  } catch {
    return UNAVAILABLE; // conexão caiu ou o prazo esgotou no meio do corpo
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return INVALID;
  }
  return isPlainObject(parsed) && parsed["success"] === true ? { status: "ok", response: parsed } : INVALID;
}

function classify(status: number, retryAfter: string | null, limits: ExifToolsLimits): Attempt {
  if (status === 429 || status >= 500) return { status: "retry", waitMs: retryWaitMs(retryAfter, limits.maxRetryWaitMs) };
  if (status === 401 || status === 403) return { status: "config_error" }; // chave inválida: erro nosso
  if (status === 413) return { status: "too_large" };
  if (status === 415) return { status: "unsupported" };
  return INVALID; // 400, outros 4xx e redirecionamentos (não seguidos)
}

async function attempt(media: MediaFile, options: ExtractOptions, endpoint: string, apiKey: string, limits: ExifToolsLimits): Promise<Attempt> {
  const remaining = options.deadlineAt - performance.now();
  if (remaining <= 0 || options.signal.aborted) return UNAVAILABLE;
  // AbortSignal.timeout exige inteiro; performance.now() dá frações.
  const timeoutMs = Math.max(1, Math.floor(Math.min(limits.callTimeoutMs, remaining)));
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(timeoutMs)]);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "X-API-Key": apiKey, Accept: "application/json" },
      body: multipart(media),
      // manual: um redirecionamento para outra origem levaria o X-API-Key junto.
      redirect: "manual",
      signal,
    });
  } catch {
    // Prazo da chamada ou falha de rede: candidata a nova tentativa; cancelamento de quem chamou, não.
    return options.signal.aborted ? UNAVAILABLE : { status: "retry", waitMs: Math.min(DEFAULT_RETRY_WAIT_MS, limits.maxRetryWaitMs) };
  }
  if (response.status === 200) return readSuccess(response, limits.maxResponseBytes);
  await response.body?.cancel().catch(() => {});
  return classify(response.status, response.headers.get("retry-after"), limits);
}

export function createExifToolsClient(options: ExifToolsClientOptions): ExtractCall {
  const limits = resolveLimits(options.limits);
  const endpoint = options.endpoint ?? EXIFTOOLS_EXTRACT_URL;
  const { apiKey } = options;

  const extract: ExtractCall = async (media, extractOptions) => {
    if (apiKey === "") return { status: "config_error" };
    const first = await attempt(media, extractOptions, endpoint, apiKey, limits);
    if (first.status !== "retry") return first;
    // No máximo uma nova tentativa, com espera curta, e só se couber no prazo total.
    const left = extractOptions.deadlineAt - performance.now();
    if (extractOptions.signal.aborted || left < first.waitMs + limits.retryReserveMs) return UNAVAILABLE;
    try {
      await sleep(first.waitMs, undefined, { signal: extractOptions.signal });
    } catch {
      return UNAVAILABLE;
    }
    const second = await attempt(media, extractOptions, endpoint, apiKey, limits);
    return second.status === "retry" ? UNAVAILABLE : second;
  };
  // Rede de proteção: um erro inesperado também vira status, sem a mensagem original.
  return (media, extractOptions) => extract(media, extractOptions).catch(() => UNAVAILABLE);
}
