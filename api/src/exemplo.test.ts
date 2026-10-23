import assert from "node:assert/strict";
import { test } from "node:test";

import { name } from "./index.ts";

test("o workspace api exporta o próprio nome", () => {
  assert.equal(name, "api");
});
