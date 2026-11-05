import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeSignals } from "../public/report-summary.js";

/** @typedef {import("../public/report-parse.js").Report} Report */
/** @typedef {import("../public/report-parse.js").MediaItem} MediaItem */
/** @typedef {import("../public/report-parse.js").Signals} Signals */
/** @typedef {import("../public/report-parse.js").C2pa} C2pa */

/**
 * @param {Partial<Signals>} extra
 * @returns {Signals}
 */
function signals(extra) {
  return {
    fileType: "jpeg",
    width: 10,
    height: 10,
    sha256: null,
    dates: [],
    camera: null,
    software: [],
    containsLocation: null,
    containsAuthorship: null,
    c2pa: null,
    ...extra,
  };
}

/**
 * @param {number} n
 * @param {Partial<Signals>} extra
 * @returns {MediaItem}
 */
function media(n, extra) {
  return {
    url: `https://exemplo.com/${n}.jpg`,
    group: n,
    skipReason: null,
    download: { status: "ok" },
    metadata: { status: "ok", signals: signals(extra) },
  };
}

/**
 * @param {MediaItem[]} items
 * @returns {Report}
 */
function report(items) {
  return { page: { finalUrl: null, title: null, headline: null }, notices: [], media: items };
}

/** @type {C2pa} */
const c2paWithAi = { state: "valid", reason: null, signer: null, signedAt: null, generator: null, aiGenerated: true, checks: [] };

test("sem mídia analisada, o resumo é vazio", () => {
  assert.deepEqual(summarizeSignals(report([])), []);
});

test("mídia ignorada ou sem metadados não entra na conta", () => {
  const ignorada = { ...media(1, {}), skipReason: "icon" };
  const semMeta = { ...media(2, {}), metadata: null };
  assert.deepEqual(summarizeSignals(report([ignorada, semMeta])), []);
});

test("conta C2PA, marcação de IA, software e falta de dados de origem", () => {
  const text = summarizeSignals(report([media(1, { c2pa: c2paWithAi }), media(2, { software: ["Photoshop"] }), media(3, {})])).join("\n");
  assert.match(text, /1 mídia tem assinatura C2PA/);
  assert.match(text, /1 mídia declara geração por IA/);
  assert.match(text, /1 mídia cita software/);
  assert.match(text, /1 mídia não tem assinatura C2PA/);
});

test("C2PA ilegível não conta como ausente", () => {
  const text = summarizeSignals(report([media(1, { c2pa: undefined })])).join("\n");
  assert.doesNotMatch(text, /não tem assinatura C2PA/);
});

test("o resumo nunca fala em veredito", () => {
  const text = summarizeSignals(report([media(1, {})])).join("\n");
  assert.doesNotMatch(text, /falso|verdadeiro|fraude/i);
});
