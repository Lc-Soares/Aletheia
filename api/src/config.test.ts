import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  test("lê GOOGLE_CLIENT_ID e PORT", () => {
    assert.deepEqual(loadConfig({ GOOGLE_CLIENT_ID: "abc", PORT: "8080" }), { googleClientId: "abc", port: 8080 });
  });

  test("erro nomeia GOOGLE_CLIENT_ID quando falta ou está vazia", () => {
    assert.throws(() => loadConfig({ PORT: "8080" }), /GOOGLE_CLIENT_ID/);
    assert.throws(() => loadConfig({ GOOGLE_CLIENT_ID: "  ", PORT: "8080" }), /GOOGLE_CLIENT_ID/);
  });

  test("erro nomeia PORT quando falta", () => {
    assert.throws(() => loadConfig({ GOOGLE_CLIENT_ID: "abc" }), /PORT/);
  });

  for (const port of ["0", "65536", "-1", "80.5", "abc", "8080x"]) {
    test(`recusa PORT inválida: ${port}`, () => {
      assert.throws(() => loadConfig({ GOOGLE_CLIENT_ID: "abc", PORT: port }), /PORT/);
    });
  }

  test("o erro não repete o valor recebido", () => {
    assert.throws(
      () => loadConfig({ GOOGLE_CLIENT_ID: "abc", PORT: "segredo-123" }),
      (error: unknown) => error instanceof Error && !error.message.includes("segredo-123"),
    );
  });
});
