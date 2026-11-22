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

  test("tetos de JSON-LD (ClaimReview): valores padrão, só reduzíveis", () => {
    assert.deepEqual(
      [DEFAULT_LIMITS.maxJsonLdBlocks, DEFAULT_LIMITS.maxJsonLdBlockChars, DEFAULT_LIMITS.maxJsonLdNodes, DEFAULT_LIMITS.maxJsonLdDepth, DEFAULT_LIMITS.maxClaimReviews],
      [20, 256 * 1024, 2_000, 16, 5],
    );
    const raised = resolveLimits({ maxJsonLdBlocks: 1e6, maxJsonLdBlockChars: 1e9, maxJsonLdNodes: 1e9, maxJsonLdDepth: 1e4, maxClaimReviews: 1e3 });
    assert.deepEqual(raised, DEFAULT_LIMITS);
    assert.equal(resolveLimits({ maxJsonLdDepth: 4 }).maxJsonLdDepth, 4);
    assert.equal(resolveLimits({ maxClaimReviews: 0 }).maxClaimReviews, DEFAULT_LIMITS.maxClaimReviews);
  });

  test("os padrões são imutáveis", () => {
    assert.throws(() => {
      (DEFAULT_LIMITS as { maxRedirects: number }).maxRedirects = 50;
    });
  });
});
