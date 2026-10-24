import { createHash } from "node:crypto";

import type { ByteBudget } from "./body.ts";
import { FetchError, type FetchErrorCategory, OverloadedError, toFetchError } from "./errors.ts";
import type { Extractor } from "./extract-pool.ts";
import type { MediaRef } from "./media.ts";
import { type FetcherDeps, safeFetch } from "./safe-fetch.ts";

export type MediaDownload =
  | (MediaRef & { ok: true; contentType: string; size: number; sha256: string; bytes: Buffer })
  | (MediaRef & { ok: false; error: FetchErrorCategory; httpStatus?: number });

// O extrator é injetado: em produção, o pool de workers criado uma vez em main.ts.
export type PageDeps = FetcherDeps & { extract: Extractor };

export type PageResult = {
  finalUrl: string;
  title: string | null;
  headline: string | null;
  media: MediaRef[];
  possiblyNeedsJavaScript: boolean;
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
    const { category, httpStatus } = toFetchError(error, signal);
    return httpStatus === undefined ? { ...ref, ok: false, error: category } : { ...ref, ok: false, error: category, httpStatus };
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

// Só os selecionados pelo worker, em ordem de grupo (1 = melhor). O validador já garantiu no
// máximo maxSelectedMedia; o slice é defesa em profundidade.
function selectedRefs(media: MediaRef[], maxSelected: number): MediaRef[] {
  return media
    .filter((ref) => ref.selected)
    .sort((a, b) => a.group - b.group)
    .slice(0, maxSelected);
}

// Baixa a página e as mídias selecionadas, tudo em memória. Falha da página lança FetchError;
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
    const downloads = await downloadAll(selectedRefs(extracted.media, deps.limits.maxSelectedMedia), deps, pageSignal);
    const { title, headline, media, possiblyNeedsJavaScript } = extracted;
    return { finalUrl: page.finalUrl, title, headline, media, possiblyNeedsJavaScript, downloads };
  } catch (error) {
    if (error instanceof OverloadedError) throw error; // vira 503 no serviço
    throw toFetchError(error, pageSignal);
  } finally {
    controller.abort(); // cancela qualquer download que ainda esteja pendente
  }
}
