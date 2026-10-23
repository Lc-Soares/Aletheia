import { request } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import type { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";

import { FetchError } from "./errors.ts";
import { canonicalAddress } from "./ip-policy.ts";
import type { ResolvedAddress } from "./resolve.ts";

export type ResponseHeaders = Record<string, string | string[] | undefined>;

export type TransportRequest = {
  url: URL;
  hostname: string;
  hostHeader: string;
  port: number;
  address: ResolvedAddress; // IP já validado; o transporte nunca resolve o nome
  headers: Record<string, string>;
  maxHeaderBytes: number;
  headersTimeoutMs: number; // conexão + TLS + cabeçalhos deste salto
  signal: AbortSignal; // prazo total; continua valendo durante a leitura do corpo
};

export type TransportResponse = { status: number; headers: ResponseHeaders; body: Readable };
export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

// Abre o TCP direto no IP (net.connect com IP literal não consulta DNS).
export type SocketOpener = (address: ResolvedAddress, port: number) => Socket;

const openPinnedSocket: SocketOpener = ({ address, family }, port) => netConnect({ host: address, port, family });

function isHeaderOverflow(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "HPE_HEADER_OVERFLOW";
}

function exchange(req: TransportRequest, openSocket: SocketOpener): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    let socket: Socket | null = null;
    let settled = false;
    const onAbort = (): void => settle(new FetchError("timeout"));
    const timer = setTimeout(onAbort, req.headersTimeoutMs);

    function settle(error: FetchError | null, response?: TransportResponse): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.signal.removeEventListener("abort", onAbort);
      if (error !== null || response === undefined) {
        socket?.destroy();
        reject(error ?? new FetchError("network"));
      } else {
        resolve(response);
      }
    }

    function sendRequest(stream: Socket): void {
      const clientRequest = request({
        createConnection: () => stream, // sem agent: sem pool, sem proxy, Connection: close
        host: req.hostname,
        port: req.port,
        path: `${req.url.pathname}${req.url.search}`,
        method: "GET",
        setHost: false,
        headers: { ...req.headers, Host: req.hostHeader },
        maxHeaderSize: req.maxHeaderBytes,
      });
      clientRequest.on("error", (error) => settle(new FetchError(isHeaderOverflow(error) ? "too_large" : "network")));
      clientRequest.on("response", (res) => {
        settle(null, { status: res.statusCode ?? 0, headers: res.headers, body: res });
      });
      clientRequest.end();
    }

    if (req.signal.aborted) return onAbort();
    req.signal.addEventListener("abort", onAbort, { once: true });

    const raw = openSocket(req.address, req.port);
    socket = raw;
    raw.on("error", () => settle(new FetchError("network")));
    raw.once("connect", () => {
      // Confere o par conectado antes de enviar qualquer byte.
      if (canonicalAddress(raw.remoteAddress ?? "") !== req.address.address) return settle(new FetchError("blocked"));
      if (req.url.protocol !== "https:") return sendRequest(raw);
      // SNI e verificação do certificado usam o hostname original, não o IP.
      const secure = tlsConnect({
        socket: raw,
        host: req.hostname,
        servername: isIP(req.hostname) === 0 ? req.hostname : undefined,
        ALPNProtocols: ["http/1.1"],
      });
      socket = secure;
      secure.on("error", () => settle(new FetchError("network")));
      secure.once("secureConnect", () => sendRequest(secure));
    });
  });
}

export function createNodeTransport(options: { openSocket?: SocketOpener } = {}): Transport {
  const openSocket = options.openSocket ?? openPinnedSocket;
  return (req) => exchange(req, openSocket);
}
