import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { PLANS, resolvePlan } from "./plans.ts";

describe("planos", () => {
  test("o plano gratuito tem 10 verificações por hora e até 8 mídias por verificação", () => {
    assert.deepEqual(PLANS.free, { checksPerHour: 10, maxMediaPerCheck: 8 });
  });

  test("a tabela não pode ser alterada em tempo de execução", () => {
    assert.ok(Object.isFrozen(PLANS));
    assert.ok(Object.isFrozen(PLANS.free));
  });

  test("resolvePlan devolve sempre o plano gratuito", () => {
    assert.equal(resolvePlan({ sub: "1" }), "free");
    assert.equal(resolvePlan({ sub: "outra-conta" }), "free");
  });
});
