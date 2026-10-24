// Auxiliares só para testes: tokens assinados com chave gerada na hora. Nada aqui fala com o Google.
import { createHash, createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { OAuth2Client } from "google-auth-library";

import type { CheckDeps } from "./check.ts";
import { RateLimiter } from "./rate-limit.ts";

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

// ---------------------------------------------------------------------------------------------
// Fetcher falso: servidor HTTP local em 127.0.0.1 que imita o contrato de docs/fetcher.md.
// Nada aqui acessa a internet.

export type FakeFetcherRequest = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
export type FakeFetcherHandler = (req: FakeFetcherRequest, res: ServerResponse) => void | Promise<void>;
export type FakeFetcher = { url: string; requests: FakeFetcherRequest[]; close: () => Promise<void> };

export async function startFakeFetcher(handler: FakeFetcherHandler): Promise<FakeFetcher> {
  const requests: FakeFetcherRequest[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const entry = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      requests.push(entry);
      await handler(entry, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url: `http://127.0.0.1:${port}`, requests, close };
}

export const TEST_SERVICE_TOKEN = "service.token.de-teste";
export const PAGE_URL = "https://noticias.example/materia";
export const CAPA_BYTES = Buffer.from("bytes-da-capa-\u00e7\u00e3o", "utf8");
export const FOTO_BYTES = Buffer.from("bytes-da-foto", "utf8");

type Line = Record<string, unknown>;

export function mediaRef(overrides: Line = {}): Line {
  return { url: "https://cdn.example/og/capa.jpg", kind: "image", source: "og:image", group: 1, score: 100, selected: true, skipReason: null, ...overrides };
}

// Três referências: capa (og:image, grupo 1), foto do corpo (grupo 2) e um ícone ignorado (grupo 3).
export const CAPA_REF = mediaRef();
export const FOTO_REF = mediaRef({ url: "https://noticias.example/fotos/principal.jpg", source: "img", group: 2, score: 20 });
export const ICONE_REF = mediaRef({
  url: "https://noticias.example/assets/marca.png",
  source: "img",
  group: 3,
  score: -70,
  selected: false,
  skipReason: "icon",
});

export function pageLine(overrides: Line = {}): Line {
  return {
    type: "page",
    finalUrl: PAGE_URL,
    title: "Mat\u00e9ria de exemplo",
    headline: "Manchete inventada",
    possiblyNeedsJavaScript: false,
    media: [CAPA_REF, FOTO_REF, ICONE_REF],
    ...overrides,
  };
}

const sha256Hex = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function mediaLine(ref: Line, bytes: Buffer, overrides: Line = {}): Line {
  const { url, kind, source, group } = ref;
  return {
    type: "media",
    url,
    kind,
    source,
    group,
    contentType: "image/jpeg",
    size: bytes.length,
    sha256: sha256Hex(bytes),
    data: bytes.toString("base64"),
    ...overrides,
  };
}

export function mediaErrorLine(ref: Line, error: string, httpStatus?: number): Line {
  const { url, kind, source, group } = ref;
  const line = { type: "media_error", url, kind, source, group, error };
  return httpStatus === undefined ? line : { ...line, httpStatus };
}

export const DONE_LINE: Line = { type: "done" };

export const ndjson = (lines: unknown[]): string => lines.map((line) => `${JSON.stringify(line)}\n`).join("");

// Resposta completa e válida: capa baixada, foto com erro "blocked", ícone ignorado.
export const standardStream = (): string =>
  ndjson([pageLine(), mediaLine(CAPA_REF, CAPA_BYTES), mediaErrorLine(FOTO_REF, "blocked"), DONE_LINE]);

// Envia o corpo em fatias pequenas, para cortar linhas e caracteres UTF-8 ao meio.
export async function sendNdjson(res: ServerResponse, body: string | Buffer, chunkBytes = 0): Promise<void> {
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8" });
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  if (chunkBytes <= 0) return void res.end(bytes);
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    res.write(bytes.subarray(offset, offset + chunkBytes));
    await new Promise((resolve) => setImmediate(resolve));
  }
  res.end();
}

export function sendJsonResponse(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

// Dependências da rota /api/check para testes que não a exercitam.
export function testCheckDeps(overrides: Partial<CheckDeps> = {}): CheckDeps {
  return {
    callFetcher: () => Promise.resolve({ kind: "failed", reason: "network" }),
    limiter: new RateLimiter({ windowMs: 3_600_000 }),
    maxInFlightChecks: 4,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------------------------
// ExifTools falsa: servidor HTTP local em 127.0.0.1. Os testes nunca chamam a ExifTools real.

export type FakeExifToolsRequest = { method: string; path: string; headers: IncomingHttpHeaders; rawBody: Buffer };
export type FakeExifToolsHandler = (req: FakeExifToolsRequest, res: ServerResponse) => void | Promise<void>;
export type FakeExifTools = {
  endpoint: string;
  requests: FakeExifToolsRequest[];
  maxConcurrent: () => number;
  close: () => Promise<void>;
};

export const TEST_EXIFTOOLS_KEY = "chave-sentinela-exiftools-0123456789";

export async function startFakeExifTools(handler: FakeExifToolsHandler): Promise<FakeExifTools> {
  const requests: FakeExifToolsRequest[] = [];
  let active = 0;
  let peak = 0;
  const server = createServer((req, res) => {
    active++;
    peak = Math.max(peak, active);
    res.on("close", () => active--);
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const entry = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, rawBody: Buffer.concat(chunks) };
      requests.push(entry);
      await handler(entry, res);
    })().catch(() => res.destroy());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { endpoint: `http://127.0.0.1:${port}/api/v1/extract`, requests, maxConcurrent: () => peak, close };
}

// Lê o multipart recebido com o parser nativo (Request.formData), sem dependência nova.
export function parseMultipart(req: FakeExifToolsRequest): Promise<FormData> {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
  }
  return new Request("http://fake.invalid/", { method: "POST", headers, body: req.rawBody }).formData();
}

// Resposta de sucesso no formato do exemplo de docs/apis/documentacao-exif.md.
export function exifSuccess(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    success: true,
    status: "completed",
    fileName: "media.jpg",
    uuid: "123e4567-e89b-12d3-a456-426614174000",
    processedAt: "2026-03-15T10:31:02+00:00",
    createDate: "2026-03-15 10:30:00",
    fileSize: "4.2 MB",
    fileSizeBytes: 4404019,
    mimeType: "image/jpeg",
    dimensions: "8192x5464",
    cameraModel: "Canon EOS R5",
    metadata: {
      File: {
        FileType: "JPEG",
        MIMEType: "image/jpeg",
        FileSize: "4.2 MB",
        ImageWidth: 8192,
        ImageHeight: 5464,
        SHA256: "a5e50cbe66078249973d9a71230c4a8edbaedc26af11204042d3bce1f9ed4409",
      },
      EXIF: {
        Make: "Canon",
        Model: "Canon EOS R5",
        DateTimeOriginal: "2026:03:15 10:30:00",
        ExposureTime: "1/1000",
        FNumber: 2.8,
        ISO: 100,
      },
    },
    ...overrides,
  };
}

// Bloco contentCredentials no formato do exemplo da documentação.
export function contentCredentials(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "trusted_legacy",
    signer: "Adobe Inc.",
    certificateName: "cai-prod",
    trustList: "itl",
    signedAt: "2023-10-02T16:51:02+00:00",
    timestamped: true,
    algorithm: "Ps256",
    generator: "Adobe Firefly 1.0",
    title: "Generated image",
    aiGenerated: true,
    digitalSourceTypes: ["ai"],
    actions: [{ action: "c2pa.created", softwareAgent: "Adobe Firefly", digitalSourceType: "ai" }],
    ingredients: [],
    creator: [],
    aiTraining: [],
    checks: [{ code: "assertion.dataHash.match", outcome: "success" }],
    manifestUrl: "https://exiftools.com/results/123e4567-e89b-12d3-a456-426614174000/credentials?format=manifest",
    checkedAt: "2026-10-15T16:36:48+00:00",
    ...overrides,
  };
}
