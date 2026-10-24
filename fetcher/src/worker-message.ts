import { FetchError } from "./errors.ts";
import type { Limits } from "./limits.ts";
import {
  type ExtractedPage,
  MAX_SCORE,
  MAX_TEXT_LENGTH,
  MEDIA_KINDS,
  MEDIA_SOURCES,
  type MediaRef,
  MIN_SCORE,
  SKIP_REASONS,
} from "./media.ts";

// O worker roda o parser sobre HTML hostil, então a mensagem dele é tratada como não confiável:
// só passa o formato exato de ExtractedPage, dentro dos limites; qualquer desvio vira network.
const KINDS: ReadonlySet<unknown> = new Set(MEDIA_KINDS);
const SOURCES: ReadonlySet<unknown> = new Set(MEDIA_SOURCES);
const REASONS: ReadonlySet<unknown> = new Set(SKIP_REASONS);
const PAGE_KEYS = ["headline", "media", "possiblyNeedsJavaScript", "title"];
const REF_KEYS = ["group", "kind", "score", "selected", "skipReason", "source", "url"];

type PlainObject = Record<string, unknown>;
type ValidationLimits = Pick<Limits, "maxMediaRefs" | "maxUrlLength" | "maxSelectedMedia">;

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;
}

function hasExactKeys(value: PlainObject, keys: readonly string[]): boolean {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
}

const isText = (value: unknown): value is string | null =>
  value === null || (typeof value === "string" && value.length <= MAX_TEXT_LENGTH && value.isWellFormed());

const isIntegerIn = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

function isHttpUrl(value: unknown, maxLength: number): value is string {
  if (typeof value !== "string" || value.length > maxLength) return false;
  try {
    // Forma normalizada: o worker legítimo sempre envia url.href, então qualquer diferença
    // (espaços, controles, maiúsculas, porta padrão explícita) é recusada, não corrigida.
    const { protocol, href } = new URL(value);
    return href === value && (protocol === "http:" || protocol === "https:");
  } catch {
    return false;
  }
}

// skipReason é null exatamente quando selected é true.
const isSelection = (selected: unknown, skipReason: unknown): boolean =>
  (selected === true && skipReason === null) || (selected === false && skipReason !== null && REASONS.has(skipReason));

function toMediaRef(value: unknown, limits: ValidationLimits, count: number): MediaRef {
  if (!isPlainObject(value) || !hasExactKeys(value, REF_KEYS)) throw new FetchError("network");
  const { url, kind, source, group, score, selected, skipReason } = value;
  if (!isHttpUrl(url, limits.maxUrlLength) || !KINDS.has(kind) || !SOURCES.has(source)) throw new FetchError("network");
  if (!isIntegerIn(group, 1, count) || !isIntegerIn(score, MIN_SCORE, MAX_SCORE)) throw new FetchError("network");
  if (!isSelection(selected, skipReason)) throw new FetchError("network");
  return {
    url,
    kind: kind as MediaRef["kind"],
    source: source as MediaRef["source"],
    group,
    score,
    selected: selected as boolean,
    skipReason: skipReason as MediaRef["skipReason"],
  };
}

// Cada grupo: exatamente um item que não é variante, mesmo tipo e mesma pontuação em todos.
// No total, no máximo maxSelectedMedia selecionados.
function checkGroups(refs: MediaRef[], maxSelected: number): void {
  const leads = new Map<number, MediaRef>();
  for (const ref of refs) {
    if (ref.skipReason === "variant") continue;
    if (leads.has(ref.group)) throw new FetchError("network");
    leads.set(ref.group, ref);
  }
  for (const ref of refs) {
    const lead = leads.get(ref.group);
    if (lead === undefined || lead.kind !== ref.kind || lead.score !== ref.score) throw new FetchError("network");
  }
  if (refs.filter((ref) => ref.selected).length > maxSelected) throw new FetchError("network");
}

export function validateWorkerPage(message: unknown, limits: ValidationLimits): ExtractedPage {
  if (!isPlainObject(message) || !hasExactKeys(message, PAGE_KEYS)) throw new FetchError("network");
  const { title, headline, media, possiblyNeedsJavaScript } = message;
  if (!isText(title) || !isText(headline)) throw new FetchError("network");
  if (!Array.isArray(media) || media.length > limits.maxMediaRefs) throw new FetchError("network");
  if (typeof possiblyNeedsJavaScript !== "boolean" || (possiblyNeedsJavaScript && media.length > 0)) throw new FetchError("network");
  // Laço por índice (e não map/every): buracos de array esparso viram undefined e são recusados.
  const refs: MediaRef[] = [];
  for (let i = 0; i < media.length; i++) refs.push(toMediaRef(media[i], limits, media.length));
  checkGroups(refs, limits.maxSelectedMedia);
  return { title, headline, media: refs, possiblyNeedsJavaScript };
}
