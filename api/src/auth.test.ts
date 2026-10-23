import assert from "node:assert/strict";
import { before, describe, test } from "node:test";

import { createGoogleVerifier, extractBearerToken, type TokenVerifier } from "./auth.ts";
import {
  generateTestKeys,
  OfflineOAuth2Client,
  signToken,
  TEST_CLIENT_ID,
  validClaims,
  type TestKeys,
} from "./testing.ts";

describe("extractBearerToken", () => {
  const jwtLike = "aaa.bbb.ccc";

  test("aceita Bearer com token de três partes", () => {
    assert.equal(extractBearerToken(`Bearer ${jwtLike}`), jwtLike);
  });

  test("aceita assinatura vazia (alg none) para que o verificador a recuse", () => {
    assert.equal(extractBearerToken("Bearer aaa.bbb."), "aaa.bbb.");
  });

  for (const header of [
    undefined,
    "",
    "Bearer",
    "Bearer ",
    `Basic ${jwtLike}`,
    jwtLike,
    `Bearer  ${jwtLike}`,
    `Bearer ${jwtLike} extra`,
    "Bearer sem-pontos",
    "Bearer a.b",
    "Bearer a.b.c.d",
    `Bearer ${"a".repeat(5000)}.b.c`,
    "Bearer a.b.c\r\nX-Injected: 1",
  ]) {
    test(`recusa formato inválido: ${JSON.stringify(header)?.slice(0, 40)}`, () => {
      assert.equal(extractBearerToken(header), null);
    });
  }
});

describe("createGoogleVerifier", () => {
  let keys: TestKeys;
  let otherKeys: TestKeys;
  let verify: TokenVerifier;

  before(() => {
    keys = generateTestKeys();
    otherKeys = generateTestKeys();
    verify = createGoogleVerifier(TEST_CLIENT_ID, new OfflineOAuth2Client(keys.publicPem));
  });

  test("aceita token válido e devolve só o e-mail", async () => {
    const result = await verify(signToken(validClaims(), { keys }));
    assert.deepEqual(result, { email: "pessoa@example.com" });
  });

  test("aceita iss sem esquema (accounts.google.com)", async () => {
    const token = signToken(validClaims({ iss: "accounts.google.com" }), { keys });
    assert.deepEqual(await verify(token), { email: "pessoa@example.com" });
  });

  const rejected: Array<[string, () => string]> = [
    ["token malformado (não é JWT)", () => "abc.def.ghi"],
    ["cabeçalho que não é JSON", () => `${Buffer.from("x").toString("base64url")}.e30.c2ln`],
    ["assinatura de outra chave", () => signToken(validClaims(), { keys: otherKeys })],
    [
      "payload adulterado após assinar",
      () => {
        const [h, , s] = signToken(validClaims(), { keys }).split(".");
        const forged = Buffer.from(JSON.stringify(validClaims({ email: "outra@example.com" }))).toString("base64url");
        return `${h}.${forged}.${s}`;
      },
    ],
    ["aud errada", () => signToken(validClaims({ aud: "outro-cliente" }), { keys })],
    ["aud ausente", () => signToken(validClaims({ aud: undefined }), { keys })],
    ["iss errado", () => signToken(validClaims({ iss: "https://evil.example" }), { keys })],
    ["iss do universo googleapis.com", () => signToken(validClaims({ iss: "googleapis.com" }), { keys })],
    [
      "token expirado",
      () => signToken(validClaims({ iat: 1_000_000, exp: Math.floor(Date.now() / 1000) - 3600 }), { keys }),
    ],
    ["email_verified falso", () => signToken(validClaims({ email_verified: false }), { keys })],
    ["email_verified como string", () => signToken(validClaims({ email_verified: "true" }), { keys })],
    ["email_verified ausente", () => signToken(validClaims({ email_verified: undefined }), { keys })],
    ["e-mail ausente", () => signToken(validClaims({ email: undefined }), { keys })],
    ["e-mail que não é string", () => signToken(validClaims({ email: 42 }), { keys })],
    ["alg none", () => signToken(validClaims(), { keys, mode: "none" })],
    ["HS256 com a chave pública como segredo", () => signToken(validClaims(), { keys, mode: "hs256-public-key" })],
    ["kid desconhecido", () => signToken(validClaims(), { keys, header: { kid: "outro" } })],
    ["alg declarado diferente de RS256", () => signToken(validClaims(), { keys, header: { alg: "ES256" } })],
  ];

  for (const [name, build] of rejected) {
    test(`recusa: ${name}`, async () => {
      await assert.rejects(verify(build()));
    });
  }

  test("a mensagem de erro não contém o token", async () => {
    const token = signToken(validClaims({ aud: "outro" }), { keys });
    await assert.rejects(verify(token), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes(token), false);
      assert.equal(error.message.includes("pessoa@example.com"), false);
      return true;
    });
  });
});
