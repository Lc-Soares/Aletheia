import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_LIMITS, resolveLimits } from "./limits.ts";

describe("resolveLimits", () => {
  test("sem argumentos devolve os padrões", () => {
    assert.deepEqual(resolveLimits(), DEFAULT_LIMITS);
  });

  test("aceita valores menores", () => {
    const limits = resolveLimits({ maxHtmlBytes: 1024, maxRedirects: 1 });
    assert.equal(limits.maxHtmlBytes, 1024);
    assert.equal(limits.maxRedirects, 1);
  });

  test("nunca aumenta um limite", () => {
    const limits = resolveLimits({ maxHtmlBytes: 1e12, maxRedirects: 100, pageTotalMs: 1e9 });
    assert.equal(limits.maxHtmlBytes, DEFAULT_LIMITS.maxHtmlBytes);
    assert.equal(limits.maxRedirects, DEFAULT_LIMITS.maxRedirects);
    assert.equal(limits.pageTotalMs, DEFAULT_LIMITS.pageTotalMs);
  });

  for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    test(`valor inválido (${value}) não desliga o limite`, () => {
      assert.equal(resolveLimits({ maxMediaBytes: value }).maxMediaBytes, DEFAULT_LIMITS.maxMediaBytes);
    });
  }

  test("os padrões são imutáveis", () => {
    assert.throws(() => {
      (DEFAULT_LIMITS as { maxRedirects: number }).maxRedirects = 50;
    });
  });
});
