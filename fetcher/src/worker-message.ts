import { FetchError } from "./errors.ts";
import type { Limits } from "./limits.ts";
import { type ExtractedPage, MAX_TEXT_LENGTH, MEDIA_KINDS, MEDIA_SOURCES, type MediaRef } from "./media.ts";

// O worker roda o parser sobre HTML hostil, então a mensagem dele é tratada como não confiável:
// só passa o formato exato de ExtractedPage, dentro dos limites; qualquer desvio vira network.
const KINDS: ReadonlySet<unknown> = new Set(MEDIA_KINDS);
const SOURCES: ReadonlySet<unknown> = new Set(MEDIA_SOURCES);
const PAGE_KEYS = ["headline", "media", "title"];
const REF_KEYS = ["kind", "source", "url"];

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: PlainObject, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}

const isText = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= MAX_TEXT_LENGTH);

function isHttpUrl(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function toMediaRef(value: unknown, maxUrlLength: number): MediaRef {
  if (!isPlainObject(value) || !hasExactKeys(value, REF_KEYS)) throw new FetchError("network");
  const { url, kind, source } = value;
  if (!isHttpUrl(url, maxUrlLength) || !KINDS.has(kind) || !SOURCES.has(source)) throw new FetchError("network");
  return { url, kind: kind as MediaRef["kind"], source: source as MediaRef["source"] };
}

export function validateWorkerPage(message: unknown, limits: Pick<Limits, "maxMediaRefs" | "maxUrlLength">): ExtractedPage {
  if (!isPlainObject(message) || !hasExactKeys(message, PAGE_KEYS)) throw new FetchError("network");
  const { title, headline, media } = message;
  if (!isText(title) || !isText(headline)) throw new FetchError("network");
  if (!Array.isArray(media) || media.length > limits.maxMediaRefs) throw new FetchError("network");
  // Laço por índice (e não map/every): buracos de array esparso viram undefined e são recusados.
  const refs: MediaRef[] = [];
  for (let i = 0; i < media.length; i++) refs.push(toMediaRef(media[i], limits.maxUrlLength));
  return { title, headline, media: refs };
}
