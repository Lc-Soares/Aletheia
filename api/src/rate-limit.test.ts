import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { RateLimiter, userKey } from "./rate-limit.ts";

const HOUR = 3_600_000;

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return { now: () => current, advance: (ms) => (current += ms) };
}

describe("RateLimiter (janela deslizante por usuário)", () => {
  test("permite até o limite dentro da janela", () => {
    const limiter = new RateLimiter({ windowMs: HOUR, now: clock().now });
    for (let i = 0; i < 10; i++) assert.equal(limiter.consume("a", 10).allowed, true, `checagem ${i + 1}`);
  });

  test("estourou: recusa com Retry-After até a mais antiga sair da janela", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, now: time.now });
    limiter.consume("a", 10);
    time.advance(10 * 60_000);
    for (let i = 0; i < 9; i++) limiter.consume("a", 10);
    const result = limiter.consume("a", 10);
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason === "limit");
    assert.ok(!result.allowed && result.retryAfterSeconds === 50 * 60, "a primeira sai da janela em 50 min");
  });

  test("Retry-After nunca é menor que 1 s", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, now: time.now });
    limiter.consume("a", 1);
    time.advance(HOUR - 1);
    const result = limiter.consume("a", 1);
    assert.ok(!result.allowed && result.retryAfterSeconds === 1);
  });

  test("a janela expira e libera de novo", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, now: time.now });
    for (let i = 0; i < 10; i++) limiter.consume("a", 10);
    assert.equal(limiter.consume("a", 10).allowed, false);
    time.advance(HOUR);
    assert.equal(limiter.consume("a", 10).allowed, true);
  });

  test("usuários são independentes", () => {
    const limiter = new RateLimiter({ windowMs: HOUR, now: clock().now });
    for (let i = 0; i < 10; i++) limiter.consume("a", 10);
    assert.equal(limiter.consume("a", 10).allowed, false);
    assert.equal(limiter.consume("b", 10).allowed, true);
  });

  test("recusa não consome vaga", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, now: time.now });
    limiter.consume("a", 1);
    for (let i = 0; i < 5; i++) limiter.consume("a", 1);
    time.advance(HOUR);
    assert.equal(limiter.consume("a", 1).allowed, true);
  });

  test("release devolve a vaga uma única vez", () => {
    const limiter = new RateLimiter({ windowMs: HOUR, now: clock().now });
    const first = limiter.consume("a", 1);
    assert.ok(first.allowed);
    if (first.allowed) {
      first.release();
      first.release();
    }
    assert.equal(limiter.consume("a", 1).allowed, true);
    assert.equal(limiter.consume("a", 1).allowed, false, "o segundo release não pode liberar outra vaga");
  });

  test("memória limpa: chaves expiradas são removidas na varredura", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, sweepIntervalMs: 60_000, now: time.now });
    for (let i = 0; i < 100; i++) limiter.consume(`u${i}`, 10);
    assert.equal(limiter.trackedKeys, 100);
    time.advance(HOUR + 60_000);
    limiter.consume("novo", 10);
    assert.equal(limiter.trackedKeys, 1);
  });

  test("release da última vaga remove a chave", () => {
    const limiter = new RateLimiter({ windowMs: HOUR, now: clock().now });
    const result = limiter.consume("a", 10);
    if (result.allowed) result.release();
    assert.equal(limiter.trackedKeys, 0);
  });

  test("teto de chaves: cheio e sem nada expirado, recusa chave nova (falha fechada)", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, maxKeys: 3, now: time.now });
    for (const key of ["a", "b", "c"]) limiter.consume(key, 10);
    const result = limiter.consume("d", 10);
    assert.equal(result.allowed, false);
    assert.ok(!result.allowed && result.reason === "full" && result.retryAfterSeconds > 0);
    assert.equal(limiter.consume("a", 10).allowed, true, "quem já está no mapa continua sendo atendido");
    assert.equal(limiter.trackedKeys, 3);
  });

  test("teto de chaves: libera espaço quando as chaves expiram", () => {
    const time = clock();
    const limiter = new RateLimiter({ windowMs: HOUR, maxKeys: 3, now: time.now });
    for (const key of ["a", "b", "c"]) limiter.consume(key, 10);
    time.advance(HOUR);
    assert.equal(limiter.consume("d", 10).allowed, true);
    assert.equal(limiter.trackedKeys, 1);
  });
});

describe("userKey", () => {
  test("é estável, não contém o sub e distingue usuários", () => {
    const key = userKey("1234567890");
    assert.equal(key, userKey("1234567890"));
    assert.notEqual(key, userKey("1234567891"));
    assert.equal(key.includes("1234567890"), false);
    assert.match(key, /^[0-9a-f]{64}$/);
  });
});
