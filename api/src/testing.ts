// Auxiliares só para testes: tokens assinados com chave gerada na hora. Nada aqui fala com o Google.
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";

import { OAuth2Client } from "google-auth-library";

export const TEST_CLIENT_ID = "test-client-id.apps.googleusercontent.com";
export const TEST_KID = "test-kid";

export type TestKeys = { publicPem: string; privatePem: string };

export function generateTestKeys(): TestKeys {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const b64url = (value: string | Buffer): string => Buffer.from(value).toString("base64url");

export function validClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: "https://accounts.google.com",
    aud: TEST_CLIENT_ID,
    sub: "1234567890",
    email: "pessoa@example.com",
    email_verified: true,
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

type SignOptions = {
  header?: Record<string, unknown>;
  mode?: "rs256" | "hs256-public-key" | "none";
  keys: TestKeys;
};

export function signToken(claims: Record<string, unknown>, options: SignOptions): string {
  const mode = options.mode ?? "rs256";
  const alg = mode === "rs256" ? "RS256" : mode === "none" ? "none" : "HS256";
  const header = { alg, typ: "JWT", kid: TEST_KID, ...options.header };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  if (mode === "none") return `${signingInput}.`;
  const signature =
    mode === "rs256"
      ? createSign("RSA-SHA256").update(signingInput).sign(options.keys.privatePem)
      : createHmac("sha256", options.keys.publicPem).update(signingInput).digest();
  return `${signingInput}.${b64url(signature)}`;
}

type CertsResponse = Awaited<ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>>;

// Cliente que usa as chaves de teste em vez de baixar os certificados do Google.
export class OfflineOAuth2Client extends OAuth2Client {
  readonly #publicPem: string;

  constructor(publicPem: string) {
    super({ issuers: ["accounts.google.com", "https://accounts.google.com"] });
    this.#publicPem = publicPem;
  }

  override getFederatedSignonCertsAsync(): Promise<CertsResponse> {
    return Promise.resolve({ certs: { [TEST_KID]: this.#publicPem }, format: "PEM" as CertsResponse["format"] });
  }
}
