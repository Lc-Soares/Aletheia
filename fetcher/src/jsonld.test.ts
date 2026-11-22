import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractPage } from "./extract.ts";
import { exceedsDepth, readClaimReviews } from "./jsonld.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import { ldScript, OFFICIAL_CLAIMREVIEW, OFFICIAL_CLAIMREVIEW_LEGACY, OFFICIAL_CLAIMREVIEW_MARK } from "./testing.ts";

const PAGE = "https://checagem.example/materia";
const reviews = (htmlText: string) => extractPage(htmlText, PAGE).claimReviews;
const official = (): Record<string, unknown> => JSON.parse(OFFICIAL_CLAIMREVIEW) as Record<string, unknown>;
const mark = (overrides: Record<string, unknown> = {}) => ({ ...OFFICIAL_CLAIMREVIEW_MARK, ...overrides });
const EMPTY_MARK = {
  claimReviewed: null,
  ratingLabel: null,
  ratingValue: null,
  bestRating: null,
  worstRating: null,
  url: null,
  authorName: null,
  datePublished: null,
};
// ClaimReview mínimo com a afirmação dada (marcações distintas para os testes de teto).
const minimal = (claim: string) => JSON.stringify({ "@type": "ClaimReview", claimReviewed: claim });

describe("ClaimReview: exemplos da página oficial", () => {
  test("exemplo principal: campos esperados, nada de itemReviewed nem publisher", () => {
    const found = reviews(`<html><head>${ldScript(OFFICIAL_CLAIMREVIEW)}</head><body></body></html>`);
    assert.deepEqual(found, [OFFICIAL_CLAIMREVIEW_MARK]);
    const text = JSON.stringify(found);
    for (const absent of ["Square World Society", "T. Tellar", "Skeptical News", "flatworlders", "a122121", "logo.jpg", "2024-06-20"]) {
      assert.equal(text.includes(absent), false, `não deveria sair: ${absent}`);
    }
  });

  test("exemplo de compatibilidade: datePublished da raiz é a data da checagem", () => {
    assert.deepEqual(reviews(ldScript(OFFICIAL_CLAIMREVIEW_LEGACY)), [mark({ datePublished: "2024-06-22" })]);
  });

  test("não muda título, manchete nem mídias", () => {
    const htmlText = `<title>T</title><meta property="og:image" content="/capa.jpg">${ldScript(OFFICIAL_CLAIMREVIEW)}<h1>M</h1>`;
    const page = extractPage(htmlText, PAGE);
    assert.equal(page.title, "T");
    assert.equal(page.headline, "M");
    assert.deepEqual(page.media.map((m) => m.url), ["https://checagem.example/capa.jpg"]);
  });
});

describe("ClaimReview: formas aceitas", () => {
  test("página sem JSON-LD: lista vazia", () => {
    assert.deepEqual(reviews("<title>Sem marcação</title><p>texto</p>"), []);
  });

  test("JSON inválido: lista vazia, e o resto da extração intacto", () => {
    const page = extractPage(`<title>T</title>${ldScript('{"@type": "ClaimReview", ')}<img src="/a.jpg">`, PAGE);
    assert.deepEqual(page.claimReviews, []);
    assert.equal(page.title, "T");
    assert.equal(page.media.length, 1);
  });

  test("vários blocos, um inválido no meio", () => {
    const found = reviews(`${ldScript('{"@type":"NewsArticle"}')}${ldScript("{invalido")}${ldScript(OFFICIAL_CLAIMREVIEW)}`);
    assert.deepEqual(found, [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("@graph (como array e como objeto)", () => {
    const graph = JSON.stringify({ "@context": "https://schema.org", "@graph": [{ "@type": "WebPage" }, official()] });
    assert.deepEqual(reviews(ldScript(graph)), [OFFICIAL_CLAIMREVIEW_MARK]);
    assert.deepEqual(reviews(ldScript(JSON.stringify({ "@graph": official() }))), [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("ClaimReview dentro de array na raiz", () => {
    assert.deepEqual(reviews(ldScript(JSON.stringify([{ "@type": "Organization" }, official()]))), [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("ClaimReview aninhado em outro objeto (mainEntity, review)", () => {
    const page = JSON.stringify({ "@type": "WebPage", mainEntity: official() });
    const article = JSON.stringify({ "@type": "NewsArticle", review: [{ "@type": "Review" }, official()] });
    assert.deepEqual(reviews(ldScript(page)), [OFFICIAL_CLAIMREVIEW_MARK]);
    assert.deepEqual(reviews(ldScript(article)), [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("@type em lista e como IRI do schema.org", () => {
    for (const type of [["ClaimReview", "Review"], "https://schema.org/ClaimReview", "http://schema.org/ClaimReview"]) {
      assert.deepEqual(reviews(ldScript(JSON.stringify({ ...official(), "@type": type }))), [OFFICIAL_CLAIMREVIEW_MARK], JSON.stringify(type));
    }
  });

  test("@type parecido não conta (maiúsculas, prefixo, outro tipo)", () => {
    for (const type of ["claimreview", "ClaimReviews", "schema:ClaimReview", "Review", 42, null, { "@id": "ClaimReview" }]) {
      assert.deepEqual(reviews(ldScript(JSON.stringify({ ...official(), "@type": type }))), [], JSON.stringify(type));
    }
  });

  test("@context não é exigido", () => {
    const { "@context": _context, ...rest } = official();
    assert.deepEqual(reviews(ldScript(JSON.stringify(rest))), [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("bloco que não é objeto nem array é ignorado", () => {
    for (const json of ['"ClaimReview"', "42", "null", "true"]) assert.deepEqual(reviews(ldScript(json)), [], json);
  });

  test("type do script com espaços e maiúsculas é aceito; outros types não", () => {
    assert.deepEqual(reviews(ldScript(OFFICIAL_CLAIMREVIEW, "  Application/LD+JSON ")), [OFFICIAL_CLAIMREVIEW_MARK]);
    for (const type of ["text/javascript", "application/json", "application/ld+json+x"]) {
      assert.deepEqual(reviews(ldScript(OFFICIAL_CLAIMREVIEW, type)), [], type);
    }
    assert.deepEqual(reviews(`<script>${OFFICIAL_CLAIMREVIEW}</script>`), []);
  });
});

describe("ClaimReview: campos", () => {
  test("campos faltando viram null (a marcação continua listada)", () => {
    assert.deepEqual(reviews(ldScript('{"@type":"ClaimReview"}')), [EMPTY_MARK]);
  });

  test("números só quando são number finito", () => {
    const json = OFFICIAL_CLAIMREVIEW.replace('"ratingValue": 1', '"ratingValue": "1"').replace('"bestRating": 5', '"bestRating": 1e999');
    assert.deepEqual(reviews(ldScript(json)), [mark({ ratingValue: null, bestRating: null })]);
  });

  test("sem alternateName, o rótulo vem de reviewRating.name; com os dois, vale alternateName", () => {
    const rating = (r: Record<string, unknown>) => JSON.stringify({ "@type": "ClaimReview", reviewRating: r });
    assert.equal(reviews(ldScript(rating({ name: "Falso" })))[0]?.ratingLabel, "Falso");
    assert.equal(reviews(ldScript(rating({ name: "Nome", alternateName: "Alternativo" })))[0]?.ratingLabel, "Alternativo");
  });

  test("reviewRating em array: usa o primeiro objeto", () => {
    const json = JSON.stringify({ "@type": "ClaimReview", reviewRating: ["x", { alternateName: "Enganoso", ratingValue: 2 }, { alternateName: "Outro" }] });
    assert.deepEqual(reviews(ldScript(json)), [{ ...EMPTY_MARK, ratingLabel: "Enganoso", ratingValue: 2 }]);
  });

  test("author como texto simples, objeto ou array", () => {
    const author = (value: unknown) => reviews(ldScript(JSON.stringify({ "@type": "ClaimReview", author: value })))[0]?.authorName;
    assert.equal(author("Lupa"), "Lupa");
    assert.equal(author("  Lupa \n\t Checagem  "), "Lupa Checagem");
    assert.equal(author({ "@type": "Organization", name: "Aos Fatos" }), "Aos Fatos");
    assert.equal(author([{ "@type": "Person" }, { name: "Primeiro com nome" }, { name: "Segundo" }]), "Primeiro com nome");
    assert.equal(author(["Texto na lista"]), "Texto na lista");
    for (const value of [42, null, { url: "https://x.example/" }, [], "   "]) assert.equal(author(value), null, JSON.stringify(value));
  });

  test("url da checagem: só http(s) absoluta, sem usuário e senha, normalizada", () => {
    const url = (value: unknown) => reviews(ldScript(JSON.stringify({ "@type": "ClaimReview", url: value })))[0]?.url;
    assert.equal(url(" HTTPS://Checagem.Example/a b "), "https://checagem.example/a%20b");
    assert.equal(url("http://checagem.example"), "http://checagem.example/");
    for (const value of ["/relativa", "checagem.example/x", "javascript:alert(1)", "data:text/html,x", "ftp://x.example/", "https://u:p@x.example/", 42, `https://x.example/${"a".repeat(2048)}`]) {
      assert.equal(url(value), null, String(value).slice(0, 40));
    }
  });

  test("textos: espaços colapsados; cortados em 300 (data em 64) e bem formados", () => {
    const emoji = "😀";
    const json = JSON.stringify({
      "@type": "ClaimReview",
      claimReviewed: `${"a".repeat(299)}${emoji}${"b".repeat(5000)}`,
      reviewRating: { alternateName: `  Falso \n\n demais ` },
      datePublished: "2".repeat(200),
    });
    const [found] = reviews(ldScript(json));
    assert.ok(found?.claimReviewed);
    assert.equal(found.claimReviewed.length, 300);
    assert.ok(found.claimReviewed.isWellFormed());
    assert.equal(found.ratingLabel, "Falso demais");
    assert.equal(found.datePublished?.length, 64);
  });

  test("HTML e script no texto continuam texto (quem exibe escapa)", () => {
    const json = JSON.stringify({ "@type": "ClaimReview", claimReviewed: "<script>alert(1)</script>", reviewRating: { alternateName: '<img src=x onerror="alert(1)">' } });
    const [found] = reviews(ldScript(json.replaceAll("</", "<\\/")));
    assert.equal(found?.claimReviewed, "<script>alert(1)</script>");
    assert.equal(found?.ratingLabel, '<img src=x onerror="alert(1)">');
  });

  test("__proto__ e constructor: nada é lido por herança e Object.prototype fica intacto", () => {
    const json = `{"@type":"ClaimReview",
      "__proto__": {"claimReviewed": "herdado", "url": "https://herdado.example/"},
      "constructor": {"claimReviewed": "do constructor"},
      "reviewRating": {"__proto__": {"alternateName": "herdado"}, "constructor": {"name": "x"}},
      "author": {"__proto__": {"name": "herdado"}}}`;
    assert.deepEqual(reviews(ldScript(json)), [EMPTY_MARK]);
    assert.equal(Object.hasOwn(Object.prototype, "claimReviewed"), false);
    assert.equal(({} as Record<string, unknown>)["alternateName"], undefined);
  });

  test("ClaimReview cujo @type só existiria por herança não conta", () => {
    // O objeto de fora não é ClaimReview (não tem @type próprio), então o "x" dele não é lido. O de
    // dentro de "__proto__" é um valor próprio aninhado (JSON.parse cria a chave como propriedade
    // comum) e conta como qualquer outro aninhamento: uma marcação vazia.
    const json = '{"__proto__": {"@type": "ClaimReview"}, "constructor": {"@type": "Thing"}, "claimReviewed": "x"}';
    assert.deepEqual(reviews(ldScript(json)), [EMPTY_MARK]);
    assert.deepEqual(reviews(ldScript('{"__proto__": {"name": "x"}, "claimReviewed": "x"}')), []);
  });
});

describe("ClaimReview: duplicatas e tetos", () => {
  test("marcação idêntica na raiz de um bloco e no @graph de outro: uma só", () => {
    const graph = JSON.stringify({ "@graph": [official()] });
    assert.deepEqual(reviews(`${ldScript(OFFICIAL_CLAIMREVIEW)}${ldScript(graph)}`), [OFFICIAL_CLAIMREVIEW_MARK]);
  });

  test("duplicatas saem antes do teto: 6 distintas e uma repetida dão as 5 primeiras distintas", () => {
    const claims = ["um", "um", "dois", "tres", "quatro", "cinco", "seis"];
    const found = reviews(ldScript(JSON.stringify(claims.map((c) => JSON.parse(minimal(c)) as unknown))));
    assert.deepEqual(found.map((r) => r.claimReviewed), ["um", "dois", "tres", "quatro", "cinco"]);
  });

  test("no máximo maxClaimReviews (5) por página, somando os blocos", () => {
    const blocks = ["a", "b", "c", "d", "e", "f"].map((c) => ldScript(minimal(c))).join("");
    assert.equal(DEFAULT_LIMITS.maxClaimReviews, 5);
    assert.equal(reviews(blocks).length, 5);
  });

  test("bloco acima de maxJsonLdBlockChars é ignorado sem parse; no limite exato, lido", () => {
    const max = DEFAULT_LIMITS.maxJsonLdBlockChars;
    const prefix = '{"@type":"ClaimReview","claimReviewed":"x","pad":"';
    const exact = `${prefix}${"a".repeat(max - prefix.length - 2)}"}`;
    assert.equal(exact.length, max);
    assert.equal(reviews(ldScript(exact)).length, 1);
    assert.deepEqual(reviews(ldScript(`${prefix}${"a".repeat(max - prefix.length - 1)}"}`)), []);
  });

  test("só os primeiros maxJsonLdBlocks (20) blocos são lidos", () => {
    const filler = ldScript('{"@type":"Thing"}').repeat(DEFAULT_LIMITS.maxJsonLdBlocks - 1);
    assert.equal(reviews(`${filler}${ldScript(OFFICIAL_CLAIMREVIEW)}`).length, 1); // 20º
    assert.deepEqual(reviews(`${filler}${ldScript("{}")}${ldScript(OFFICIAL_CLAIMREVIEW)}`), []); // 21º
  });

  test("@graph com mais de maxJsonLdNodes (2000) itens: a varredura para no teto", () => {
    const things = (n: number) => Array.from({ length: n }, () => ({ "@type": "Thing" }));
    const early = JSON.stringify({ "@graph": [official(), ...things(2500)] });
    const late = JSON.stringify({ "@graph": [...things(2500), official()] });
    assert.equal(reviews(ldScript(early)).length, 1);
    assert.deepEqual(reviews(ldScript(late)), []);
  });

  test("profundidade acima de maxJsonLdDepth (16) ignora o bloco; no limite, lido", () => {
    const nested = (levels: number) => `${"[".repeat(levels)}0${"]".repeat(levels)}`;
    const withDepth = (total: number) => `{"@type":"ClaimReview","claimReviewed":"x","a":${nested(total - 1)}}`;
    assert.equal(reviews(ldScript(withDepth(16))).length, 1);
    assert.deepEqual(reviews(ldScript(withDepth(17))), []);
  });

  test("tetos menores passados pelo chamador valem; maiores que o padrão, não", () => {
    const blocks = ["a", "b", "c"].map((c) => ldScript(minimal(c))).join("");
    const limits = { ...DEFAULT_LIMITS, maxClaimReviews: 1 };
    assert.equal(extractPage(blocks, PAGE, limits).claimReviews.length, 1);
    const looser = { ...DEFAULT_LIMITS, maxClaimReviews: 1000, maxJsonLdBlocks: 1000 };
    const many = Array.from({ length: 30 }, (_, i) => ldScript(minimal(`c${i}`))).join("");
    assert.equal(extractPage(many, PAGE, looser).claimReviews.length, 5);
  });
});

describe("ClaimReview: HTML e JSON hostis", () => {
  test("100 mil '[' aninhados terminam rápido, sem lançar", () => {
    const started = performance.now();
    assert.deepEqual(reviews(ldScript("[".repeat(100_000))), []);
    assert.deepEqual(reviews(ldScript(`${"[".repeat(50_000)}${"]".repeat(50_000)}`)), []);
    assert.deepEqual(reviews(ldScript(`${'{"a":'.repeat(40_000)}1${"}".repeat(40_000)}`)), []);
    assert.ok(performance.now() - started < 2_000);
  });

  test("pré-varredura de profundidade ignora colchetes dentro de strings e escapes", () => {
    assert.equal(exceedsDepth(`{"a":"${"[".repeat(100)}"}`, 2), false);
    assert.equal(exceedsDepth(`{"a":"\\"[[[[\\""}`, 1), false);
    assert.equal(exceedsDepth("[[[", 2), true);
    assert.equal(exceedsDepth("[[]]", 2), false);
  });

  test("</script> dentro de string fecha o bloco: JSON inválido, ignorado; o resto vira HTML", () => {
    const page = extractPage(`${ldScript('{"@type":"ClaimReview","claimReviewed":"a</script><img src="/x.jpg">"}')}`, PAGE);
    assert.deepEqual(page.claimReviews, []);
    assert.deepEqual(page.media.map((m) => m.url), ["https://checagem.example/x.jpg"]);
  });

  test("<\\/script> escapado é lido como texto", () => {
    const [found] = reviews(ldScript('{"@type":"ClaimReview","claimReviewed":"a<\\/script>b"}'));
    assert.equal(found?.claimReviewed, "a</script>b");
  });

  test("comentário HTML e CDATA dentro do script: JSON inválido, ignorado", () => {
    assert.deepEqual(reviews(ldScript(`<!-- ${OFFICIAL_CLAIMREVIEW} -->`)), []);
    assert.deepEqual(reviews(ldScript(`/*<![CDATA[*/${OFFICIAL_CLAIMREVIEW}/*]]>*/`)), []);
    assert.deepEqual(reviews(ldScript(`<![CDATA[${OFFICIAL_CLAIMREVIEW}]]>`)), []);
  });

  test("JSON-LD dentro de <template>, <noscript> ou comentário não é lido", () => {
    assert.deepEqual(reviews(`<template>${ldScript(OFFICIAL_CLAIMREVIEW)}</template>`), []);
    assert.deepEqual(reviews(`<noscript>${ldScript(OFFICIAL_CLAIMREVIEW)}</noscript>`), []);
    assert.deepEqual(reviews(`<!-- ${ldScript(OFFICIAL_CLAIMREVIEW)} -->`), []);
  });

  test("JSON-LD em <svg> não conta (só script HTML)", () => {
    assert.deepEqual(reviews(`<svg>${ldScript(OFFICIAL_CLAIMREVIEW)}</svg>`), []);
  });

  test("readClaimReviews direto: bloco a mais que o teto é ignorado, entrada não confiável não lança", () => {
    const blocks = [...Array.from({ length: 25 }, () => "{}"), OFFICIAL_CLAIMREVIEW];
    assert.deepEqual(readClaimReviews(blocks, DEFAULT_LIMITS), []);
    assert.deepEqual(readClaimReviews(["", " ", "\u0000", "{", "]"], DEFAULT_LIMITS), []);
    assert.deepEqual(readClaimReviews([OFFICIAL_CLAIMREVIEW], DEFAULT_LIMITS), [OFFICIAL_CLAIMREVIEW_MARK]);
  });
});
