// Auxiliares só para testes. Este arquivo não entra na imagem (.dockerignore) e nada fora de
// *.test.ts o importa. Nada aqui fala com a internet.
import { createHmac, createSign, generateKeyPairSync } from "node:crypto";
import { createSocket } from "node:dgram";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { Readable } from "node:stream";

import { OAuth2Client } from "google-auth-library";

import type { Extractor } from "./extract-pool.ts";
import { type ExtractLimits, extractPage } from "./extract.ts";
import { type AddressPolicy, isPublicAddress } from "./ip-policy.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
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

// Roda `run` e devolve as unhandled rejections que aconteceram até o fim do macrotask seguinte.
// Sob o node:test, uma rejeição dessas também reprova o teste (e o guarda global, a execução).
export async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
  const seen: unknown[] = [];
  const listener = (reason: unknown): void => {
    seen.push(reason);
  };
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 20)); // a detecção roda depois das microtasks
  } finally {
    process.off("unhandledRejection", listener);
  }
  return seen;
}

// Extrator no próprio processo, sem worker. Para testes cujo assunto não é a extração e que não
// podem depender do tempo de subir um worker (no CI, isso passou de 150 ms).
export function inlineExtractor(limits: ExtractLimits = DEFAULT_LIMITS): Extractor {
  return Object.assign(async (htmlText: string, pageUrl: string) => extractPage(htmlText, pageUrl, limits), { active: 0 });
}

// Worker de extração falso (URL data:) que responde uma página vazia depois de `delayMs`.
export function slowWorker(delayMs: number): URL {
  const code = `import { parentPort } from "node:worker_threads";
    setTimeout(() => parentPort.postMessage({ title: null, headline: null, media: [] }), ${delayMs});`;
  return new URL(`data:text/javascript,${encodeURIComponent(code)}`);
}

// Páginas hostis da revisão de segurança da Fase 3.
// Achado 1: <b> com atributos distintos escapam do "Noah's Ark" e são clonados a cada <p>x</p>.
export function formattingBomb(count: number): string {
  let page = "<p>";
  for (let i = 0; i < count; i++) page += `<b id=${i}>`;
  return `${page}</p>${"<p>x</p>".repeat(count)}`;
}

// Achado 2: cada </i> órfão percorre a pilha inteira de <span> abertos (O(n²) sem criar nós).
export const orphanEndTags = (count: number): string => "<span>".repeat(count) + "</i>".repeat(count);

// Achado 3: srcset terminado em vírgulas (ReDoS em /,+$/, corrigido no parseSrcset).
export function srcsetCommas(): string {
  const tag = `<img srcset="a${",".repeat(16_000)}x,">`;
  return tag.repeat(Math.floor((2 * 1024 * 1024) / tag.length));
}

// Página de notícia legítima e grande: head com CSS e script inline, cartões com picture/srcset.
export function legitNewsPage(targetBytes: number): string {
  const head = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Notícia</title>
<meta property="og:title" content="Manchete"><meta property="og:image" content="https://cdn.example/capa.jpg">
<style>${".card{color:#333;margin:0 auto;padding:4px}\n".repeat(2000)}</style>
<script>${"window.dataLayer=window.dataLayer||[];dataLayer.push({event:'view',id:1});\n".repeat(3000)}</script></head><body><h1>Manchete</h1>`;
  const paragraph = (i: number) =>
    `<p>Texto do parágrafo com <strong>destaque</strong>, <em>ênfase</em> e um <a href="/link/${i}">link</a>. Mais texto corrido para encher a linha.</p>\n`;
  const card = (i: number) => `<article class="card"><div class="meta"><a href="/secao/${i}">Seção</a> <time datetime="2026-10-23">23/10</time></div>
<h2><a href="/materia/${i}">Título da matéria ${i}</a></h2><figure><picture><source srcset="/img/${i}.avif 1x, /img/${i}@2x.avif 2x" type="image/avif"><img src="/img/${i}.jpg" srcset="/img/${i}-640.jpg 640w, /img/${i}-1280.jpg 1280w" alt="Foto ${i}" loading="lazy"></picture><figcaption>Legenda ${i}</figcaption></figure>
${paragraph(i).repeat(4)}</article>\n`;
  let body = "";
  for (let i = 0; head.length + body.length < targetBytes; i++) body += card(i);
  return `${head}<main>${body}</main></body></html>`;
}

// Fixtures da seleção de mídias, escritas à mão. Imitam só a ESTRUTURA de páginas reais (srcset
// com muitos tamanhos, <picture>, ícones no cabeçalho, pixel de rastreamento, casca de SPA); o
// conteúdo é inventado.
const widths = [320, 480, 640, 800, 1024, 1280, 1600];

// <img> com src + 7 candidatos w: 8 variantes da mesma foto; a maior é 1600w.
export const SRCSET_8_VARIANTS = `<img src="/fotos/principal.jpg" srcset="${widths
  .map((w) => `/fotos/principal-${w}.jpg ${w}w`)
  .join(", ")}" sizes="(max-width: 800px) 100vw, 800px" alt="Foto principal">`;

// <picture> com avif e webp em 3 larguras e o <img> interno: um grupo; a maior é o avif 1600w.
export const PICTURE_8_VARIANTS = `<picture>
<source type="image/avif" srcset="/fotos/segunda-400.avif 400w, /fotos/segunda-800.avif 800w, /fotos/segunda-1600.avif 1600w">
<source type="image/webp" srcset="/fotos/segunda-400.webp 400w, /fotos/segunda-800.webp 800w, /fotos/segunda-1600.webp 1600w">
<img src="/fotos/segunda.jpg" srcset="/fotos/segunda-1200.jpg 1200w" alt="Segunda foto"></picture>`;

// Matéria com og:image, imagens no <article>, ícones no <header>/<nav>, imagem lateral em
// <aside>, SVG, selo pequeno e pixel 1x1 no <footer>.
export function newsArticleFixture(): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Matéria de exemplo</title>
<meta property="og:image" content="https://cdn.example/og/capa-1200.jpg">
<script src="/static/app.js"></script></head><body>
<header class="topo"><a href="/"><img class="site-logo" src="/assets/marca.png" alt="Portal"></a>
<nav><img src="/assets/menu.png" width="24" height="24" alt=""><img class="icon icon-busca" src="/assets/busca.png" alt=""></nav></header>
<main><article><h1>Manchete inventada</h1>
<figure>${SRCSET_8_VARIANTS}<figcaption>Legenda</figcaption></figure>
<p>${"Texto corrido da matéria, escrito só para o teste. ".repeat(20)}</p>
<figure>${PICTURE_8_VARIANTS}</figure>
<img src="/graficos/evolucao.svg" alt="Gráfico">
</article><aside><img src="/fotos/relacionada.jpg" alt="Outra matéria"></aside></main>
<footer><img src="/assets/selo.png" width="88" height="31" alt="Selo"><img src="https://rastreio.example/p.gif" width="1" height="1" alt=""></footer>
</body></html>`;
}

// Casca de aplicação de página única: título genérico, script, ponto de montagem vazio.
export const SPA_SHELL_FIXTURE = `<!doctype html><html><head><title>Portal</title>
<script src="/static/js/main.3f2a.js" defer></script></head>
<body><div id="root"></div><noscript>Ative o JavaScript para usar este site.</noscript></body></html>`;

// Página estática curta, sem script e sem mídia (no estilo de example.com).
export const SHORT_STATIC_FIXTURE = `<!doctype html><html><head><title>Domínio de exemplo</title>
<style>body{margin:0}</style></head><body><div><h1>Domínio de exemplo</h1>
<p>Este domínio serve para exemplos em documentos.</p><p><a href="/mais">Mais informações</a></p></div></body></html>`;

// Matéria só de texto, com scripts, sem imagens: conteúdo suficiente, sem sinal de JavaScript.
export const TEXT_ONLY_FIXTURE = `<!doctype html><html><head><title>Coluna</title><script>window.analytics=[]</script></head>
<body><main><article><h1>Coluna de opinião</h1>${"<p>Parágrafo de texto da coluna, sem nenhuma imagem.</p>".repeat(30)}</article></main></body></html>`;

// Servidor DNS UDP local para exercitar o c-ares de verdade, sem internet. Responde A e AAAA da
// tabela, NOERROR sem resposta para tipo ausente (c-ares: ENODATA) e NXDOMAIN para nome ausente
// (ENOTFOUND). "mudo" nunca responde, como um autoritativo do atacante.
export type DnsRecords = Record<string, { A?: string[]; AAAA?: string[] }>;
export type FakeDnsServer = { server: string; queries: () => number; close: () => Promise<void> };

const DNS_TYPE_A = 1;
const DNS_TYPE_AAAA = 28;

function ipv6Bytes(address: string): Buffer {
  const [head = "", tail] = address.split("::");
  const groups = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const start = groups(head);
  const end = tail === undefined ? [] : groups(tail);
  const all = [...start, ...Array<string>(8 - start.length - end.length).fill("0"), ...end];
  const bytes = Buffer.alloc(16);
  all.forEach((group, i) => bytes.writeUInt16BE(parseInt(group, 16), i * 2));
  return bytes;
}

function dnsAnswer(query: Buffer, records: DnsRecords): Buffer | null {
  if (query.length < 12) return null;
  const labels: string[] = [];
  let offset = 12;
  for (let length = query[offset] ?? 0; length > 0; length = query[offset] ?? 0) {
    labels.push(query.subarray(offset + 1, offset + 1 + length).toString("latin1"));
    offset += 1 + length;
  }
  const questionEnd = offset + 5; // byte zero + tipo (2) + classe (2)
  if (questionEnd > query.length) return null;
  const type = query.readUInt16BE(offset + 1);
  const entry = records[labels.join(".").toLowerCase()];
  const addresses = type === DNS_TYPE_A ? (entry?.A ?? []) : type === DNS_TYPE_AAAA ? (entry?.AAAA ?? []) : [];
  const header = Buffer.alloc(12);
  header.writeUInt16BE(query.readUInt16BE(0), 0); // mesmo ID
  header.writeUInt16BE(entry === undefined ? 0x8183 : 0x8180, 2); // resposta; NXDOMAIN ou NOERROR
  header.writeUInt16BE(1, 4);
  header.writeUInt16BE(addresses.length, 6);
  const answers = addresses.map((address) => {
    const rdata = type === DNS_TYPE_A ? Buffer.from(address.split(".").map(Number)) : ipv6Bytes(address);
    const fixed = Buffer.alloc(12);
    fixed.writeUInt16BE(0xc00c, 0); // ponteiro para o nome da pergunta
    fixed.writeUInt16BE(type, 2);
    fixed.writeUInt16BE(1, 4); // classe IN
    fixed.writeUInt32BE(60, 6); // TTL
    fixed.writeUInt16BE(rdata.length, 10);
    return Buffer.concat([fixed, rdata]);
  });
  return Buffer.concat([header, query.subarray(12, questionEnd), ...answers]);
}

export async function startFakeDnsServer(records: DnsRecords | "mudo"): Promise<FakeDnsServer> {
  const socket = createSocket("udp4");
  let queries = 0;
  socket.on("message", (query, peer) => {
    queries++;
    if (records === "mudo") return;
    const answer = dnsAnswer(query, records);
    if (answer) socket.send(answer, peer.port, peer.address);
  });
  await new Promise<void>((resolve) => socket.bind(0, "127.0.0.1", resolve));
  return {
    server: `127.0.0.1:${socket.address().port}`,
    queries: () => queries,
    close: () => new Promise<void>((resolve) => socket.close(() => resolve())),
  };
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
