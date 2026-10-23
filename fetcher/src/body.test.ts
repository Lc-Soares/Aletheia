import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { describe, test } from "node:test";
import { brotliCompressSync, constants, deflateSync, gzipSync } from "node:zlib";

import { readLimited } from "./body.ts";
import { FetchError, type FetchErrorCategory } from "./errors.ts";

const never = new AbortController().signal;
const KIB = 1024;
const MIB = 1024 * KIB;

async function assertRejects(promise: Promise<unknown>, category: FetchErrorCategory): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FetchError && error.category === category);
}

// Stream que conta quanto foi efetivamente puxado da "rede".
function countingStream(data: Buffer, chunkSize = 16 * KIB): Readable & { pulled: () => number } {
  let offset = 0;
  const stream = new Readable({
    read() {
      if (offset >= data.length) return this.push(null);
      this.push(data.subarray(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
  return Object.assign(stream, { pulled: () => Math.min(offset, data.length) });
}

describe("readLimited", () => {
  test("lê corpo sem codificação", async () => {
    const body = await readLimited(Readable.from([Buffer.from("olá")]), undefined, 1 * KIB, never);
    assert.equal(body.toString("utf8"), "olá");
  });

  for (const [name, encode] of [
    ["gzip", gzipSync],
    ["x-gzip", gzipSync],
    ["deflate", deflateSync],
    ["br", brotliCompressSync],
  ] as const) {
    test(`descompacta ${name}`, async () => {
      const original = Buffer.from("conteúdo ".repeat(1000));
      const body = await readLimited(Readable.from([encode(original)]), name, 1 * MIB, never);
      assert.deepEqual(body, original);
    });
  }

  test("corpo acima do limite: aborta sem ler tudo", async () => {
    const stream = countingStream(Buffer.alloc(10 * MIB));
    await assertRejects(readLimited(stream, undefined, 1 * MIB, never), "too_large");
    assert.ok(stream.pulled() <= 1 * MIB + 64 * KIB, `puxou ${stream.pulled()} bytes`);
    assert.ok(stream.destroyed);
  });

  test("bomba gzip: aborta logo depois do limite descompactado", async () => {
    const bomb = gzipSync(Buffer.alloc(200 * MIB)); // ~200 KiB compactados
    assert.ok(bomb.length < 1 * MIB);
    const stream = countingStream(bomb);
    const used = process.memoryUsage().arrayBuffers;
    await assertRejects(readLimited(stream, "gzip", 2 * MIB, never), "too_large");
    assert.ok(stream.pulled() < bomb.length, "não leu a bomba inteira");
    assert.ok(process.memoryUsage().arrayBuffers - used < 50 * MIB, "não expandiu na memória");
  });

  test("bomba brotli: aborta logo depois do limite descompactado", async () => {
    // 200 MiB viram ~300 bytes: a bomba cabe num chunk só, então o que se mede é a memória.
    const bomb = brotliCompressSync(Buffer.alloc(200 * MIB), { params: { [constants.BROTLI_PARAM_QUALITY]: 4 } });
    assert.ok(bomb.length < 4 * KIB);
    const used = process.memoryUsage().arrayBuffers;
    await assertRejects(readLimited(countingStream(bomb, 1 * KIB), "br", 2 * MIB, never), "too_large");
    assert.ok(process.memoryUsage().arrayBuffers - used < 50 * MIB, "não expandiu na memória");
  });

  test("dados compactados acima do limite também contam", async () => {
    const random = Buffer.from(Array.from({ length: 3 * MIB }, (_, i) => (i * 2654435761) % 251));
    await assertRejects(readLimited(Readable.from([gzipSync(random)]), "gzip", 1 * MIB, never), "too_large");
  });

  for (const encoding of ["zstd", "gzip, br", "compress", "x-desconhecida"]) {
    test(`codificação não suportada: ${encoding}`, async () => {
      await assertRejects(readLimited(Readable.from([Buffer.from("x")]), encoding, 1 * KIB, never), "unsupported_type");
    });
  }

  test("gzip corrompido: falha de rede genérica", async () => {
    await assertRejects(readLimited(Readable.from([Buffer.from("não é gzip")]), "gzip", 1 * KIB, never), "network");
  });

  test("corpo lento: tempo esgotado pelo sinal", async () => {
    const slow = new Readable({ read() {} }); // nunca termina
    await assertRejects(readLimited(slow, undefined, 1 * KIB, AbortSignal.timeout(50)), "timeout");
    assert.ok(slow.destroyed);
  });

  test("orçamento agregado é respeitado e devolvido em caso de falha", async () => {
    const budget = { remaining: 100 };
    const first = await readLimited(Readable.from([Buffer.alloc(60)]), undefined, 1 * KIB, never, budget);
    assert.equal(first.length, 60);
    assert.equal(budget.remaining, 40);
    await assertRejects(readLimited(Readable.from([Buffer.alloc(50)]), undefined, 1 * KIB, never, budget), "too_large");
    assert.equal(budget.remaining, 40);
  });
});
