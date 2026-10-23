export type Config = { googleClientId: string; port: number };

export function loadConfig(env: Record<string, string | undefined>): Config {
  const googleClientId = env["GOOGLE_CLIENT_ID"]?.trim();
  if (!googleClientId) throw new Error("Variável de ambiente obrigatória ausente: GOOGLE_CLIENT_ID");

  const rawPort = env["PORT"]?.trim();
  if (!rawPort) throw new Error("Variável de ambiente obrigatória ausente: PORT");
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("Variável de ambiente PORT inválida: use um inteiro entre 1 e 65535");
  }
  return { googleClientId, port };
}
