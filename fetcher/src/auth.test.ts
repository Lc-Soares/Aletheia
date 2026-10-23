import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { type CallerVerifier, createCallerVerifier, extractBearerToken } from "./auth.ts";
import {
  generateTestKeys,
  OfflineOAuth2Client,
  signToken,
  TEST_AUDIENCE,
  TEST_CALLER_EMAIL,
  type TestKeys,
  validClaims,
} from "./testing.ts";

describe("extractBearerToken", () => {
  test("aceita Bearer com token de três partes", () => assert.equal(extractBearerToken("Bearer a.b.c"), "a.b.c"));
  for (const header of [undefined, "", "Bearer", "Basic a.b.c", "a.b.c", "Bearer a.b", `Bearer ${"a".repeat(5000)}.b.c`, "Bearer a.b.c\r\nX: 1"]) {
    test(`recusa ${JSON.stringify(header)?.slice(0, 30)}`, () => assert.equal(extractBearerToken(header), null));
  }
});

describe("createCallerVerifier", () => {
  let keys: TestKeys;
  let otherKeys: TestKeys;
  let verify: CallerVerifier;

  before(() => {
    keys = generateTestKeys();
    otherKeys = generateTestKeys();
    verify = createCallerVerifier(TEST_AUDIENCE, TEST_CALLER_EMAIL, new OfflineOAuth2Client(keys.publicPem));
  });

  test("aceita o token da conta de serviço da API", async () => {
    assert.deepEqual(await verify(signToken(validClaims(), keys)), { email: TEST_CALLER_EMAIL });
  });

  test("compara o e-mail sem diferenciar maiúsculas", async () => {
    const token = signToken(validClaims({ email: TEST_CALLER_EMAIL.toUpperCase() }), keys);
    assert.ok(await verify(token));
  });

  const rejected: Array<[string, () => string]> = [
    ["token ausente/malformado", () => "abc.def.ghi"],
    ["assinatura de outra chave", () => signToken(validClaims(), otherKeys)],
    ["aud errada (outro serviço)", () => signToken(validClaims({ aud: "https://outro.a.run.app" }), keys)],
    ["aud do cliente OAuth do front", () => signToken(validClaims({ aud: "123.apps.googleusercontent.com" }), keys)],
    ["aud ausente", () => signToken(validClaims({ aud: undefined }), keys)],
    ["iss errado", () => signToken(validClaims({ iss: "https://evil.example" }), keys)],
    ["token expirado", () => signToken(validClaims({ iat: 1_000_000, exp: Math.floor(Date.now() / 1000) - 3600 }), keys)],
    ["outra conta de serviço", () => signToken(validClaims({ email: "outra@projeto.iam.gserviceaccount.com" }), keys)],
    ["usuário comum com e-mail verificado", () => signToken(validClaims({ email: "pessoa@gmail.com" }), keys)],
    ["email_verified falso", () => signToken(validClaims({ email_verified: false }), keys)],
    ["email_verified ausente", () => signToken(validClaims({ email_verified: undefined }), keys)],
    ["e-mail ausente", () => signToken(validClaims({ email: undefined }), keys)],
    ["alg none", () => signToken(validClaims(), keys, "none")],
    ["HS256 com a chave pública como segredo", () => signToken(validClaims(), keys, "hs256-public-key")],
  ];

  for (const [name, build] of rejected) {
    test(`recusa: ${name}`, async () => {
      await assert.rejects(verify(build()));
    });
  }

  test("a mensagem de erro não contém o token nem o e-mail", async () => {
    const token = signToken(validClaims({ email: "outra@projeto.iam.gserviceaccount.com" }), keys);
    await assert.rejects(verify(token), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("outra@"), false);
      return true;
    });
  });
});
