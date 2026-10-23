import assert from "node:assert/strict";
import { getDefaultHighWaterMark, Readable } from "node:stream";
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

  // O que se lê além do limite é constante (buffers dos streams), não proporcional ao corpo.
  // Teto derivado de readLimited (fonte -> wireLimiter), com hwm = getDefaultHighWaterMark(false):
  //   chunk que cruza o limite (o wireLimiter conta e falha)   1 chunk
  //   buffer de leitura da fonte (Readable)                     até hwm + 1 chunk
  //   buffer de escrita do wireLimiter (Transform)              até hwm + 1 chunk
  //   chunk em trânsito no pipe                                 1 chunk
  // Total: limite + 2 × hwm + 4 × chunk. No CI (Linux, hwm 16 KiB, chunk 16 KiB) foram
  // limite + 80 KiB; no Windows, limite + 32 KiB. A diferença é só a ordem dos eventos.
  for (const bodySize of [10 * MIB, 50 * MIB]) {
    const data = Buffer.alloc(bodySize);
    for (const chunk of [1 * KIB, 16 * KIB, 64 * KIB]) {
      test(`corpo de ${bodySize / MIB} MiB acima do limite, chunk de ${chunk / KIB} KiB: lê no máximo limite + buffers`, async (t) => {
        const limit = 1 * MIB;
        const ceiling = limit + 2 * getDefaultHighWaterMark(false) + 4 * chunk;
        const stream = countingStream(data, chunk);
        await assertRejects(readLimited(stream, undefined, limit, never), "too_large");
        const excess = stream.pulled() - limit;
        t.diagnostic(`puxou ${stream.pulled()} bytes = limite + ${excess / KIB} KiB (teto: limite + ${(ceiling - limit) / KIB} KiB)`);
        assert.ok(stream.pulled() <= ceiling, `puxou ${stream.pulled()} bytes; teto ${ceiling}`);
        assert.ok(stream.destroyed);
      });
    }
  }

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
