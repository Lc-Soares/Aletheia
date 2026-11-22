import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeReport } from "../public/report-describe.js";
import { parseReport } from "../public/report-parse.js";
import { summarizeSignals } from "../public/report-summary.js";
import {
  API_NOTICES,
  CLAIM_REVIEW_NOTICE_TEXT,
  FACT_CHECK_NOTICE_TEXT,
  FIXED_NOTICE_TEXT,
  SHA,
  apiExample,
  claimReview,
  factCheck,
  factCheckClaim,
  factCheckReview,
  okSignals,
  singleMedia,
  syntheticC2pa,
  variantsPage,
  withClaimReviews,
  withFactCheck,
} from "./fixtures/report-fixtures.js";
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

describe("relatório: marcação ClaimReview declarada pela página", () => {
  const HEADING = "Marcação de checagem declarada pela página (ClaimReview)";
  const LIMIT_TEXT = "Mostramos no máximo 5 marcações.";
  /** @param {Record<string, unknown>[]} marks */
  const withMarks = (marks) => {
    const json = apiExample();
    json.page["claimReviews"] = marks;
    return json;
  };
  /** Valor (dd) da linha com o rótulo dado, como texto, na ordem da árvore. @param {import("../public/report-describe.js").Descriptor} root @param {string} label */
  const valuesOf = (root, label) => {
    const nodes = flatten(root);
    return nodes.flatMap((node, i) => (node.tag === "dt" && node.text === label ? [allText(/** @type {never} */ (nodes[i + 1]))] : []));
  };

  test("ausente: nenhuma seção, nenhum aviso e nenhum texto de 'não encontrado'", () => {
    for (const json of [apiExample(), withMarks([])]) {
      const text = allText(tree(json));
      assert.doesNotMatch(text, /ClaimReview|checagem/i);
    }
  });

  test("seção entre a página analisada e as mídias, com título, aviso fixo, explicação e contagem", () => {
    const root = tree(withClaimReviews(1));
    const headings = byTag(root, "h3").map((h) => h.text);
    assert.deepEqual(headings.slice(-3), ["Página analisada", HEADING, "Mídias"]);
    const text = allText(root);
    assert.ok(text.includes(CLAIM_REVIEW_NOTICE_TEXT));
    assert.ok(text.includes("Qualquer site pode publicar essa marcação. O conteúdo abaixo foi declarado pela página, não pelo Aletheia."));
    assert.ok(text.includes("1 marcação ClaimReview encontrada."));
    assert.ok(allText(tree(withClaimReviews(2))).includes("2 marcações ClaimReview encontradas."));
  });

  test("a fonte fica sempre visível: domínio e endereço da página que declarou", () => {
    const root = tree(withClaimReviews(1));
    const [source] = valuesOf(root, "Declarada por");
    assert.ok(source?.includes("exemplo.com.br"));
    assert.ok(source?.includes("https://exemplo.com.br/materia"));
    const json = withClaimReviews(1);
    json.page.finalUrl = null;
    assert.deepEqual(valuesOf(tree(json), "Declarada por"), ["Não informado"]);
  });

  test("cada marcação: afirmação, avaliação citada entre aspas, nota, autor, data e endereço", () => {
    const root = tree(withMarks([claimReview()]));
    assert.deepEqual(byTag(root, "h4").map((h) => h.text).filter((t) => t?.startsWith("Marcação")), ["Marcação 1"]);
    assert.deepEqual(valuesOf(root, "Afirmação checada (segundo a página)"), ["A Terra é plana"]);
    assert.deepEqual(valuesOf(root, "Avaliação declarada pela página"), ["“Falso”"]);
    assert.deepEqual(valuesOf(root, "Nota declarada"), ["1 (escala de 1 a 5)"]);
    assert.deepEqual(valuesOf(root, "Quem publicou a checagem (declarado)"), ["Agência de Checagem"]);
    assert.deepEqual(valuesOf(root, "Data da checagem (declarada)"), ["2024-06-22"]);
    assert.deepEqual(valuesOf(root, "Endereço da checagem (declarado)"), ["https://checagem.example/terra-plana"]);
  });

  test("nota: sem escala quando faltam os extremos; sem linha quando falta a nota", () => {
    assert.deepEqual(valuesOf(tree(withMarks([claimReview({ bestRating: null })])), "Nota declarada"), ["1"]);
    assert.deepEqual(valuesOf(tree(withMarks([claimReview({ ratingValue: null })])), "Nota declarada"), []);
  });

  test("campos ausentes aparecem como 'Não informado'", () => {
    const empty = { claimReviewed: null, ratingLabel: null, ratingValue: null, bestRating: null, worstRating: null, url: null, authorName: null, datePublished: null };
    const root = tree(withMarks([empty]));
    for (const label of ["Afirmação checada (segundo a página)", "Avaliação declarada pela página", "Quem publicou a checagem (declarado)", "Data da checagem (declarada)", "Endereço da checagem (declarado)"]) {
      assert.deepEqual(valuesOf(root, label), ["Não informado"], label);
    }
  });

  test("endereço http(s) vira link seguro cujo texto é sempre o endereço completo", () => {
    const url = "https://checagem.example/terra-plana?x=1";
    const links = byTag(tree(withMarks([claimReview({ url })])), "a").filter((a) => a.attrs?.["href"] === url);
    assert.equal(links.length, 1);
    assert.deepEqual(links[0], { tag: "a", text: url, attrs: { class: "report-link", href: url, rel: "noopener noreferrer nofollow", target: "_blank" } });
  });

  test("endereço que não é http(s) ou tem usuário e senha fica só como texto, sem link", () => {
    for (const url of ["javascript:alert(1)", "https://u:p@checagem.example/", "/relativa", "data:text/html,x"]) {
      const root = tree(withMarks([claimReview({ url })]));
      assert.equal(attributesOf(root).some(([, name, value]) => name === "href" && value !== "https://exemplo.com.br/materia"), false, url);
      assert.deepEqual(valuesOf(root, "Endereço da checagem (declarado)"), [url]);
    }
  });

  test("exatamente 5 marcações: avisa que mostramos no máximo 5; com 4, não", () => {
    assert.ok(allText(tree(withClaimReviews(5))).includes(LIMIT_TEXT));
    assert.equal(allText(tree(withClaimReviews(4))).includes(LIMIT_TEXT), false);
    assert.ok(allText(tree(withClaimReviews(8))).includes(LIMIT_TEXT)); // o parse já cortou em 5
  });

  test("nenhum veredito do Aletheia: o rótulo só aparece como citação; o resumo não muda", () => {
    const json = withClaimReviews(1);
    const root = tree(json);
    let text = allText(root).replace("“Falso”", "").replace(FIXED_NOTICE_TEXT, "").replace(/Isso não indica fraude\./g, "");
    for (const notice of API_NOTICES) text = text.replace(notice, "");
    assert.doesNotMatch(text, /verdadeir|fals[ao]|fraud|fake|mentira/i);
    const report = parseReport(json);
    const plain = parseReport(apiExample());
    assert.ok(report && plain);
    assert.deepEqual(summarizeSignals(report), summarizeSignals(plain));
  });

  test("sem cor nem tag nova: só as tags e classes que o relatório já usa", () => {
    const known = new Set(tagsOf(tree(apiExample())));
    for (const tag of tagsOf(tree(withClaimReviews(5)))) assert.ok(known.has(tag) || tag === "a", tag);
    for (const [, name] of attributesOf(tree(withClaimReviews(1)))) assert.notEqual(name, "style");
  });
});

describe("relatório: checagens publicadas (Google Fact Check Tools)", () => {
  const HEADING = "Checagens publicadas sobre afirmações parecidas (Google Fact Check Tools)";
  const SEARCHED = "Buscamos por: «Manchete da matéria»";
  const SENT = "Esse texto foi enviado ao Google Fact Check Tools.";
  const EMPTY = "Nenhuma checagem encontrada para esse texto. Isso não diz nada sobre a matéria: a busca depende das palavras usadas e só cobre checagens que o Google indexou.";
  /** @param {import("../public/report-describe.js").Descriptor} root @param {string} label */
  const valuesOf = (root, label) => {
    const nodes = flatten(root);
    return nodes.flatMap((node, i) => (node.tag === "dt" && node.text === label ? [allText(/** @type {never} */ (nodes[i + 1]))] : []));
  };
  /** @param {Record<string, unknown>} review */
  const withReview = (review) => withFactCheck(factCheck({ claims: [factCheckClaim({ reviews: [factCheckReview(review)] })] }));

  test("campo ausente (API anterior): nenhuma seção", () => {
    const text = allText(tree(apiExample()));
    assert.equal(text.includes(HEADING), false);
    assert.doesNotMatch(text, /Fact Check|Buscamos por/);
  });

  test("seção depois da página (e da marcação ClaimReview) e antes das mídias", () => {
    assert.deepEqual(byTag(tree(withFactCheck(factCheck())), "h3").map((h) => h.text).slice(-3), ["Página analisada", HEADING, "Mídias"]);
    const both = withClaimReviews(1);
    both.factCheck = factCheck();
    assert.deepEqual(byTag(tree(both), "h3").map((h) => h.text).slice(-4), ["Página analisada", "Marcação de checagem declarada pela página (ClaimReview)", HEADING, "Mídias"]);
  });

  test("sempre mostra o texto enviado, a linha de envio ao Google e o aviso fixo", () => {
    for (const status of ["ok", "unavailable"]) {
      const text = allText(tree(withFactCheck(factCheck({ status }))));
      assert.ok(text.includes(SEARCHED), status);
      assert.ok(text.includes(SENT), status);
      assert.ok(text.includes(FACT_CHECK_NOTICE_TEXT), status);
    }
  });

  test("cada afirmação e cada checagem: texto, quem afirmou, datas, publicador, rótulo entre aspas, título, idioma e endereço", () => {
    const root = tree(withFactCheck(factCheck()));
    assert.ok(byTag(root, "h4").some((h) => h.text === "Afirmação 1"));
    assert.deepEqual(valuesOf(root, "Afirmação checada (segundo o publicador)"), ["Crime has doubled in the last 2 years."]);
    assert.deepEqual(valuesOf(root, "Quem afirmou (segundo o publicador)"), ["John Doe"]);
    assert.deepEqual(valuesOf(root, "Data da afirmação"), ["2014-10-02T15:01:23.045123456Z"]);
    assert.deepEqual(valuesOf(root, "Publicado por"), ["Awesome Fact Checks (awesomefactchecks.com)"]);
    assert.deepEqual(valuesOf(root, "Avaliação do publicador"), ["“Mostly false”"]);
    assert.deepEqual(valuesOf(root, "Título da checagem"), ["Has crime doubled in the last 2 years?"]);
    assert.deepEqual(valuesOf(root, "Data da checagem"), ["2014-10-02T15:01:23Z"]);
    assert.deepEqual(valuesOf(root, "Idioma da checagem"), ["en"]);
    assert.deepEqual(valuesOf(root, "Endereço da checagem"), ["https://awesomefactchecks.com/checagem/crime-doubled"]);
  });

  test("campos ausentes aparecem como 'Não informado'; publicador só com o nome ou só com o site", () => {
    const empty = { publisherName: null, publisherSite: null, url: null, title: null, reviewDate: null, textualRating: null, languageCode: null };
    const root = tree(withFactCheck(factCheck({ claims: [{ text: null, claimant: null, claimDate: null, reviews: [empty] }] })));
    for (const label of ["Afirmação checada (segundo o publicador)", "Quem afirmou (segundo o publicador)", "Data da afirmação", "Publicado por", "Avaliação do publicador", "Título da checagem", "Data da checagem", "Idioma da checagem", "Endereço da checagem"]) {
      assert.deepEqual(valuesOf(root, label), ["Não informado"], label);
    }
    assert.deepEqual(valuesOf(tree(withReview({ publisherSite: null })), "Publicado por"), ["Awesome Fact Checks"]);
    assert.deepEqual(valuesOf(tree(withReview({ publisherName: null })), "Publicado por"), ["awesomefactchecks.com"]);
  });

  test("a ordem é a do Google: sem ordenação por rótulo", () => {
    const claims = [factCheckClaim({ text: "Primeira", reviews: [factCheckReview({ textualRating: "True" })] }), factCheckClaim({ text: "Segunda", reviews: [factCheckReview({ textualRating: "False" })] })];
    const root = tree(withFactCheck(factCheck({ claims })));
    assert.deepEqual(valuesOf(root, "Afirmação checada (segundo o publicador)"), ["Primeira", "Segunda"]);
  });

  test("endereço http(s) vira link seguro cujo texto é o próprio endereço; outro esquema fica só texto", () => {
    const url = "https://awesomefactchecks.com/checagem/crime-doubled?x=1";
    const links = byTag(tree(withReview({ url })), "a").filter((a) => a.attrs?.["href"] === url);
    assert.deepEqual(links, [{ tag: "a", text: url, attrs: { class: "report-link", href: url, rel: "noopener noreferrer nofollow", target: "_blank" } }]);
    for (const bad of ["javascript:alert(1)", "https://u:p@checagem.example/", "/relativa", "data:text/html,x"]) {
      const root = tree(withReview({ url: bad }));
      assert.equal(attributesOf(root).some(([, name, value]) => name === "href" && value !== "https://exemplo.com.br/materia"), false, bad);
      assert.deepEqual(valuesOf(root, "Endereço da checagem"), [bad]);
    }
  });

  test("nenhuma checagem: aviso de que isso não diz nada sobre a matéria", () => {
    const text = allText(tree(withFactCheck(factCheck({ claims: [] }))));
    assert.ok(text.includes(EMPTY));
    assert.ok(text.includes(SEARCHED));
  });

  test("indisponível, sem texto para buscar e sem chave: cada um com o seu texto, sem detalhe técnico", () => {
    /** @type {Array<[string, string]>} */
    const cases = [
      ["unavailable", "Não foi possível consultar as checagens agora."],
      ["skipped", "Não buscamos checagens: a página não tem manchete nem título."],
      ["not_configured", "A busca de checagens não está ativa neste ambiente."],
    ];
    for (const [status, expected] of cases) {
      const text = allText(tree(withFactCheck(factCheck({ status }))));
      assert.ok(text.includes(String(expected)), status);
      assert.equal(text.includes(EMPTY), false, status);
      assert.doesNotMatch(text, /http_|429|403|timeout/);
    }
    for (const status of ["skipped", "not_configured"]) {
      const text = allText(tree(withFactCheck(factCheck({ status }))));
      assert.equal(text.includes("Buscamos por"), false, status);
      assert.equal(text.includes(SENT), false, status);
    }
  });

  test("nenhum veredito do Aletheia: o rótulo só aparece entre aspas; o resumo de sinais não muda", () => {
    const json = withReview({ textualRating: "Falso" });
    let text = allText(tree(json)).replace("“Falso”", "").replace(FIXED_NOTICE_TEXT, "").replace(/Isso não indica fraude\./g, "");
    for (const notice of API_NOTICES) text = text.replace(notice, "");
    assert.doesNotMatch(text, /verdadeir|fals[ao]|fraud|fake|mentira/i);
    const report = parseReport(json);
    const plain = parseReport(apiExample());
    assert.ok(report && plain);
    assert.deepEqual(summarizeSignals(report), summarizeSignals(plain));
  });

  test("sem cor nem tag nova: só as tags e classes que o relatório já usa", () => {
    const known = new Set(tagsOf(tree(apiExample())));
    for (const tag of tagsOf(tree(withFactCheck(factCheck())))) assert.ok(known.has(tag) || tag === "a", tag);
    for (const [, name] of attributesOf(tree(withFactCheck(factCheck())))) assert.notEqual(name, "style");
  });
});
