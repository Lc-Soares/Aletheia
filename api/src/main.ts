import { createGoogleVerifier } from "./auth.ts";
import { DEFAULT_MAX_IN_FLIGHT_CHECKS } from "./check.ts";
import { type Config, loadConfig } from "./config.ts";
import { createExifToolsClient } from "./exiftools-client.ts";
import { createFetcherClient } from "./fetcher-client.ts";
import { RateLimiter } from "./rate-limit.ts";
import { createApiServer, shutdown } from "./server.ts";
import { createServiceTokenSource } from "./service-token.ts";

const SHUTDOWN_GRACE_MS = 10_000;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuração inválida");
    return process.exit(1);
  }
}

const config = loadConfigOrExit();
const server = createApiServer({
  verifier: createGoogleVerifier(config.googleClientId),
  log: (entry) => console.log(JSON.stringify(entry)),
  check: {
    // O token de serviço vem sempre do Google (metadados no Cloud Run, gcloud com impersonação
    // em desenvolvimento); não há modo que pule a autenticação do fetcher.
    callFetcher: createFetcherClient({ fetcherUrl: config.fetcherUrl, token: createServiceTokenSource(config.fetcherAudience) }),
    // Endereço e limites de produção da ExifTools; a chave vai só no cabeçalho X-API-Key.
    extract: createExifToolsClient({ apiKey: config.exifToolsApiKey }),
    limiter: new RateLimiter({ windowMs: RATE_LIMIT_WINDOW_MS }),
    maxInFlightChecks: DEFAULT_MAX_IN_FLIGHT_CHECKS,
  },
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "listening", port: config.port }));
});

process.on("SIGTERM", () => {
  void shutdown(server, SHUTDOWN_GRACE_MS).then(() => process.exit(0));
});
