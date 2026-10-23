import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractPage, parseSrcset } from "./extract.ts";

const PAGE = "https://noticias.example/politica/materia.html";
const urls = (htmlText: string, page = PAGE) => extractPage(htmlText, page).media.map((m) => m.url);

describe("extractPage: título e manchete", () => {
  test("título do <title>, manchete do og:title", () => {
    const page = extractPage(
      `<html><head><title>  Título   da
       página </title><meta property="og:title" content="Manchete OG"></head><body><h1>H1</h1></body></html>`,
      PAGE,
    );
    assert.equal(page.title, "Título da página");
    assert.equal(page.headline, "Manchete OG");
  });

  test("sem og:title, a manchete vem do primeiro <h1>", () => {
    const page = extractPage("<h1>Primeira <em>manchete</em></h1><h1>Segunda</h1>", PAGE);
    assert.equal(page.headline, "Primeira manchete");
  });

  test("título ausente: null", () => {
    const page = extractPage("<p>sem título</p>", PAGE);
    assert.equal(page.title, null);
    assert.equal(page.headline, null);
  });

  test("texto longo é cortado", () => {
    assert.equal(extractPage(`<title>${"a".repeat(5000)}</title>`, PAGE).title?.length, 300);
  });

  test("<title> de SVG não conta como título da página", () => {
    assert.equal(extractPage("<svg><title>ícone</title></svg>", PAGE).title, null);
  });

  test("HTML e script no título viram texto, sem interpretação", () => {
    const page = extractPage("<title>&lt;script&gt;alert(1)&lt;/script&gt;</title>", PAGE);
    assert.equal(page.title, "<script>alert(1)</script>");
  });
});

describe("extractPage: mídias", () => {
  test("relativas, absolutas e protocolo relativo", () => {
    assert.deepEqual(
      urls(`<img src="foto.jpg"><img src="/img/b.png"><img src="../c.webp"><img src="https://cdn.example/d.jpg"><img src="//cdn.example/e.jpg">`),
      [
        "https://noticias.example/politica/foto.jpg",
        "https://noticias.example/img/b.png",
        "https://noticias.example/c.webp",
        "https://cdn.example/d.jpg",
        "https://cdn.example/e.jpg",
      ],
    );
  });

  test("og:image e og:video vêm primeiro, com tipo e origem", () => {
    const page = extractPage(
      `<img src="/corpo.jpg"><meta property="og:image" content="/capa.jpg"><meta property="og:video:url" content="https://cdn.example/v.mp4">`,
      PAGE,
    );
    assert.deepEqual(page.media, [
      { url: "https://noticias.example/capa.jpg", kind: "image", source: "og:image" },
      { url: "https://cdn.example/v.mp4", kind: "video", source: "og:video" },
      { url: "https://noticias.example/corpo.jpg", kind: "image", source: "img" },
    ]);
  });

  test("srcset com descritores de largura e densidade", () => {
    assert.deepEqual(urls(`<img srcset="a.jpg 1x, b.jpg 2x,c.jpg 640w">`), [
      "https://noticias.example/politica/a.jpg",
      "https://noticias.example/politica/b.jpg",
      "https://noticias.example/politica/c.jpg",
    ]);
  });

  test("srcset com vírgula dentro da URL", () => {
    assert.deepEqual(parseSrcset("https://img.example/w_100,h_100/a.jpg 1x, https://img.example/b.jpg 2x"), [
      "https://img.example/w_100,h_100/a.jpg",
      "https://img.example/b.jpg",
    ]);
  });

  test("video, poster e source dentro de video e picture", () => {
    const page = extractPage(
      `<video src="v1.mp4" poster="capa.jpg"><source src="v2.webm"></video>
       <picture><source srcset="p.avif"><img src="p.jpg"></picture>
       <audio><source src="som.mp3"></audio>`,
      PAGE,
    );
    assert.deepEqual(
      page.media.map((m) => [m.url.split("/").pop(), m.kind, m.source]),
      [
        ["v1.mp4", "video", "video"],
        ["capa.jpg", "image", "video-poster"],
        ["v2.webm", "video", "source"],
        ["p.avif", "image", "source-srcset"],
        ["p.jpg", "image", "img"],
      ],
    );
  });

  test("<base href> muda a resolução das relativas", () => {
    assert.deepEqual(urls(`<head><base href="https://cdn.example/estatico/"></head><img src="a.jpg">`), [
      "https://cdn.example/estatico/a.jpg",
    ]);
  });

  test("<base href> com esquema perigoso é ignorado", () => {
    assert.deepEqual(urls(`<base href="javascript:alert(1)//"><img src="a.jpg">`), ["https://noticias.example/politica/a.jpg"]);
  });

  test("ignora data:, javascript:, blob:, file: e vazias", () => {
    assert.deepEqual(
      urls(`<img src="data:image/png;base64,AAAA"><img src="javascript:alert(1)"><img src="blob:https://x/y">
            <img src="file:///etc/passwd"><img src=""><img src="   "><img src="ok.jpg">`),
      ["https://noticias.example/politica/ok.jpg"],
    );
  });

  test("remove duplicadas e o fragmento", () => {
    assert.deepEqual(urls(`<img src="a.jpg"><img src="a.jpg#x"><meta property="og:image" content="a.jpg">`), [
      "https://noticias.example/politica/a.jpg",
    ]);
  });

  test("URLs internas são listadas (o download as bloqueia depois)", () => {
    assert.deepEqual(urls(`<img src="http://169.254.169.254/x.jpg">`), ["http://169.254.169.254/x.jpg"]);
  });

  test("não extrai <img> de dentro de script, comentário, template ou atributo", () => {
    assert.deepEqual(
      urls(`<script>document.write('<img src="s.jpg">')</script><!-- <img src="c.jpg"> -->
            <template><img src="t.jpg"></template><div title='<img src="a.jpg">'></div><textarea><img src="x.jpg"></textarea>`),
      [],
    );
  });

  test("<noscript> não é extraído (decisão aberta em docs/fetcher.md)", () => {
    assert.deepEqual(urls(`<head><noscript><img src="h.jpg"></noscript></head><noscript><img src="b.jpg"></noscript>`), []);
  });

  test("twitter:image não é extraído (decisão aberta em docs/fetcher.md)", () => {
    assert.deepEqual(urls(`<meta name="twitter:image" content="https://cdn.example/t.jpg">`), []);
  });

  test("limita a quantidade de referências", () => {
    const tags = Array.from({ length: 500 }, (_, i) => `<img src="/i${i}.jpg">`).join("");
    assert.equal(urls(tags).length, 200);
  });

  test("coleta bruta tem teto antes da deduplicação (4 × maxMediaRefs por lista)", () => {
    // 8 valores brutos distintos que viram a mesma URL esgotam o teto (2 × 4); b.jpg fica de fora.
    const variants = Array.from({ length: 8 }, (_, i) => `<img src="a.jpg#${i}">`).join("");
    const page = extractPage(`${variants}<img src="b.jpg">`, PAGE, { maxMediaRefs: 2, maxUrlLength: 2048, maxHtmlNodes: 100_000 });
    assert.deepEqual(page.media.map((m) => m.url), ["https://noticias.example/politica/a.jpg"]);
  });

  test("valor bruto repetido não consome o teto", () => {
    const repeated = `<img src="a.jpg">`.repeat(100);
    const page = extractPage(`${repeated}<img src="b.jpg">`, PAGE, { maxMediaRefs: 2, maxUrlLength: 2048, maxHtmlNodes: 100_000 });
    assert.deepEqual(page.media.map((m) => m.url), [
      "https://noticias.example/politica/a.jpg",
      "https://noticias.example/politica/b.jpg",
    ]);
  });

  test("teto do corpo não tira o lugar do og:image", () => {
    const body = Array.from({ length: 50 }, (_, i) => `<img src="x${i}.jpg">`).join("");
    const page = extractPage(`${body}<meta property="og:image" content="capa.jpg">`, PAGE, {
      maxMediaRefs: 2,
      maxUrlLength: 2048,
      maxHtmlNodes: 100_000,
    });
    assert.deepEqual(page.media.map((m) => m.source), ["og:image", "img"]);
  });

  test("ignora URL longa demais", () => {
    assert.deepEqual(urls(`<img src="/${"a".repeat(3000)}.jpg"><img src="ok.jpg">`), ["https://noticias.example/politica/ok.jpg"]);
  });
});

describe("extractPage: HTML hostil", () => {
  test("HTML malformado é lido como o navegador leria", () => {
    assert.deepEqual(urls(`<p>texto<img src="a.jpg"<p><img src=b.jpg><div><img SRC="C.JPG"></div>`), [
      "https://noticias.example/politica/a.jpg",
      "https://noticias.example/politica/b.jpg",
      "https://noticias.example/politica/C.JPG",
    ]);
  });

  test("<title> sem fechamento engole o resto como texto, sem gerar mídias", () => {
    const page = extractPage(`<title>Quebrado<img src="a.jpg"><img src=b.jpg>`, PAGE);
    assert.equal(page.title, `Quebrado<img src="a.jpg"><img src=b.jpg>`);
    assert.deepEqual(page.media, []);
  });

  test("lixo sintático não lança erro", () => {
    assert.deepEqual(extractPage("<<<>>><img src=>>>></img></img>&&&;", PAGE).media, []);
  });

  test("atributos em maiúsculas e sem aspas", () => {
    assert.deepEqual(urls(`<IMG SRC=foto.jpg>`), ["https://noticias.example/politica/foto.jpg"]);
  });

  test("aninhamento profundo não estoura a pilha", () => {
    const depth = 10_000;
    const page = extractPage(`${"<div>".repeat(depth)}<img src="fundo.jpg">${"</div>".repeat(depth)}`, PAGE);
    assert.deepEqual(page.media.map((m) => m.url), ["https://noticias.example/politica/fundo.jpg"]);
  });

  test("teto de nós interrompe a varredura sem erro", () => {
    const tags = `${"<p></p>".repeat(1000)}<img src="depois.jpg">`;
    const page = extractPage(tags, PAGE, { maxMediaRefs: 200, maxUrlLength: 2048, maxHtmlNodes: 100 });
    assert.deepEqual(page.media, []);
  });

  test("entrada vazia", () => {
    assert.deepEqual(extractPage("", PAGE), { title: null, headline: null, media: [] });
  });

  test("srcset terminado em vírgulas: tempo linear, sem ReDoS", () => {
    assert.deepEqual(parseSrcset(`a${",".repeat(100)}x,`), [`a${",".repeat(100)}x`]);
    // Antes da correção, /,+$/ levava cerca de 19 s nesta página de 2 MiB.
    const tag = `<img srcset="a${",".repeat(16_000)}x,">`;
    const htmlText = tag.repeat(Math.floor((2 * 1024 * 1024) / tag.length));
    const started = performance.now();
    extractPage(htmlText, PAGE);
    assert.ok(performance.now() - started < 3_000);
  });
});
