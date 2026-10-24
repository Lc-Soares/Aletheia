// Contrato do NDJSON de POST /fetch (docs/fetcher.md). A resposta do fetcher é tratada como não
// confiável: só passa o formato exato, dentro dos limites; qualquer desvio lança MalformedResponse.
// Os valores aceitos são cópia de fetcher/src/media.ts e errors.ts (a API não importa o fetcher).
import { createHash } from "node:crypto";

export const FETCHER_CATEGORIES = [
  "invalid_url",
  "blocked",
  "timeout",
  "too_large",
  "unsupported_type",
  "too_many_redirects",
  "upstream_status",
  "network",
] as const;
export const MEDIA_KINDS = ["image", "video"] as const;
export const MEDIA_SOURCES = [
  "og:image",
  "og:video",
  "img",
  "img-srcset",
  "source",
  "source-srcset",
  "video",
  "video-poster",
  "twitter:image",
] as const;
export const SKIP_REASONS = ["variant", "icon", "unsupported_format", "low_score", "limit", "other"] as const;
// Os content-types que o fetcher aceita para mídia (MEDIA_TYPES de fetcher/src/safe-fetch.ts).
export const MEDIA_CONTENT_TYPES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
  "image/tiff",
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

export type FetcherCategory = (typeof FETCHER_CATEGORIES)[number];
export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaSource = (typeof MEDIA_SOURCES)[number];
export type SkipReason = (typeof SKIP_REASONS)[number];

export type MediaRef = {
  url: string;
  kind: MediaKind;
  source: MediaSource;
  group: number;
  score: number;
  selected: boolean;
  skipReason: SkipReason | null;
};
type MediaIdentity = Pick<MediaRef, "url" | "kind" | "source" | "group">;
export type DownloadResult = MediaIdentity &
  (
    | { ok: true; contentType: string; size: number; sha256: string; bytes: Buffer }
    | { ok: false; error: FetcherCategory; httpStatus?: number }
  );
export type FetchedPage = {
  finalUrl: string;
  title: string | null;
  headline: string | null;
  possiblyNeedsJavaScript: boolean;
  media: MediaRef[];
  downloads: DownloadResult[];
};

export type ContractLimits = { maxMediaRefs: number; maxUrlLength: number; maxDownloads: number; maxMediaBytes: number };
export const CONTRACT_LIMITS: Readonly<ContractLimits> = Object.freeze({
  maxMediaRefs: 200,
  maxUrlLength: 2048,
  maxDownloads: 8,
  maxMediaBytes: 15 * 1024 * 1024,
});

export class MalformedResponse extends Error {
  constructor() {
    super("Resposta do fetcher fora do contrato");
    this.name = "MalformedResponse";
  }
}

const CATEGORIES: ReadonlySet<unknown> = new Set(FETCHER_CATEGORIES);
const KINDS: ReadonlySet<unknown> = new Set(MEDIA_KINDS);
const SOURCES: ReadonlySet<unknown> = new Set(MEDIA_SOURCES);
const REASONS: ReadonlySet<unknown> = new Set(SKIP_REASONS);
const PAGE_KEYS = ["finalUrl", "headline", "media", "possiblyNeedsJavaScript", "title", "type"];
const REF_KEYS = ["group", "kind", "score", "selected", "skipReason", "source", "url"];
const MEDIA_KEYS = ["contentType", "data", "group", "kind", "sha256", "size", "source", "type", "url"];
const MEDIA_ERROR_KEYS = ["error", "group", "kind", "source", "type", "url"];
const MAX_TEXT_LENGTH = 300;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: PlainObject, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}

function ensure(condition: boolean): asserts condition {
  if (!condition) throw new MalformedResponse();
}

const isText = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= MAX_TEXT_LENGTH && value.isWellFormed());

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

export const isHttpStatus = (value: unknown): value is number => isIntegerIn(value, 100, 599);

export const isFetcherCategory = (value: unknown): value is FetcherCategory => CATEGORIES.has(value);

function isHttpUrl(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function toMediaRef(value: unknown, limits: ContractLimits, count: number): MediaRef {
  ensure(isPlainObject(value) && hasExactKeys(value, REF_KEYS));
  const { url, kind, source, group, score, selected, skipReason } = value;
  ensure(isHttpUrl(url, limits.maxUrlLength) && KINDS.has(kind) && SOURCES.has(source));
  ensure(isIntegerIn(group, 1, count) && isIntegerIn(score, -1000, 1000));
  // skipReason é null exatamente quando selected é true.
  ensure((selected === true && skipReason === null) || (selected === false && REASONS.has(skipReason)));
  return {
    url,
    kind: kind as MediaKind,
    source: source as MediaSource,
    group,
    score,
    selected,
    skipReason: skipReason as SkipReason | null,
  };
}

function parsePage(value: PlainObject, limits: ContractLimits): Omit<FetchedPage, "downloads"> {
  ensure(hasExactKeys(value, PAGE_KEYS));
  const { finalUrl, title, headline, possiblyNeedsJavaScript, media } = value;
  ensure(isHttpUrl(finalUrl, limits.maxUrlLength) && isText(title) && isText(headline));
  ensure(typeof possiblyNeedsJavaScript === "boolean");
  ensure(Array.isArray(media) && media.length <= limits.maxMediaRefs);
  // Laço por índice: buracos de array esparso viram undefined e são recusados.
  const refs: MediaRef[] = [];
  for (let i = 0; i < media.length; i++) refs.push(toMediaRef(media[i], limits, media.length));
  ensure(refs.filter((ref) => ref.selected).length <= limits.maxDownloads);
  return { finalUrl, title, headline, possiblyNeedsJavaScript, media: refs };
}

// Bytes decodificados linha a linha; o tamanho e o SHA-256 declarados precisam conferir.
function parseMedia(value: PlainObject, limits: ContractLimits, identity: MediaIdentity): DownloadResult {
  ensure(hasExactKeys(value, MEDIA_KEYS));
  const { contentType, size, sha256, data } = value;
  ensure(typeof contentType === "string" && MEDIA_CONTENT_TYPES.has(contentType));
  ensure(isIntegerIn(size, 0, limits.maxMediaBytes) && typeof sha256 === "string" && SHA256_HEX.test(sha256));
  ensure(typeof data === "string" && data.length % 4 === 0 && BASE64.test(data));
  const bytes = Buffer.from(data, "base64");
  ensure(bytes.length === size && createHash("sha256").update(bytes).digest("hex") === sha256);
  return { ...identity, ok: true, contentType, size, sha256, bytes };
}

function parseMediaError(value: PlainObject, identity: MediaIdentity): DownloadResult {
  const { error, httpStatus } = value;
  if (error === "upstream_status" && "httpStatus" in value) {
    ensure(hasExactKeys(value, [...MEDIA_ERROR_KEYS, "httpStatus"].sort()) && isHttpStatus(httpStatus));
    return { ...identity, ok: false, error, httpStatus };
  }
  ensure(hasExactKeys(value, MEDIA_ERROR_KEYS) && isFetcherCategory(error));
  return { ...identity, ok: false, error };
}

// Linhas na ordem: uma "page", um resultado por mídia selecionada (sem repetir) e "done".
export class FetcherStreamParser {
  readonly #limits: ContractLimits;
  #state: "start" | "media" | "done" = "start";
  #page: Omit<FetchedPage, "downloads"> | null = null;
  readonly #pending = new Map<string, MediaRef>();
  readonly #downloads: DownloadResult[] = [];

  constructor(limits: ContractLimits = CONTRACT_LIMITS) {
    this.#limits = limits;
  }

  accept(value: unknown): void {
    ensure(isPlainObject(value) && this.#state !== "done");
    if (this.#state === "start") {
      ensure(value["type"] === "page");
      this.#page = parsePage(value, this.#limits);
      for (const ref of this.#page.media) if (ref.selected) this.#pending.set(ref.url, ref);
      this.#state = "media";
      return;
    }
    if (value["type"] === "done") {
      ensure(Object.keys(value).length === 1 && this.#pending.size === 0);
      this.#state = "done";
      return;
    }
    this.#downloads.push(this.#parseDownload(value));
  }

  finish(): FetchedPage {
    ensure(this.#state === "done" && this.#page !== null);
    return { ...this.#page, downloads: this.#downloads };
  }

  #parseDownload(value: PlainObject): DownloadResult {
    const ref = typeof value["url"] === "string" ? this.#pending.get(value["url"]) : undefined;
    ensure(ref !== undefined);
    ensure(value["kind"] === ref.kind && value["source"] === ref.source && value["group"] === ref.group);
    this.#pending.delete(ref.url);
    const identity = { url: ref.url, kind: ref.kind, source: ref.source, group: ref.group };
    if (value["type"] === "media") return parseMedia(value, this.#limits, identity);
    ensure(value["type"] === "media_error");
    return parseMediaError(value, identity);
  }
}
