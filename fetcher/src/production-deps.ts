import { createWorkerExtractor } from "./extract-pool.ts";
import type { PageDeps } from "./fetch-page.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { systemResolver } from "./resolve.ts";
import { createNodeTransport } from "./transport.ts";

// As dependências de produção, num lugar só: main.ts e o script de desenvolvimento
// (scripts/try-fetch.ts) usam esta função. Sem parâmetros: não há como trocar a política, o DNS,
// o transporte ou os limites por aqui.
export function createProductionDeps(): PageDeps {
  const limits = { ...DEFAULT_LIMITS };
  return {
    resolver: systemResolver,
    transport: createNodeTransport(),
    policy: isPublicAddress,
    limits,
    extract: createWorkerExtractor(limits),
  };
}
