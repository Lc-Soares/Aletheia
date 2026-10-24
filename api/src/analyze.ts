// Análise de metadados das mídias baixadas: cada mídia tem o próprio resultado, e a falha de uma não
// derruba as outras. No máximo EXIF_CONCURRENCY chamadas simultâneas à ExifTools; com a chave
// inválida (config_error), as chamadas que faltam são puladas, para não insistir com uma chave
// recusada. Os bytes só passam por aqui a caminho do cliente; nada é guardado.
import type { ExtractCall, ExtractResult } from "./exiftools-client.ts";
import type { DownloadResult } from "./fetcher-contract.ts";
import { METADATA_MESSAGES } from "./messages.ts";
import { extractSignals, type MediaSignals } from "./metadata-allowlist.ts";

export type MetadataView =
  | { status: "ok"; signals: MediaSignals }
  | { status: "unavailable" | "unsupported" | "too_large" | "error" | "not_analyzed"; message: string };

// views por URL da mídia; analyzed = mídias com sinais; tally = contagem por status (só para o log).
export type Analysis = { views: Map<string, MetadataView>; analyzed: number; tally: Record<string, number> };

export type AnalyzeOptions = { extract: ExtractCall; maxMedia: number; signal: AbortSignal; deadlineAt: number };

export const EXIF_CONCURRENCY = 2;

type Downloaded = Extract<DownloadResult, { ok: true }>;

const UNAVAILABLE: MetadataView = { status: "unavailable", message: METADATA_MESSAGES.unavailable };

function toView(result: ExtractResult, sha256: string): MetadataView {
  switch (result.status) {
    case "ok":
      return { status: "ok", signals: extractSignals(result.response, sha256) };
    case "unsupported":
      return { status: "unsupported", message: METADATA_MESSAGES.unsupported };
    case "too_large":
      return { status: "too_large", message: METADATA_MESSAGES.tooLarge };
    case "invalid":
      return { status: "error", message: METADATA_MESSAGES.error };
    case "unavailable":
    case "config_error":
      return UNAVAILABLE;
  }
}

export async function analyzeDownloads(downloads: DownloadResult[], options: AnalyzeOptions): Promise<Analysis> {
  const views = new Map<string, MetadataView>();
  const tally: Record<string, number> = {};
  const count = (key: string): void => {
    tally[key] = (tally[key] ?? 0) + 1;
  };
  const downloaded = downloads.filter((download): download is Downloaded => download.ok);
  const queue = downloaded.slice(0, options.maxMedia);
  for (const download of downloaded.slice(options.maxMedia)) {
    views.set(download.url, { status: "not_analyzed", message: METADATA_MESSAGES.notAnalyzed });
    count("not_analyzed");
  }

  let next = 0;
  let keyRejected = false;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < queue.length; index = next++) {
      const download = queue[index];
      if (download === undefined) continue;
      if (keyRejected) {
        views.set(download.url, UNAVAILABLE);
        count("skipped");
        continue;
      }
      const media = { bytes: download.bytes, contentType: download.contentType };
      const result = await options.extract(media, { signal: options.signal, deadlineAt: options.deadlineAt });
      if (result.status === "config_error") keyRejected = true;
      views.set(download.url, toView(result, download.sha256));
      count(result.status);
    }
  };
  await Promise.all(Array.from({ length: Math.min(EXIF_CONCURRENCY, queue.length) }, worker));
  return { views, analyzed: tally["ok"] ?? 0, tally };
}
