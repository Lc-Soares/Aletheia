import { Resolver as AresResolver } from "node:dns/promises";
import { isIP } from "node:net";

import { FetchError, toFetchError, withDeadline } from "./errors.ts";
import { type AddressPolicy, canonicalAddress } from "./ip-policy.ts";
import type { TargetUrl } from "./url-policy.ts";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string, signal?: AbortSignal) => Promise<readonly ResolvedAddress[]>;

// O que o resolvedor usa do c-ares (dns.promises.Resolver); injetável nos testes.
export type DnsClient = {
  resolve4: (hostname: string) => Promise<string[]>;
  resolve6: (hostname: string) => Promise<string[]>;
  cancel: () => void;
};

// c-ares não usa o threadpool do libuv (getaddrinfo usa, e uma thread presa num servidor DNS que
// não responde só é liberada pelo timeout do sistema). Aqui o timeout e as tentativas são nossos.
export const DNS_OPTIONS = Object.freeze({ timeout: 1_500, tries: 2 });

// "Sem registro desta família": o nome pode ter só A ou só AAAA.
const NO_RECORDS = new Set(["ENODATA", "ENOTFOUND"]);

function familyAddresses(result: PromiseSettledResult<string[]>, family: 4 | 6): ResolvedAddress[] {
  if (result.status === "fulfilled") return result.value.map((address) => ({ address, family }));
  const code = (result.reason as { code?: unknown } | null)?.code;
  if (typeof code === "string" && NO_RECORDS.has(code)) return [];
  // Qualquer outra falha (timeout, SERVFAIL...) falha fechado: não dá para garantir que vimos todos os IPs.
  throw result.reason;
}

// Um cliente por resolução, para que cancelar uma requisição não cancele as consultas de outra.
export function createDnsResolver(newClient: () => DnsClient = () => new AresResolver(DNS_OPTIONS)): Resolver {
  return async (hostname, signal) => {
    const client = newClient();
    const onAbort = (): void => client.cancel();
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const [v4, v6] = await Promise.allSettled([client.resolve4(hostname), client.resolve6(hostname)]);
      return [...familyAddresses(v4, 4), ...familyAddresses(v6, 6)];
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}

export const systemResolver: Resolver = createDnsResolver();

function allowedAddress(address: string, policy: AddressPolicy): ResolvedAddress {
  const canonical = canonicalAddress(address);
  if (canonical === null || !policy(canonical)) throw new FetchError("blocked");
  return { address: canonical, family: isIP(canonical) === 6 ? 6 : 4 };
}

// Resolve o DNS uma única vez e exige que TODOS os IPs sejam permitidos. O IP devolvido é o
// único a que o transporte pode se conectar; ninguém resolve o nome de novo depois disto.
export async function resolveTarget(
  target: TargetUrl,
  resolver: Resolver,
  policy: AddressPolicy,
  signal: AbortSignal,
): Promise<ResolvedAddress> {
  if (target.ipVersion !== 0) return allowedAddress(target.hostname, policy);

  let results: readonly ResolvedAddress[];
  try {
    results = await withDeadline(resolver(target.hostname, signal), signal);
  } catch (error) {
    throw toFetchError(error, signal);
  }
  if (results.length === 0) throw new FetchError("network");
  const allowed = results.map(({ address }) => allowedAddress(address, policy));
  const [first] = allowed;
  if (first === undefined) throw new FetchError("network");
  return first;
}
