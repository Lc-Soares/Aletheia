import { createHash } from "node:crypto";

import type { ByteBudget } from "./body.ts";
import { FetchError, type FetchErrorCategory, toFetchError } from "./errors.ts";
import type { Extractor } from "./extract-pool.ts";
import type { MediaRef } from "./extract.ts";
import { type FetcherDeps, safeFetch } from "./safe-fetch.ts";

export type MediaDownload =
  | (MediaRef & { ok: true; contentType: string; size: number; sha256: string; bytes: Buffer })
  | (MediaRef & { ok: false; error: FetchErrorCategory });

// O extrator é injetado: em produção, o pool de workers criado uma vez em main.ts.
export type PageDeps = FetcherDeps & { extract: Extractor };

export type PageResult = {
  finalUrl: string;
  title: string | null;
  headline: string | null;
  media: MediaRef[];
  downloads: MediaDownload[];
};

function decodeHtml(body: Buffer, charset: string | null): string {
  try {
    return new TextDecoder(charset ?? "utf-8").decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body); // charset desconhecido
  }
}

async function downloadOne(ref: MediaRef, deps: FetcherDeps, signal: AbortSignal, budget: ByteBudget): Promise<MediaDownload> {
  try {
    if (budget.remaining <= 0) throw new FetchError("too_large");
    const { contentType, body } = await safeFetch(ref.url, "media", deps, { signal, budget });
    const sha256 = createHash("sha256").update(body).digest("hex");
    return { ...ref, ok: true, contentType, size: body.length, sha256, bytes: body };
  } catch (error) {
    return { ...ref, ok: false, error: toFetchError(error, signal).category };
  }
}

// Fila com concorrência fixa e orçamento agregado de bytes compartilhado.
async function downloadAll(refs: MediaRef[], deps: FetcherDeps, signal: AbortSignal): Promise<MediaDownload[]> {
  const results: MediaDownload[] = [];
  const budget: ByteBudget = { remaining: deps.limits.maxAggregateMediaBytes };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < refs.length; index = next++) {
      const ref = refs[index];
      if (ref) results[index] = await downloadOne(ref, deps, signal, budget);
    }
  };
  const workers = Math.min(deps.limits.mediaConcurrency, refs.length);
  await Promise.all(Array.from({ length: workers }, worker));
  return results;
}

// Baixa a página e até N mídias, tudo em memória. Falha da página lança FetchError;
// falha de uma mídia vira um item com a categoria do erro.
export async function fetchPage(rawUrl: string, deps: PageDeps, signal?: AbortSignal): Promise<PageResult> {
  const controller = new AbortController();
  const pageSignal = AbortSignal.any([
    controller.signal,
    AbortSignal.timeout(deps.limits.pageTotalMs),
    ...(signal ? [signal] : []),
  ]);
  try {
    const page = await safeFetch(rawUrl, "html", deps, { signal: pageSignal });
    const extracted = await deps.extract(decodeHtml(page.body, page.charset), page.finalUrl, pageSignal);
    const downloads = await downloadAll(extracted.media.slice(0, deps.limits.maxMediaDownloads), deps, pageSignal);
    return { finalUrl: page.finalUrl, title: extracted.title, headline: extracted.headline, media: extracted.media, downloads };
  } catch (error) {
    throw toFetchError(error, pageSignal);
  } finally {
    controller.abort(); // cancela qualquer download que ainda esteja pendente
  }
}
