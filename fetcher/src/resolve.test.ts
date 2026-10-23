import assert from "node:assert/strict";
import { Resolver as AresResolver } from "node:dns/promises";
import { describe, test } from "node:test";

import { FetchError, type FetchErrorCategory } from "./errors.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { createDnsResolver, DNS_OPTIONS, type DnsClient, resolveTarget } from "./resolve.ts";
import { type DnsRecords, type FakeDnsServer, fakeResolver, startFakeDnsServer } from "./testing.ts";
import { parseTargetUrl } from "./url-policy.ts";

const never = new AbortController().signal;

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

describe("resolveTarget", () => {
  test("nome com IP público devolve esse IP", async () => {
    const resolver = fakeResolver({ "noticias.example": ["93.184.216.34"] });
    const result = await resolveTarget(parseTargetUrl("https://noticias.example/"), resolver, isPublicAddress, never);
    assert.deepEqual(result, { address: "93.184.216.34", family: 4 });
    assert.equal(resolver.calls.length, 1);
  });

  test("vários IPs com um proibido: bloqueia", async () => {
    const resolver = fakeResolver({ "misto.example": ["93.184.216.34", "10.0.0.5", "8.8.8.8"] });
    await assertRejects(resolveTarget(parseTargetUrl("https://misto.example/"), resolver, isPublicAddress, never), "blocked");
  });

  test("IPv6 proibido no meio de IPv4 públicos: bloqueia", async () => {
    const resolver = fakeResolver({ "misto6.example": ["93.184.216.34", "::1"] });
    await assertRejects(resolveTarget(parseTargetUrl("https://misto6.example/"), resolver, isPublicAddress, never), "blocked");
  });

  test("IPv4-mapeado privado vindo do DNS: bloqueia", async () => {
    const resolver = fakeResolver({ "mapeado.example": ["::ffff:169.254.169.254"] });
    await assertRejects(resolveTarget(parseTargetUrl("https://mapeado.example/"), resolver, isPublicAddress, never), "blocked");
  });

  test("IPv4-mapeado público vira IPv4", async () => {
    const resolver = fakeResolver({ "mapeado.example": ["::ffff:8.8.8.8"] });
    const result = await resolveTarget(parseTargetUrl("https://mapeado.example/"), resolver, isPublicAddress, never);
    assert.deepEqual(result, { address: "8.8.8.8", family: 4 });
  });

  test("resposta que não é IP: bloqueia", async () => {
    const resolver = fakeResolver({ "lixo.example": ["não-é-ip"] });
    await assertRejects(resolveTarget(parseTargetUrl("https://lixo.example/"), resolver, isPublicAddress, never), "blocked");
  });

  test("IP literal não consulta o DNS", async () => {
    const resolver = fakeResolver({});
    const result = await resolveTarget(parseTargetUrl("http://8.8.8.8/"), resolver, isPublicAddress, never);
    assert.deepEqual(result, { address: "8.8.8.8", family: 4 });
    assert.equal(resolver.calls.length, 0);
  });

  for (const raw of [
    "http://127.0.0.1/",
    "http://2130706433/",
    "http://0177.0.0.1/",
    "http://0x7f.1/",
    "http://169.254.169.254/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
  ]) {
    test(`IP literal proibido ${raw}: bloqueia sem DNS`, async () => {
      const resolver = fakeResolver({});
      await assertRejects(resolveTarget(parseTargetUrl(raw), resolver, isPublicAddress, never), "blocked");
      assert.equal(resolver.calls.length, 0);
    });
  }

  test("nome que não resolve: falha de rede", async () => {
    await assertRejects(
      resolveTarget(parseTargetUrl("https://nao-existe.example/"), fakeResolver({}), isPublicAddress, never),
      "network",
    );
  });

  test("DNS lento: tempo esgotado", async () => {
    const resolver = () => new Promise<never>(() => {});
    await assertRejects(
      resolveTarget(parseTargetUrl("https://lento.example/"), resolver, isPublicAddress, AbortSignal.timeout(20)),
      "timeout",
    );
  });
});

// Cliente c-ares falso: cada família responde uma lista ou falha com um código de erro do DNS.
type Answer = readonly string[] | { code: string };
type FakeDns = { clients: number; cancelled: number; newClient: () => DnsClient };

function fakeDns(v4: Answer | "pendente", v6: Answer | "pendente"): FakeDns {
  const state: FakeDns = {
    clients: 0,
    cancelled: 0,
    newClient: () => {
      state.clients++;
      let cancel = (): void => {};
      const cancelled = new Promise<never>((_, reject) => {
        cancel = () => {
          state.cancelled++;
          reject(Object.assign(new Error("cancelado"), { code: "ECANCELLED" }));
        };
      });
      const answer = (value: Answer | "pendente"): Promise<string[]> => {
        if (value === "pendente") return cancelled;
        if ("code" in value) return Promise.reject(Object.assign(new Error(`falha ${value.code} 10.0.0.1`), value));
        return Promise.resolve([...value]);
      };
      return { resolve4: () => answer(v4), resolve6: () => answer(v6), cancel };
    },
  };
  return state;
}

const resolveWith = (dns: FakeDns, signal = never) =>
  resolveTarget(parseTargetUrl("https://site.example/"), createDnsResolver(dns.newClient), isPublicAddress, signal);

describe("resolvedor DNS (c-ares, resolve4 + resolve6)", () => {
  test("as duas famílias respondem: devolve as duas, cada uma com sua família", async () => {
    const resolver = createDnsResolver(fakeDns(["93.184.216.34"], ["2606:2800:220:1::1"]).newClient);
    assert.deepEqual(await resolver("site.example"), [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  test("IPv6 sem registro (ENODATA) e IPv4 respondendo: segue com o IPv4", async () => {
    assert.deepEqual(await resolveWith(fakeDns(["93.184.216.34"], { code: "ENODATA" })), { address: "93.184.216.34", family: 4 });
  });

  test("IPv4 sem registro (ENOTFOUND) e IPv6 respondendo: segue com o IPv6", async () => {
    assert.deepEqual(await resolveWith(fakeDns({ code: "ENOTFOUND" }, ["2606:2800:220:1::1"])), {
      address: "2606:2800:220:1::1",
      family: 6,
    });
  });

  test("nenhuma família tem registro: falha de rede", async () => {
    await assertRejects(resolveWith(fakeDns({ code: "ENOTFOUND" }, { code: "ENODATA" })), "network");
  });

  for (const code of ["ETIMEOUT", "ESERVFAIL", "ECONNREFUSED", "EREFUSED", "EBADRESP"]) {
    test(`uma família responde e a outra falha com ${code}: falha fechado`, async () => {
      await assertRejects(resolveWith(fakeDns(["93.184.216.34"], { code })), "network");
      await assertRejects(resolveWith(fakeDns({ code }, ["2606:2800:220:1::1"])), "network");
    });
  }

  test("IPv4 público e IPv6 privado: bloqueia (todos os IPs precisam ser permitidos)", async () => {
    await assertRejects(resolveWith(fakeDns(["93.184.216.34"], ["fd00::1"])), "blocked");
    await assertRejects(resolveWith(fakeDns(["10.0.0.5"], ["2606:2800:220:1::1"])), "blocked");
  });

  test("prazo esgotado cancela as consultas pendentes", async () => {
    const dns = fakeDns("pendente", "pendente");
    await assertRejects(resolveWith(dns, AbortSignal.timeout(20)), "timeout");
    assert.equal(dns.cancelled, 1);
  });

  test("um cliente novo por resolução (cancelar não afeta outras requisições)", async () => {
    const dns = fakeDns(["93.184.216.34"], { code: "ENODATA" });
    const resolver = createDnsResolver(dns.newClient);
    await resolver("a.example");
    await resolver("b.example");
    assert.equal(dns.clients, 2);
    assert.equal(dns.cancelled, 0);
  });

  test("produção não usa dns.lookup (getaddrinfo ocupa o threadpool do libuv)", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("./resolve.ts", import.meta.url), "utf8");
    assert.doesNotMatch(source, /\blookup\b/);
  });
});

describe("prazo próprio do DNS por salto", () => {
  test("resolvedor que nunca responde: timeout no prazo do salto, mesmo sem o prazo do download", { timeout: 5_000 }, async () => {
    const pending = () => new Promise<never>(() => {});
    const started = performance.now();
    await assertRejects(resolveTarget(parseTargetUrl("https://lento.example/"), pending, isPublicAddress, never, 200), "timeout");
    assert.ok(performance.now() - started < 1_000);
  });

  test("o prazo do salto cancela as consultas pendentes", { timeout: 5_000 }, async () => {
    const dns = fakeDns("pendente", "pendente");
    const resolver = createDnsResolver(dns.newClient);
    await assertRejects(resolveTarget(parseTargetUrl("https://site.example/"), resolver, isPublicAddress, never, 100), "timeout");
    assert.equal(dns.cancelled, 1);
  });

  test("padrões: 1 s por tentativa, 2 tentativas e prazo rígido de 3 s por salto", () => {
    assert.deepEqual(DNS_OPTIONS, { timeout: 1_000, tries: 2 });
    assert.equal(DEFAULT_LIMITS.dnsHopMs, 3_000);
  });
});

// c-ares de verdade (dns.promises.Resolver) contra um servidor DNS UDP local, sem internet.
const aresAt = (server: string) =>
  createDnsResolver(() => {
    const client = new AresResolver(DNS_OPTIONS);
    client.setServers([server]);
    return client;
  });

async function withDns<T>(records: DnsRecords | "mudo", run: (dns: FakeDnsServer) => Promise<T>): Promise<T> {
  const dns = await startFakeDnsServer(records);
  try {
    return await run(dns);
  } finally {
    await dns.close();
  }
}

describe("c-ares real contra servidor DNS local", () => {
  test("A respondido e AAAA sem registro (ENODATA): resolve pelo IPv4", async () => {
    await withDns({ "site.example": { A: ["93.184.216.34"] } }, async (dns) => {
      const result = await resolveTarget(parseTargetUrl("https://site.example/"), aresAt(dns.server), isPublicAddress, never);
      assert.deepEqual(result, { address: "93.184.216.34", family: 4 });
    });
  });

  test("A e AAAA respondidos: devolve as duas famílias", async () => {
    await withDns({ "site.example": { A: ["93.184.216.34"], AAAA: ["2606:2800:220:1::1"] } }, async (dns) => {
      assert.deepEqual(await aresAt(dns.server)("site.example"), [
        { address: "93.184.216.34", family: 4 },
        { address: "2606:2800:220:1::1", family: 6 },
      ]);
    });
  });

  test("AAAA privado ao lado de A público: bloqueia", async () => {
    await withDns({ "site.example": { A: ["93.184.216.34"], AAAA: ["fd00::1"] } }, async (dns) => {
      await assertRejects(resolveTarget(parseTargetUrl("https://site.example/"), aresAt(dns.server), isPublicAddress, never), "blocked");
    });
  });

  test("nome inexistente (NXDOMAIN nas duas famílias): network", async () => {
    await withDns({}, async (dns) => {
      await assertRejects(resolveTarget(parseTargetUrl("https://nao-existe.example/"), aresAt(dns.server), isPublicAddress, never), "network");
    });
  });

  test("servidor mudo: timeout dentro do prazo do salto (pior caso previsível)", { timeout: 15_000 }, async (t) => {
    await withDns("mudo", async (dns) => {
      const started = performance.now();
      await assertRejects(resolveTarget(parseTargetUrl("https://mudo.example/"), aresAt(dns.server), isPublicAddress, never), "timeout");
      const elapsed = performance.now() - started;
      t.diagnostic(`servidor mudo: ${Math.round(elapsed)} ms, ${dns.queries()} pacotes recebidos`);
      assert.ok(elapsed < DEFAULT_LIMITS.dnsHopMs + 500, `levou ${Math.round(elapsed)} ms`);
    });
  });
});

// Um resolvedor c-ares por consulta: se o canal não fechar o socket UDP ao terminar ou ao ser
// cancelado, os descritores crescem com a carga. /proc/self/fd só existe no Linux (o CI).
describe("c-ares não vaza descritores (só Linux)", { skip: process.platform !== "linux" && "usa /proc/self/fd" }, () => {
  const openDescriptors = async (): Promise<number> => {
    const { readdirSync } = await import("node:fs");
    await new Promise((resolve) => setTimeout(resolve, 200)); // deixa o c-ares fechar o que for fechar
    return readdirSync("/proc/self/fd").length;
  };

  test("300 resoluções respondidas não deixam sockets abertos", { timeout: 60_000 }, async (t) => {
    await withDns({ "site.example": { A: ["93.184.216.34"] } }, async (dns) => {
      const resolver = aresAt(dns.server);
      await resolver("site.example"); // aquece o que o Node inicializa uma vez só
      const before = await openDescriptors();
      for (let i = 0; i < 300; i++) await resolver("site.example");
      const after = await openDescriptors();
      t.diagnostic(`descritores: ${before} antes, ${after} depois`);
      assert.ok(after - before <= 5, `antes ${before}, depois ${after}`);
    });
  });

  test("100 resoluções canceladas pelo prazo do salto não deixam sockets abertos", { timeout: 60_000 }, async (t) => {
    await withDns("mudo", async (dns) => {
      const resolver = aresAt(dns.server);
      const target = parseTargetUrl("https://mudo.example/");
      await assertRejects(resolveTarget(target, resolver, isPublicAddress, never, 20), "timeout");
      const before = await openDescriptors();
      for (let i = 0; i < 100; i++) await assertRejects(resolveTarget(target, resolver, isPublicAddress, never, 20), "timeout");
      const after = await openDescriptors();
      t.diagnostic(`descritores: ${before} antes, ${after} depois`);
      assert.ok(after - before <= 5, `antes ${before}, depois ${after}`);
    });
  });
});
