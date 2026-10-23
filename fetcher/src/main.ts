import { createCallerVerifier } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import { fetchPage } from "./fetch-page.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { systemResolver } from "./resolve.ts";
import type { FetcherDeps } from "./safe-fetch.ts";
import { createFetcherServer, shutdown } from "./server.ts";
import { createNodeTransport } from "./transport.ts";

const SHUTDOWN_GRACE_MS = 10_000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuração inválida");
    return process.exit(1);
  }
}

const config = loadConfigOrExit();

// Produção usa sempre a política pública e os limites padrão; não há chave para mudá-los.
const deps: FetcherDeps = {
  resolver: systemResolver,
  transport: createNodeTransport(),
  policy: isPublicAddress,
  limits: { ...DEFAULT_LIMITS },
};

const server = createFetcherServer({
  verifier: createCallerVerifier(config.audience, config.callerEmail),
  fetchPage: (url, signal) => fetchPage(url, deps, signal),
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "listening", port: config.port }));
});

process.on("SIGTERM", () => {
  void shutdown(server, SHUTDOWN_GRACE_MS).then(() => process.exit(0));
});
