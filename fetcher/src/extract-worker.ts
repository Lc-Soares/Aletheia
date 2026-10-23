// Ponto de entrada do worker de extração (iniciado por extract-pool.ts). Recebe só o HTML, a URL
// base e os limites numéricos, e devolve dados simples. Não importa nada de rede nem de disco
// (extract-pool.test.ts confere o grafo de imports).
import { parentPort, workerData } from "node:worker_threads";

import { type ExtractLimits, extractPage } from "./extract.ts";

type WorkerInput = { htmlText: string; pageUrl: string; limits: ExtractLimits };

const { htmlText, pageUrl, limits } = workerData as WorkerInput;
parentPort?.postMessage(extractPage(htmlText, pageUrl, limits));
