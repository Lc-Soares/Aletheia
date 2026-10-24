import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractSignals, type MediaSignals } from "./metadata-allowlist.ts";
import { contentCredentials, exifSuccess } from "./testing.ts";

const SHA = "f".repeat(64);

// Todas as chaves que podem aparecer na saída, em qualquer nível.
const ALLOWED_KEYS = new Set([
  "fileType",
  "mimeType",
  "width",
  "height",
  "sha256",
  "dates",
  "tag",
  "value",
  "camera",
  "make",
  "model",
  "software",
  "containsLocation",
  "containsAuthorship",
  "c2pa",
  "state",
  "reason",
  "signer",
  "certificateName",
  "trustList",
  "signedAt",
  "timestamped",
  "generator",
  "aiGenerated",
  "digitalSourceTypes",
  "actions",
  "action",
  "softwareAgent",
  "digitalSourceType",
  "checks",
  "code",
  "outcome",
  "ingredientCount",
  "remoteHost",
]);

function allKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const item of value) allKeys(item, found);
  else if (typeof value === "object" && value !== null) {
    for (const [key, inner] of Object.entries(value)) {
      found.add(key);
      allKeys(inner, found);
    }
  }
  return found;
}

function allStrings(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") found.push(value);
  else if (typeof value === "object" && value !== null) for (const inner of Object.values(value)) allStrings(inner, found);
  return found;
}

const EMPTY: MediaSignals = {
  fileType: null,
  mimeType: null,
  width: null,
  height: null,
  sha256: SHA,
  dates: [],
  camera: null,
  software: [],
  containsLocation: false,
  containsAuthorship: false,
  c2pa: null,
};

// Resposta hostil: dados pessoais, identificadores, campos inventados, HTML e caracteres de controle.
function hostileResponse(): Record<string, unknown> {
  return exifSuccess({
    author: "Fulano de Tal",
    fileName: "foto-da-familia-fulano.jpg",
    campoInventado: "NovoCampoSecreto",
    metadata: {
      File: { FileType: "JPEG", MIMEType: "image/jpeg", ImageWidth: 4000, ImageHeight: 3000, SHA256: "0".repeat(64), FileModifyDate: "2026:10:24 09:00:00" },
      EXIF: {
        Make: "M".repeat(1000),
        Model: "Modelo\u0000\u001b[31m‮oculto\u0085",
        Software: "<script>alert(1)</script>",
        Artist: "Fulano de Tal",
        SerialNumber: "SN-998877",
        BodySerialNumber: "BSN-112233",
        DateTimeOriginal: "2026:01:02 03:04:05",
      },
      GPS: { GPSLatitude: "23 deg 33' 1.00\" S", GPSLongitude: "46 deg 38' 2.00\" W", GPSAltitude: "760 m" },
      Composite: { GPSPosition: "23.5501 S, 46.6339 W" },
      IPTC: { "By-line": "Fulano de Tal", CopyrightNotice: "© 2026 Fulano de Tal" },
      XMP: { Creator: "Fulano de Tal", Rights: "Todos os direitos", CreatorTool: "Editor X 2.0" },
      MakerNotes: { InternalSerialNumber: "INT-445566", OwnerName: "Fulano de Tal" },
      ICC_Profile: { ProfileDescription: "Perfil Privado" },
      NovoGrupo: { Segredo: "NovoGrupoSecreto" },
    },
    contentCredentials: contentCredentials({
      creator: ["Fulano de Tal"],
      title: "Título Secreto",
      aiTraining: ["notAllowed-segredo"],
      ingredients: [{ title: "ingrediente-privado.jpg" }],
      algorithm: "Ps256",
      extraC2pa: "ExtraC2paSecreto",
    }),
  });
}

describe("lista permitida: exemplo da documentação", () => {
  test("extrai só os sinais permitidos", () => {
    assert.deepEqual(extractSignals(exifSuccess(), SHA), {
      fileType: "JPEG",
      mimeType: "image/jpeg",
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

  test("o SHA-256 é o calculado do nosso lado, não o da ExifTools", () => {
    assert.equal(extractSignals(exifSuccess(), SHA).sha256, SHA);
  });

  test("C2PA do exemplo da documentação", () => {
    const signals = extractSignals(exifSuccess({ contentCredentials: contentCredentials() }), SHA);
    assert.deepEqual(signals.c2pa, {
      state: "trusted_legacy",
      reason: null,
      signer: "Adobe Inc.",
      certificateName: "cai-prod",
      trustList: "itl",
      signedAt: "2023-10-02T16:51:02+00:00",
      timestamped: true,
      generator: "Adobe Firefly 1.0",
      aiGenerated: true,
      digitalSourceTypes: ["ai"],
      actions: [{ action: "c2pa.created", softwareAgent: "Adobe Firefly", digitalSourceType: "ai" }],
      checks: [{ code: "assertion.dataHash.match", outcome: "success" }],
      ingredientCount: 0,
      remoteHost: null,
    });
  });
});

describe("lista permitida: resposta hostil", () => {
  const signals = extractSignals(hostileResponse(), SHA);
  const dump = JSON.stringify(signals);

  test("nenhuma chave fora da lista aparece, em nenhum nível", () => {
    for (const key of allKeys(signals)) assert.ok(ALLOWED_KEYS.has(key), `chave fora da lista: ${key}`);
  });

  test("nenhum dado pessoal, identificador ou campo inventado chega à saída", () => {
    for (const secret of [
      "Fulano",
      "foto-da-familia",
      "123e4567",
      "SN-998877",
      "BSN-112233",
      "INT-445566",
      "23.5501",
      "46.6339",
      "23 deg",
      "760 m",
      "manifest",
      "exiftools.com",
      "Título Secreto",
      "notAllowed-segredo",
      "ingrediente-privado",
      "NovoCampoSecreto",
      "NovoGrupoSecreto",
      "ExtraC2paSecreto",
      "Perfil Privado",
      "Todos os direitos",
      "Ps256",
      "2026:10:24 09:00:00",
    ]) {
      assert.equal(dump.includes(secret), false, `vazou: ${secret}`);
    }
  });

  test("GPS vira só o booleano containsLocation", () => {
    assert.equal(signals.containsLocation, true);
  });

  test("autoria vira só o booleano containsAuthorship", () => {
    assert.equal(signals.containsAuthorship, true);
  });

  test("HTML chega como texto inerte; controles e caracteres de formato são removidos; texto é cortado", () => {
    assert.deepEqual(signals.software, ["<script>alert(1)</script>", "Editor X 2.0"]);
    assert.equal(signals.camera?.model, "Modelo[31moculto");
    assert.equal(signals.camera?.make?.length, 256);
    for (const text of allStrings(signals)) assert.doesNotMatch(text, /[\p{Cc}\p{Cf}]/u, JSON.stringify(text));
  });

  test("ingredientes viram só a contagem", () => {
    assert.equal(signals.c2pa?.ingredientCount, 1);
  });
});

describe("lista permitida: presença de localização e autoria", () => {
  const withGroups = (metadata: Record<string, unknown>, extra: Record<string, unknown> = {}): MediaSignals =>
    extractSignals(exifSuccess({ metadata, ...extra }), SHA);

  for (const [name, metadata] of [
    ["GPS.GPSLatitude", { GPS: { GPSLatitude: "23 deg S" } }],
    ["GPS.GPSLongitude", { GPS: { GPSLongitude: "46 deg W" } }],
    ["Composite.GPSPosition", { Composite: { GPSPosition: "23.5 S, 46.6 W" } }],
    ["Composite.GPSLatitude", { Composite: { GPSLatitude: -23.5 } }],
    ["XMP.GPSLatitude", { XMP: { GPSLatitude: "23,33.0S" } }],
  ] as const) {
    test(`localização presente: ${name}`, () => {
      const signals = withGroups(metadata);
      assert.equal(signals.containsLocation, true);
      assert.equal(JSON.stringify(signals).includes("23"), false, "sem coordenadas");
    });
  }

  test("GPS sem coordenadas (só versão) ou com valor vazio não conta como localização", () => {
    assert.equal(withGroups({ GPS: { GPSVersionID: "2.3.0.0" } }).containsLocation, false);
    assert.equal(withGroups({ GPS: { GPSLatitude: "" } }).containsLocation, false);
  });

  for (const [name, metadata, extra] of [
    ["author (nível superior)", {}, { author: "Fulano" }],
    ["IPTC.By-line", { IPTC: { "By-line": "Fulano" } }, {}],
    ["IPTC.CopyrightNotice", { IPTC: { CopyrightNotice: "© Fulano" } }, {}],
    ["EXIF.Artist", { EXIF: { Artist: "Fulano" } }, {}],
    ["EXIF.Copyright", { EXIF: { Copyright: "Fulano" } }, {}],
    ["XMP.Creator (lista)", { XMP: { Creator: ["Fulano"] } }, {}],
    ["XMP.Rights", { XMP: { Rights: "Fulano" } }, {}],
    ["contentCredentials.creator", {}, { contentCredentials: contentCredentials({ creator: ["Fulano"] }) }],
  ] as const) {
    test(`autoria presente: ${name}`, () => {
      const signals = withGroups(metadata, extra);
      assert.equal(signals.containsAuthorship, true);
      assert.equal(JSON.stringify(signals).includes("Fulano"), false, "sem o nome");
    });
  }

  test("autoria vazia não conta", () => {
    assert.equal(withGroups({ IPTC: { "By-line": "  " }, XMP: { Creator: [] } }).containsAuthorship, false);
  });
});

describe("lista permitida: datas, software e C2PA", () => {
  test("datas de EXIF e XMP, na ordem da lista; datas do sistema de arquivos ficam de fora", () => {
    const signals = extractSignals(
      exifSuccess({
        metadata: {
          File: { FileModifyDate: "2026:10:24 09:00:00", FileAccessDate: "2026:10:24 09:00:01" },
          EXIF: { DateTimeOriginal: "2020:01:01 10:00:00", CreateDate: "2020:01:01 10:00:01", ModifyDate: "2021:05:05 12:00:00" },
          XMP: { CreateDate: "2020:01:01 10:00:00", ModifyDate: "2021:05:05", MetadataDate: "2021:05:06" },
        },
      }),
      SHA,
    );
    assert.deepEqual(signals.dates, [
      { tag: "EXIF:DateTimeOriginal", value: "2020:01:01 10:00:00" },
      { tag: "EXIF:CreateDate", value: "2020:01:01 10:00:01" },
      { tag: "EXIF:ModifyDate", value: "2021:05:05 12:00:00" },
      { tag: "XMP:CreateDate", value: "2020:01:01 10:00:00" },
      { tag: "XMP:ModifyDate", value: "2021:05:05" },
      { tag: "XMP:MetadataDate", value: "2021:05:06" },
    ]);
  });

  test("software: fontes da lista, sem repetição, até 10", () => {
    const history = Array.from({ length: 30 }, (_, i) => `Editor ${i}`);
    const signals = extractSignals(
      exifSuccess({
        metadata: {
          EXIF: { Software: "Editor 0", ProcessingSoftware: "Revelador" },
          XMP: { CreatorTool: "Editor 0", HistorySoftwareAgent: history },
        },
      }),
      SHA,
    );
    assert.equal(signals.software.length, 10);
    assert.deepEqual(signals.software.slice(0, 3), ["Editor 0", "Revelador", "Editor 1"]);
  });

  test("C2PA inválido: estado, motivo e checks com falha; listas com teto", () => {
    const actions = Array.from({ length: 100 }, (_, i) => ({ action: `c2pa.edited.${i}`, softwareAgent: "Editor", extra: "x" }));
    const checks = Array.from({ length: 200 }, (_, i) => ({ code: `check.${i}`, outcome: i === 0 ? "failure" : "success", explanation: "segredo" }));
    const c2pa = extractSignals(
      exifSuccess({ contentCredentials: contentCredentials({ state: "invalid", reason: "changed", actions, checks, ingredients: [{}, {}, {}] }) }),
      SHA,
    ).c2pa;
    assert.equal(c2pa?.state, "invalid");
    assert.equal(c2pa?.reason, "changed");
    assert.equal(c2pa?.actions.length, 20);
    assert.deepEqual(c2pa?.actions[0], { action: "c2pa.edited.0", softwareAgent: "Editor", digitalSourceType: null });
    assert.equal(c2pa?.checks.length, 50);
    assert.deepEqual(c2pa?.checks[0], { code: "check.0", outcome: "failure" });
    assert.equal(c2pa?.ingredientCount, 3);
  });

  test("C2PA remoto: só o host", () => {
    const c2pa = extractSignals(exifSuccess({ contentCredentials: { state: "remote", remoteHost: "cdn.credenciais.example" } }), SHA).c2pa;
    assert.equal(c2pa?.state, "remote");
    assert.equal(c2pa?.remoteHost, "cdn.credenciais.example");
    assert.equal(c2pa?.ingredientCount, null);
    assert.deepEqual(c2pa?.actions, []);
  });
});

describe("lista permitida: tipos inesperados", () => {
  test("resposta que não é objeto devolve sinais vazios", () => {
    for (const response of [null, undefined, 42, "texto", [], { success: true, metadata: "x" }]) {
      assert.deepEqual(extractSignals(response, SHA), EMPTY);
    }
  });

  test("campo com tipo errado é omitido (null), sem derrubar os outros", () => {
    const signals = extractSignals(
      exifSuccess({
        mimeType: 42,
        metadata: {
          File: { FileType: { a: 1 }, MIMEType: "image/png", ImageWidth: "8192", ImageHeight: -5 },
          EXIF: { Make: 42, Model: "Modelo", DateTimeOriginal: 20200101 },
        },
        contentCredentials: "não é objeto",
      }),
      SHA,
    );
    assert.equal(signals.fileType, null);
    assert.equal(signals.mimeType, "image/png");
    assert.equal(signals.width, null);
    assert.equal(signals.height, null);
    assert.deepEqual(signals.camera, { make: null, model: "Modelo" });
    assert.deepEqual(signals.dates, []);
    assert.equal(signals.c2pa, null);
  });

  test("C2PA com campos de tipo errado", () => {
    const c2pa = extractSignals(
      exifSuccess({ contentCredentials: { state: 1, timestamped: "true", aiGenerated: null, digitalSourceTypes: "ai", actions: "x", checks: [1, null, { code: 2 }] } }),
      SHA,
    ).c2pa;
    assert.deepEqual(c2pa, {
      state: null,
      reason: null,
      signer: null,
      certificateName: null,
      trustList: null,
      signedAt: null,
      timestamped: null,
      generator: null,
      aiGenerated: null,
      digitalSourceTypes: [],
      actions: [],
      checks: [],
      ingredientCount: null,
      remoteHost: null,
    });
  });
});
