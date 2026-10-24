import { OAuth2Client } from "google-auth-library";

export type VerifiedIdentity = { email: string; sub: string };
export type TokenVerifier = (token: string) => Promise<VerifiedIdentity>;

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
export function createGoogleVerifier(
  clientId: string,
  client: OAuth2Client = new OAuth2Client({ issuers: GOOGLE_ISSUERS }),
): TokenVerifier {
  return async (token) => {
    if (declaredAlgorithm(token) !== "RS256") throw new Error("algoritmo não aceito");
    const ticket = await client.verifyIdToken({ idToken: token, audience: clientId });
    const payload = ticket.getPayload();
    if (!payload) throw new Error("payload ausente");
    if (payload.aud !== clientId) throw new Error("aud inválida");
    if (!GOOGLE_ISSUERS.includes(payload.iss)) throw new Error("iss inválido");
    if (payload.exp * 1000 <= Date.now()) throw new Error("token expirado");
    if (payload.email_verified !== true) throw new Error("e-mail não verificado");
    if (typeof payload.email !== "string" || payload.email === "") throw new Error("e-mail ausente");
    // sub: identificador estável da conta, usado (em HMAC) como chave do limite por usuário.
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("sub ausente");
    return { email: payload.email, sub: payload.sub };
  };
}
