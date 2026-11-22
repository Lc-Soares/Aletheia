import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FACT_CHECK_LIMITS, factCheckQuery, parseSearchResponse } from "./factcheck-response.ts";
import { FACT_CHECK_CLAIM_VIEW, FACT_CHECK_REVIEW_VIEW, factCheckClaimRaw, factCheckResponseRaw, factCheckReviewRaw } from "./testing.ts";

// Caracteres invisíveis montados pelo código, para não ficarem crus no arquivo.
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NUL = String.fromCharCode(0);

const claimsOf = (claims: unknown[]): unknown => parseSearchResponse(factCheckResponseRaw(claims));
const reviewOf = (review: Record<string, unknown>): unknown => parseSearchResponse(factCheckResponseRaw([factCheckClaimRaw({ claimReview: [review] })]));
const onlyReview = (review: Record<string, unknown>): unknown => {
  const claims = reviewOf(review) as Array<{ reviews: unknown[] }>;
  return claims[0]?.reviews[0];
};

describe("Fact Check Tools: texto da busca (manchete, senão título)", () => {
  test("usa a manchete; sem ela, o título; sem os dois, nada", () => {
    assert.equal(factCheckQuery({ headline: "Manchete", title: "Título" }), "Manchete");
    assert.equal(factCheckQuery({ headline: null, title: "Título" }), "Título");
    assert.equal(factCheckQuery({ headline: null, title: null }), null);
  });

  test("manchete que fica vazia depois da limpeza cai para o título", () => {
    assert.equal(factCheckQuery({ headline: ` ${RLO}${NUL} `, title: "Título" }), "Título");
    assert.equal(factCheckQuery({ headline: "   ", title: "\t\n" }), null);
  });

  test("controles viram espaço; bidi e surrogate solto saem; espaços colapsados", () => {
    assert.equal(factCheckQuery({ headline: "  ação\n\t&  reação ", title: null }), "ação & reação");
    assert.equal(factCheckQuery({ headline: `abc${RLO}def${ZWSP}`, title: null }), "abcdef");
    assert.equal(factCheckQuery({ headline: "a\uD800b\uDFFFc", title: null }), "abc");
  });

  test(`corte em ${FACT_CHECK_LIMITS.maxQueryLength} pontos de código, sem partir surrogate`, () => {
    const query = factCheckQuery({ headline: "😀".repeat(250), title: null });
    assert.ok(query !== null);
    assert.equal(Array.from(query).length, 200);
    assert.ok(query.isWellFormed());
    assert.equal(FACT_CHECK_LIMITS.maxQueryLength, 200);
  });
});

describe("Fact Check Tools: resposta do exemplo oficial", () => {
  test("Claim, ClaimReview e Publisher viram a lista permitida", () => {
    assert.deepEqual(parseSearchResponse(factCheckResponseRaw()), [FACT_CHECK_CLAIM_VIEW]);
  });

  test("sem resultados: {} e claims vazio viram lista vazia; nextPageToken é ignorado", () => {
    assert.deepEqual(parseSearchResponse({}), []);
    assert.deepEqual(parseSearchResponse({ claims: [] }), []);
    assert.deepEqual(parseSearchResponse({ nextPageToken: "abc" }), []);
  });

  test("fora do formato: a resposta inteira é descartada (null)", () => {
    for (const value of [null, undefined, "x", 1, [], [factCheckClaimRaw()], { claims: "x" }, { claims: {} }, { claims: null }]) {
      assert.equal(parseSearchResponse(value), null, JSON.stringify(value));
    }
  });
});

describe("Fact Check Tools: campos desconhecidos e tipos errados", () => {
  test("campo a mais em qualquer nível é ignorado e nunca repassado", () => {
    const review = { ...factCheckReviewRaw(), publisher: { name: "Awesome Fact Checks", site: "awesomefactchecks.com", logo: "x" }, rating: 1, extra: "y" };
    const raw = { ...factCheckResponseRaw([{ ...factCheckClaimRaw({ claimReview: [review] }), claimantUrl: "z", extra: 1 }]), extra: true };
    const parsed = parseSearchResponse(raw);
    assert.deepEqual(parsed, [FACT_CHECK_CLAIM_VIEW]);
    assert.doesNotMatch(JSON.stringify(parsed), /extra|logo|rating"|claimantUrl/);
  });

  test("campo com tipo errado vira null, sem derrubar o resto", () => {
    const claims = claimsOf([factCheckClaimRaw({ text: 1, claimant: {}, claimDate: ["2014"] })]) as Array<Record<string, unknown>>;
    assert.deepEqual(claims[0], { text: null, claimant: null, claimDate: null, reviews: [FACT_CHECK_REVIEW_VIEW] });
    assert.deepEqual(onlyReview(factCheckReviewRaw({ publisher: "Awesome", languageCode: 5, reviewDate: null })), {
      ...FACT_CHECK_REVIEW_VIEW,
      publisherName: null,
      publisherSite: null,
      reviewDate: null,
      languageCode: null,
    });
    assert.deepEqual(onlyReview(factCheckReviewRaw({ publisher: { name: 1, site: ["x"] } })), { ...FACT_CHECK_REVIEW_VIEW, publisherName: null, publisherSite: null });
  });

  test("datas só no formato RFC 3339 UTC da documentação; idioma só como código BCP-47", () => {
    for (const date of ["2014-10-02", "ontem", "2014-10-02T15:01:23+03:00", "2014-10-02T15:01:23.0451234567Z", "x".repeat(65)]) {
      assert.equal((onlyReview(factCheckReviewRaw({ reviewDate: date })) as Record<string, unknown>)["reviewDate"], null, date);
    }
    assert.equal((onlyReview(factCheckReviewRaw({ reviewDate: "2014-10-02T15:01:23.045Z" })) as Record<string, unknown>)["reviewDate"], "2014-10-02T15:01:23.045Z");
    for (const code of ["pt-BR", "sr-Latn", "de"]) assert.equal((onlyReview(factCheckReviewRaw({ languageCode: code })) as Record<string, unknown>)["languageCode"], code);
    for (const code of ["en_US", "<b>", "", "a".repeat(36), "pt BR"]) {
      assert.equal((onlyReview(factCheckReviewRaw({ languageCode: code })) as Record<string, unknown>)["languageCode"], null, code);
    }
  });

  test("textos: espaços colapsados, corte em 300 e sempre bem formados; vazio vira null", () => {
    const claims = claimsOf([factCheckClaimRaw({ text: `  a \n b  ${"x".repeat(400)}`, claimant: "   " })]) as Array<Record<string, unknown>>;
    const text = String(claims[0]?.["text"]);
    assert.ok(text.startsWith("a b x"));
    assert.equal(text.length, 300);
    assert.equal(claims[0]?.["claimant"], null);
    const cut = claimsOf([factCheckClaimRaw({ text: `${"a".repeat(299)}😀` })]) as Array<Record<string, unknown>>;
    assert.ok(String(cut[0]?.["text"]).isWellFormed());
    const lone = claimsOf([factCheckClaimRaw({ text: "a\uD800b" })]) as Array<Record<string, unknown>>;
    assert.ok(String(lone[0]?.["text"]).isWellFormed());
  });
});

describe("Fact Check Tools: URL da revisão", () => {
  test("http(s) absoluta é guardada na forma normalizada", () => {
    assert.equal((onlyReview(factCheckReviewRaw({ url: "HTTPS://Checagem.Example/a b" })) as Record<string, unknown>)["url"], "https://checagem.example/a%20b");
  });

  test("javascript:, credenciais, relativa, outro esquema ou longa demais viram null", () => {
    for (const url of ["javascript:alert(1)", "https://u:p@checagem.example/", "https://u@checagem.example/", "/relativa", "//checagem.example/x", "ftp://checagem.example/", "data:text/html,x", `https://checagem.example/${"a".repeat(2048)}`, 42]) {
      assert.equal((onlyReview(factCheckReviewRaw({ url })) as Record<string, unknown>)["url"], null, String(url));
    }
  });
});

describe("Fact Check Tools: itens descartados e tetos", () => {
  test("revisão sem url, title e textualRating é descartada; afirmação sem revisão válida também", () => {
    const empty = factCheckReviewRaw({ url: null, title: null, textualRating: null });
    assert.deepEqual(reviewOf(empty), []);
    assert.deepEqual(claimsOf([factCheckClaimRaw({ claimReview: [] })]), []);
    assert.deepEqual(claimsOf([factCheckClaimRaw({ claimReview: "x" })]), []);
    assert.deepEqual(claimsOf([factCheckClaimRaw({ claimReview: [null, "x", 1, []] })]), []);
    const kept = reviewOf(factCheckReviewRaw({ url: null, title: null })) as Array<{ reviews: unknown[] }>;
    assert.equal(kept[0]?.reviews.length, 1, "só o rótulo já basta para manter a revisão");
  });

  test("afirmação que não é objeto é descartada; as outras ficam, na ordem do Google", () => {
    const second = factCheckClaimRaw({ text: "Segunda" });
    const claims = claimsOf([null, "x", factCheckClaimRaw(), [], second]) as Array<Record<string, unknown>>;
    assert.deepEqual(claims.map((claim) => claim["text"]), ["Crime has doubled in the last 2 years.", "Segunda"]);
  });

  test(`no máximo ${FACT_CHECK_LIMITS.maxClaims} afirmações e ${FACT_CHECK_LIMITS.maxReviewsPerClaim} revisões por afirmação`, () => {
    const many = Array.from({ length: 60 }, (_, i) => factCheckClaimRaw({ text: `Afirmação ${i}` }));
    assert.equal((claimsOf(many) as unknown[]).length, 10);
    const reviews = Array.from({ length: 20 }, (_, i) => factCheckReviewRaw({ title: `Revisão ${i}` }));
    const claims = claimsOf([factCheckClaimRaw({ claimReview: reviews })]) as Array<{ reviews: unknown[] }>;
    assert.equal(claims[0]?.reviews.length, 5);
  });

  test("listas enormes nunca são percorridas inteiras: só os primeiros 50 itens são lidos", () => {
    const junk = Array.from({ length: 50 }, () => null);
    assert.deepEqual(claimsOf([...junk, factCheckClaimRaw()]), []);
    const reviews = [...Array.from({ length: 50 }, () => null), factCheckReviewRaw()];
    assert.deepEqual(claimsOf([factCheckClaimRaw({ claimReview: reviews })]), []);
    const huge = new Array(1_000_000).fill(null);
    const started = performance.now();
    assert.deepEqual(claimsOf(huge), []);
    assert.ok(performance.now() - started < 200);
  });
});

describe("Fact Check Tools: __proto__ e constructor não são lidos como herança", () => {
  test("chaves próprias __proto__ e constructor (JSON.parse) não preenchem nenhum campo", () => {
    const review = JSON.stringify(factCheckReviewRaw());
    const text = `{"claims":[{"__proto__":{"text":"herdado","claimant":"herdado"},"constructor":{"claimDate":"2014-10-02T15:01:23Z"},"claimReview":[${review}]}],"__proto__":{"claims":[]}}`;
    const claims = parseSearchResponse(JSON.parse(text)) as Array<Record<string, unknown>>;
    assert.deepEqual(claims[0], { text: null, claimant: null, claimDate: null, reviews: [FACT_CHECK_REVIEW_VIEW] });
    assert.equal(Object.hasOwn(Object.prototype, "text"), false);
  });

  test("herança de verdade (objeto com protótipo) também não é lida", () => {
    const inherited = Object.assign(Object.create({ text: "herdado" }) as Record<string, unknown>, { claimReview: [factCheckReviewRaw()] });
    const claims = claimsOf([inherited]) as Array<Record<string, unknown>>;
    assert.equal(claims.length, 0, "objeto com protótipo próprio não é objeto JSON simples");
  });
});
