import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeReport } from "../public/report-describe.js";
import { parseReport } from "../public/report-parse.js";
import { API_NOTICES, FIXED_NOTICE_TEXT, SHA, apiExample, okSignals, singleMedia, syntheticC2pa, variantsPage } from "./fixtures/report-fixtures.js";
import { allText, attributesOf, byTag, flatten, nodesWithText, tagsOf } from "./tree.js";

/** @param {unknown} json */
function tree(json) {
  const report = parseReport(json);
  assert.ok(report, "fixture inválida");
  return describeReport(report);
}

/** @param {Record<string, unknown>} overrides */
const withSignals = (overrides) => singleMedia({ status: "ok", signals: { ...okSignals(), ...overrides } });

describe("relatório: topo e avisos", () => {
  test("título do relatório é um h2 com id e tabindex -1 (alvo do foco)", () => {
    const root = tree(apiExample());
    const headings = byTag(root, "h2");
    assert.equal(headings.length, 1);
    assert.equal(headings[0]?.attrs?.["id"], "report-title");
    assert.equal(headings[0]?.attrs?.["tabindex"], "-1");
    assert.equal(headings[0]?.text, "Relatório de sinais");
  });

  test("aviso fixo no topo e TODOS os notices da API, em lista", () => {
    const root = tree(apiExample());
    const text = allText(root);
    assert.ok(text.includes(FIXED_NOTICE_TEXT));
    assert.ok(text.indexOf(FIXED_NOTICE_TEXT) < text.indexOf(API_NOTICES[0] ?? ""));
    const items = byTag(root, "li").map((li) => li.text);
    for (const notice of API_NOTICES) assert.ok(items.includes(notice), notice);
  });

  test("o aviso de JavaScript vem de notices e não é duplicado", () => {
    const json = apiExample();
    json.page.possiblyNeedsJavaScript = true;
    const jsNotice = "Esta página possivelmente depende de JavaScript; parte das mídias pode não ter sido listada.";
    json.notices = [...json.notices, jsNotice];
    assert.equal(nodesWithText(tree(json), "JavaScript").length, 1);
    json.notices = API_NOTICES;
    assert.equal(nodesWithText(tree(json), "JavaScript").length, 0);
  });

  test("nunca fala em veredito: sem 'verdadeiro', 'falso' ou 'fraude' fora dos avisos combinados", () => {
    // O aviso fixo e os avisos da API são textos combinados; o resto é texto do próprio relatório.
    let text = allText(tree(variantsPage())).replace(FIXED_NOTICE_TEXT, "").replace(/Isso não indica fraude\./g, "");
    for (const notice of API_NOTICES) text = text.replace(notice, "");
    assert.doesNotMatch(text, /verdadeir|falso|fals[ao]|fraud|fake|mentira|confiável: |autêntic/i);
  });
});

describe("relatório: página", () => {
  test("título, manchete e URL final como texto", () => {
    const text = allText(tree(apiExample()));
    for (const expected of ["Título da matéria", "Manchete da matéria", "https://exemplo.com.br/materia"]) assert.ok(text.includes(expected), expected);
  });

  test("URL final http(s) vira link seguro", () => {
    const links = byTag(tree(apiExample()), "a");
    assert.equal(links.length, 1);
    assert.equal(links[0]?.attrs?.["href"], "https://exemplo.com.br/materia");
    assert.equal(links[0]?.attrs?.["rel"], "noopener noreferrer nofollow");
    assert.equal(links[0]?.attrs?.["target"], "_blank");
    assert.equal(links[0]?.text, "https://exemplo.com.br/materia");
  });

  test("URL final que não é http(s) ou tem usuário e senha fica só como texto, sem link", () => {
    const bads = [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "ftp://exemplo.com/arquivo",
      "file:///etc/passwd",
      "//exemplo.com/x",
      "exemplo.com/sem-esquema",
      "https://usuario:senha@exemplo.com/",
      "https://usuario@exemplo.com/",
      "http://",
      "não é url",
    ];
    for (const bad of bads) {
      const json = apiExample();
      json.page.finalUrl = bad;
      const root = tree(json);
      assert.equal(byTag(root, "a").length, 0, bad);
      assert.ok(allText(root).includes(bad), `o texto deve continuar visível: ${bad}`);
    }
  });

  test("campos ausentes aparecem como 'Não informado'", () => {
    const root = tree({ page: {}, media: [], notices: [] });
    assert.equal(nodesWithText(root, "Não informado").length, 3);
  });
});

describe("relatório: mídias agrupadas", () => {
  test("uma linha por grupo; o representante é o item que não é 'variant'", () => {
    const root = tree(variantsPage());
    const headings = byTag(root, "h4").map((h) => h.text);
    assert.deepEqual(headings, ["Mídia 1", "Mídia 2", "Mídia 3", "Mídia 4", "Mídia 5", "Mídia 6"]);
    const text = allText(root);
    assert.ok(text.includes("https://exemplo.com.br/a-1600.jpg"));
    assert.equal(text.includes("a-480.jpg"), false);
    assert.equal(text.includes("a-800.jpg"), false);
    assert.equal(text.includes("logo-2x.png"), false);
  });

  test("mostra '+N variantes' (plural) e '+1 variante' (singular)", () => {
    const root = tree(variantsPage());
    assert.equal(nodesWithText(root, "+2 variantes").length, 1);
    assert.equal(nodesWithText(root, "+1 variante").length, 1);
    assert.equal(nodesWithText(root, "+1 variantes").length, 0);
  });

  test("grupo só com variantes (defensivo): usa o primeiro item como representante", () => {
    const json = apiExample();
    json.media = [
      { ...json.media[2], url: "https://e.com/v1.png", group: 1, skipReason: "variant" },
      { ...json.media[2], url: "https://e.com/v2.png", group: 1, skipReason: "variant" },
    ];
    const text = allText(tree(json));
    assert.ok(text.includes("https://e.com/v1.png"));
    assert.equal(text.includes("v2.png"), false);
  });

  test("os grupos saem na ordem do campo group, mesmo com a lista embaralhada", () => {
    const json = variantsPage();
    json.media.reverse();
    const urls = nodesWithText(tree(json), "https://exemplo.com.br/").map((n) => n.text);
    assert.ok((urls.findIndex((u) => u?.includes("a-1600")) ?? 0) < urls.findIndex((u) => u?.includes("logo-1x")));
  });

  test("a URL da mídia aparece como texto e NUNCA como link", () => {
    const root = tree(variantsPage());
    const links = byTag(root, "a").map((a) => a.attrs?.["href"]);
    assert.deepEqual(links, ["https://exemplo.com.br/materia"]);
    assert.equal(nodesWithText(root, "https://exemplo.com.br/a-1600.jpg").length, 1);
  });

  test("sem miniaturas nem tags de mídia ou script", () => {
    const tags = tagsOf(tree(variantsPage()));
    for (const forbidden of ["img", "picture", "video", "audio", "source", "iframe", "script", "svg", "object", "embed", "link", "style", "canvas", "input", "button", "form"]) {
      assert.equal(tags.includes(forbidden), false, forbidden);
    }
  });
});

describe("relatório: mídias ignoradas", () => {
  /** @type {Array<[number, string]>} */
  const reasons = [
    [2, "Parece ícone ou elemento de interface"],
    [3, "Formato que não conseguimos analisar (SVG)"],
    [4, "Parece elemento secundário da página"],
    [5, "Fora do limite de mídias analisadas por verificação"],
    [6, "Não analisada"],
  ];
  for (const [position, expected] of reasons) {
    test(`Mídia ${position}: "${expected}"`, () => {
      const root = tree(variantsPage());
      assert.equal(nodesWithText(root, expected).length >= 1, true);
    });
  }

  test("o motivo cru da API nunca aparece na tela", () => {
    const text = allText(tree(variantsPage()));
    for (const raw of ["unsupported_format", "low_score", "skipReason", "icon"]) assert.equal(text.includes(raw), false, raw);
  });

  test("explica que a seleção é automática e heurística e que uma ignorada pode ser relevante", () => {
    const text = allText(tree(variantsPage()));
    assert.match(text, /automática e heurística/);
    assert.match(text, /mídia ignorada pode ser relevante/);
  });

  test("mídia ignorada não mostra download nem metadados", () => {
    const root = tree(variantsPage());
    const ignoredText = allText(root);
    assert.equal(nodesWithText(root, "SHA-256").length, 1); // só a analisada
    assert.ok(ignoredText.includes("Parece ícone"));
  });
});

describe("relatório: estados vazios", () => {
  test("nenhuma mídia encontrada", () => {
    const json = apiExample();
    json.media = [];
    const root = tree(json);
    assert.equal(nodesWithText(root, "Nenhuma mídia encontrada").length, 1);
    assert.equal(byTag(root, "h4").length, 0);
  });

  test("todas ignoradas: avisa e ainda lista os grupos", () => {
    const json = apiExample();
    json.media = json.media.slice(2);
    const root = tree(json);
    assert.equal(nodesWithText(root, "Todas as mídias encontradas foram ignoradas").length, 1);
    assert.equal(byTag(root, "h4").length, 1);
  });

  test("com alguma analisada, nenhum dos dois avisos aparece", () => {
    const root = tree(apiExample());
    assert.equal(nodesWithText(root, "Nenhuma mídia encontrada").length, 0);
    assert.equal(nodesWithText(root, "Todas as mídias encontradas foram ignoradas").length, 0);
  });
});

describe("relatório: download e metadata.status", () => {
  test("download com erro mostra a message do servidor, como texto", () => {
    const root = tree(apiExample());
    assert.equal(nodesWithText(root, "Não foi possível acessar este endereço.").length, 1);
  });

  test("download com erro sem message: texto próprio", () => {
    const json = apiExample();
    /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (json.media[1])).download = { status: "error" };
    assert.equal(nodesWithText(tree(json), "Não foi possível baixar esta mídia.").length, 1);
  });

  /** @type {Array<[string, string]>} */
  const statuses = [
    ["unavailable", "Análise de metadados indisponível no momento."],
    ["unsupported", "Formato não suportado pela análise de metadados."],
    ["too_large", "Arquivo grande demais para a análise de metadados."],
    ["error", "Não foi possível analisar os metadados deste arquivo."],
    ["not_analyzed", "Fora do limite de mídias analisadas por verificação."],
  ];
  for (const [status, expected] of statuses) {
    test(`metadata ${status}: texto próprio em português, sem sinais`, () => {
      const root = tree(singleMedia({ status, message: "texto qualquer do servidor" }));
      assert.equal(nodesWithText(root, expected).length, 1);
      assert.equal(nodesWithText(root, "texto qualquer do servidor").length, 0);
      assert.equal(nodesWithText(root, "SHA-256").length, 0);
    });
  }

  test("status desconhecido usa a message do servidor, escapada, ou um texto genérico", () => {
    assert.equal(nodesWithText(tree(singleMedia({ status: "novo", message: "Mensagem nova" })), "Mensagem nova").length, 1);
    assert.equal(nodesWithText(tree(singleMedia({ status: "novo" })), "Não foi possível analisar os metadados deste arquivo.").length, 1);
  });

  test("baixada mas sem metadata: texto simples", () => {
    const json = apiExample();
    /** @type {Record<string, unknown>} */ (json.media[0]).metadata = null;
    assert.equal(nodesWithText(tree(json), "Metadados não disponíveis").length, 1);
  });
});

describe("relatório: sinais (metadata ok)", () => {
  test("tipo de arquivo, dimensões, SHA-256, câmera e datas com rótulo", () => {
    const root = tree(apiExample());
    const text = allText(root);
    assert.ok(text.includes("JPEG"));
    assert.ok(text.includes("8192 x 5464"));
    assert.ok(text.includes("Canon"));
    assert.ok(text.includes("Canon EOS R5"));
    assert.ok(text.includes("Data original da captura (EXIF)"));
    assert.ok(text.includes("2026:03:15 10:30:00"));
  });

  test("SHA-256 em elemento code (fonte monoespaçada)", () => {
    const codes = byTag(tree(apiExample()), "code");
    assert.ok(codes.some((c) => c.text === SHA));
  });

  test("software: cada item aparece", () => {
    const text = allText(tree(withSignals({ software: ["Adobe Photoshop 25.0", "GIMP"] })));
    assert.ok(text.includes("Adobe Photoshop 25.0"));
    assert.ok(text.includes("GIMP"));
  });

  test("tag de data desconhecida aparece como veio (higienizada)", () => {
    const text = allText(tree(withSignals({ dates: [{ tag: "EXIF:OutraData", value: "2020:01:01 00:00:00" }] })));
    assert.ok(text.includes("EXIF:OutraData"));
  });

  test("campos ausentes não geram linhas vazias nem 'null' ou 'undefined'", () => {
    const root = tree(withSignals({ fileType: null, width: null, height: null, sha256: null, dates: [], camera: null, software: [] }));
    const text = allText(root);
    assert.doesNotMatch(text, /null|undefined|NaN/);
    assert.equal(nodesWithText(root, "Dimensões").length, 0);
    assert.equal(nodesWithText(root, "Câmera").length, 0);
    assert.equal(nodesWithText(root, "SHA-256").length, 0);
  });

  test("só uma das dimensões: não mostra 'x'", () => {
    assert.equal(nodesWithText(tree(withSignals({ height: null })), "Dimensões").length, 0);
  });

  test("localização e autoria: só as frases combinadas, sem valores", () => {
    const yes = allText(tree(withSignals({ containsLocation: true, containsAuthorship: true })));
    assert.ok(yes.includes("Contém dados de localização (não exibidos)"));
    assert.ok(yes.includes("Contém autoria declarada nos metadados (não exibida)"));
    const no = allText(tree(withSignals({ containsLocation: false, containsAuthorship: false })));
    assert.ok(no.includes("Não encontramos dados de localização"));
    assert.ok(no.includes("Não encontramos autoria declarada"));
  });

  test("localização e autoria desconhecidas (tipo errado): linha omitida, sem afirmar ausência", () => {
    const text = allText(tree(withSignals({ containsLocation: "talvez", containsAuthorship: 3 })));
    assert.doesNotMatch(text, /localização|autoria/i);
  });

  test("mesmo que o servidor mande coordenadas, endereço ou nome do autor, nada disso é exibido", () => {
    const json = withSignals({
      containsLocation: true,
      containsAuthorship: true,
      latitude: -23.55052,
      longitude: -46.633308,
      gpsCoordinates: { lat: -23.55, lng: -46.63 },
      address: "Avenida Paulista, 1000",
      author: "Maria Fotógrafa",
      artist: "Maria Fotógrafa",
      copyright: "© Maria",
    });
    const text = allText(tree(json));
    for (const leaked of ["23.55", "46.63", "Paulista", "Maria", "©"]) assert.equal(text.includes(leaked), false, leaked);
  });
});

describe("relatório: C2PA", () => {
  test("c2pa null: 'Nenhuma assinatura C2PA encontrada. Isso não indica fraude.'", () => {
    assert.equal(nodesWithText(tree(apiExample()), "Nenhuma assinatura C2PA encontrada. Isso não indica fraude.").length, 1);
  });

  test("c2pa de tipo errado (desconhecido): não afirma nada sobre C2PA", () => {
    const json = withSignals({ c2pa: "x" });
    json.notices = []; // os avisos fixos da API falam de C2PA; aqui só interessa o bloco da mídia
    assert.doesNotMatch(allText(tree(json)), /C2PA/);
  });

  test("[fixture SINTÉTICA] mostra estado, signatário, data, gerador, IA e contagem de verificações", () => {
    const text = allText(tree(withSignals({ c2pa: syntheticC2pa() })));
    assert.ok(text.includes("Signatário na lista anterior de Content Credentials"));
    assert.ok(text.includes("Assinante Sintético Ltda."));
    assert.ok(text.includes("2023-10-02T16:51:02+00:00"));
    assert.ok(text.includes("Gerador Sintético 1.0"));
    assert.ok(text.includes("Marcado como gerado por IA nos metadados C2PA"));
    assert.ok(text.includes("2 com sucesso, 1 com falha"));
    assert.doesNotMatch(text, /Nenhuma assinatura C2PA/);
  });

  test("[SINTÉTICA] aiGenerated false e null", () => {
    const no = allText(tree(withSignals({ c2pa: { ...syntheticC2pa(), aiGenerated: false } })));
    assert.ok(no.includes("Não marcado como gerado por IA nos metadados C2PA"));
    const unknown = allText(tree(withSignals({ c2pa: { ...syntheticC2pa(), aiGenerated: null } })));
    assert.doesNotMatch(unknown, /gerado por IA/);
  });

  test("[SINTÉTICA] campos ausentes não são supostos", () => {
    const root = tree(withSignals({ c2pa: { state: "valid" } }));
    const text = allText(root);
    assert.ok(text.includes("Assinatura e arquivo íntegros; signatário fora das listas de confiança"));
    const labels = byTag(root, "dt").map((dt) => dt.text);
    assert.ok(labels.includes("Estado"));
    for (const absent of ["Signatário", "Data da assinatura", "Gerador", "Marcação de IA", "Verificações"]) assert.equal(labels.includes(absent), false, absent);
    assert.doesNotMatch(text, /null|undefined/);
  });

  test("[SINTÉTICA] C2PA vazio: diz que há assinatura sem detalhes legíveis", () => {
    assert.equal(nodesWithText(tree(withSignals({ c2pa: {} })), "sem detalhes legíveis").length, 1);
  });

  test("[SINTÉTICA] estado inválido mostra o motivo; estado e motivo desconhecidos aparecem como vieram", () => {
    const invalid = allText(tree(withSignals({ c2pa: { state: "invalid", reason: "changed" } })));
    assert.ok(invalid.includes("Assinatura inválida"));
    assert.ok(invalid.includes("arquivo alterado depois da assinatura"));
    const unknown = allText(tree(withSignals({ c2pa: { state: "estado_novo", reason: "motivo_novo" } })));
    assert.ok(unknown.includes("estado_novo"));
    assert.ok(unknown.includes("motivo_novo"));
  });

  test("[SINTÉTICA] verificações: só success e failure entram na conta", () => {
    const checks = [{ code: "a", outcome: "info" }, { code: "b", outcome: "desconhecido" }, { code: "c", outcome: null }];
    const text = allText(tree(withSignals({ c2pa: { state: "valid", checks } })));
    assert.ok(text.includes("0 com sucesso, 0 com falha"));
  });
});

describe("relatório: árvore", () => {
  test("só tags de uma lista fechada e nenhum atributo on* nem style", () => {
    const root = tree(withSignals({ c2pa: syntheticC2pa(), containsLocation: true }));
    const allowed = ["a", "code", "dd", "div", "dl", "dt", "h2", "h3", "h4", "h5", "li", "p", "section", "span", "strong", "ul"];
    for (const tag of tagsOf(root)) assert.ok(allowed.includes(tag), tag);
    for (const [, name] of attributesOf(root)) {
      assert.doesNotMatch(name, /^on/i);
      assert.notEqual(name, "style");
    }
  });

  test("hierarquia de títulos: h2 → h3 → h4 → h5, sem pular nível", () => {
    const levels = flatten(tree(withSignals({ c2pa: syntheticC2pa() })))
      .filter((n) => /^h\d$/.test(n.tag))
      .map((n) => Number(n.tag.slice(1)));
    assert.equal(levels[0], 2);
    for (let i = 1; i < levels.length; i++) assert.ok((levels[i] ?? 0) - (levels[i - 1] ?? 0) <= 1);
  });

  test("os nós têm só as chaves tag, text, attrs e children (sem campo de HTML cru)", () => {
    for (const node of flatten(tree(variantsPage()))) {
      for (const key of Object.keys(node)) assert.ok(["tag", "text", "attrs", "children"].includes(key), key);
    }
  });

  test("não usa o console", () => {
    /** @type {string[]} */
    const written = [];
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (console));
    const saved = target["log"];
    target["log"] = () => written.push("log");
    try {
      tree(variantsPage());
    } finally {
      target["log"] = saved;
    }
    assert.deepEqual(written, []);
  });
});
