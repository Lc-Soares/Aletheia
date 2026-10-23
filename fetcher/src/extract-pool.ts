import { Worker } from "node:worker_threads";

import { FetchError, withDeadline } from "./errors.ts";
import type { ExtractedPage } from "./extract.ts";
import type { Limits } from "./limits.ts";

// O parse5 monta a árvore inteira e tem casos patológicos de memória e de CPU síncrona com HTML
// hostil (revisão da Fase 3, achados 1 e 2). Cada extração roda num worker novo, com heap limitado
// e prazo rígido; o event loop principal nunca executa o parser. Ver docs/fetcher.md.
export type Extractor = ((htmlText: string, pageUrl: string, signal: AbortSignal) => Promise<ExtractedPage>) & {
  readonly active: number;
};

const WORKER_URL = new URL("./extract-worker.ts", import.meta.url);
const YOUNG_GENERATION_MB = 32;

type Semaphore = { acquire: (signal: AbortSignal) => Promise<void>; release: () => void };

// No máximo `size` vagas; quem espera na fila desiste quando o sinal abortar.
function createSemaphore(size: number): Semaphore {
  let free = size;
  const queue: (() => void)[] = [];
  const release = (): void => {
    const next = queue.shift();
    if (next) next();
    else free++;
  };
  const acquire = (signal: AbortSignal): Promise<void> => {
    if (signal.aborted) return Promise.reject(new FetchError("timeout"));
    if (free > 0) {
      free--;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        queue.splice(queue.indexOf(grant), 1);
        reject(new FetchError("timeout"));
      };
      queue.push(grant);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };
  return { acquire, release };
}

// Estouro do heap do worker vira too_large; qualquer outra falha vira network (sem detalhe).
function workerError(error: unknown): FetchError {
  const code = (error as { code?: unknown } | null)?.code;
  return new FetchError(code === "ERR_WORKER_OUT_OF_MEMORY" ? "too_large" : "network");
}

function workerResult(worker: Worker): Promise<ExtractedPage> {
  return new Promise((resolve, reject) => {
    worker.once("message", (page: ExtractedPage) => resolve(page));
    worker.once("error", (error) => reject(workerError(error)));
    worker.once("exit", () => reject(new FetchError("network"))); // saiu sem responder
  });
}

function startWorker(htmlText: string, pageUrl: string, limits: Limits): Worker {
  const { maxMediaRefs, maxUrlLength, maxHtmlNodes } = limits;
  return new Worker(WORKER_URL, {
    workerData: { htmlText, pageUrl, limits: { maxMediaRefs, maxUrlLength, maxHtmlNodes } },
    execArgv: [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: limits.extractHeapMb, maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
  });
}

export function createWorkerExtractor(limits: Limits): Extractor {
  const slots = createSemaphore(limits.extractConcurrency);
  let active = 0;
  const runWorker = async (htmlText: string, pageUrl: string, signal: AbortSignal): Promise<ExtractedPage> => {
    // O prazo conta a partir da vaga: inclui subir o worker, mas não a espera na fila.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.extractTotalMs)]);
    const worker = startWorker(htmlText, pageUrl, limits);
    active++;
    try {
      return await withDeadline(workerResult(worker), deadline);
    } finally {
      await worker.terminate(); // sempre: sucesso, erro, prazo ou requisição cancelada
      active--;
    }
  };
  const extract = async (htmlText: string, pageUrl: string, signal: AbortSignal): Promise<ExtractedPage> => {
    await slots.acquire(signal);
    try {
      return await runWorker(htmlText, pageUrl, signal);
    } finally {
      slots.release();
    }
  };
  return Object.defineProperty(extract, "active", { get: () => active }) as Extractor;
}
