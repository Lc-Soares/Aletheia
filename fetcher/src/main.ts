import { createCallerVerifier } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import type { Extractor } from "./extract-pool.ts";
import { fetchPage } from "./fetch-page.ts";
import { createProductionDeps } from "./production-deps.ts";
import { createFetcherServer, shutdown } from "./server.ts";

const SHUTDOWN_GRACE_MS = 10_000;

function loadConfigOrExit(): Config {
  try {
    return loadConfig(process.env);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Configuração inválida");
    return process.exit(1);
  }
}

// Uma extração mínima antes de aceitar tráfego: se o worker não subir (por exemplo, arquivo fora
// da imagem), o processo sai na inicialização em vez de falhar em toda requisição.
async function checkExtractorOrExit(extract: Extractor): Promise<void> {
  try {
    const page = await extract("<title>ok</title>", "https://aletheia.invalid/", AbortSignal.timeout(10_000));
    if (page.title !== "ok") throw new Error("resultado inesperado");
  } catch {
    console.error("Worker de extração não iniciou");
    process.exit(1);
  }
}

const config = loadConfigOrExit();

// Produção usa sempre a política pública e os limites padrão; não há chave para mudá-los.
const deps = createProductionDeps();
await checkExtractorOrExit(deps.extract);

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
