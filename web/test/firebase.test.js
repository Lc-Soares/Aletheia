import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

const config = JSON.parse(readFileSync(new URL("../../firebase.json", import.meta.url), "utf8"));
const hosting = config.hosting;

/** Cabeçalhos da regra que vale para todas as rotas, em minúsculas. */
function globalHeaders() {
  const rule = hosting.headers.find((/** @type {{ source: string }} */ h) => h.source === "**");
  assert.ok(rule, "falta a regra de cabeçalhos para **");
  return new Map(rule.headers.map((/** @type {{ key: string, value: string }} */ h) => [h.key.toLowerCase(), h.value]));
}

function csp() {
  const raw = globalHeaders().get("content-security-policy");
  assert.equal(typeof raw, "string");
  return new Map(
    String(raw)
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter((tokens) => tokens[0])
      .map(([name, ...sources]) => [name, sources]),
  );
}

describe("firebase.json", () => {
  test("publica web/public", () => {
    assert.equal(hosting.public, "web/public");
  });

  test("encaminha /api/** para o serviço aletheia-api no Cloud Run", () => {
    const rewrite = hosting.rewrites.find((/** @type {{ source: string }} */ r) => r.source === "/api/**");
    assert.ok(rewrite);
    assert.equal(rewrite.run.serviceId, "aletheia-api");
    assert.ok(rewrite.run.region);
  });

  test("cabeçalhos de segurança exigidos", () => {
    const headers = globalHeaders();
    assert.match(String(headers.get("strict-transport-security")), /max-age=\d{7,}/);
    assert.equal(headers.get("x-content-type-options"), "nosniff");
    assert.ok(headers.get("referrer-policy"));
    assert.ok(headers.get("content-security-policy"));
  });

  test("CSP impede enquadramento e restringe base e formulários", () => {
    const policy = csp();
    assert.deepEqual(policy.get("frame-ancestors"), ["'none'"]);
    assert.deepEqual(policy.get("base-uri"), ["'none'"]);
    assert.deepEqual(policy.get("form-action"), ["'none'"]);
    assert.deepEqual(policy.get("default-src"), ["'none'"]);
  });

  test("CSP lista só as origens que o Google Identity Services exige", () => {
    const policy = csp();
    assert.deepEqual(policy.get("script-src"), ["'self'", "https://accounts.google.com/gsi/client"]);
    assert.deepEqual(policy.get("style-src"), ["'self'", "https://accounts.google.com/gsi/style"]);
    assert.deepEqual(policy.get("frame-src"), ["https://accounts.google.com/gsi/"]);
    assert.deepEqual(policy.get("connect-src"), ["'self'", "https://accounts.google.com/gsi/"]);
    assert.deepEqual(policy.get("img-src"), ["'self'"]);
  });

  test("CSP não afrouxa com unsafe-inline, unsafe-eval, data:, curinga ou http:", () => {
    const raw = String(globalHeaders().get("content-security-policy"));
    assert.doesNotMatch(raw, /unsafe-inline|unsafe-eval|unsafe-hashes|data:|http:(?!\/\/localhost)|\*/);
  });
});
