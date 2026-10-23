import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FetchError, type FetchErrorCategory } from "./errors.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { resolveTarget } from "./resolve.ts";
import { fakeResolver } from "./testing.ts";
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
