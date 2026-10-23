import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isPublicAddress } from "./ip-policy.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { createProductionDeps } from "./production-deps.ts";
import { systemResolver } from "./resolve.ts";

describe("createProductionDeps", () => {
  test("usa sempre a política pública, os limites padrão e o DNS do sistema", () => {
    const deps = createProductionDeps();
    assert.equal(deps.policy, isPublicAddress);
    assert.equal(deps.resolver, systemResolver);
    assert.deepEqual(deps.limits, DEFAULT_LIMITS);
    assert.notEqual(deps.limits, DEFAULT_LIMITS, "cópia: ninguém altera o objeto congelado");
    assert.equal(typeof deps.transport, "function");
    assert.equal(deps.extract.active, 0, "criar as dependências não sobe worker");
  });

  test("não aceita parâmetros: não há como afrouxar nada", () => {
    assert.equal(createProductionDeps.length, 0);
  });
});
