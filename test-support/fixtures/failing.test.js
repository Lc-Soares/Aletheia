// Fixture do runner: falha DE PROPÓSITO, para provar que o runner não esconde falha de teste.
// Só é executada pelos testes do runner (fetcher/src/test-guard.test.ts), nunca pelo npm run test.
import assert from "node:assert/strict";
import { test } from "node:test";

test("falha de propósito", () => {
  assert.equal(1 + 1, 3);
});
