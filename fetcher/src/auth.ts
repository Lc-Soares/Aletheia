// Cópia adaptada de api/src/auth.ts (dívida técnica registrada em docs/fetcher.md): aqui quem
// chama é a conta de serviço da API, com ID token emitido pelo Google para o aud do fetcher.
import { OAuth2Client } from "google-auth-library";

export type CallerIdentity = { email: string };
export type CallerVerifier = (token: string) => Promise<CallerIdentity>;

const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];
const MAX_TOKEN_LENGTH = 4096;
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/i;

export function extractBearerToken(header: string | undefined): string | null {
  if (header === undefined || header.length > MAX_TOKEN_LENGTH + 7) return null;
  return BEARER.exec(header)?.[1] ?? null;
}

function declaredAlgorithm(token: string): unknown {
  const [header] = token.split(".");
  return (JSON.parse(Buffer.from(header ?? "", "base64url").toString("utf8")) as { alg?: unknown }).alg;
}

// Qualquer falha lança; quem chama responde 401 genérico e não repassa a mensagem.
// email e email_verified aparecem nos exemplos oficiais de ID token de conta de serviço, mas a
// documentação não os garante: se faltarem, a chamada é recusada (falha fechada).
export function createCallerVerifier(
  audience: string,
  allowedEmail: string,
  client: OAuth2Client = new OAuth2Client({ issuers: GOOGLE_ISSUERS }),
): CallerVerifier {
  const expectedEmail = allowedEmail.toLowerCase();
  return async (token) => {
    if (declaredAlgorithm(token) !== "RS256") throw new Error("algoritmo não aceito");
    const ticket = await client.verifyIdToken({ idToken: token, audience });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("payload ausente");
    if (payload.aud !== audience) throw new Error("aud inválida");
    if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("iss inválido");
    if (payload.exp * 1000 <= Date.now()) throw new Error("token expirado");
    if (payload.email_verified !== true) throw new Error("e-mail não verificado");
    if (typeof payload.email !== "string" || payload.email.toLowerCase() !== expectedEmail) {
      throw new Error("chamador não autorizado");
    }
    return { email: payload.email };
  };
}
