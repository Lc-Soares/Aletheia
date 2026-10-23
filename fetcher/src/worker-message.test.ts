import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FetchError } from "./errors.ts";
import { validateWorkerPage } from "./worker-message.ts";

const LIMITS = { maxMediaRefs: 2, maxUrlLength: 40, maxSelectedMedia: 2 };
const ref = (overrides: Record<string, unknown> = {}) => ({
  url: "https://cdn.example/a.jpg",
  kind: "image",
  source: "img",
  group: 1,
  score: 0,
  selected: true,
  skipReason: null,
  ...overrides,
});
const page = (overrides: Record<string, unknown> = {}) => ({
  title: "Título",
  headline: null,
  media: [ref()],
  possiblyNeedsJavaScript: false,
  ...overrides,
});
// Mídia de outro grupo, e variante do grupo 1.
const other = (overrides: Record<string, unknown> = {}) => ref({ url: "https://cdn.example/b.jpg", group: 2, ...overrides });
const variant = (overrides: Record<string, unknown> = {}) =>
  ref({ url: "https://cdn.example/a-2x.jpg", source: "img-srcset", selected: false, skipReason: "variant", ...overrides });

function assertNetwork(message: unknown): void {
  assert.throws(
    () => validateWorkerPage(message, LIMITS),
    (error: unknown) => error instanceof FetchError && error.category === "network",
  );
}

describe("validateWorkerPage", () => {
  test("mensagem válida volta igual, em objeto novo", () => {
    const message = page({ headline: "Manchete", media: [ref(), other({ url: "http://x.example/v.mp4", kind: "video", source: "og:video" })] });
    const result = validateWorkerPage(message, LIMITS);
    assert.deepEqual(result, message);
    assert.notEqual(result, message);
    assert.notEqual(result.media[0], message.media[0]);
  });

  test("limites exatos passam (300 caracteres, maxMediaRefs itens, maxUrlLength)", () => {
    const url = `https://x.example/${"a".repeat(40 - "https://x.example/".length)}`;
    assert.equal(url.length, 40);
    validateWorkerPage(page({ title: "t".repeat(300), headline: "h".repeat(300), media: [ref({ url }), other()] }), LIMITS);
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
    // Forma normalizada (terceira revisão, achado 2): o worker legítimo sempre envia url.href.
    ["url com espaços, quebra de linha, <script> e tab", page({ media: [ref({ url: " https://a.example/x\n<script>.jpg\t" })] })],
    ["url com esquema e host em maiúsculas e porta padrão", page({ media: [ref({ url: "HTTP://A.example:443/x" })] })],
    ["url com espaço no caminho", page({ media: [ref({ url: "https://a.example/a b.jpg" })] })],
    ["title com surrogate alto solto", page({ title: `${"a".repeat(10)}\uD83D` })],
    ["headline com surrogate baixo solto", page({ headline: "\uDE00manchete" })],
    // Campos da seleção de mídias.
    ["possiblyNeedsJavaScript ausente", { title: null, headline: null, media: [] }],
    ["possiblyNeedsJavaScript texto", page({ media: [], possiblyNeedsJavaScript: "true" })],
    ["possiblyNeedsJavaScript número", page({ media: [], possiblyNeedsJavaScript: 1 })],
    ["possiblyNeedsJavaScript true com mídia", page({ possiblyNeedsJavaScript: true })],
    ["item sem score", page({ media: [{ url: "https://cdn.example/a.jpg", kind: "image", source: "img", group: 1, selected: true, skipReason: null }] })],
    ["item no formato antigo (sem group, score, selected, skipReason)", page({ media: [{ url: "https://cdn.example/a.jpg", kind: "image", source: "img" }] })],
    ["score fracionário", page({ media: [ref({ score: 1.5 })] })],
    ["score acima de 1000", page({ media: [ref({ score: 1001 })] })],
    ["score abaixo de -1000", page({ media: [ref({ score: -1001 })] })],
    ["score texto", page({ media: [ref({ score: "10" })] })],
    ["score NaN", page({ media: [ref({ score: Number.NaN })] })],
    ["group zero", page({ media: [ref({ group: 0 })] })],
    ["group acima do número de itens", page({ media: [ref({ group: 2 })] })],
    ["group fracionário", page({ media: [ref({ group: 1.5 })] })],
    ["group texto", page({ media: [ref({ group: "1" })] })],
    ["selected texto", page({ media: [ref({ selected: "true" })] })],
    ["selecionada com motivo", page({ media: [ref({ skipReason: "limit" })] })],
    ["ignorada sem motivo", page({ media: [ref({ selected: false })] })],
    ["motivo desconhecido", page({ media: [ref({ selected: false, skipReason: "error" })] })],
    ["motivo com HTML", page({ media: [ref({ selected: false, skipReason: "<script>" })] })],
    ["dois representantes no mesmo grupo", page({ media: [ref(), other({ group: 1 })] })],
    ["grupo só com variantes", page({ media: [variant()] })],
    ["tipos misturados no grupo", page({ media: [ref(), variant({ kind: "video", source: "video" })] })],
    ["pontuações diferentes no grupo", page({ media: [ref(), variant({ score: 5 })] })],
  ];

  test("grupo com representante e variante passa; todos os motivos conhecidos passam", () => {
    for (const reason of ["icon", "unsupported_format", "limit", "other"]) {
      const media = [ref({ selected: false, skipReason: reason }), variant()];
      assert.deepEqual(validateWorkerPage(page({ media }), LIMITS).media, media);
    }
  });

  test("pontuação nos extremos da faixa passa", () => {
    for (const score of [-1000, 1000]) validateWorkerPage(page({ media: [ref({ score })] }), LIMITS);
  });

  test("sinal de JavaScript sem mídia passa", () => {
    assert.equal(validateWorkerPage(page({ media: [], possiblyNeedsJavaScript: true }), LIMITS).possiblyNeedsJavaScript, true);
  });

  test("selecionadas acima de maxSelectedMedia: FetchError network", () => {
    const message = page({ media: [ref(), other()] });
    validateWorkerPage(message, LIMITS);
    assert.throws(
      () => validateWorkerPage(message, { ...LIMITS, maxSelectedMedia: 1 }),
      (error: unknown) => error instanceof FetchError && error.category === "network",
    );
  });

  test("userinfo e porta não padrão na forma normalizada passam (o download as bloqueia)", () => {
    const url = "http://u:p@10.0.0.1:22/x";
    assert.equal(new URL(url).href, url);
    assert.equal(validateWorkerPage(page({ media: [ref({ url })] }), LIMITS).media[0]?.url, url);
  });

  test("texto com par surrogate completo passa", () => {
    assert.equal(validateWorkerPage(page({ title: "notícia 😀" }), LIMITS).title, "notícia 😀");
  });
  for (const [name, message] of malformed) {
    test(`${name}: FetchError network`, () => assertNetwork(message));
  }
});
