import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { describe, test } from "node:test";

import { C } from "../public/report-classes.js";
import { createUi } from "../public/render.js";

const dir = new URL("../public/", import.meta.url);
const read = (/** @type {string} */ name) => readFileSync(new URL(name, dir), "utf8");
const html = read("index.html");
const css = read("style.css");
const app = read("app.js");

const idsInHtml = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);

describe("index.html: estrutura e acessibilidade", () => {
  test("idioma pt-BR, viewport e um só h1", () => {
    assert.match(html, /<html lang="pt-BR">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1"/);
    assert.equal(html.match(/<h1[\s>]/g)?.length, 1);
  });

  test("títulos hierárquicos: h1, depois h2 (nunca h3 antes de um h2)", () => {
    const levels = [...html.matchAll(/<h([1-6])[\s>]/g)].map((m) => Number(m[1]));
    assert.equal(levels[0], 1);
    for (let i = 1; i < levels.length; i++) assert.ok((levels[i] ?? 0) - (levels[i - 1] ?? 0) <= 1);
  });

  test("o campo do link tem rótulo associado (label for) e descrição", () => {
    assert.match(html, /<label for="check-url"[^>]*>[^<]+<\/label>/);
    assert.match(html, /<input[^>]*\bid="check-url"/);
    assert.match(html, /<input[^>]*aria-describedby="check-hint check-error"/);
    assert.match(html, /\bid="check-hint"/);
  });

  test("campo de link: sem corretor e sem maxlength (o excesso gera mensagem, não corta a colagem)", () => {
    const input = /** @type {string} */ (html.match(/<input[^>]*\bid="check-url"[^>]*>/)?.[0]);
    assert.ok(input);
    assert.match(input, /autocomplete="off"/);
    assert.match(input, /spellcheck="false"/);
    assert.match(input, /inputmode="url"/);
    assert.doesNotMatch(input, /maxlength/i);
  });

  test("formulário POST sem validação do navegador (a URL nunca iria para a query string)", () => {
    const form = /** @type {string} */ (html.match(/<form[^>]*>/)?.[0]);
    assert.ok(form);
    assert.match(form, /method="post"/);
    assert.match(form, /novalidate/);
    assert.doesNotMatch(form, /method="get"/i);
    assert.doesNotMatch(form, /\baction=/);
  });

  test("região viva para 'Analisando...' e mensagem de erro focável", () => {
    assert.match(html, /<p id="check-progress"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(html, /<p id="check-error"[^>]*tabindex="-1"/);
  });

  test("botão de envio dentro do formulário, com texto 'Verificar'", () => {
    assert.match(html, /<button id="check-submit" type="submit">Verificar<\/button>/);
  });

  test("o painel começa escondido (só aparece depois do login)", () => {
    assert.match(html, /<section id="check-panel"[^>]*\bhidden\b/);
  });

  test("sem imagem, iframe, estilo inline, manipulador on* nem recurso de terceiros além do Google Identity", () => {
    assert.doesNotMatch(html, /<img|<iframe|<object|<embed|<video|<audio|<link[^>]*rel="(preload|prefetch|icon)"/i);
    assert.doesNotMatch(html, /\sstyle=|\son[a-z]+=/i);
    const external = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(external, ["https://accounts.google.com/gsi/client"]);
  });

  test("ids únicos", () => {
    assert.equal(new Set(idsInHtml).size, idsInHtml.length);
  });

  test("todo id pedido pelo app.js existe no index.html", () => {
    const wanted = [...app.matchAll(/byId\("([^"]+)"\)/g)].map((m) => m[1]);
    assert.ok(wanted.length >= 8);
    for (const id of wanted) assert.ok(idsInHtml.includes(id), `falta #${id} no index.html`);
  });
});

describe("style.css: responsivo, contraste e sem recursos externos", () => {
  test("sem url(), @import nem fontes externas", () => {
    assert.doesNotMatch(css, /url\(|@import|@font-face|https?:/i);
  });

  test("margem lateral de 16 px e URLs/hashes longos quebram", () => {
    assert.match(css, /main\s*\{[^}]*padding:\s*0 1rem/);
    assert.match(css, /overflow-wrap:\s*anywhere/);
    assert.match(css, /\.report-mono\s*\{[^}]*font-family:[^;]*monospace/);
  });

  test("sem rolagem horizontal: nada com largura fixa maior que a tela", () => {
    assert.doesNotMatch(css, /(?<!max-)width:\s*\d+(px|rem|em)/);
    assert.match(css, /box-sizing:\s*border-box/);
  });

  test("foco visível e atributo hidden respeitado", () => {
    assert.match(css, /:focus-visible\s*\{[^}]*outline/);
    assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  });

  test("o campo de texto usa 1rem (o iOS não amplia a tela ao focar)", () => {
    assert.match(css, /input\s*\{[^}]*font-size:\s*1rem/);
  });

  test("cada classe do relatório tem regra ou está marcada como sem estilo próprio", () => {
    const noStyle = new Set([C.facts]);
    for (const name of Object.values(C)) {
      if (noStyle.has(name)) continue;
      assert.match(css, new RegExp(`\\.${name}\\b`), `falta regra para .${name}`);
    }
  });

  test("pares de cor de texto e fundo têm contraste de pelo menos 4,5:1", () => {
    /** @param {string} hex */
    const luminance = (hex) => {
      const [r, g, b] = [1, 3, 5].map((i) => {
        const v = parseInt(hex.slice(i, i + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    /** @param {string} a @param {string} b */
    const ratio = (a, b) => {
      const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
      return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
    };
    const vars = Object.fromEntries([...css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})/g)].map((m) => [m[1], m[2]]));
    /** @type {Array<[string, string]>} */
    const pairs = [["text", "bg"], ["muted", "bg"], ["link", "bg"], ["error", "bg"], ["button-text", "button-bg"], ["notice-text", "notice-bg"]];
    for (const [fg, bg] of pairs) {
      assert.ok(vars[fg] && vars[bg], `variáveis --${fg} e --${bg}`);
      assert.ok(ratio(/** @type {string} */ (vars[fg]), /** @type {string} */ (vars[bg])) >= 4.5, `${fg} sobre ${bg}`);
    }
  });
});

describe("app.js e demais arquivos: sem rastros", () => {
  const sources = readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => /** @type {[string, string]} */ ([f, read(f)]));

  test("nenhum console.log/debug/warn/error/trace; console.info só em session.js", () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /console\.(log|debug|warn|error|trace|dir|table)/, file);
      if (file !== "session.js") assert.doesNotMatch(text, /console\./, file);
    }
  });

  test("nada de <img>, Image() nem requisição a recurso de terceiros", () => {
    for (const [file, text] of sources) {
      assert.doesNotMatch(text, /createElement\(\s*["']img["']\)|new Image\(|\.src\s*=/, file);
    }
  });

  test("fetch só aparece no app.js, com caminho relativo da própria origem", () => {
    for (const [file, text] of sources) {
      if (file === "app.js") continue;
      assert.doesNotMatch(text.replace(/\/\/.*$/gm, ""), /\bfetch\(/, file);
    }
    assert.match(app, /fetch\(url, init\)/);
  });

  test("a URL digitada pelo usuário não aparece em nenhum log nem em atributo de página", () => {
    assert.doesNotMatch(app, /location\.(search|hash)|history\.|URLSearchParams/);
  });
});

describe("render: showLogin", () => {
  test("mostra o botão de login e limpa o texto de 'Conectado como...'", () => {
    const status = { textContent: "Conectado como a@b.c" };
    const elements = { status, signin: { hidden: true } };
    createUi(elements).showLogin();
    assert.equal(elements.signin.hidden, false);
    assert.equal(status.textContent, "");
  });
});
