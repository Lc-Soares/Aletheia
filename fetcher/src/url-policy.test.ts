import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FetchError, type FetchErrorCategory } from "./errors.ts";
import { parseTargetUrl } from "./url-policy.ts";

function assertRejects(raw: string, category: FetchErrorCategory, base?: string): void {
  assert.throws(
    () => parseTargetUrl(raw, base),
    (error: unknown) => error instanceof FetchError && error.category === category,
  );
}

describe("parseTargetUrl: esquemas", () => {
  for (const raw of [
    "file:///etc/passwd",
    "ftp://example.com/x",
    "gopher://example.com:70/_x",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "ws://example.com/",
    "blob:https://example.com/uuid",
    "dict://example.com:11211/",
  ]) {
    test(`recusa ${raw.slice(0, 30)}`, () => assertRejects(raw, "blocked"));
  }
});

describe("parseTargetUrl: portas", () => {
  for (const raw of ["http://example.com:8080/", "https://example.com:22/", "http://example.com:0/", "http://example.com:6379/"]) {
    test(`recusa ${raw}`, () => assertRejects(raw, "blocked"));
  }
  for (const raw of ["http://example.com/", "https://example.com/", "http://example.com:443/", "https://example.com:443/"]) {
    test(`aceita ${raw}`, () => assert.ok(parseTargetUrl(raw)));
  }
  test("porta padrão vira número", () => {
    assert.equal(parseTargetUrl("http://example.com/").port, 80);
    assert.equal(parseTargetUrl("https://example.com/").port, 443);
    assert.equal(parseTargetUrl("http://example.com:443/").port, 443);
  });
});

describe("parseTargetUrl: credenciais na URL", () => {
  for (const raw of ["http://user:pass@example.com/", "http://user@example.com/", "https://:senha@example.com/"]) {
    test(`recusa ${raw}`, () => assertRejects(raw, "blocked"));
  }
});

describe("parseTargetUrl: hostname", () => {
  for (const raw of ["http://", "http://a..b/", "http://.example.com/", "http://example.com../"]) {
    test(`recusa ${JSON.stringify(raw)}`, () => assertRejects(raw, "invalid_url"));
  }
  for (const raw of [
    "http://intranet/",
    "http:///x", // o WHATWG lê como host "x"
    "http://metadata/",
    "http://localhost/",
    "http://localhost./",
    "http://LOCALHOST/",
    "http://app.localhost/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata.google.internal./",
    "http://impressora.local/",
    "http://roteador.home.arpa/",
  ]) {
    test(`recusa nome interno ${raw}`, () => assertRejects(raw, "blocked"));
  }
  test("aceita IP literal sem ponto no sentido de nome (8.8.8.8)", () => {
    const target = parseTargetUrl("http://8.8.8.8/");
    assert.equal(target.hostname, "8.8.8.8");
    assert.equal(target.ipVersion, 4);
  });
  test("tira o ponto final do hostname", () => {
    assert.equal(parseTargetUrl("https://example.com./a").hostname, "example.com");
  });
  test("converte nome internacional para punycode", () => {
    assert.equal(parseTargetUrl("https://bücher.example/").hostname, "xn--bcher-kva.example");
  });
});

describe("parseTargetUrl: formatos exóticos de IP são normalizados (e bloqueados depois pelo IP)", () => {
  for (const [raw, expected] of [
    ["http://2130706433/", "127.0.0.1"],
    ["http://0177.0.0.1/", "127.0.0.1"],
    ["http://0x7f.1/", "127.0.0.1"],
    ["http://0x7f000001/", "127.0.0.1"],
    ["http://127.1/", "127.0.0.1"],
    ["http://169.254.43518/", "169.254.169.254"],
    ["http://0251.0376.0251.0376/", "169.254.169.254"],
  ] as const) {
    test(`${raw} vira ${expected}`, () => {
      const target = parseTargetUrl(raw);
      assert.equal(target.hostname, expected);
      assert.equal(target.ipVersion, 4);
    });
  }
  for (const [raw, expected] of [
    ["http://[::1]/", "::1"],
    ["http://[::ffff:127.0.0.1]/", "::ffff:7f00:1"],
    ["http://[0:0:0:0:0:ffff:7f00:1]/", "::ffff:7f00:1"],
    ["http://[fe80::1]/", "fe80::1"],
  ] as const) {
    test(`${raw} vira IPv6 sem colchetes`, () => {
      const target = parseTargetUrl(raw);
      assert.equal(target.hostname, expected);
      assert.equal(target.ipVersion, 6);
    });
  }
  for (const raw of ["http://1.2.3.4.5/", "http://0x100000000/", "http://[fe80::1%25eth0]/", "http://[::1/"]) {
    test(`recusa ${raw}`, () => assertRejects(raw, "invalid_url"));
  }
});

describe("parseTargetUrl: diversos", () => {
  test("recusa URL longa demais", () => {
    assertRejects(`https://example.com/${"a".repeat(2100)}`, "invalid_url");
  });
  test("recusa texto que não é URL", () => assertRejects("não é url", "invalid_url"));
  test("recusa URL relativa sem base", () => assertRejects("/foto.jpg", "invalid_url"));
  test("resolve relativa pela base", () => {
    const target = parseTargetUrl("../img/a.jpg", "https://example.com/noticias/x/");
    assert.equal(target.url.href, "https://example.com/noticias/img/a.jpg");
  });
  test("relativa não herda esquema perigoso da base", () => {
    assertRejects("//127.0.0.1:8080/", "blocked", "https://example.com/");
  });
  test("descarta o fragmento", () => {
    assert.equal(parseTargetUrl("https://example.com/a#segredo").url.href, "https://example.com/a");
  });
  test("cabeçalho Host usa o hostname e a porta explícita", () => {
    assert.equal(parseTargetUrl("https://example.com./a").hostHeader, "example.com");
    assert.equal(parseTargetUrl("http://example.com:443/a").hostHeader, "example.com:443");
    assert.equal(parseTargetUrl("http://[2001:4860:4860::8888]/").hostHeader, "[2001:4860:4860::8888]");
  });
  test("a mensagem de erro não contém a URL", () => {
    try {
      parseTargetUrl("http://segredo.internal/");
      assert.fail("deveria ter lançado");
    } catch (error) {
      assert.ok(error instanceof FetchError);
      assert.doesNotMatch(error.message, /segredo/);
    }
  });
});
