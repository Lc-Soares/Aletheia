export type Config = { googleClientId: string; port: number; fetcherUrl: string; fetcherAudience: string };

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

// URL de um serviço nosso: https, ou http://localhost só em desenvolvimento local (mesma regra
// do FETCHER_AUDIENCE do fetcher). Sem usuário/senha. O erro nunca repete o valor.
function checkServiceUrl(raw: string, name: string): URL {
  const invalid = new Error(`Variável de ambiente ${name} inválida: use https (ou http://localhost em desenvolvimento)`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid;
  }
  const allowedScheme = url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "localhost");
  if (!allowedScheme || url.username !== "" || url.password !== "") throw invalid;
  return url;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const googleClientId = required(env, "GOOGLE_CLIENT_ID");

  const rawPort = required(env, "PORT");
  const port = Number(rawPort);
  if (!/^\d+$/.test(rawPort) || port < 1 || port > 65535) {
    throw new Error("Variável de ambiente PORT inválida: use um inteiro entre 1 e 65535");
  }

  const fetcherUrl = checkServiceUrl(required(env, "FETCHER_URL"), "FETCHER_URL");
  if (fetcherUrl.search !== "" || fetcherUrl.hash !== "") {
    throw new Error("Variável de ambiente FETCHER_URL inválida: sem query nem fragmento");
  }
  // O aud do ID token precisa ser igual, caractere por caractere, ao FETCHER_AUDIENCE do fetcher.
  const fetcherAudience = required(env, "FETCHER_AUDIENCE");
  checkServiceUrl(fetcherAudience, "FETCHER_AUDIENCE");
  return { googleClientId, port, fetcherUrl: fetcherUrl.href, fetcherAudience };
}
