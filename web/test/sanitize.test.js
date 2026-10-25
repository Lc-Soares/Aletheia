import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { sanitizeText } from "../public/sanitize.js";

describe("sanitizeText", () => {
  test("texto comum passa sem mudança", () => {
    assert.equal(sanitizeText("Prefeitura anuncia obra", 100), "Prefeitura anuncia obra");
  });

  test("não é texto: null", () => {
    for (const value of [undefined, null, 42, true, {}, [], ["a"]]) assert.equal(sanitizeText(value, 10), null);
  });

  test("vazio, só espaços ou só caracteres removidos: null", () => {
    for (const value of ["", "   ", "\u202e\u200b", "\u0000\u0007"]) assert.equal(sanitizeText(value, 10), null);
  });

  test("remove controles C0, DEL e C1", () => {
    assert.equal(sanitizeText("a\u0000b\u0007c\u001bd\u007fe\u0085f\u009fg", 50), "abcdefg");
  });

  test("quebras de linha, tab e separadores U+2028/U+2029 viram um espaço só", () => {
    assert.equal(sanitizeText("a\r\nb\tc\u2028d\u2029e   f", 50), "a b c d e f");
  });

  test("remove caracteres de formato: U+202E (inverte o texto), U+200B, U+FEFF e isolados bidi", () => {
    assert.equal(sanitizeText("abc\u202edef\u200bg\ufeffh\u2066i\u2069", 50), "abcdefghi");
  });

  test("remove surrogates soltos e mantém emoji inteiro", () => {
    assert.equal(sanitizeText("a\ud800b\udc00c\u{1f600}", 50), "abc\u{1f600}");
  });

  test("limita o tamanho por ponto de código e marca o corte com reticências", () => {
    const text = sanitizeText("a".repeat(500), 10);
    assert.equal(text, `${"a".repeat(9)}…`);
    assert.equal(sanitizeText("\u{1f600}".repeat(20), 5), `${"\u{1f600}".repeat(4)}…`);
  });

  test("texto no limite exato não é cortado", () => {
    assert.equal(sanitizeText("abcde", 5), "abcde");
  });

  test("texto enorme é cortado sem varrer o resto inteiro", () => {
    assert.equal(sanitizeText("x".repeat(5_000_000), 20)?.length, 20);
  });

  test("HTML continua sendo texto: nada é removido nem interpretado", () => {
    const hostile = '<img src=x onerror="alert(1)"><script>x</script>"><svg onload=1>';
    assert.equal(sanitizeText(hostile, 200), hostile);
  });
});
