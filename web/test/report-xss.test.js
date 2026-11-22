import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeReport } from "../public/report-describe.js";
import { mount } from "../public/report-mount.js";
import { parseReport } from "../public/report-parse.js";
import { apiExample, claimReview, syntheticC2pa } from "./fixtures/report-fixtures.js";
import { createFakeDocument } from "./fake-dom.js";
import { allText, attributesOf, flatten, tagsOf } from "./tree.js";

const FORBIDDEN_TAGS = ["img", "script", "svg", "iframe", "style", "object", "embed", "link", "video", "audio", "source", "picture", "form", "input", "button", "math"];

/** Cargas hostis. A de bidi e a de controles vêm com texto ao redor, para sobrar algo a exibir. */
const PAYLOADS = [
  { name: "<img onerror>", value: '<img src=x onerror="alert(1)">', visible: '<img src=x onerror="alert(1)">' },
  { name: "<script>", value: "<script>alert(document.cookie)</script>", visible: "<script>alert(document.cookie)</script>" },
  { name: '"><svg onload>', value: '"><svg onload=alert(1)>', visible: '"><svg onload=alert(1)>' },
  { name: "javascript:", value: "javascript:alert(1)", visible: "javascript:alert(1)" },
  { name: "bidi U+202E", value: "abc\u202Edef", visible: "abcdef" },
  { name: "controles", value: "a\u0000b\u0007c\u001bd\u007fe\u009ff", visible: "abcdef" },
  { name: "texto enorme", value: `ini${"A".repeat(300_000)}fim`, visible: "ini" },
];

/**
 * Campos de terceiros que entram no DOM. `set` aplica a carga num relatório base completo.
 * `shown: false` = o campo é lido, mas a tela só o conta (não o exibe).
 * @type {Array<{ name: string, shown?: boolean, set: (json: ReturnType<typeof base>, value: string) => void }>}
 */
const FIELDS = [
  { name: "page.title", set: (j, v) => (j.page.title = v) },
  { name: "page.headline", set: (j, v) => (j.page.headline = v) },
  { name: "page.finalUrl", set: (j, v) => (j.page.finalUrl = v) },
  { name: "notices[0]", set: (j, v) => (j.notices[0] = v) },
  { name: "media.url", set: (j, v) => (/** @type {{ url: string }} */ (j.media[0]).url = v) },
  { name: "media.download.message", set: (j, v) => (/** @type {{ download: { message: string } }} */ (j.media[1]).download.message = v) },
  { name: "media.metadata.message (status desconhecido)", set: (j, v) => (j.media[3] && (/** @type {{ metadata: { message: string } }} */ (j.media[3]).metadata.message = v)) },
  { name: "signals.fileType", set: (j, v) => (signals(j)["fileType"] = v) },
  { name: "signals.camera.make", set: (j, v) => (/** @type {Record<string, string>} */ (signals(j)["camera"])["make"] = v) },
  { name: "signals.camera.model", set: (j, v) => (/** @type {Record<string, string>} */ (signals(j)["camera"])["model"] = v) },
  { name: "signals.software", set: (j, v) => (signals(j)["software"] = [v]) },
  { name: "signals.dates.tag", set: (j, v) => (firstOf(signals(j)["dates"])["tag"] = v) },
  { name: "signals.dates.value", set: (j, v) => (firstOf(signals(j)["dates"])["value"] = v) },
  { name: "c2pa.state", set: (j, v) => (c2pa(j)["state"] = v) },
  { name: "c2pa.reason", set: (j, v) => ((c2pa(j)["state"] = "invalid"), (c2pa(j)["reason"] = v)) },
  { name: "c2pa.signer", set: (j, v) => (c2pa(j)["signer"] = v) },
  { name: "c2pa.signedAt", set: (j, v) => (c2pa(j)["signedAt"] = v) },
  { name: "c2pa.generator", set: (j, v) => (c2pa(j)["generator"] = v) },
  { name: "c2pa.checks.code", shown: false, set: (j, v) => (firstOf(c2pa(j)["checks"])["code"] = v) },
  { name: "c2pa.checks.outcome", shown: false, set: (j, v) => (firstOf(c2pa(j)["checks"])["outcome"] = v) },
  { name: "claimReviews.claimReviewed", set: (j, v) => (claim(j)["claimReviewed"] = v) },
  { name: "claimReviews.ratingLabel", set: (j, v) => (claim(j)["ratingLabel"] = v) },
  { name: "claimReviews.authorName", set: (j, v) => (claim(j)["authorName"] = v) },
  { name: "claimReviews.datePublished", set: (j, v) => (claim(j)["datePublished"] = v) },
  { name: "claimReviews.url", set: (j, v) => (claim(j)["url"] = v) },
];

/** Primeiro item de uma lista crua de objetos. @param {unknown} list @returns {Record<string, string>} */
const firstOf = (list) => /** @type {Record<string, string>} */ (/** @type {unknown[]} */ (list)[0]);
/** @param {ReturnType<typeof base>} json @returns {Record<string, unknown>} */
const signals = (json) => /** @type {{ metadata: { signals: Record<string, unknown> } }} */ (json.media[0]).metadata.signals;
/** @param {ReturnType<typeof base>} json @returns {Record<string, unknown>} */
const c2pa = (json) => /** @type {Record<string, unknown>} */ (signals(json)["c2pa"]);
/** @param {ReturnType<typeof base>} json @returns {Record<string, unknown>} */
const claim = (json) => /** @type {Record<string, unknown>[]} */ (json.page["claimReviews"])[0] ?? {};

/** Relatório com todos os campos de terceiros preenchidos (C2PA sintético). */
function base() {
  const json = apiExample();
  const first = /** @type {{ metadata: { signals: Record<string, unknown> } }} */ (json.media[0]);
  first.metadata.signals["c2pa"] = syntheticC2pa();
  first.metadata.signals["software"] = ["Editor"];
  json.page["claimReviews"] = [claimReview()];
  json.media.push({
    ...json.media[1],
    url: "https://exemplo.com.br/quarta.jpg",
    group: 4,
    download: { status: "ok", contentType: "image/jpeg", size: 1, sha256: "a".repeat(64) },
    metadata: { status: "status-novo", message: "mensagem" },
  });
  return json;
}

/** @param {ReturnType<typeof base>} json */
function render(json) {
  const report = parseReport(json);
  assert.ok(report, "o relatório hostil deve ser aceito (a carga é só texto)");
  return describeReport(report);
}

const baseline = render(base());
const baselineNodes = flatten(baseline).length;

describe("XSS: cada campo de terceiros × cada carga hostil", () => {
  for (const field of FIELDS) {
    for (const payload of PAYLOADS) {
      test(`${field.name} ← ${payload.name}`, () => {
        const json = base();
        field.set(json, payload.value);
        const root = render(json);

        // Nenhum elemento nasce da carga: mesma quantidade de nós e mesmas tags do relatório base.
        if (field.name !== "page.finalUrl") assert.equal(flatten(root).length, baselineNodes);
        // O texto do link é sempre o próprio endereço, nunca um rótulo vindo da página.
        for (const link of flatten(root).filter((node) => node.tag === "a")) assert.equal(link.text, link.attrs?.["href"]);
        assert.deepEqual(tagsOf(root).filter((t) => FORBIDDEN_TAGS.includes(t)), []);

        // A carga só aparece como texto, higienizada: sem controles nem bidi, e com tamanho limitado.
        const text = allText(root);
        assert.doesNotMatch(text.replaceAll("\n", ""), /[\p{Cc}\p{Cf}]/u);
        for (const node of flatten(root)) assert.ok(Array.from(node.text ?? "").length <= 2100, `${node.tag} grande demais`);
        if (payload.name !== "texto enorme" && field.shown !== false) assert.ok(text.includes(payload.visible), `esperava o texto visível: ${payload.visible}`);

        // Nenhum atributo vem da carga (só href da URL final, e só se for http(s)).
        for (const [tag, name, value] of attributesOf(root)) {
          assert.doesNotMatch(name, /^on/i);
          assert.notEqual(name, "style");
          if (name === "href") {
            assert.equal(tag, "a");
            assert.match(String(value), /^https?:\/\//);
          } else {
            assert.equal(String(value).includes(payload.value.slice(0, 20)), false, `atributo ${name} contém a carga`);
          }
        }
      });
    }
  }
});

describe("XSS: URL final com esquema perigoso nunca vira link", () => {
  for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "\u202Ejavascript:alert(1)", "java\tscript:alert(1)", "https://u:p@exemplo.com/"]) {
    test(JSON.stringify(url).slice(0, 50), () => {
      const json = base();
      json.page.finalUrl = url;
      const root = render(json);
      for (const [, name, value] of attributesOf(root)) {
        if (name === "href") assert.match(String(value), /^https?:\/\/[^@]*$/);
      }
    });
  }
});

describe("XSS: URL da checagem (ClaimReview) com esquema perigoso nunca vira link", () => {
  for (const url of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,<script>1</script>", "vbscript:x", "\u202Ejavascript:alert(1)", "java\tscript:alert(1)", "https://u:p@checagem.example/", "//checagem.example/x"]) {
    test(JSON.stringify(url).slice(0, 50), () => {
      const json = base();
      claim(json)["url"] = url;
      const root = render(json);
      const hrefs = attributesOf(root).filter(([, name]) => name === "href").map(([, , value]) => String(value));
      assert.deepEqual(hrefs, ["https://exemplo.com.br/materia", "https://exemplo.com.br/materia"]);
    });
  }
});

describe("XSS: __proto__ e constructor no JSON não são lidos como herança", () => {
  const PAGE_FIELDS = '"finalUrl":"https://exemplo.com.br/materia","title":"T","headline":null';

  test("page com __proto__ e constructor (chaves próprias do JSON): nenhuma marcação aparece", () => {
    const text = `{"page":{${PAGE_FIELDS},"__proto__":{"claimReviews":[{"claimReviewed":"herdado"}]},"constructor":{"claimReviews":[{"claimReviewed":"do constructor"}]}},"media":[],"notices":[]}`;
    const report = parseReport(JSON.parse(text));
    assert.ok(report);
    assert.deepEqual(report.page.claimReviews, []);
    assert.doesNotMatch(allText(describeReport(report)), /herdado|do constructor|ClaimReview/);
  });

  test("marcação com __proto__ e constructor: só as chaves próprias conhecidas são lidas", () => {
    const item = '{"__proto__":{"claimReviewed":"herdado","url":"https://herdado.example/"},"constructor":{"ratingLabel":"x"},"ratingLabel":"Falso"}';
    const report = parseReport(JSON.parse(`{"page":{${PAGE_FIELDS},"claimReviews":[${item}]},"media":[],"notices":[]}`));
    assert.ok(report);
    assert.deepEqual(report.page.claimReviews, [
      { claimReviewed: null, ratingLabel: "Falso", ratingValue: null, bestRating: null, worstRating: null, url: null, authorName: null, datePublished: null },
    ]);
    const root = describeReport(report);
    assert.doesNotMatch(allText(root), /herdado/);
    assert.equal(attributesOf(root).some(([, , value]) => String(value).includes("herdado")), false);
  });

  test("herança de verdade (objeto com protótipo) também não é lida", () => {
    const json = apiExample();
    json.page = Object.assign(Object.create({ claimReviews: [claimReview()] }), json.page);
    let report = parseReport(json);
    assert.deepEqual(report?.page.claimReviews, []);
    const inherited = Object.assign(Object.create({ claimReviewed: "herdado", url: "https://herdado.example/" }), { ratingLabel: "Falso" });
    json.page = { ...apiExample().page, claimReviews: [inherited] };
    report = parseReport(json);
    assert.equal(report?.page.claimReviews[0]?.claimReviewed, null);
    assert.equal(report?.page.claimReviews[0]?.url, null);
    assert.equal(report?.page.claimReviews[0]?.ratingLabel, "Falso");
  });

  test("Object.prototype fica intacto depois do parse e da descrição", () => {
    const text = `{"page":{${PAGE_FIELDS},"__proto__":{"polluted":"sim"},"claimReviews":[{"__proto__":{"polluted":"sim"}}]},"media":[],"notices":[]}`;
    const report = parseReport(JSON.parse(text));
    assert.ok(report);
    describeReport(report);
    assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
    assert.equal(/** @type {Record<string, unknown>} */ ({})["polluted"], undefined);
  });
});

describe("XSS: o mount com o document falso mantém a carga como texto", () => {
  for (const payload of PAYLOADS) {
    test(payload.name, () => {
      const json = base();
      for (const field of FIELDS) field.set(json, payload.value);
      const root = render(json);
      assert.ok(allText(root).includes("Marcação 1"), "a seção de ClaimReview precisa estar na árvore montada");
      const { doc, created } = createFakeDocument();
      assert.doesNotThrow(() => mount(root, /** @type {never} */ (doc)));
      assert.equal(created.length, flatten(root).length, "só os nós do descritor viram elementos");
    });
  }
});

describe("XSS: varredura do código", () => {
  test("os módulos do relatório não usam as APIs que interpretam HTML", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["report-parse.js", "report-model.js", "report-describe.js", "report-mount.js", "report-view.js", "report-text.js", "report-classes.js", "sanitize.js", "safe-url.js"]) {
      const source = readFileSync(new URL(`../public/${file}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|createContextualFragment|DOMParser|\.srcdoc|setAttribute\(\s*["']on/, file);
      assert.doesNotMatch(source, /createElement\(\s*["'](img|script|iframe|svg)["']/, file);
    }
  });
});
