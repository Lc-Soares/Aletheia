import { BlockList, isIP } from "node:net";

// Decide se o fetcher pode se conectar a um IP. Recebe só IPs já resolvidos ou literais.
export type AddressPolicy = (address: string) => boolean;

const IPV4_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], // "esta rede"
  ["10.0.0.0", 8], // privada
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, inclui o servidor de metadados 169.254.169.254
  ["172.16.0.0", 12], // privada
  ["192.0.0.0", 24], // atribuições de protocolo da IETF
  ["192.0.2.0", 24], // documentação
  ["192.88.99.0", 24], // relay 6to4 (obsoleto)
  ["192.168.0.0", 16], // privada
  ["198.18.0.0", 15], // benchmark
  ["198.51.100.0", 24], // documentação
  ["203.0.113.0", 24], // documentação
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservada, inclui 255.255.255.255
] as const) {
  IPV4_BLOCKED.addSubnet(network, prefix, "ipv4");
}

// IPv6: só unicast global (2000::/3) é aceito. Isso já exclui ::, ::1, fc00::/7, fe80::/10,
// fec0::/10, ff00::/8, 64:ff9b::/96, 100::/64 e ::/96. Dentro de 2000::/3, bloqueia o resto.
const IPV6_ALLOWED = new BlockList();
IPV6_ALLOWED.addSubnet("2000::", 3, "ipv6");

const IPV6_BLOCKED = new BlockList();
for (const [network, prefix] of [
  ["2001::", 23], // atribuições de protocolo da IETF, inclui Teredo (2001::/32)
  ["2001:db8::", 32], // documentação
  ["2002::", 16], // 6to4 (carrega IPv4 embutido)
  ["3fff::", 20], // documentação
] as const) {
  IPV6_BLOCKED.addSubnet(network, prefix, "ipv6");
}

// Usa o serializador WHATWG para expandir o IPv6 em 8 grupos (ele já converte "a.b.c.d" no fim para hex).
function ipv6Groups(ip: string): { groups: number[]; text: string } | null {
  let host: string;
  try {
    host = new URL(`http://[${ip}]/`).hostname;
  } catch {
    return null;
  }
  const text = host.slice(1, -1);
  const toNumbers = (part: string): number[] => (part === "" ? [] : part.split(":").map((g) => parseInt(g, 16)));
  const [head = "", tail] = text.split("::");
  const left = toNumbers(head);
  const right = tail === undefined ? [] : toNumbers(tail);
  const groups = tail === undefined ? left : [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
  return groups.length === 8 ? { groups, text } : null;
}

function embeddedMappedIpv4(groups: number[]): string | null {
  const isMapped = groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff;
  if (!isMapped) return null;
  const [high = 0, low = 0] = groups.slice(6);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

// Forma canônica para comparar endereços: IPv4 em quatro octetos, IPv4-mapeado vira IPv4,
// IPv6 em minúsculas e compactado. Devolve null para o que não é IP.
export function canonicalAddress(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const parsed = ipv6Groups(ip);
  if (parsed === null) return null;
  return embeddedMappedIpv4(parsed.groups) ?? parsed.text;
}

export const isPublicAddress: AddressPolicy = (address) => {
  const canonical = canonicalAddress(address);
  if (canonical === null) return false;
  if (isIP(canonical) === 4) return !IPV4_BLOCKED.check(canonical, "ipv4");
  return IPV6_ALLOWED.check(canonical, "ipv6") && !IPV6_BLOCKED.check(canonical, "ipv6");
};
