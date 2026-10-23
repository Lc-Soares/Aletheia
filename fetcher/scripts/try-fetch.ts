// Script de DESENVOLVIMENTO: roda o fetchPage contra páginas reais da internet, com exatamente as
// dependências de produção (createProductionDeps: DNS real, política de IP pública, extrator em
// worker, limites padrão). Não relaxa nenhuma proteção, não lê variável de ambiente, não grava
// nada em disco e nunca imprime os bytes das mídias. Fica fora da imagem (.dockerignore).
// Uso: docs/desenvolvimento-local.md.
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";

import { FetchError } from "../src/errors.ts";
import type { Extractor } from "../src/extract-pool.ts";
import { fetchPage, type PageDeps } from "../src/fetch-page.ts";
import type { MediaKind } from "../src/media.ts";
import { createProductionDeps } from "../src/production-deps.ts";

export type MediaLine = { url: string; kind: MediaKind; contentType?: string; size?: number; sha256?: string; error?: string };
export type Timings = { pageMs: number; extractMs: number; mediaMs: number; totalMs: number };
export type RunResult =
  | {
      url: string;
      ok: true;
      finalUrl: string;
      title: string | null;
      headline: string | null;
      listed: number;
      attempted: number;
      downloaded: number;
      media: MediaLine[];
      timings: Timings;
    }
  | { url: string; ok: false; error: string; timings: Timings };
export type Summary = { total: number; ok: number; pageErrors: Record<string, number>; mediaErrors: Record<string, number> };
export type MainIo = { deps?: () => PageDeps; readFile?: (path: string) => Promise<string>; write?: (text: string) => void };

const USAGE = `Uso: npm run try-fetch -w fetcher -- <url>
     npm run try-fetch -w fetcher -- --arquivo <lista.txt>
Faz requisições reais a partir desta máquina, com as proteções de produção. Só páginas públicas.
`;

// Texto de terceiros (título, URLs, content-type) antes de ir para o terminal: tira sequências
// ANSI, troca quebras e tabs por espaço e remove controles C0/C1 e caracteres de formato Unicode
// (inclusive os de direção, como U+202E), que poderiam esconder ou inverter o que é impresso.
export function sanitize(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
}

export function parseUrlList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

const categoryOf = (error: unknown): string => (error instanceof FetchError ? error.category : "erro_inesperado");

// Mede as fases envolvendo o extrator: página = até a extração começar; mídias = depois dela.
export async function runOne(url: string, deps: PageDeps, now: () => number = () => performance.now()): Promise<RunResult> {
  const started = now();
  let extractStart: number | null = null;
  let extractEnd: number | null = null;
  const timedExtract: Extractor = Object.defineProperty(
    async (htmlText: string, pageUrl: string, signal: AbortSignal) => {
      extractStart = now();
      try {
        return await deps.extract(htmlText, pageUrl, signal);
      } finally {
        extractEnd = now();
      }
    },
    "active",
    { get: () => deps.extract.active },
  ) as Extractor;
  try {
    const page = await fetchPage(url, { ...deps, extract: timedExtract });
    const ended = now();
    const extractedAt = extractStart ?? ended;
    const extractedEnd = extractEnd ?? ended;
    // Só dados simples: os bytes de cada mídia são descartados aqui.
    const media: MediaLine[] = page.downloads.map((d) =>
      d.ok
        ? { url: d.url, kind: d.kind, contentType: d.contentType, size: d.size, sha256: d.sha256.slice(0, 12) }
        : { url: d.url, kind: d.kind, error: d.error },
    );
    return {
      url,
      ok: true,
      finalUrl: page.finalUrl,
      title: page.title,
      headline: page.headline,
      listed: page.media.length,
      attempted: page.downloads.length,
      downloaded: page.downloads.filter((d) => d.ok).length,
      media,
      timings: {
        pageMs: extractedAt - started,
        extractMs: extractedEnd - extractedAt,
        mediaMs: ended - extractedEnd,
        totalMs: ended - started,
      },
    };
  } catch (error) {
    const totalMs = now() - started;
    return { url, ok: false, error: categoryOf(error), timings: { pageMs: totalMs, extractMs: 0, mediaMs: 0, totalMs } };
  }
}

const ms = (value: number): string => `${Math.round(value)} ms`;
const text = (value: string | null): string => (value === null ? "(nenhum)" : sanitize(value));

export function formatResult(result: RunResult): string {
  const lines = [`URL: ${sanitize(result.url)}`];
  if (!result.ok) {
    lines.push(`  erro: ${result.error}`, `  tempo total: ${ms(result.timings.totalMs)}`);
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    `  URL final: ${sanitize(result.finalUrl)}`,
    `  título: ${text(result.title)}`,
    `  manchete: ${text(result.headline)}`,
    `  mídias: ${result.listed} listadas, ${result.attempted} tentadas, ${result.downloaded} baixadas`,
  );
  for (const m of result.media) {
    const detail = m.error ?? `${sanitize(m.contentType ?? "")}  ${m.size ?? 0} bytes  sha256 ${m.sha256 ?? ""}`;
    lines.push(`    - ${m.kind}  ${detail}  ${sanitize(m.url)}`);
  }
  const { pageMs, extractMs, mediaMs, totalMs } = result.timings;
  lines.push(`  tempos: página ${ms(pageMs)} · extração ${ms(extractMs)} · mídias ${ms(mediaMs)} · total ${ms(totalMs)}`);
  return `${lines.join("\n")}\n`;
}

const increment = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

export function summarize(results: RunResult[]): Summary {
  const summary: Summary = { total: results.length, ok: 0, pageErrors: {}, mediaErrors: {} };
  for (const result of results) {
    if (!result.ok) {
      increment(summary.pageErrors, result.error);
      continue;
    }
    summary.ok++;
    for (const m of result.media) if (m.error !== undefined) increment(summary.mediaErrors, m.error);
  }
  return summary;
}

const counts = (record: Record<string, number>): string =>
  Object.entries(record).length === 0
    ? "nenhum"
    : Object.entries(record)
        .map(([category, n]) => `${category}: ${n}`)
        .join(", ");

export function formatSummary(summary: Summary): string {
  return [
    `Resumo: ${summary.ok} de ${summary.total} páginas deram certo`,
    `  erros de página: ${counts(summary.pageErrors)}`,
    `  erros de mídia: ${counts(summary.mediaErrors)}`,
  ].join("\n").concat("\n");
}

// Devolve o código de saída: 0 quando rodou (falhas de página aparecem no resultado), 2 para uso errado.
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const write = io.write ?? ((output: string) => void process.stdout.write(output));
  const read = io.readFile ?? ((path: string) => readFile(path, "utf8"));
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    write(USAGE);
    return 0;
  }
  let urls: string[];
  if (argv.length === 2 && argv[0] === "--arquivo" && argv[1] !== undefined) {
    try {
      urls = parseUrlList(await read(argv[1]));
    } catch {
      write("Não foi possível ler o arquivo de URLs.\n");
      return 2;
    }
  } else if (argv.length === 1 && argv[0] !== undefined && !argv[0].startsWith("-")) {
    urls = [argv[0]];
  } else {
    write(USAGE);
    return 2;
  }
  const deps = io.deps ? io.deps() : createProductionDeps(); // io.deps só em teste
  const results: RunResult[] = [];
  for (const url of urls) {
    const result = await runOne(url, deps); // uma por vez: sem rajada contra os sites
    results.push(result);
    write(formatResult(result));
  }
  if (urls.length > 1 || argv[0] === "--arquivo") write(formatSummary(summarize(results)));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
