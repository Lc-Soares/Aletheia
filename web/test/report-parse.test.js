import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseReport } from "../public/report-parse.js";
import { API_NOTICES, SHA, apiExample, okSignals, syntheticC2pa } from "./fixtures/report-fixtures.js";

/** @param {unknown} json */
const parsed = (json) => /** @type {NonNullable<ReturnType<typeof parseReport>>} */ (parseReport(json));

/** Sinais crus (mutáveis) da primeira mídia do exemplo. */
const rawSignals = (/** @type {ReturnType<typeof apiExample>} */ json) =>
  /** @type {{ metadata: { signals: Record<string, unknown> } }} */ (/** @type {unknown} */ (json.media[0])).metadata.signals;

/** @param {unknown} json */
const signalsOf = (json) => {
  const metadata = parsed(json).media[0]?.metadata;
  assert.equal(metadata?.status, "ok");
  return /** @type {{ signals: import("../public/report-parse.js").Signals }} */ (metadata).signals;
};

describe("parseReport: formato geral", () => {
  test("o exemplo de docs/api.md é aceito", () => {
    const report = parsed(apiExample());
    assert.equal(report.page.title, "Título da matéria");
    assert.equal(report.page.headline, "Manchete da matéria");
    assert.equal(report.page.finalUrl, "https://exemplo.com.br/materia");
    assert.equal(report.media.length, 3);
    assert.deepEqual(report.notices, API_NOTICES);
  });

  test("resposta fora do formato vira null", () => {
    /** @type {unknown[]} */
    const bad = [null, undefined, 42, "texto", true, [], [apiExample()], {}, { page: {}, media: "x" }, { page: [], media: [] }, { page: null, media: [] }, { media: [] }, { page: {} }];
    for (const json of bad) assert.equal(parseReport(json), null, JSON.stringify(json));
  });

  test("mínimo aceito: page objeto e media lista; o resto vira ausente", () => {
    const report = parsed({ page: {}, media: [] });
    assert.deepEqual(report, { page: { finalUrl: null, title: null, headline: null }, notices: [], media: [] });
  });

  test("notices: só textos, no máximo 20; tipo errado vira lista vazia", () => {
    assert.deepEqual(parsed({ page: {}, media: [], notices: "aviso" }).notices, []);
    assert.deepEqual(parsed({ page: {}, media: [], notices: { a: 1 } }).notices, []);
    assert.deepEqual(parsed({ page: {}, media: [], notices: ["a", 1, null, "", "b"] }).notices, ["a", "b"]);
    const many = Array.from({ length: 50 }, (_, i) => `aviso ${i}`);
    assert.equal(parsed({ page: {}, media: [], notices: many }).notices.length, 20);
  });

  test("campos de page com tipo errado viram ausentes sem derrubar os outros", () => {
    const json = { page: { finalUrl: 42, title: ["x"], headline: "Manchete" }, media: [] };
    assert.deepEqual(parsed(json).page, { finalUrl: null, title: null, headline: "Manchete" });
  });

  test("teto de 200 mídias", () => {
    const json = apiExample();
    const base = /** @type {object} */ (json.media[2]);
    json.media = Array.from({ length: 500 }, (_, i) => ({ ...base, url: `https://e.com/${i}.png`, group: i + 1 }));
    assert.equal(parsed(json).media.length, 200);
  });
});

describe("parseReport: mídias", () => {
  test("item que não é objeto ou sem url texto é descartado; o resto fica", () => {
    const json = apiExample();
    json.media = [.../** @type {Array<Record<string, any>>} */ (/** @type {unknown} */ ([null, 7, "x", { group: 1 }, { url: 5, group: 2 }, { url: "", group: 3 }])), { ...json.media[0] }];
    const report = parsed(json);
    assert.equal(report.media.length, 1);
    assert.equal(report.media[0]?.url, "https://exemplo.com.br/foto.jpg");
  });

  test("group inválido não derruba o item: cada um vira um grupo próprio", () => {
    const json = apiExample();
    for (const bad of ["1", 0, -3, 1.5, null, undefined, NaN]) {
      /** @type {Record<string, unknown>} */ (json.media[0]).group = bad;
      /** @type {Record<string, unknown>} */ (json.media[1]).group = bad;
      const [a, b] = parsed(json).media;
      assert.notEqual(a?.group, b?.group, String(bad));
    }
  });

  test("skipReason conhecido é mantido; desconhecido ou de tipo errado vira 'other'", () => {
    const json = apiExample();
    const item = /** @type {Record<string, unknown>} */ (json.media[2]);
    /** @type {Array<[unknown, boolean, string | null]>} */
    const table = [
      ["icon", false, "icon"],
      ["variant", false, "variant"],
      ["unsupported_format", false, "unsupported_format"],
      ["low_score", false, "low_score"],
      ["limit", false, "limit"],
      ["other", false, "other"],
      ["inventado", false, "other"],
      ["<script>", false, "other"],
      [7, false, "other"],
      [undefined, false, "other"],
      [null, true, null],
      [undefined, true, null],
    ];
    for (const [reason, selected, expected] of table) {
      item["skipReason"] = reason;
      item["selected"] = selected;
      assert.equal(parsed(json).media[2]?.skipReason, expected, `${String(reason)} ${selected}`);
    }
  });

  test("download: ok, error com message higienizada; outro formato vira ausente", () => {
    const json = apiExample();
    const [first, second] = parsed(json).media;
    assert.deepEqual(first?.download, { status: "ok" });
    assert.deepEqual(second?.download, { status: "error", message: "Não foi possível acessar este endereço." });
    for (const bad of [{ status: "talvez" }, "ok", 5, [], { status: 7 }]) {
      /** @type {Record<string, unknown>} */ (json.media[0]).download = bad;
      assert.equal(parsed(json).media[0]?.download, null);
    }
    /** @type {Record<string, unknown>} */ (json.media[1]).download = { status: "error", message: { a: 1 } };
    assert.deepEqual(parsed(json).media[1]?.download, { status: "error", message: null });
  });

  test("metadata.status: cada um dos seis valores conhecidos é mantido", () => {
    for (const status of ["unavailable", "unsupported", "too_large", "error", "not_analyzed"]) {
      const json = apiExample();
      /** @type {Record<string, unknown>} */ (json.media[0]).metadata = { status, message: "texto do servidor" };
      assert.deepEqual(parsed(json).media[0]?.metadata, { status, message: "texto do servidor" });
    }
    assert.equal(parsed(apiExample()).media[0]?.metadata?.status, "ok");
  });

  test("metadata com status desconhecido ou 'ok' sem sinais vira 'unknown', com a message se houver", () => {
    /** @type {unknown[]} */
    const bads = [{ status: "novo", message: "m" }, { status: 3 }, { status: "ok" }, { status: "ok", signals: "x" }, { status: "ok", signals: [] }];
    for (const bad of bads) {
      const json = apiExample();
      /** @type {Record<string, unknown>} */ (json.media[0]).metadata = bad;
      assert.equal(parsed(json).media[0]?.metadata?.status, "unknown", JSON.stringify(bad));
    }
    const json = apiExample();
    /** @type {Record<string, unknown>} */ (json.media[0]).metadata = { status: "novo", message: "m" };
    assert.deepEqual(parsed(json).media[0]?.metadata, { status: "unknown", message: "m" });
  });

  test("metadata que não é objeto é ausente", () => {
    for (const bad of ["ok", 4, [], undefined]) {
      const json = apiExample();
      /** @type {Record<string, unknown>} */ (json.media[0]).metadata = bad;
      assert.equal(parsed(json).media[0]?.metadata, null);
    }
  });
});

describe("parseReport: sinais (lista permitida)", () => {
  test("lê os campos conhecidos do exemplo", () => {
    const signals = signalsOf(apiExample());
    assert.deepEqual(signals, {
      fileType: "JPEG",
      width: 8192,
      height: 5464,
      sha256: SHA,
      dates: [{ tag: "EXIF:DateTimeOriginal", value: "2026:03:15 10:30:00" }],
      camera: { make: "Canon", model: "Canon EOS R5" },
      software: [],
      containsLocation: false,
      containsAuthorship: false,
      c2pa: null,
    });
  });

  test("campos fora da lista nunca chegam à saída, mesmo no meio dos conhecidos", () => {
    const json = apiExample();
    const metadata = /** @type {{ signals: Record<string, unknown> }} */ (json.media[0]?.metadata);
    Object.assign(metadata.signals, {
      latitude: -23.5,
      longitude: -46.6,
      gpsCoordinates: { lat: -23.5, lng: -46.6 },
      address: "Rua Secreta, 10",
      author: "Fulana de Tal",
      uuid: "u-1",
      manifestUrl: "https://exiftools.com/results/u/credentials",
      serialNumber: "123",
      mimeType: "image/jpeg",
    });
    Object.assign(json.media[0] ?? {}, { score: 100, source: "og:image", extra: "x" });
    const text = JSON.stringify(parsed(json));
    for (const leaked of ["-23.5", "Rua Secreta", "Fulana", "u-1", "manifestUrl", "serialNumber", "extra", "og:image"]) {
      assert.equal(text.includes(leaked), false, leaked);
    }
  });

  test("tipo errado vira ausente sem derrubar o resto", () => {
    const json = apiExample();
    const metadata = /** @type {{ signals: Record<string, unknown> }} */ (json.media[0]?.metadata);
    Object.assign(metadata.signals, {
      fileType: 7,
      width: "8192",
      height: 1.5,
      sha256: "curto",
      dates: "hoje",
      camera: "Canon",
      software: 9,
      containsLocation: "sim",
      containsAuthorship: 1,
      c2pa: "x",
    });
    assert.deepEqual(signalsOf(json), {
      fileType: null,
      width: null,
      height: null,
      sha256: null,
      dates: [],
      camera: null,
      software: [],
      containsLocation: null,
      containsAuthorship: null,
      c2pa: undefined,
    });
  });

  test("dimensões: inteiros de 1 a 100000", () => {
    const json = apiExample();
    const signals = rawSignals(json);
    for (const [value, expected] of /** @type {Array<[unknown, number | null]>} */ ([[1, 1], [100000, 100000], [0, null], [100001, null], [-5, null], [Infinity, null]])) {
      signals["width"] = value;
      assert.equal(signalsOf(json).width, expected, String(value));
    }
  });

  test("sha256 só aceita 64 dígitos hexadecimais", () => {
    const json = apiExample();
    const signals = rawSignals(json);
    signals["sha256"] = `${"A".repeat(64)}`;
    assert.equal(signalsOf(json).sha256, "A".repeat(64));
    for (const bad of ["a".repeat(63), `${"a".repeat(63)}g`, `<b>${"a".repeat(61)}`, `${SHA}\n`]) {
      signals["sha256"] = bad;
      assert.equal(signalsOf(json).sha256, null, bad);
    }
  });

  test("datas, software e câmera: itens inválidos descartados, listas com teto", () => {
    const json = apiExample();
    const signals = rawSignals(json);
    signals["dates"] = [{ tag: "EXIF:CreateDate", value: "2026:01:01 00:00:00" }, { tag: 1, value: "x" }, { tag: "t" }, null, "s"];
    signals["software"] = ["Photoshop", "", 5, "Photoshop", "GIMP"];
    signals["camera"] = { make: "Sony", model: 4 };
    const result = signalsOf(json);
    assert.deepEqual(result.dates, [{ tag: "EXIF:CreateDate", value: "2026:01:01 00:00:00" }]);
    assert.deepEqual(result.software, ["Photoshop", "GIMP"]);
    assert.deepEqual(result.camera, { make: "Sony", model: null });
    signals["camera"] = { make: 1, model: 2 };
    assert.equal(signalsOf(json).camera, null);
    signals["dates"] = Array.from({ length: 50 }, (_, i) => ({ tag: `EXIF:Tag${i}`, value: `${i}` }));
    signals["software"] = Array.from({ length: 50 }, (_, i) => `sw ${i}`);
    const capped = signalsOf(json);
    assert.ok(capped.dates.length <= 10);
    assert.ok(capped.software.length <= 10);
  });

  test("containsLocation e containsAuthorship: só booleano de verdade; outra coisa é ausente (null)", () => {
    const json = apiExample();
    const signals = rawSignals(json);
    for (const [value, expected] of /** @type {Array<[unknown, boolean | null]>} */ ([[true, true], [false, false], ["true", null], [1, null], [0, null], [null, null], [undefined, null]])) {
      signals["containsLocation"] = value;
      signals["containsAuthorship"] = value;
      const result = signalsOf(json);
      assert.equal(result.containsLocation, expected);
      assert.equal(result.containsAuthorship, expected);
    }
  });
});

describe("parseReport: C2PA", () => {
  /** @param {unknown} c2pa */
  const withC2pa = (c2pa) => {
    const json = apiExample();
    rawSignals(json)["c2pa"] = c2pa;
    return json;
  };

  test("null é 'nenhuma assinatura'; tipo errado é indefinido (não se sabe)", () => {
    assert.equal(signalsOf(withC2pa(null)).c2pa, null);
    for (const bad of ["x", 5, [], true]) assert.equal(signalsOf(withC2pa(bad)).c2pa, undefined);
  });

  test("fixture SINTÉTICA: lê só estado, motivo, signatário, data, gerador, IA e verificações", () => {
    const c2pa = signalsOf(withC2pa(syntheticC2pa())).c2pa;
    assert.deepEqual(c2pa, {
      state: "trusted_legacy",
      reason: null,
      signer: "Assinante Sintético Ltda.",
      signedAt: "2023-10-02T16:51:02+00:00",
      generator: "Gerador Sintético 1.0",
      aiGenerated: true,
      checks: [
        { code: "assertion.dataHash.match", outcome: "success" },
        { code: "claimSignature.validated", outcome: "success" },
        { code: "assertion.hashedURI.mismatch", outcome: "failure" },
        { code: "signingCredential.ocsp.skipped", outcome: "info" },
      ],
    });
  });

  test("objeto vazio: tudo ausente, nada é suposto", () => {
    assert.deepEqual(signalsOf(withC2pa({})).c2pa, {
      state: null,
      reason: null,
      signer: null,
      signedAt: null,
      generator: null,
      aiGenerated: null,
      checks: [],
    });
  });

  test("tipos errados dentro do C2PA viram ausentes; verificações inválidas são descartadas e limitadas a 50", () => {
    const c2pa = signalsOf(
      withC2pa({
        state: 5,
        signer: ["x"],
        signedAt: {},
        generator: null,
        aiGenerated: "sim",
        checks: [{ code: "a", outcome: "success" }, { code: 1, outcome: "failure" }, "x", null, { code: "b", outcome: 9 }],
      }),
    ).c2pa;
    assert.deepEqual(c2pa, {
      state: null,
      reason: null,
      signer: null,
      signedAt: null,
      generator: null,
      aiGenerated: null,
      checks: [
        { code: "a", outcome: "success" },
        { code: "b", outcome: null },
      ],
    });
    const many = signalsOf(withC2pa({ checks: Array.from({ length: 200 }, (_, i) => ({ code: `c${i}`, outcome: "success" })) })).c2pa;
    assert.equal(many?.checks.length, 50);
  });

  test("não carrega manifestUrl, creator, title nem ingredients", () => {
    const text = JSON.stringify(signalsOf(withC2pa({ ...syntheticC2pa(), manifestUrl: "https://exiftools.com/x", creator: ["Fulano"], title: "T", ingredients: [{ a: 1 }] })).c2pa);
    for (const leaked of ["manifestUrl", "exiftools.com", "Fulano", "creator", "ingredients"]) assert.equal(text.includes(leaked), false, leaked);
  });
});

describe("parseReport: higienização", () => {
  test("texto de terceiros sai sem controles nem caracteres de formato, e cortado", () => {
    const json = apiExample();
    json.page.title = `Manchete\u202Eoculta\u0007${"x".repeat(2000)}`;
    json.page.finalUrl = `https://exemplo.com/\u202E${"a".repeat(5000)}`;
    const report = parsed(json);
    assert.equal((report.page.title ?? "").includes("\u202E") || (report.page.title ?? "").includes("\u0007"), false);
    assert.ok(Array.from(report.page.title ?? "").length <= 300);
    assert.ok(Array.from(report.page.finalUrl ?? "").length <= 2048);
  });

  test("HTML permanece como texto", () => {
    const json = apiExample();
    json.page.title = '<img src=x onerror="alert(1)">';
    assert.equal(parsed(json).page.title, '<img src=x onerror="alert(1)">');
  });

  test("a entrada original não é alterada", () => {
    const json = apiExample();
    const before = JSON.stringify(json);
    parseReport(json);
    assert.equal(JSON.stringify(json), before);
  });

  test("assinaturas sintéticas e sinais de exemplo continuam consistentes", () => {
    assert.equal(okSignals().sha256, SHA);
    assert.equal(syntheticC2pa().aiGenerated, true);
  });
});
