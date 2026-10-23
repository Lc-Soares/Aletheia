import { isIP } from "node:net";

import { FetchError } from "./errors.ts";
import { DEFAULT_LIMITS } from "./limits.ts";

export type TargetUrl = {
  url: URL;
  hostname: string; // sem colchetes e sem ponto final
  hostHeader: string;
  port: number;
  ipVersion: 0 | 4 | 6; // 0 = nome, que ainda precisa de DNS
};

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);
const ALLOWED_PORTS = new Set([80, 443]);
const BLOCKED_NAMES = new Set(["localhost", "metadata"]);
const BLOCKED_SUFFIXES = [".localhost", ".internal", ".local", ".home.arpa"];

function parse(raw: string, base: string | URL | undefined, maxLength: number): URL {
  if (raw.length > maxLength) throw new FetchError("invalid_url");
  try {
    return new URL(raw, base);
  } catch {
    throw new FetchError("invalid_url");
  }
}

function normalizeHostname(url: URL): { hostname: string; ipVersion: 0 | 4 | 6 } {
  const raw = url.hostname;
  if (raw.startsWith("[")) {
    const inner = raw.slice(1, -1);
    if (isIP(inner) !== 6) throw new FetchError("invalid_url");
    return { hostname: inner, ipVersion: 6 };
  }
  const hostname = raw.endsWith(".") ? raw.slice(0, -1) : raw;
  if (hostname === "" || hostname.split(".").some((label) => label === "")) throw new FetchError("invalid_url");
  if (isIP(hostname) === 4) return { hostname, ipVersion: 4 };
  return { hostname, ipVersion: 0 };
}

function assertNameAllowed(hostname: string): void {
  // Nome sem ponto (intranet, metadata, localhost) só resolve em rede interna.
  if (!hostname.includes(".")) throw new FetchError("blocked");
  if (BLOCKED_NAMES.has(hostname) || BLOCKED_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    throw new FetchError("blocked");
  }
}

// Valida a forma da URL. Não decide pelo IP: isso fica para resolveTarget, depois do DNS.
export function parseTargetUrl(
  raw: string,
  base?: string | URL,
  maxLength: number = DEFAULT_LIMITS.maxUrlLength,
): TargetUrl {
  const url = parse(raw, base, maxLength);
  url.hash = "";
  if (url.href.length > maxLength) throw new FetchError("invalid_url");
  if (!ALLOWED_PROTOCOLS.has(url.protocol)) throw new FetchError("blocked");
  if (url.username !== "" || url.password !== "") throw new FetchError("blocked");

  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) throw new FetchError("blocked");

  const { hostname, ipVersion } = normalizeHostname(url);
  if (ipVersion === 0) assertNameAllowed(hostname);

  const hostPart = ipVersion === 6 ? `[${hostname}]` : hostname;
  const hostHeader = url.port === "" ? hostPart : `${hostPart}:${url.port}`;
  return { url, hostname, hostHeader, port, ipVersion };
}
