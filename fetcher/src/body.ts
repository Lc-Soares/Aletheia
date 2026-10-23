import { pipeline, type Readable, Transform } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { FetchError, toFetchError } from "./errors.ts";

// Orçamento compartilhado entre downloads (limite agregado de mídia por página).
export type ByteBudget = { remaining: number };

function createDecoder(contentEncoding: string | undefined): Transform | null {
  const encoding = (contentEncoding ?? "").trim().toLowerCase();
  if (encoding === "" || encoding === "identity") return null;
  if (encoding === "gzip" || encoding === "x-gzip") return createGunzip();
  if (encoding === "deflate") return createInflate();
  if (encoding === "br") return createBrotliDecompress();
  throw new FetchError("unsupported_type"); // inclui listas ("gzip, br") e codificações desconhecidas
}

// Conta os bytes que chegam pela rede, antes de descompactar.
function wireLimiter(maxBytes: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      if (total > maxBytes) return callback(new FetchError("too_large"));
      callback(null, chunk);
    },
  });
}

// Lê o corpo inteiro para a memória, abortando no primeiro chunk que passar do limite
// (antes e depois de descompactar). Nunca grava em disco.
export async function readLimited(
  body: Readable,
  contentEncoding: string | undefined,
  maxBytes: number,
  signal: AbortSignal,
  budget?: ByteBudget,
): Promise<Buffer> {
  let decoder: Transform | null;
  try {
    decoder = createDecoder(contentEncoding);
  } catch (error) {
    body.destroy();
    throw error;
  }
  const stages: (Readable | Transform)[] = [body, wireLimiter(maxBytes), ...(decoder ? [decoder] : [])];
  const output = (pipeline as (...streams: unknown[]) => Readable)(...stages, () => {});
  const onAbort = (): void => {
    output.destroy(new FetchError("timeout"));
  };
  signal.addEventListener("abort", onAbort, { once: true });

  const chunks: Buffer[] = [];
  let total = 0;
  try {
    if (signal.aborted) throw new FetchError("timeout");
    for await (const chunk of output) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (budget) budget.remaining -= buffer.length;
      if (total > maxBytes || (budget !== undefined && budget.remaining < 0)) throw new FetchError("too_large");
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (budget) budget.remaining += total; // devolve o que não vai ser usado
    chunks.length = 0;
    throw toFetchError(error, signal);
  } finally {
    signal.removeEventListener("abort", onAbort);
    output.destroy();
    body.destroy();
  }
}
