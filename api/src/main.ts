import { createGoogleVerifier } from "./auth.ts";
import { type Config, loadConfig } from "./config.ts";
import { createApiServer, shutdown } from "./server.ts";

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
const server = createApiServer({
  verifier: createGoogleVerifier(config.googleClientId),
  log: (entry) => console.log(JSON.stringify(entry)),
});

server.listen(config.port, () => {
  console.log(JSON.stringify({ event: "listening", port: config.port }));
});

process.on("SIGTERM", () => {
  void shutdown(server, SHUTDOWN_GRACE_MS).then(() => process.exit(0));
});
