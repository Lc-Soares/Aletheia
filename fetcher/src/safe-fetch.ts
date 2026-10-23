import { type ByteBudget, readLimited } from "./body.ts";
import { FetchError, toFetchError, withDeadline } from "./errors.ts";
import type { AddressPolicy } from "./ip-policy.ts";
import type { Limits } from "./limits.ts";
import { resolveTarget, type Resolver } from "./resolve.ts";
import type { ResponseHeaders, Transport, TransportResponse } from "./transport.ts";
import { parseTargetUrl, type TargetUrl } from "./url-policy.ts";

export type FetcherDeps = { resolver: Resolver; transport: Transport; policy: AddressPolicy; limits: Limits };
export type FetchKind = "html" | "media";
export type FetchedResource = { finalUrl: string; contentType: string; charset: string | null; body: Buffer };
export type SafeFetchOptions = { signal: AbortSignal; base?: string | URL; budget?: ByteBudget };

export const USER_AGENT = "AletheiaFetcher/0.1 (+https://github.com/Lc-Soares/Aletheia)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const HTML_TYPES = new Set(["text/html", "application/xhtml+xml"]);
// Sem SVG: é XML e pode conter script.
export const MEDIA_TYPES: ReadonlyMap<string, "image" | "video"> = new Map([
  ["image/jpeg", "image"],
  ["image/jpg", "image"], // apelido comum, não registrado, de image/jpeg
  ["image/png", "image"],
  ["image/gif", "image"],
  ["image/webp", "image"],
  ["image/avif", "image"],
  ["image/heic", "image"],
  ["image/heif", "image"],
  ["image/tiff", "image"],
  ["video/mp4", "video"],
  ["video/webm", "video"],
  ["video/quicktime", "video"],
]);

// Cabeçalhos fixos: nada de Cookie, Authorization, Referer ou qualquer credencial.
const REQUEST_HEADERS: Record<FetchKind, Record<string, string>> = {
  html: {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
  },
  media: {
    "User-Agent": USER_AGENT,
    Accept: "image/avif,image/webp,image/jpeg,image/png,image/*;q=0.8,video/*;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
  },
};

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function mediaTypeOf(headers: ResponseHeaders): string {
  return (single(headers["content-type"]) ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
}

// Só o parâmetro charset, para decodificar o HTML; o resto do cabeçalho é ignorado.
export function charsetOf(headers: ResponseHeaders): string | null {
  for (const param of (single(headers["content-type"]) ?? "").split(";").slice(1)) {
    const [name, value] = param.split("=");
    if (name?.trim().toLowerCase() === "charset" && value) return value.trim().replace(/^"|"$/g, "").toLowerCase() || null;
  }
  return null;
}

function isAllowedType(type: string, kind: FetchKind): boolean {
  return kind === "html" ? HTML_TYPES.has(type) : MEDIA_TYPES.has(type);
}

async function readResponse(
  response: TransportResponse,
  target: TargetUrl,
  kind: FetchKind,
  limits: Limits,
  signal: AbortSignal,
  budget: ByteBudget | undefined,
): Promise<FetchedResource> {
  if (response.status < 200 || response.status > 299) throw new FetchError("upstream_status");
  const contentType = mediaTypeOf(response.headers);
  if (!isAllowedType(contentType, kind)) throw new FetchError("unsupported_type");

  const maxBytes = kind === "html" ? limits.maxHtmlBytes : limits.maxMediaBytes;
  const declared = Number(single(response.headers["content-length"]));
  if (Number.isFinite(declared) && declared > maxBytes) throw new FetchError("too_large");

  const encoding = single(response.headers["content-encoding"]);
  const body = await readLimited(response.body, encoding, maxBytes, signal, budget);
  return { finalUrl: target.url.href, contentType, charset: charsetOf(response.headers), body };
}

// Busca uma URL hostil. Cada salto de redirecionamento refaz toda a validação (URL, DNS, IP).
export async function safeFetch(
  raw: string,
  kind: FetchKind,
  deps: FetcherDeps,
  options: SafeFetchOptions,
): Promise<FetchedResource> {
  const { limits } = deps;
  const totalMs = kind === "html" ? limits.htmlTotalMs : limits.mediaTotalMs;
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(totalMs)]);
  try {
    let target = parseTargetUrl(raw, options.base, limits.maxUrlLength);
    for (let redirects = 0; ; redirects++) {
      const address = await resolveTarget(target, deps.resolver, deps.policy, signal, limits.dnsHopMs);
      const response = await withDeadline(
        deps.transport({
          url: target.url,
          hostname: target.hostname,
          hostHeader: target.hostHeader,
          port: target.port,
          address,
          headers: REQUEST_HEADERS[kind],
          maxHeaderBytes: limits.maxResponseHeaderBytes,
          headersTimeoutMs: limits.hopHeadersMs,
          signal,
        }),
        signal,
      );
      try {
        if (!REDIRECT_STATUSES.has(response.status)) {
          return await readResponse(response, target, kind, limits, signal, options.budget);
        }
        if (redirects >= limits.maxRedirects) throw new FetchError("too_many_redirects");
        const location = single(response.headers.location);
        if (location === undefined || location === "") throw new FetchError("upstream_status");
        target = parseTargetUrl(location, target.url, limits.maxUrlLength);
      } finally {
        response.body.destroy(); // descarta o corpo do redirecionamento ou o que sobrou
      }
    }
  } catch (error) {
    throw toFetchError(error, signal);
  }
}
