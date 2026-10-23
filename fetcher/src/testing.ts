// Auxiliares só para testes. Este arquivo não entra na imagem (.dockerignore) e nada fora de
// *.test.ts o importa. Nada aqui fala com a internet.
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";

import { OAuth2Client } from "google-auth-library";

import { type AddressPolicy, isPublicAddress } from "./ip-policy.ts";
import type { ResolvedAddress, Resolver } from "./resolve.ts";
import type { ResponseHeaders, Transport, TransportRequest } from "./transport.ts";

// Política explícita de teste: igual à de produção, mais o loopback 127.0.0.1 dos servidores locais.
export const TEST_LOOPBACK_POLICY: AddressPolicy = (address) => address === "127.0.0.1" || isPublicAddress(address);

type ResolverAnswer = readonly string[] | ((call: number) => readonly string[]);
export type FakeResolver = Resolver & { calls: string[] };

export function fakeResolver(table: Record<string, ResolverAnswer>): FakeResolver {
  const calls: string[] = [];
  const resolver = async (hostname: string): Promise<readonly ResolvedAddress[]> => {
    calls.push(hostname);
    const answer = table[hostname];
    if (answer === undefined) throw Object.assign(new Error("ENOTFOUND interno 10.0.0.1"), { code: "ENOTFOUND" });
    const list = typeof answer === "function" ? answer(calls.filter((h) => h === hostname).length) : answer;
    return list.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
  return Object.assign(resolver, { calls });
}

export type FakeResponse = { status?: number; headers?: ResponseHeaders; body?: Buffer | string | Readable };
export type FakeTransport = Transport & { calls: TransportRequest[] };

export function fakeTransport(handler: (req: TransportRequest) => FakeResponse | Promise<FakeResponse>): FakeTransport {
  const calls: TransportRequest[] = [];
  const transport = async (req: TransportRequest) => {
    calls.push(req);
    const response = await handler(req);
    const body = response.body ?? "";
    return {
      status: response.status ?? 200,
      headers: response.headers ?? {},
      body: body instanceof Readable ? body : Readable.from([Buffer.from(body)]),
    };
  };
  return Object.assign(transport, { calls });
}

// Mapa URL -> resposta, para montar páginas inteiras sem rede.
export function routeTransport(routes: Record<string, FakeResponse>): FakeTransport {
  return fakeTransport((req) => routes[req.url.href] ?? { status: 404, headers: { "content-type": "text/html" } });
}

// Encaminha para o transporte real trocando só a porta (80/443 -> porta do servidor local).
export function portMappingTransport(inner: Transport, port: number): Transport {
  return (req) => inner({ ...req, port });
}

export function html(body: string, headers: ResponseHeaders = {}): FakeResponse {
  return { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers }, body };
}

export function image(bytes: Buffer | string, contentType = "image/jpeg"): FakeResponse {
  return { status: 200, headers: { "content-type": contentType }, body: bytes };
}

export function redirect(location: string, status = 302): FakeResponse {
  return { status, headers: { location } };
}

export type LocalServer = { server: Server; port: number; requests: IncomingMessage[]; connections: Socket[]; close: () => Promise<void> };

export async function startLocalServer(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<LocalServer> {
  const requests: IncomingMessage[] = [];
  const connections: Socket[] = [];
  const server = createServer((req, res) => {
    requests.push(req);
    handler(req, res);
  });
  server.on("connection", (socket) => connections.push(socket));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { server, port, requests, connections, close };
}

// Tokens assinados com chave gerada na hora, como em api/src/testing.ts (duplicação registrada
// como dívida técnica em docs/fetcher.md).
export const TEST_AUDIENCE = "https://fetcher-test.a.run.app";
export const TEST_CALLER_EMAIL = "api@projeto-teste.iam.gserviceaccount.com";
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
    aud: TEST_AUDIENCE,
    azp: "123456789012345678901",
    sub: "123456789012345678901",
    email: TEST_CALLER_EMAIL,
    email_verified: true,
    iat: now - 10,
    exp: now + 3600,
    ...overrides,
  };
}

export function signToken(
  claims: Record<string, unknown>,
  keys: TestKeys,
  mode: "rs256" | "hs256-public-key" | "none" = "rs256",
): string {
  const alg = mode === "rs256" ? "RS256" : mode === "none" ? "none" : "HS256";
  const signingInput = `${b64url(JSON.stringify({ alg, typ: "JWT", kid: TEST_KID }))}.${b64url(JSON.stringify(claims))}`;
  if (mode === "none") return `${signingInput}.`;
  const signature =
    mode === "rs256"
      ? createSign("RSA-SHA256").update(signingInput).sign(keys.privatePem)
      : createHmac("sha256", keys.publicPem).update(signingInput).digest();
  return `${signingInput}.${b64url(signature)}`;
}

type CertsResponse = Awaited<ReturnType<OAuth2Client["getFederatedSignonCertsAsync"]>>;

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
