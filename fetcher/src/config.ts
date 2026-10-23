// Nenhuma variável aqui relaxa proteção: só porta e identidade de quem pode chamar.
export type Config = { port: number; audience: string; callerEmail: string };

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const rawPort = required(env, "PORT");
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("Variável de ambiente PORT inválida: use um inteiro entre 1 e 65535");
  }

  const audience = required(env, "FETCHER_AUDIENCE");
  let audienceUrl: URL;
  try {
    audienceUrl = new URL(audience);
  } catch {
    throw new Error("Variável de ambiente FETCHER_AUDIENCE inválida: use a URL do serviço");
  }
  if (audienceUrl.protocol !== "https:" && audienceUrl.hostname !== "localhost") {
    throw new Error("Variável de ambiente FETCHER_AUDIENCE inválida: use https (ou localhost em desenvolvimento)");
  }

  const callerEmail = required(env, "API_SERVICE_ACCOUNT_EMAIL");
  if (!/^[^@\s]+@[^@\s]+$/.test(callerEmail)) {
    throw new Error("Variável de ambiente API_SERVICE_ACCOUNT_EMAIL inválida");
  }
  return { port, audience, callerEmail };
}
