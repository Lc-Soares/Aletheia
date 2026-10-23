import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, test, type TestContext } from "node:test";

import type { CallerVerifier } from "./auth.ts";
import { createWorkerExtractor } from "./extract-pool.ts";
import { fetchPage, type PageDeps } from "./fetch-page.ts";
import { isPublicAddress } from "./ip-policy.ts";
import { resolveLimits } from "./limits.ts";
import { createFetcherServer, shutdown } from "./server.ts";
import { fakeResolver, formattingBomb, html, orphanEndTags, routeTransport, srcsetCommas } from "./testing.ts";

// Páginas da revisão de segurança da Fase 3 (achados 1, 2 e 3), de ponta a ponta pelo serviço.
// Prazos generosos: o que se testa é "erro controlado em segundos", não "minutos ou queda".

const GOOD_TOKEN = "good.token.value";
const verifier: CallerVerifier = async (token) => {
  if (token === GOOD_TOKEN) return { email: "api@projeto.iam.gserviceaccount.com" };
  throw new Error("token inválido");
};

type Started = { base: string; close: () => Promise<void> };

async function startWithPage(body: string): Promise<Started> {
  const transport = routeTransport({ "https://noticias.example/": html(body) });
  const limits = resolveLimits();
  const deps: PageDeps = {
    resolver: fakeResolver({ "noticias.example": ["93.184.216.34"] }),
    transport,
    policy: isPublicAddress,
    limits,
    extract: createWorkerExtractor(limits),
  };
  const server = createFetcherServer({ verifier, fetchPage: (url, signal) => fetchPage(url, deps, signal), log: () => {} });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => shutdown(server, 500) };
}

const postFetch = (base: string) =>
  fetch(`${base}/fetch`, {
    method: "POST",
    headers: { Authorization: `Bearer ${GOOD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://noticias.example/" }),
  });

type Observed = { status: number; error: unknown; elapsedMs: number; maxTimerLagMs: number; slowestHealthzMs: number };

// Faz o POST hostil e, enquanto ele roda, mede o atraso de um timer e o tempo de /healthz.
async function attack(body: string): Promise<Observed> {
  const s = await startWithPage(body);
  let maxTimerLagMs = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxTimerLagMs = Math.max(maxTimerLagMs, now - last - 20);
    last = now;
  }, 20);
  let done = false;
  let slowestHealthzMs = 0;
  const probe = (async () => {
    while (!done) {
      const started = performance.now();
      const res = await fetch(`${s.base}/healthz`);
      assert.equal(res.status, 200);
      await res.body?.cancel();
      slowestHealthzMs = Math.max(slowestHealthzMs, performance.now() - started);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  try {
    const started = performance.now();
    const res = await postFetch(s.base);
    const text = await res.text();
    const elapsedMs = performance.now() - started;
    const error = res.status === 422 ? (JSON.parse(text) as { error: unknown }).error : null;
    return { status: res.status, error, elapsedMs, maxTimerLagMs, slowestHealthzMs };
  } finally {
    done = true;
    await probe;
    clearInterval(timer);
    await s.close();
  }
}

function assertResponsive(observed: Observed, t: TestContext): void {
  const ms = (value: number) => Math.round(value);
  t.diagnostic(`resposta ${ms(observed.elapsedMs)} ms, timer +${ms(observed.maxTimerLagMs)} ms, /healthz ${ms(observed.slowestHealthzMs)} ms`);
  assert.ok(observed.elapsedMs < 15_000, `resposta em ${Math.round(observed.elapsedMs)} ms`);
  assert.ok(observed.maxTimerLagMs < 1_000, `timer atrasou ${Math.round(observed.maxTimerLagMs)} ms`);
  assert.ok(observed.slowestHealthzMs < 1_000, `/healthz levou ${Math.round(observed.slowestHealthzMs)} ms`);
}

describe("HTML hostil de ponta a ponta (revisão da Fase 3)", () => {
  test("achado 1: explosão de memória do parse5 vira too_large, e a instância segue respondendo", { timeout: 60_000 }, async (t) => {
    const page = formattingBomb(3000);
    assert.ok(page.length < 64 * 1024);
    const observed = await attack(page);
    assert.deepEqual([observed.status, observed.error], [422, "too_large"]);
    assertResponsive(observed, t);
  });

  test("achado 2: CPU quadrática do parse5 vira timeout, e a instância segue respondendo", { timeout: 60_000 }, async (t) => {
    const observed = await attack(orphanEndTags(60_000)); // 600 KB
    assert.deepEqual([observed.status, observed.error], [422, "timeout"]);
    assertResponsive(observed, t);
  });

  test("achado 3: srcset com vírgulas termina dentro do prazo, e a instância segue respondendo", { timeout: 60_000 }, async (t) => {
    const observed = await attack(srcsetCommas());
    assert.equal(observed.status, 200);
    assertResponsive(observed, t);
  });
});
