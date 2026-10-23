import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import { FetchError, toFetchError } from "./errors.ts";
import { type AddressPolicy, canonicalAddress } from "./ip-policy.ts";
import type { TargetUrl } from "./url-policy.ts";

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type Resolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const results = await lookup(hostname, { all: true, order: "verbatim" });
  return results.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

function rejectOnAbort(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let onAbort = (): void => {};
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new FetchError("timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  return { promise, dispose: () => signal.removeEventListener("abort", onAbort) };
}

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

  const abort = rejectOnAbort(signal);
  let results: readonly ResolvedAddress[];
  try {
    results = await Promise.race([resolver(target.hostname), abort.promise]);
  } catch (error) {
    throw toFetchError(error, signal);
  } finally {
    abort.dispose();
  }
  if (results.length === 0) throw new FetchError("network");
  const allowed = results.map(({ address }) => allowedAddress(address, policy));
  const [first] = allowed;
  if (first === undefined) throw new FetchError("network");
  return first;
}
