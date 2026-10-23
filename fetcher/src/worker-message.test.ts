import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FetchError } from "./errors.ts";
import { validateWorkerPage } from "./worker-message.ts";

const LIMITS = { maxMediaRefs: 2, maxUrlLength: 40 };
const ref = (overrides: Record<string, unknown> = {}) => ({ url: "https://cdn.example/a.jpg", kind: "image", source: "img", ...overrides });
const page = (overrides: Record<string, unknown> = {}) => ({ title: "Título", headline: null, media: [ref()], ...overrides });

function assertNetwork(message: unknown): void {
  assert.throws(
    () => validateWorkerPage(message, LIMITS),
    (error: unknown) => error instanceof FetchError && error.category === "network",
  );
}

describe("validateWorkerPage", () => {
  test("mensagem válida volta igual, em objeto novo", () => {
    const message = page({ headline: "Manchete", media: [ref(), ref({ url: "http://x.example/v.mp4", kind: "video", source: "og:video" })] });
    const result = validateWorkerPage(message, LIMITS);
    assert.deepEqual(result, message);
    assert.notEqual(result, message);
    assert.notEqual(result.media[0], message.media[0]);
  });

  test("limites exatos passam (300 caracteres, maxMediaRefs itens, maxUrlLength)", () => {
    const url = `https://x.example/${"a".repeat(40 - "https://x.example/".length)}`;
    assert.equal(url.length, 40);
    validateWorkerPage(page({ title: "t".repeat(300), headline: "h".repeat(300), media: [ref({ url }), ref()] }), LIMITS);
  });

  const malformed: [string, unknown][] = [
    ["null", null],
    ["undefined", undefined],
    ["texto", "página"],
    ["número", 42],
    ["array", [page()]],
    ["chave a mais", { ...page(), extra: 1 }],
    ["chave faltando", { title: null, headline: null }],
    ["title número", page({ title: 1 })],
    ["title acima de 300", page({ title: "t".repeat(301) })],
    ["headline objeto", page({ headline: { toString: "x" } })],
    ["headline acima de 300", page({ headline: "h".repeat(301) })],
    ["media não é array", page({ media: { length: 0 } })],
    ["media acima de maxMediaRefs", page({ media: [ref(), ref(), ref()] })],
    ["media esparso", page({ media: new Array(1) })],
    ["item null", page({ media: [null] })],
    ["item com chave a mais", page({ media: [{ ...ref(), html: "<script>" }] })],
    ["url número", page({ media: [ref({ url: 1 })] })],
    ["url acima de maxUrlLength", page({ media: [ref({ url: `https://x.example/${"a".repeat(40)}` })] })],
    ["url javascript:", page({ media: [ref({ url: "javascript:alert(1)" })] })],
    ["url data:", page({ media: [ref({ url: "data:image/png;base64,AA" })] })],
    ["url inválida", page({ media: [ref({ url: "http://[::1" })] })],
    ["kind desconhecido", page({ media: [ref({ kind: "audio" })] })],
    ["source desconhecido", page({ media: [ref({ source: "iframe" })] })],
  ];
  for (const [name, message] of malformed) {
    test(`${name}: FetchError network`, () => assertNetwork(message));
  }
});
