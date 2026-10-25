import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { FIXED_NOTICE } from "../public/report-text.js";
import { buildReportJson, reportFileName, saveReportJson } from "../public/report-json.js";
import { parseReport } from "../public/report-parse.js";
import { API_NOTICES, SHA, apiExample, syntheticC2pa, variantsPage } from "./fixtures/report-fixtures.js";

const NOW = new Date("2026-10-24T15:30:45.123Z");
const LINK = "https://exemplo.com.br/materia";

/** Item cru da lista de mídias (mutável). @param {{ media: Array<Record<string, any>> }} json @param {number} index @returns {Record<string, any>} */
const media = (json, index) => /** @type {Record<string, any>} */ (json.media[index]);

/** @param {unknown} json */
function parsed(json) {
  const report = parseReport(json);
  assert.ok(report);
  return report;
}

/** @param {unknown} json */
const build = (json, analyzedUrl = LINK) => buildReportJson({ report: parsed(json), analyzedUrl, now: NOW });

/** @param {unknown} value @returns {string[]} */
function keysDeep(value) {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (typeof value !== "object" || value === null) return [];
  return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
}

describe("buildReportJson", () => {
  test("cabeçalho: schemaVersion 1, data/hora ISO, URL analisada e os mesmos avisos da tela", () => {
    const json = build(apiExample());
    assert.equal(json.schemaVersion, 1);
    assert.equal(json.generatedAt, "2026-10-24T15:30:45.123Z");
    assert.equal(json.analyzedUrl, LINK);
    assert.deepEqual(json.notices, [FIXED_NOTICE, ...API_NOTICES]);
  });

  test("página: URL final, título e manchete (como estão na tela)", () => {
    assert.deepEqual(build(apiExample()).page, { finalUrl: "https://exemplo.com.br/materia", title: "Título da matéria", headline: "Manchete da matéria" });
  });

  test("a URL analisada é higienizada como todo texto", () => {
    assert.equal(build(apiExample(), `${LINK}\u202E`).analyzedUrl, LINK);
  });

  test("grupos de mídia: um por grupo, com variantes contadas e motivo de descarte", () => {
    const groups = build(variantsPage()).mediaGroups;
    assert.equal(groups.length, 6);
    assert.deepEqual(
      groups.map((g) => [g.position, g.variantCount, g.ignored?.code ?? null]),
      [[1, 2, null], [2, 1, "icon"], [3, 0, "unsupported_format"], [4, 0, "low_score"], [5, 0, "limit"], [6, 0, "other"]],
    );
    assert.equal(groups[1]?.ignored?.text, "Parece ícone ou elemento de interface");
    assert.equal(groups[0]?.url, "https://exemplo.com.br/a-1600.jpg");
    assert.equal(JSON.stringify(groups).includes("a-480.jpg"), false);
  });

  test("mídia analisada: sinais com tipo de arquivo, dimensões, SHA-256, câmera, software, datas", () => {
    const group = build(apiExample()).mediaGroups[0];
    assert.equal(group?.metadata?.status, "ok");
    assert.deepEqual(group?.metadata?.signals, {
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

  test("download com erro e metadata sem sinais", () => {
    const groups = build(apiExample()).mediaGroups;
    assert.deepEqual(groups[1]?.download, { status: "error", message: "Não foi possível acessar este endereço." });
    assert.equal(groups[1]?.metadata, null);
    assert.equal(groups[2]?.download, null);
    const json = apiExample();
    media(json, 0).metadata = { status: "too_large", message: "Arquivo grande demais para a análise de metadados." };
    assert.deepEqual(build(json).mediaGroups[0]?.metadata, { status: "too_large", message: "Arquivo grande demais para a análise de metadados." });
  });

  test("[C2PA sintético] só o que a tela mostra; verificações viram contagem", () => {
    const json = apiExample();
    media(json, 0).metadata.signals.c2pa = syntheticC2pa();
    const c2pa = build(json).mediaGroups[0]?.metadata?.signals?.c2pa;
    assert.deepEqual(c2pa, {
      state: "trusted_legacy",
      reason: null,
      signer: "Assinante Sintético Ltda.",
      signedAt: "2023-10-02T16:51:02+00:00",
      generator: "Gerador Sintético 1.0",
      aiGenerated: true,
      checks: { success: 2, failure: 1 },
    });
  });

  test("localização e autoria saem só como booleano, sem valores, mesmo se o servidor mandar", () => {
    const json = apiExample();
    Object.assign(media(json, 0).metadata.signals, {
      containsLocation: true,
      containsAuthorship: true,
      latitude: -23.55052,
      longitude: -46.633308,
      address: "Avenida Paulista, 1000",
      author: "Maria Fotógrafa",
      copyright: "© Maria",
      manifestUrl: "https://exiftools.com/results/u/credentials",
      uuid: "uuid-1",
    });
    const text = JSON.stringify(build(json));
    for (const leaked of ["23.55", "46.63", "Paulista", "Maria", "©", "exiftools", "uuid-1"]) assert.equal(text.includes(leaked), false, leaked);
    const signals = build(json).mediaGroups[0]?.metadata?.signals;
    assert.equal(signals?.containsLocation, true);
    assert.equal(signals?.containsAuthorship, true);
  });

  test("não carrega score, source, kind nem campos fora da lista (chaves conhecidas apenas)", () => {
    const allowed = new Set([
      "schemaVersion", "generatedAt", "analyzedUrl", "notices", "page", "finalUrl", "title", "headline", "mediaGroups",
      "position", "url", "variantCount", "ignored", "code", "text", "download", "status", "message", "metadata", "signals",
      "fileType", "width", "height", "sha256", "dates", "tag", "value", "camera", "make", "model", "software",
      "containsLocation", "containsAuthorship", "c2pa", "state", "reason", "signer", "signedAt", "generator", "aiGenerated", "checks", "success", "failure",
    ]);
    const json = variantsPage();
    media(json, 1).metadata.signals.c2pa = syntheticC2pa();
    Object.assign(media(json, 1), { score: 99, source: "og:image", kind: "image", extra: 1 });
    for (const key of keysDeep(build(json))) assert.ok(allowed.has(key), `chave fora da lista: ${key}`);
  });

  test("o objeto vira JSON e volta igual (sem undefined, funções nem ciclos)", () => {
    const json = build(variantsPage());
    assert.deepEqual(JSON.parse(JSON.stringify(json)), json);
  });
});

describe("reportFileName", () => {
  test("aletheia-relatorio-<timestamp>.json, sem domínio nem caracteres de caminho", () => {
    const name = reportFileName(NOW);
    assert.equal(name, "aletheia-relatorio-20261024-153045.json");
    assert.match(name, /^aletheia-relatorio-\d{8}-\d{6}\.json$/);
    assert.equal(name.includes("exemplo"), false);
  });
});

describe("saveReportJson (Blob no navegador, sem tocar na CSP)", () => {
  function env() {
    /** @type {string[]} */
    const log = [];
    /** @type {Blob[]} */
    const blobs = [];
    /** @type {Array<{ fn: () => void, ms: number }>} */
    const timers = [];
    /** @type {Record<string, string>} */
    const attributes = {};
    const anchor = {
      setAttribute: (/** @type {string} */ name, /** @type {string} */ value) => {
        attributes[name] = value;
      },
      click: () => log.push("click"),
      remove: () => log.push("remove"),
    };
    return {
      log,
      blobs,
      timers,
      attributes,
      deps: {
        doc: {
          createElement: (/** @type {string} */ tag) => (log.push(`create:${tag}`), anchor),
          body: { appendChild: (/** @type {unknown} */ node) => (log.push("append"), node) },
        },
        urlApi: {
          createObjectURL: (/** @type {Blob} */ blob) => (blobs.push(blob), log.push("createObjectURL"), "blob:https://aletheia.test/abc-123"),
          revokeObjectURL: (/** @type {string} */ url) => log.push(`revoke:${url}`),
        },
        now: () => NOW,
        schedule: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.push({ fn, ms }),
      },
    };
  }

  test("cria o Blob JSON, baixa por uma âncora com download e revoga o URL depois", async () => {
    const { log, blobs, timers, attributes, deps } = env();
    saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (deps));
    assert.deepEqual(log, ["createObjectURL", "create:a", "append", "click", "remove"]);
    assert.equal(blobs.length, 1);
    assert.equal(blobs[0]?.type, "application/json;charset=utf-8");
    assert.equal(attributes["href"], "blob:https://aletheia.test/abc-123");
    assert.equal(attributes["download"], "aletheia-relatorio-20261024-153045.json");
    assert.equal(log.some((entry) => entry.startsWith("revoke")), false, "não revoga antes do clique terminar");
    assert.equal(timers.length, 1);
    timers[0]?.fn();
    assert.deepEqual(log.slice(-1), ["revoke:blob:https://aletheia.test/abc-123"]);
    assert.equal(log.filter((entry) => entry.startsWith("revoke")).length, 1);
    const text = await /** @type {Blob} */ (blobs[0]).text();
    assert.equal(JSON.parse(text).schemaVersion, 1);
    assert.equal(JSON.parse(text).analyzedUrl, LINK);
  });

  test("o nome do arquivo não leva o domínio, nem na âncora", () => {
    const { attributes, deps } = env();
    saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (deps));
    assert.equal(String(attributes["download"]).includes("exemplo"), false);
  });

  test("não usa fetch, XMLHttpRequest nem sendBeacon", () => {
    const { deps } = env();
    const target = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
    const saved = target["fetch"];
    target["fetch"] = () => {
      throw new Error("fetch proibido");
    };
    try {
      assert.doesNotThrow(() => saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (deps)));
    } finally {
      target["fetch"] = saved;
    }
  });

  test("cada clique gera um Blob e um URL novos, cada um revogado uma vez", () => {
    const { log, timers, deps } = env();
    saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (deps));
    saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (deps));
    for (const timer of timers) timer.fn();
    assert.equal(log.filter((entry) => entry === "createObjectURL").length, 2);
    assert.equal(log.filter((entry) => entry.startsWith("revoke")).length, 2);
  });

  test("se o clique lançar, o URL ainda é revogado", () => {
    const { log, timers, deps } = env();
    const broken = { ...deps, doc: { ...deps.doc, createElement: () => ({ setAttribute() {}, click() { throw new Error("falha"); }, remove() {} }) } };
    assert.throws(() => saveReportJson({ report: parsed(apiExample()), url: LINK }, /** @type {never} */ (broken)));
    timers[0]?.fn();
    assert.equal(log.filter((entry) => entry.startsWith("revoke")).length, 1);
  });
});
