import { createHmac, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { extractBearerToken, type TokenVerifier, type VerifiedIdentity } from "./auth.ts";

const SECURITY_HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

export function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...SECURITY_HEADERS, ...extra });
  res.end(JSON.stringify(body));
}

// Erro com resposta pronta. outcome vai só para o log; o corpo é o que o usuário vê.
export class HttpError extends Error {
  readonly status: number;
  readonly outcome: string;
  readonly body: Record<string, unknown>;
  readonly headers: Record<string, string>;

  constructor(status: number, outcome: string, body: Record<string, unknown>, headers: Record<string, string> = {}) {
    super(outcome);
    this.status = status;
    this.outcome = outcome;
    this.body = body;
    this.headers = headers;
  }
}

// Qualquer falha vira o mesmo 401 genérico; o motivo do verificador nunca é repassado.
export async function authenticate(req: IncomingMessage, verifier: TokenVerifier): Promise<VerifiedIdentity> {
  const token = extractBearerToken(req.headers.authorization);
  try {
    if (token === null) throw new Error("sem token");
    return await verifier(token);
  } catch {
    throw new HttpError(401, "unauthorized", { error: "Não autorizado" }, { "WWW-Authenticate": "Bearer" });
  }
}

// Chave aleatória gerada na inicialização e nunca gravada: sem ela, o hash dos domínios populares
// se reverte por dicionário. A correlação vale só dentro da mesma instância. Mesmo desenho de
// fetcher/src/server.ts (duplicação registrada como dívida técnica em docs/fetcher.md).
const LOG_HASH_KEY = randomBytes(32);

export function domainHash(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  try {
    const { hostname } = new URL(raw);
    return hostname === "" ? null : createHmac("sha256", LOG_HASH_KEY).update(hostname).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}
