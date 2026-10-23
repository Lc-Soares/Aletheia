import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { loadConfig } from "./config.ts";

const VALID = {
  PORT: "8080",
  FETCHER_AUDIENCE: "https://fetcher-abc-rj.a.run.app",
  API_SERVICE_ACCOUNT_EMAIL: "api@projeto.iam.gserviceaccount.com",
};

describe("loadConfig", () => {
  test("lê as três variáveis", () => {
    assert.deepEqual(loadConfig(VALID), {
      port: 8080,
      audience: "https://fetcher-abc-rj.a.run.app",
      callerEmail: "api@projeto.iam.gserviceaccount.com",
    });
  });

  test("aceita localhost em http para desenvolvimento", () => {
    assert.equal(loadConfig({ ...VALID, FETCHER_AUDIENCE: "http://localhost:8081" }).audience, "http://localhost:8081");
  });

  for (const name of Object.keys(VALID)) {
    test(`exige ${name}`, () => {
      assert.throws(() => loadConfig({ ...VALID, [name]: undefined }), new RegExp(name));
      assert.throws(() => loadConfig({ ...VALID, [name]: "  " }), new RegExp(name));
    });
  }

  for (const [name, value] of [
    ["PORT", "0"],
    ["PORT", "70000"],
    ["PORT", "80a"],
    ["FETCHER_AUDIENCE", "não é url"],
    ["FETCHER_AUDIENCE", "http://fetcher.example"],
    ["API_SERVICE_ACCOUNT_EMAIL", "sem-arroba"],
  ] as const) {
    test(`recusa ${name}=${value}`, () => {
      assert.throws(() => loadConfig({ ...VALID, [name]: value }), new RegExp(name));
    });
  }

  test("não existe variável que desligue proteção", () => {
    const config = loadConfig({ ...VALID, ALLOW_PRIVATE: "1", SSRF_DISABLED: "true", DEBUG: "1" });
    assert.deepEqual(Object.keys(config).sort(), ["audience", "callerEmail", "port"]);
  });
});
