import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadConfig } from "./config.ts";

const BASE = {
  GOOGLE_CLIENT_ID: "abc",
  PORT: "8080",
  FETCHER_URL: "https://fetcher-xyz.a.run.app",
  FETCHER_AUDIENCE: "https://fetcher-xyz.a.run.app",
};

describe("loadConfig", () => {
  test("lê todas as variáveis", () => {
    assert.deepEqual(loadConfig(BASE), {
      googleClientId: "abc",
      port: 8080,
      fetcherUrl: "https://fetcher-xyz.a.run.app/",
      fetcherAudience: "https://fetcher-xyz.a.run.app",
    });
  });

  test("erro nomeia GOOGLE_CLIENT_ID quando falta ou está vazia", () => {
    assert.throws(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: undefined }), /GOOGLE_CLIENT_ID/);
    assert.throws(() => loadConfig({ ...BASE, GOOGLE_CLIENT_ID: "  " }), /GOOGLE_CLIENT_ID/);
  });

  test("erro nomeia PORT quando falta", () => {
    assert.throws(() => loadConfig({ ...BASE, PORT: undefined }), /PORT/);
  });

  for (const port of ["0", "65536", "-1", "80.5", "abc", "8080x"]) {
    test(`recusa PORT inválida: ${port}`, () => {
      assert.throws(() => loadConfig({ ...BASE, PORT: port }), /PORT/);
    });
  }

  for (const name of ["FETCHER_URL", "FETCHER_AUDIENCE"]) {
    test(`erro nomeia ${name} quando falta ou está vazia`, () => {
      assert.throws(() => loadConfig({ ...BASE, [name]: undefined }), new RegExp(name));
      assert.throws(() => loadConfig({ ...BASE, [name]: " " }), new RegExp(name));
    });

    for (const value of [
      "http://fetcher-xyz.a.run.app",
      "ftp://localhost:8081",
      "http://127.0.0.1:8081",
      "http://localhost.evil.example",
      "https://usuario:senha@fetcher-xyz.a.run.app",
      "nao-e-url",
    ]) {
      test(`${name}: recusa ${value}`, () => {
        assert.throws(() => loadConfig({ ...BASE, [name]: value }), new RegExp(name));
      });
    }

    test(`${name}: aceita http://localhost só para desenvolvimento local`, () => {
      assert.doesNotThrow(() => loadConfig({ ...BASE, [name]: "http://localhost:8081" }));
    });
  }

  test("FETCHER_URL não aceita query nem fragmento", () => {
    assert.throws(() => loadConfig({ ...BASE, FETCHER_URL: "https://fetcher-xyz.a.run.app/?x=1" }), /FETCHER_URL/);
    assert.throws(() => loadConfig({ ...BASE, FETCHER_URL: "https://fetcher-xyz.a.run.app/#x" }), /FETCHER_URL/);
  });

  test("o erro não repete o valor recebido", () => {
    for (const env of [
      { ...BASE, PORT: "segredo-123" },
      { ...BASE, FETCHER_URL: "http://segredo-123.example" },
      { ...BASE, FETCHER_AUDIENCE: "segredo-123" },
    ]) {
      assert.throws(
        () => loadConfig(env),
        (error: unknown) => error instanceof Error && !error.message.includes("segredo-123"),
      );
    }
  });
});
