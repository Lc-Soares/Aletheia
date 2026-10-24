import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { mount } from "../public/report-mount.js";
import { parseReport } from "../public/report-parse.js";
import { describeReport } from "../public/report-describe.js";
import { RENDER_ERROR_TEXT, renderReport } from "../public/report-view.js";
import { createFakeDocument, createFakeElement, snapshot } from "./fake-dom.js";
import { flatten } from "./tree.js";
import { apiExample, variantsPage } from "./fixtures/report-fixtures.js";

const REL = "noopener noreferrer nofollow";

/** @param {unknown} descriptor */
function tryMount(descriptor) {
  const { doc, created } = createFakeDocument();
  return { run: () => mount(/** @type {never} */ (descriptor), /** @type {never} */ (doc)), created };
}

describe("mount: o que é aceito", () => {
  test("cria elementos, texto, filhos e atributos permitidos", () => {
    const { doc } = createFakeDocument();
    const { root } = mount(
      {
        tag: "section",
        attrs: { class: "caixa grande", "aria-labelledby": "titulo-x" },
        children: [
          { tag: "h2", text: "Título", attrs: { id: "titulo-x", tabindex: "-1" } },
          { tag: "ul", children: [{ tag: "li", text: "item" }] },
        ],
      },
      /** @type {never} */ (doc),
    );
    const shot = snapshot(/** @type {never} */ (root));
    assert.equal(shot.tag, "section");
    assert.deepEqual(shot.attributes, { class: "caixa grande", "aria-labelledby": "titulo-x" });
    assert.equal(shot.children[0]?.tag, "h2");
    assert.equal(shot.children[0]?.text, "Título");
    assert.deepEqual(shot.children[0]?.attributes, { id: "titulo-x", tabindex: "-1" });
    assert.equal(shot.children[1]?.children[0]?.text, "item");
  });

  test("link http(s) com rel e target exatos", () => {
    const { doc } = createFakeDocument();
    const { root } = mount(
      { tag: "a", text: "https://exemplo.com/", attrs: { href: "https://exemplo.com/", rel: REL, target: "_blank" } },
      /** @type {never} */ (doc),
    );
    assert.deepEqual(snapshot(/** @type {never} */ (root)).attributes, { href: "https://exemplo.com/", rel: REL, target: "_blank" });
  });

  test("devolve os elementos com id, para o chamador focar", () => {
    const { doc } = createFakeDocument();
    const { ids } = mount({ tag: "div", children: [{ tag: "h2", text: "t", attrs: { id: "report-title", tabindex: "-1" } }] }, /** @type {never} */ (doc));
    assert.ok(ids.get("report-title"));
  });

  test("usa só createElement, textContent, setAttribute e appendChild (o fake lança em qualquer outro acesso)", () => {
    const { doc, created } = createFakeDocument();
    const report = parseReport(variantsPage());
    assert.ok(report);
    assert.doesNotThrow(() => mount(describeReport(report), /** @type {never} */ (doc)));
    assert.ok(created.length > 10);
  });

  test("o número de elementos criados é o número de nós do descritor", () => {
    const { doc, created } = createFakeDocument();
    const report = parseReport(variantsPage());
    assert.ok(report);
    const descriptor = describeReport(report);
    mount(descriptor, /** @type {never} */ (doc));
    assert.equal(created.length, flatten(descriptor).length);
  });
});

describe("mount: o que é recusado (lança, sem criar nada e sem repetir os dados na mensagem)", () => {
  /** @type {Array<[string, unknown]>} */
  const refused = [
    ["tag fora da lista: img", { tag: "img", attrs: {} }],
    ["tag fora da lista: script", { tag: "script", text: "alert(1)" }],
    ["tag fora da lista: svg", { tag: "svg" }],
    ["tag fora da lista: iframe", { tag: "iframe" }],
    ["tag fora da lista: button", { tag: "button", text: "x" }],
    ["tag com maiúsculas ou HTML", { tag: "<img src=x onerror=alert(1)>" }],
    ["tag que não é texto", { tag: 5 }],
    ["onclick", { tag: "p", text: "x", attrs: { onclick: "alert(1)" } }],
    ["onerror", { tag: "p", attrs: { onerror: "alert(1)" } }],
    ["ONLOAD em maiúsculas", { tag: "p", attrs: { ONLOAD: "alert(1)" } }],
    ["style", { tag: "p", attrs: { style: "color:red" } }],
    ["src", { tag: "p", attrs: { src: "https://e.com/x.png" } }],
    ["srcdoc", { tag: "p", attrs: { srcdoc: "<script>" } }],
    ["atributo fora da lista", { tag: "p", attrs: { "data-x": "1" } }],
    ["href javascript:", { tag: "a", text: "x", attrs: { href: "javascript:alert(1)", rel: REL, target: "_blank" } }],
    ["href JaVaScRiPt:", { tag: "a", text: "x", attrs: { href: "JaVaScRiPt:alert(1)", rel: REL, target: "_blank" } }],
    ["href data:", { tag: "a", text: "x", attrs: { href: "data:text/html,<script>alert(1)</script>", rel: REL, target: "_blank" } }],
    ["href vbscript:", { tag: "a", text: "x", attrs: { href: "vbscript:msgbox(1)", rel: REL, target: "_blank" } }],
    ["href blob:", { tag: "a", text: "x", attrs: { href: "blob:https://e.com/1", rel: REL, target: "_blank" } }],
    ["href relativo", { tag: "a", text: "x", attrs: { href: "/api/me", rel: REL, target: "_blank" } }],
    ["href com usuário e senha", { tag: "a", text: "x", attrs: { href: "https://u:p@e.com/", rel: REL, target: "_blank" } }],
    ["href em tag que não é a", { tag: "p", attrs: { href: "https://e.com/" } }],
    ["a sem href", { tag: "a", text: "x", attrs: { rel: REL, target: "_blank" } }],
    ["a sem rel", { tag: "a", text: "x", attrs: { href: "https://e.com/", target: "_blank" } }],
    ["a sem target", { tag: "a", text: "x", attrs: { href: "https://e.com/", rel: REL } }],
    ["a com rel incompleto", { tag: "a", text: "x", attrs: { href: "https://e.com/", rel: "noopener", target: "_blank" } }],
    ["a com target _self", { tag: "a", text: "x", attrs: { href: "https://e.com/", rel: REL, target: "_self" } }],
    ["tabindex diferente de -1", { tag: "h2", attrs: { tabindex: "0" } }],
    ["id inválido", { tag: "h2", attrs: { id: 'a" onclick="x' } }],
    ["class inválida", { tag: "p", attrs: { class: '"><img src=x>' } }],
    ["aria-live inválido", { tag: "p", attrs: { "aria-live": "<x>" } }],
    ["campo de HTML cru: html", { tag: "p", html: "<img src=x>" }],
    ["campo de HTML cru: innerHTML", { tag: "p", innerHTML: "<img src=x>" }],
    ["campo desconhecido", { tag: "p", extra: 1 }],
    ["text que não é texto", { tag: "p", text: { toString: () => "x" } }],
    ["children que não é lista", { tag: "ul", children: "<li>" }],
    ["filho inválido no meio", { tag: "ul", children: [{ tag: "li", text: "ok" }, { tag: "img" }] }],
    ["descritor que não é objeto", "<p>x</p>"],
    ["descritor null", null],
    ["lista no lugar do descritor", [{ tag: "p" }]],
    ["attrs que não é objeto", { tag: "p", attrs: "class=x" }],
  ];
  for (const [name, descriptor] of refused) {
    test(name, () => {
      const { run, created } = tryMount(descriptor);
      assert.throws(run, (error) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, "Descritor inválido.");
        return true;
      });
      assert.equal(created.length, 0, "validação antes de criar qualquer elemento");
    });
  }

  test("árvore profunda demais ou grande demais é recusada", () => {
    /** @type {Record<string, unknown>} */
    let deep = { tag: "p", text: "fim" };
    for (let i = 0; i < 100; i++) deep = { tag: "div", children: [deep] };
    assert.throws(tryMount(deep).run, /Descritor inválido\./);
    const wide = { tag: "ul", children: Array.from({ length: 30_000 }, () => ({ tag: "li", text: "x" })) };
    assert.throws(tryMount(wide).run, /Descritor inválido\./);
  });
});

describe("mount: texto hostil continua texto", () => {
  const payloads = [
    '<img src=x onerror="alert(1)">',
    "<script>alert(1)</script>",
    '"><svg onload=alert(1)>',
    "javascript:alert(1)",
    "</p><p onclick=x>",
    "&lt;b&gt; &amp;",
  ];
  for (const payload of payloads) {
    test(payload, () => {
      const { doc, created } = createFakeDocument();
      const { root } = mount({ tag: "p", text: payload, children: [{ tag: "strong", text: payload }] }, /** @type {never} */ (doc));
      const shot = snapshot(/** @type {never} */ (root));
      assert.equal(shot.text, payload);
      assert.equal(shot.children[0]?.text, payload);
      assert.deepEqual(shot.attributes, {});
      assert.equal(created.length, 2, "nenhum elemento novo nasce do texto");
    });
  }
});

describe("renderReport: quem chama o mount tem try/catch", () => {
  test("relatório válido: substitui o conteúdo e devolve o título como alvo do foco", () => {
    const { doc } = createFakeDocument();
    const container = createFakeElement("div");
    const report = parseReport(apiExample());
    assert.ok(report);
    const result = renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc));
    assert.equal(result.ok, true);
    const shot = snapshot(container);
    assert.equal(shot.children.length, 1);
    assert.equal(shot.children[0]?.tag, "section");
    const target = snapshot(/** @type {never} */ (result.focusTarget));
    assert.equal(target.tag, "h2");
    assert.equal(target.text, "Relatório de sinais");
  });

  test("renderizar de novo troca o relatório anterior (não acumula)", () => {
    const { doc } = createFakeDocument();
    const container = createFakeElement("div");
    const report = parseReport(apiExample());
    assert.ok(report);
    renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc));
    renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc));
    assert.equal(snapshot(container).children.length, 1);
  });

  test("se o mount lançar: texto fixo 'Não foi possível exibir o relatório.', sem dados e sem console", () => {
    const { doc } = createFakeDocument();
    const container = createFakeElement("div");
    const report = parseReport(apiExample());
    assert.ok(report);
    /** @type {string[]} */
    const written = [];
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (console));
    const saved = Object.fromEntries(["log", "info", "warn", "error", "debug"].map((name) => [name, target[name]]));
    for (const name of Object.keys(saved)) target[name] = () => written.push(name);
    try {
      const result = renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc), {
        describe: () => ({ tag: "p", text: "SEGREDO-NA-PAGINA", attrs: { onclick: "alert(1)" } }),
      });
      assert.equal(result.ok, false);
      const shot = snapshot(container);
      assert.equal(shot.children.length, 1);
      assert.equal(shot.children[0]?.text, "Não foi possível exibir o relatório.");
      assert.equal(RENDER_ERROR_TEXT, "Não foi possível exibir o relatório.");
      assert.equal(JSON.stringify(shot).includes("SEGREDO-NA-PAGINA"), false);
      assert.equal(snapshot(/** @type {never} */ (result.focusTarget)).text, RENDER_ERROR_TEXT);
    } finally {
      for (const [name, fn] of Object.entries(saved)) target[name] = fn;
    }
    assert.deepEqual(written, []);
  });

  test("se o describe lançar: o mesmo texto fixo", () => {
    const { doc } = createFakeDocument();
    const container = createFakeElement("div");
    const report = parseReport(apiExample());
    assert.ok(report);
    const result = renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc), {
      describe: () => {
        throw new Error("erro com dados da página");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(snapshot(container).children[0]?.text, RENDER_ERROR_TEXT);
  });

  test("o describe nunca entrega ao mount um href que o mount recusaria (URL final hostil não gera erro)", () => {
    const hostile = ["javascript:alert(1)", "data:text/html,x", "https://u:p@e.com/", "ftp://e.com/", "http://", "\u202Ehttps://e.com/"];
    for (const finalUrl of hostile) {
      const json = apiExample();
      json.page.finalUrl = finalUrl;
      const report = parseReport(json);
      assert.ok(report);
      const { doc } = createFakeDocument();
      const container = createFakeElement("div");
      const result = renderReport(/** @type {never} */ (container), report, /** @type {never} */ (doc));
      assert.equal(result.ok, true, finalUrl);
    }
  });
});
