import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { expiryOf, formatExpiry } from "../public/token-info.js";

/** @param {unknown} payload */
const b64url = (payload) => Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload)).toString("base64url");
/** @param {unknown} payload */
const jwt = (payload) => `${b64url({ alg: "RS256" })}.${b64url(payload)}.assinatura`;

describe("expiryOf (exp do payload, sem verificar assinatura)", () => {
  test("exp numérico vira Date", () => {
    assert.deepEqual(expiryOf(jwt({ exp: 2_000_000_000, email: "a@b.c" })), new Date(2_000_000_000 * 1000));
  });

  /** @type {Array<[string, unknown]>} */
  const unreadable = [
    ["null", null],
    ["número", 42],
    ["vazio", ""],
    ["sem pontos", "nao-e-um-token"],
    ["duas partes", `${b64url({})}.${b64url({ exp: 1 })}`],
    ["base64 inválido", "a.!!!@@@.c"],
    ["JSON inválido", `a.${b64url("{exp:")}.c`],
    ["payload não é objeto", `a.${b64url("[1,2]")}.c`],
    ["exp ausente", jwt({ sub: "1" })],
    ["exp texto", jwt({ exp: "2000000000" })],
    ["exp não finito", `a.${b64url('{"exp":1e999}')}.c`],
    ["exp negativo", jwt({ exp: -1 })],
    ["token gigante", jwt({ exp: 2_000_000_000, x: "a".repeat(10_000) })],
  ];
  for (const [name, token] of unreadable) {
    test(`${name}: null, sem exceção`, () => {
      assert.equal(expiryOf(/** @type {string} */ (token)), null);
    });
  }
});

describe("formatExpiry", () => {
  test("hora e minuto, sem mais nada do token", () => {
    assert.match(formatExpiry(new Date(2_000_000_000 * 1000)), /^\d{2}:\d{2}$/);
  });
});
