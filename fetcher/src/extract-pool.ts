import { Worker } from "node:worker_threads";

import { FetchError, OverloadedError, withDeadline } from "./errors.ts";
import type { Limits } from "./limits.ts";
import type { ExtractedPage } from "./media.ts";
import { validateWorkerPage } from "./worker-message.ts";

// O parse5 monta a árvore inteira e tem casos patológicos de memória e de CPU síncrona com HTML
// hostil (revisão da Fase 3, achados 1 e 2). Cada extração roda num worker novo, com heap limitado
// e prazo rígido; o event loop principal nunca executa o parser. Ver docs/fetcher.md.
export type Extractor = ((htmlText: string, pageUrl: string, signal: AbortSignal) => Promise<ExtractedPage>) & {
  readonly active: number;
};

const WORKER_URL = new URL("./extract-worker.ts", import.meta.url);
const YOUNG_GENERATION_MB = 32;
const QUEUE_PER_SLOT = 2;

export type Semaphore = { acquire: (signal: AbortSignal) => Promise<void>; release: () => void };

// No máximo `size` vagas e `maxQueue` à espera (a excedente recebe OverloadedError na hora);
// quem espera na fila desiste quando o sinal abortar.
export function createSemaphore(size: number, maxQueue: number): Semaphore {
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
    if (queue.length >= maxQueue) return Promise.reject(new OverloadedError());
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = (): void => {
        // Se a vaga já foi dada, grant não está mais na fila: indexOf -1 e splice(-1) tiraria outro.
        const index = queue.indexOf(grant);
        if (index >= 0) queue.splice(index, 1);
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

function workerResult(worker: Worker): Promise<unknown> {
  return new Promise((resolve, reject) => {
    worker.once("message", (message: unknown) => resolve(message));
    worker.once("error", (error) => reject(workerError(error)));
    worker.once("exit", () => reject(new FetchError("network"))); // saiu sem responder
  });
}

function startWorker(workerUrl: URL, htmlText: string, pageUrl: string, limits: Limits): Worker {
  const { maxMediaRefs, maxUrlLength, maxHtmlNodes, maxSelectedMedia } = limits;
  return new Worker(workerUrl, {
    workerData: { htmlText, pageUrl, limits: { maxMediaRefs, maxUrlLength, maxHtmlNodes, maxSelectedMedia } },
    execArgv: [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: limits.extractHeapMb, maxYoungGenerationSizeMb: YOUNG_GENERATION_MB },
  });
}

// workerUrl só muda em teste (worker falso em URL data:); produção usa sempre extract-worker.ts.
export function createWorkerExtractor(limits: Limits, workerUrl: URL = WORKER_URL): Extractor {
  const slots = createSemaphore(limits.extractConcurrency, QUEUE_PER_SLOT * limits.extractConcurrency);
  let active = 0;
  const runWorker = async (htmlText: string, pageUrl: string, signal: AbortSignal): Promise<ExtractedPage> => {
    // O prazo conta a partir da vaga: inclui subir o worker, mas não a espera na fila.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(limits.extractTotalMs)]);
    const worker = startWorker(workerUrl, htmlText, pageUrl, limits);
    active++;
    try {
      return validateWorkerPage(await withDeadline(workerResult(worker), deadline), limits);
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
