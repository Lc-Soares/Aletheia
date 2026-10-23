import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { describe, test } from "node:test";

import { FetchError, type FetchErrorCategory, withDeadline } from "./errors.ts";
import { collectUnhandledRejections } from "./testing.ts";

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

// Promessa controlada de fora, para forçar a ordem dos eventos.
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (error: Error) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("withDeadline: nenhuma ordem de eventos deixa rejeição sem tratamento", () => {
  test("a promessa vence e o sinal aborta depois: sem rejeição solta e sem listener sobrando", async () => {
    const controller = new AbortController();
    const seen = await collectUnhandledRejections(async () => {
      assert.equal(await withDeadline(Promise.resolve("ok"), controller.signal), "ok");
      controller.abort();
    });
    assert.deepEqual(seen, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("a promessa rejeita primeiro: o erro dela passa, e o abort depois não gera nada", async () => {
    const controller = new AbortController();
    const seen = await collectUnhandledRejections(async () => {
      await assertRejects(withDeadline(Promise.reject(new FetchError("blocked")), controller.signal), "blocked");
      controller.abort();
    });
    assert.deepEqual(seen, []);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  });

  test("o sinal vence e a promessa original rejeita depois: timeout, sem rejeição solta", async () => {
    const controller = new AbortController();
    const original = deferred<never>();
    const seen = await collectUnhandledRejections(async () => {
      const pending = withDeadline(original.promise, controller.signal);
      controller.abort();
      await assertRejects(pending, "timeout");
      original.reject(new Error("chegou tarde"));
    });
    assert.deepEqual(seen, []);
  });

  test("o sinal vence e a promessa original resolve depois: timeout", async () => {
    const controller = new AbortController();
    const original = deferred<string>();
    const seen = await collectUnhandledRejections(async () => {
      const pending = withDeadline(original.promise, controller.signal);
      controller.abort();
      await assertRejects(pending, "timeout");
      original.resolve("tarde demais");
    });
    assert.deepEqual(seen, []);
  });

  test("sinal já abortado na entrada: timeout sem esperar a promessa", async () => {
    const seen = await collectUnhandledRejections(async () => {
      await assertRejects(withDeadline(new Promise<never>(() => {}), AbortSignal.abort()), "timeout");
    });
    assert.deepEqual(seen, []);
  });
});

describe("FetchError: httpStatus", () => {
  test("upstream_status guarda o código HTTP, e a mensagem continua genérica", () => {
    const error = new FetchError("upstream_status", 403);
    assert.equal(error.httpStatus, 403);
    assert.equal(error.message, "O site respondeu com erro");
  });

  test("outras categorias nunca carregam código", () => {
    for (const category of ["blocked", "network", "timeout", "unsupported_type"] as const) {
      assert.equal(new FetchError(category, 403).httpStatus, undefined);
      assert.equal(Object.hasOwn(new FetchError(category, 403), "httpStatus"), false);
    }
  });

  test("código fora de 100..599 ou não inteiro é descartado", () => {
    for (const status of [0, 99, 600, 1.5, Number.NaN, -404]) {
      assert.equal(new FetchError("upstream_status", status).httpStatus, undefined, String(status));
    }
    assert.equal(new FetchError("upstream_status").httpStatus, undefined);
  });
});

describe("collectUnhandledRejections", () => {
  // Fora do test runner: sob o node:test a rejeição deliberada reprovaria este próprio teste.
  test("detecta uma rejeição sem tratamento deliberada", () => {
    const helper = new URL("./testing.ts", import.meta.url).href;
    const script = `import { collectUnhandledRejections } from ${JSON.stringify(helper)};
      const seen = await collectUnhandledRejections(async () => { void Promise.reject(new Error("deliberada")); });
      console.log(JSON.stringify(seen.map((e) => e.message)));`;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), JSON.stringify(["deliberada"]));
  });
});
