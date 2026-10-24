import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractPage, parseSrcsetCandidates } from "./extract.ts";
import { DEFAULT_LIMITS } from "./limits.ts";
import type { MediaRef } from "./media.ts";
import { hasIconWord, parseDimension } from "./select.ts";
import {
  newsArticleFixture,
  PICTURE_8_VARIANTS,
  SHORT_STATIC_FIXTURE,
  SPA_SHELL_FIXTURE,
  SRCSET_8_VARIANTS,
  TEXT_ONLY_FIXTURE,
} from "./testing.ts";

const PAGE = "https://noticias.example/materia";
const file = (m: MediaRef): string => m.url.split("/").pop() ?? "";
const selected = (media: MediaRef[]): string[] => media.filter((m) => m.selected).map(file);
const byFile = (media: MediaRef[], name: string): MediaRef => media.find((m) => file(m) === name) ?? assert.fail(name);
const groupOf = (media: MediaRef[], group: number): MediaRef[] => media.filter((m) => m.group === group);

describe("seleção: variantes do mesmo elemento", () => {
  test("<img> com 8 variantes vira 1 grupo e só a maior (1600w) é selecionada", () => {
    const { media } = extractPage(`<article>${SRCSET_8_VARIANTS}</article>`, PAGE);
    assert.equal(media.length, 8);
    assert.deepEqual(new Set(media.map((m) => m.group)), new Set([1]));
    assert.deepEqual(selected(media), ["principal-1600.jpg"]);
    assert.deepEqual(media.filter((m) => !m.selected).map((m) => m.skipReason), Array(7).fill("variant"));
  });

  test("<picture>: sources e o <img> interno formam um grupo; empate de largura fica com o primeiro", () => {
    const { media } = extractPage(PICTURE_8_VARIANTS, PAGE);
    assert.equal(media.length, 8);
    assert.equal(new Set(media.map((m) => m.group)).size, 1);
    assert.deepEqual(selected(media), ["segunda-1600.avif"]);
  });

  test("descritor x: a maior densidade; src conta como 1x", () => {
    const { media } = extractPage(`<img src="a.jpg" srcset="a-2x.jpg 2x, a-3x.jpg 3x, a-15x.jpg 1.5x">`, PAGE);
    assert.deepEqual(selected(media), ["a-3x.jpg"]);
  });

  test("sem descritor nenhum: a primeira em ordem de documento", () => {
    const { media } = extractPage(`<video src="v1.mp4"><source src="v2.webm"><source src="v3.mp4"></video>`, PAGE);
    assert.equal(new Set(media.map((m) => m.group)).size, 1);
    assert.deepEqual(selected(media), ["v1.mp4"]);
  });

  test("poster é grupo próprio, separado do vídeo", () => {
    const { media } = extractPage(`<video src="v.mp4" poster="capa.jpg"></video>`, PAGE);
    assert.notEqual(byFile(media, "v.mp4").group, byFile(media, "capa.jpg").group);
    assert.deepEqual(selected(media).sort(), ["capa.jpg", "v.mp4"]);
  });

  test("<img> fora de <picture> direto não entra no grupo do picture", () => {
    const { media } = extractPage(`<picture><source srcset="p.avif"><div><img src="solta.jpg"></div></picture>`, PAGE);
    assert.notEqual(byFile(media, "p.avif").group, byFile(media, "solta.jpg").group);
  });

  test("URL idêntica em elementos diferentes une os grupos e conta uma vez", () => {
    const { media } = extractPage(
      `<meta property="og:image" content="/f/a-1600.jpg"><article><img src="/f/a-320.jpg" srcset="/f/a-1600.jpg 1600w"></article>
       <img src="/f/b.jpg"><img src="/f/b.jpg" srcset="/f/b-2x.jpg 2x">`,
      PAGE,
    );
    assert.deepEqual(media.map(file), ["a-1600.jpg", "a-320.jpg", "b.jpg", "b-2x.jpg"]);
    assert.equal(byFile(media, "a-1600.jpg").group, byFile(media, "a-320.jpg").group);
    assert.equal(byFile(media, "b.jpg").group, byFile(media, "b-2x.jpg").group);
    // A largura vinda do srcset vale para a URL já listada pelo og:image.
    assert.deepEqual(selected(media), ["a-1600.jpg", "b-2x.jpg"]);
  });

  test("URL repetida com tipos diferentes (vídeo e imagem) não une grupos", () => {
    const { media } = extractPage(`<meta property="og:video" content="/m/x"><img src="/m/x"><img src="/m/y">`, PAGE);
    assert.equal(media.length, 2);
    assert.notEqual(media[0]?.group, media[1]?.group);
  });
});

describe("seleção: pontuação e motivos", () => {
  const { media } = extractPage(newsArticleFixture(), PAGE);

  test("ranking: og:image, imagens do article, lateral, e por fim ícones", () => {
    const representatives = media.filter((m) => m.skipReason !== "variant").sort((a, b) => a.group - b.group);
    assert.deepEqual(
      representatives.map((m) => [m.group, file(m), m.score, m.skipReason]),
      [
        [1, "capa-1200.jpg", 100, null],
        [2, "principal-1600.jpg", 20, null],
        [3, "segunda-1600.avif", 20, null],
        [4, "evolucao.svg", 20, "unsupported_format"],
        [5, "relacionada.jpg", -10, "low_score"],
        [6, "marca.png", -70, "icon"],
        [7, "busca.png", -70, "icon"],
        [8, "menu.png", -90, "icon"],
        [9, "selo.png", -90, "icon"],
        [10, "p.gif", -190, "icon"],
      ],
    );
  });

  test("ícones ficam abaixo de todas as imagens do <article>", () => {
    const article = ["principal-1600.jpg", "segunda-1600.avif"].map((name) => byFile(media, name).score);
    for (const name of ["marca.png", "busca.png", "menu.png", "selo.png", "p.gif"]) {
      assert.ok(byFile(media, name).score < Math.min(...article), name);
    }
  });

  test("SVG é ignorado como formato não analisável, não como erro, e nunca selecionado", () => {
    const svg = byFile(media, "evolucao.svg");
    assert.equal(svg.selected, false);
    assert.equal(svg.skipReason, "unsupported_format");
  });

  test("todos os itens de um grupo têm a mesma pontuação e um só representante", () => {
    for (const group of new Set(media.map((m) => m.group))) {
      const members = groupOf(media, group);
      assert.equal(new Set(members.map((m) => m.score)).size, 1);
      assert.equal(members.filter((m) => m.skipReason !== "variant").length, 1);
    }
  });

  test("SVG dentro de <picture> nunca é a variante escolhida", () => {
    const page = extractPage(
      `<picture><source type="image/svg+xml" srcset="/g/a.svg 2000w"><img src="/g/a.png" srcset="/g/a-800.png 800w"></picture>`,
      PAGE,
    );
    assert.deepEqual(selected(page.media), ["a-800.png"]);
    assert.equal(byFile(page.media, "a.svg").skipReason, "variant");
  });

  test("og:image com logo na URL continua elegível (+100 − 40)", () => {
    const page = extractPage(`<meta property="og:image" content="/marca/logo-portal.png">`, PAGE);
    assert.deepEqual(page.media.map((m) => [m.score, m.selected]), [[60, true]]);
  });

  test("twitter:image conta como og:image", () => {
    const page = extractPage(`<meta name="twitter:image" content="/t.jpg"><img src="/corpo.jpg">`, PAGE);
    assert.deepEqual(page.media.map((m) => [file(m), m.source, m.score]), [
      ["t.jpg", "twitter:image", 100],
      ["corpo.jpg", "img", 0],
    ]);
  });

  test("<header> dentro de <article> não rebaixa (é o topo da matéria)", () => {
    const page = extractPage(`<article><header><img src="/hero.jpg"></header></article>`, PAGE);
    assert.equal(page.media[0]?.score, 20);
  });

  test("role=presentation e aria-hidden no elemento ou no <picture> excluem como ícone", () => {
    const page = extractPage(
      `<img src="/a.jpg" role="presentation"><img src="/b.jpg" aria-hidden="true">
       <picture aria-hidden="true"><img src="/c.jpg"></picture><img src="/d.jpg" aria-hidden="false">`,
      PAGE,
    );
    assert.deepEqual(page.media.map((m) => [file(m), m.skipReason]), [
      ["a.jpg", "icon"],
      ["b.jpg", "icon"],
      ["c.jpg", "icon"],
      ["d.jpg", null],
    ]);
  });

  test("só ancestral de layout: não selecionado, low_score", () => {
    const page = extractPage(`<nav><img src="/n.jpg"></nav>`, PAGE);
    assert.deepEqual(page.media.map((m) => [m.score, m.selected, m.skipReason]), [[-30, false, "low_score"]]);
  });

  test("pontuação negativa nunca é selecionada, mesmo com vaga; 0 e positiva continuam elegíveis", () => {
    const page = extractPage(
      `<article><img class="logo" src="/a/marca.png"></article><nav><img src="/n/foto.jpg"></nav>
       <img src="/solta.jpg"><article><img src="/materia.jpg"></article>`,
      PAGE,
    );
    assert.deepEqual(page.media.map((m) => [file(m), m.score, m.selected, m.skipReason]), [
      ["marca.png", -20, false, "low_score"],
      ["foto.jpg", -30, false, "low_score"],
      ["solta.jpg", 0, true, null],
      ["materia.jpg", 20, true, null],
    ]);
  });

  test("nunca mais de maxSelectedMedia selecionadas; o resto fica como limite", () => {
    const tags = Array.from({ length: 12 }, (_, i) => `<img src="/m${i}.jpg">`).join("");
    const { media } = extractPage(`<article>${tags}</article>`, PAGE);
    assert.equal(DEFAULT_LIMITS.maxSelectedMedia, 8);
    assert.equal(media.filter((m) => m.selected).length, 8);
    assert.deepEqual(media.slice(8).map((m) => m.skipReason), ["limit", "limit", "limit", "limit"]);
    const small = extractPage(`<article>${tags}</article>`, PAGE, { ...DEFAULT_LIMITS, maxSelectedMedia: 3 });
    assert.equal(small.media.filter((m) => m.selected).length, 3);
  });

  test("ícone não ocupa vaga mesmo quando sobra vaga", () => {
    const page = extractPage(`<img src="/so-um-icone.png" width="16" height="16">`, PAGE);
    assert.deepEqual(page.media.map((m) => [m.selected, m.skipReason]), [[false, "icon"]]);
  });

  test("atributos com HTML e script viram só texto para a pontuação", () => {
    const page = extractPage(
      `<img src="/x.jpg" class="&lt;script&gt;alert(1)&lt;/script&gt; logo" alt="<img src=y onerror=alert(1)>" width="<b>10</b>">`,
      PAGE,
    );
    assert.deepEqual(page.media.map((m) => [file(m), m.score, m.skipReason]), [["x.jpg", -40, "icon"]]);
  });
});

describe("seleção: entradas hostis", () => {
  test("palavra só conta dentro do primeiro 1 KiB do atributo", () => {
    assert.equal(hasIconWord("icon"), true);
    assert.equal(hasIconWord("btn site-LOGO"), true);
    assert.equal(hasIconWord("iconografia logotipo"), false);
    assert.equal(hasIconWord(`${"a".repeat(1100)} icon`), false);
    assert.equal(hasIconWord(null), false);
  });

  test("atributo gigante e hostil: tempo linear e resultado correto", () => {
    const hostile = `${"-".repeat(1023)}icon${"a-".repeat(1_000_000)}`;
    const started = performance.now();
    for (let i = 0; i < 1_000; i++) hasIconWord(hostile);
    assert.ok(performance.now() - started < 1_000);
    assert.equal(hasIconWord(hostile), false); // "icon" atravessa o corte de 1 KiB
  });

  test("página de 2 MiB com atributos enormes: extração rápida", () => {
    const tag = `<img src="/f.jpg" class="${"x ".repeat(20_000)}" alt="${"logo,".repeat(10_000)}" width="${"9".repeat(50_000)}">`;
    const htmlText = tag.repeat(Math.floor((2 * 1024 * 1024) / tag.length));
    const started = performance.now();
    const page = extractPage(htmlText, PAGE);
    assert.ok(performance.now() - started < 3_000);
    assert.equal(page.media.length, 1);
  });

  test("dimensão: só dígitos iniciais, porcentagem e lixo não contam", () => {
    assert.equal(parseDimension("24"), 24);
    assert.equal(parseDimension(" 1.5 "), 1);
    assert.equal(parseDimension("50%"), null);
    assert.equal(parseDimension("auto"), null);
    assert.equal(parseDimension(""), null);
    assert.equal(parseDimension(null), null);
    assert.equal(parseDimension("9".repeat(5000)), null);
  });

  test("descritores do srcset: w, x, ausentes e inválidos", () => {
    assert.deepEqual(parseSrcsetCandidates("a.jpg 640w, b.jpg 2x, c.jpg, d.jpg 10w 2x, e.jpg abc, f.jpg -5w"), [
      { url: "a.jpg", w: 640, x: null },
      { url: "b.jpg", w: null, x: 2 },
      { url: "c.jpg", w: null, x: 1 },
      { url: "d.jpg", w: null, x: null },
      { url: "e.jpg", w: null, x: null },
      { url: "f.jpg", w: null, x: null },
    ]);
  });
});

describe("sinal: página possivelmente depende de JavaScript", () => {
  test("casca de SPA (script, ponto de montagem vazio, sem mídia): sinal presente", () => {
    assert.equal(extractPage(SPA_SHELL_FIXTURE, PAGE).possiblyNeedsJavaScript, true);
  });

  test("página estática curta, sem script e sem mídia: sem sinal", () => {
    assert.equal(extractPage(SHORT_STATIC_FIXTURE, PAGE).possiblyNeedsJavaScript, false);
  });

  test("texto suficiente, com script e sem mídia: sem sinal", () => {
    assert.equal(extractPage(TEXT_ONLY_FIXTURE, PAGE).possiblyNeedsJavaScript, false);
  });

  test("página com mídia: sem sinal", () => {
    assert.equal(extractPage(newsArticleFixture(), PAGE).possiblyNeedsJavaScript, false);
  });

  test("ponto de montagem vazio sem script também conta; com conteúdo dentro, não", () => {
    assert.equal(extractPage(`<div id="__next"></div>`, PAGE).possiblyNeedsJavaScript, true);
    assert.equal(extractPage(`<div id="app"><p>oi</p></div>`, PAGE).possiblyNeedsJavaScript, false);
  });

  test("texto dentro de script, style e noscript não conta como texto visível", () => {
    const filler = "x".repeat(2000);
    const page = `<script>var a="${filler}"</script><style>/*${filler}*/</style><noscript>${filler}</noscript>`;
    assert.equal(extractPage(page, PAGE).possiblyNeedsJavaScript, true);
  });
});
