// Fixture do runner (test-support/run-tests.js): um teste que passa. Fora de qualquer glob de workspace.
import assert from "node:assert/strict";
import { test } from "node:test";

test("passa", () => {
  assert.equal(1 + 1, 2);
});
