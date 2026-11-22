// Cliente de GET claims:search do Google Fact Check Tools (docs/apis/fact-check.md). Regras:
// - envia só o texto da busca (a manchete ou o título da página) e pageSize; nunca a URL da página;
// - chave só no cabeçalho X-Goog-Api-Key, nunca em ?key= (a página de chaves do Google Cloud diz
//   que a chave na URL fica exposta), e nunca em log, resultado ou erro;
// - nunca lança: toda falha vira um status, e o erro original (que pode citar a URL, e com ela o
//   texto da busca) é descartado;
// - sem nova tentativa: uma chamada por checagem, com prazo curto (docs/api.md, "Fact Check Tools").
import { type FactCheckClaim, FACT_CHECK_LIMITS, parseSearchResponse } from "./factcheck-response.ts";

// Endereço fixo: sem variável de ambiente para trocar o destino (a chave iria junto). Os testes
// passam o endereço do servidor falso pelas opções.
export const FACTCHECK_SEARCH_URL = "https://factchecktools.googleapis.com/v1alpha1/claims:search";

export type FactCheckLimits = {
  callTimeoutMs: number; // por chamada, limitado também pelo prazo total de quem chama
  maxResponseBytes: number;
};

export const DEFAULT_FACTCHECK_LIMITS: Readonly<FactCheckLimits> = Object.freeze({
  callTimeoutMs: 5_000,
  maxResponseBytes: 512 * 1024,
});

// Categoria exata da falha: só para o log. O usuário vê "unavailable".
export type FactCheckFailure =
  | "http_400"
  | "http_403"
  | "http_429"
  | "http_5xx"
  | "http_other"
  | "timeout"
  | "network"
  | "invalid"
  | "too_large"
  | "aborted";

export type FactCheckResult =
  | { status: "ok"; claims: FactCheckClaim[] }
  | { status: "unavailable"; reason: FactCheckFailure }
  | { status: "not_configured" };

// deadlineAt: instante-limite da checagem inteira, na escala de performance.now().
export type FactCheckOptions = { signal: AbortSignal; deadlineAt: number };
export type FactCheckCall = (query: string, options: FactCheckOptions) => Promise<FactCheckResult>;
export type FactCheckClientOptions = { apiKey: string | null; endpoint?: string; limits?: Partial<FactCheckLimits> };

const fail = (reason: FactCheckFailure): FactCheckResult => ({ status: "unavailable", reason });

// Os limites só podem ser reduzidos (testes); produção usa os padrões.
function resolveLimits(overrides: Partial<FactCheckLimits> = {}): FactCheckLimits {
  const limits = { ...DEFAULT_FACTCHECK_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof FactCheckLimits>) {
    const value = overrides[key];
    if (value !== undefined && value >= 0) limits[key] = Math.min(limits[key], value);
  }
  return limits;
}

function classifyStatus(status: number): FactCheckFailure {
  if (status === 400) return "http_400";
  if (status === 403) return "http_403"; // chave inválida ou API desativada: precisa de ação nossa
  if (status === 429) return "http_429"; // cota
  if (status >= 500) return "http_5xx";
  return "http_other"; // outros 4xx e redirecionamentos (não seguidos)
}

function searchUrl(endpoint: string, query: string): URL {
  const url = new URL(endpoint);
  url.searchParams.set("query", query);
  url.searchParams.set("pageSize", String(FACT_CHECK_LIMITS.maxClaims));
  return url;
}

// Corpo com teto: Content-Length acima do limite é recusado sem ler; em fluxo, a leitura para no
// primeiro pedaço que passa do limite.
async function readBody(response: Response, maxBytes: number): Promise<Buffer | "too_large"> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes || response.body === null) {
    await response.body?.cancel().catch(() => {});
    return "too_large";
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > maxBytes) return "too_large"; // sair do laço cancela o stream
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function parseBody(body: Buffer): FactCheckResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return fail("invalid");
  }
  const claims = parseSearchResponse(parsed);
  return claims === null ? fail("invalid") : { status: "ok", claims };
}

async function search(query: string, options: FactCheckOptions, endpoint: string, apiKey: string, limits: FactCheckLimits): Promise<FactCheckResult> {
  if (options.signal.aborted) return fail("aborted");
  const remaining = options.deadlineAt - performance.now();
  if (remaining <= 0) return fail("timeout");
  // AbortSignal.timeout exige inteiro; performance.now() dá frações.
  const timer = AbortSignal.timeout(Math.max(1, Math.floor(Math.min(limits.callTimeoutMs, remaining))));
  const signal = AbortSignal.any([options.signal, timer]);
  // Classifica pelo estado dos sinais; o erro original é descartado.
  const failure = (): FactCheckResult => fail(options.signal.aborted ? "aborted" : timer.aborted ? "timeout" : "network");
  let response: Response;
  try {
    response = await fetch(searchUrl(endpoint, query), {
      method: "GET",
      headers: { "X-Goog-Api-Key": apiKey, Accept: "application/json" },
      // manual: um redirecionamento para outra origem levaria a chave junto.
      redirect: "manual",
      signal,
    });
  } catch {
    return failure();
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    return fail(classifyStatus(response.status));
  }
  try {
    const body = await readBody(response, limits.maxResponseBytes);
    return body === "too_large" ? fail("too_large") : parseBody(body);
  } catch {
    return failure(); // conexão caiu ou o prazo esgotou no meio do corpo
  }
}

export function createFactCheckClient(options: FactCheckClientOptions): FactCheckCall {
  const limits = resolveLimits(options.limits);
  const endpoint = options.endpoint ?? FACTCHECK_SEARCH_URL;
  const apiKey = options.apiKey ?? "";
  return (query, searchOptions) => {
    if (apiKey === "") return Promise.resolve({ status: "not_configured" });
    // Rede de proteção: um erro inesperado também vira status, sem a mensagem original.
    return search(query, searchOptions, endpoint, apiKey, limits).catch(() => fail("network"));
  };
}
