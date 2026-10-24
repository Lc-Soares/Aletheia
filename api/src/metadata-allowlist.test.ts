import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { extractSignals, type MediaSignals } from "./metadata-allowlist.ts";
import { contentCredentials, exifRealResponse, exifSuccess } from "./testing.ts";

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
    // Campos de nível superior da resposta real (derivados do GPS e resumos de autoria e câmera).
    address: "SENTINELA-H-ENDERECO Rua Secreta, 99",
    addressPlusCode: "SENTINELA-H-PLUSCODE 58XX+YY",
    latitude: -23.9876,
    longitude: -46.5432,
    gpsCoordinates: { lat: -23.9876, lng: -46.5432 },
    cameraModel: "SENTINELA-H-CAMERAMODEL",
    createDate: "SENTINELA-H-CREATEDATE",
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
        GPSLatitude: "SENTINELA-H-EXIFLAT 23 deg 59' S",
        GPSLatitudeRef: "South",
        GPSLongitude: "SENTINELA-H-EXIFLNG 46 deg 32' W",
        GPSLongitudeRef: "West",
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
      "SENTINELA",
      "23.9876",
      "46.5432",
      "Rua Secreta",
      "South",
      "West",
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
        dimensions: 42, // as três fontes de dimensões com tipo errado

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

describe("lista permitida: resposta no formato real da ExifTools", () => {
  test("dourado: o resultado é exatamente o esperado", () => {
    assert.deepEqual(extractSignals(exifRealResponse(), SHA), {
      fileType: "JPEG",
      mimeType: "image/jpeg",
      width: 640,
      height: 480,
      sha256: SHA,
      dates: [
        { tag: "EXIF:DateTimeOriginal", value: "2021:02:03 04:05:00" },
        { tag: "EXIF:CreateDate", value: "2021:02:03 04:05:06" },
        { tag: "EXIF:ModifyDate", value: "2021:02:04 10:00:00" },
        { tag: "XMP:CreateDate", value: "2021:02:03 04:05:06" },
        { tag: "XMP:ModifyDate", value: "2021:02:04 10:00:00" },
      ],
      camera: { make: "Fabricante Fictício", model: "Modelo Fictício X1" },
      software: ["Editor Fictício 1.0", "Ferramenta Fictícia 2.0"],
      containsLocation: true,
      containsAuthorship: true,
      c2pa: null,
    });
  });

  test("endereço, coordenadas, autor e identificadores nunca saem, em nenhum nível", () => {
    const signals = extractSignals(exifRealResponse(), SHA);
    const dump = JSON.stringify(signals);
    for (const secret of ["SENTINELA", "12.3456", "45.6789", "12 deg", "45 deg", "Rua Inventada", "588MC9X8", "South", "West", "0.307"]) {
      assert.equal(dump.includes(secret), false, `vazou: ${secret}`);
    }
    for (const key of allKeys(signals)) assert.ok(ALLOWED_KEYS.has(key), `chave fora da lista: ${key}`);
  });
});

describe("lista permitida: dimensões", () => {
  const dims = (response: Record<string, unknown>): [number | null, number | null] => {
    const { width, height } = extractSignals({ success: true, ...response }, SHA);
    return [width, height];
  };
  const composite = (imageSize: unknown): Record<string, unknown> => ({ metadata: { Composite: { ImageSize: imageSize } } });

  for (const value of ["640x480", "640 x 480", "640×480", " 640x480 "]) {
    test(`aceita ${JSON.stringify(value)} em Composite.ImageSize e em dimensions`, () => {
      assert.deepEqual(dims(composite(value)), [640, 480]);
      assert.deepEqual(dims({ dimensions: value }), [640, 480]);
    });
  }

  test("limites: 1x1 e 100000x100000 são aceitos", () => {
    assert.deepEqual(dims(composite("1x1")), [1, 1]);
    assert.deepEqual(dims({ dimensions: "100000x100000" }), [100000, 100000]);
  });

  for (const value of [
    "0x480",
    "640x0",
    "-640x480",
    "640x-480",
    "100001x480",
    "640x100001",
    "9999999x480",
    "640.5x480",
    "abcx480",
    "640X480",
    "640x480x3",
    "640",
    "640 480",
    "x480",
    "",
    "   ",
    640,
    { width: 640, height: 480 },
    [640, 480],
    null,
    true,
  ]) {
    test(`recusa ${JSON.stringify(value)} (largura e altura null)`, () => {
      assert.deepEqual(dims(composite(value)), [null, null]);
      assert.deepEqual(dims({ dimensions: value }), [null, null]);
    });
  }

  test("sem nenhuma fonte: null", () => {
    assert.deepEqual(dims({}), [null, null]);
    assert.deepEqual(dims({ metadata: { Composite: {} } }), [null, null]);
  });

  test("Composite ausente com dimensions presente: usa dimensions", () => {
    assert.deepEqual(dims({ dimensions: "800x600", metadata: { EXIF: { Make: "X" } } }), [800, 600]);
  });

  test("Composite inválido com dimensions válido: usa dimensions", () => {
    assert.deepEqual(dims({ dimensions: "800x600", ...composite("abc") }), [800, 600]);
  });

  test("as duas fontes válidas: Composite.ImageSize vence", () => {
    assert.deepEqual(dims({ dimensions: "800x600", ...composite("640x480") }), [640, 480]);
  });

  test("último recurso: File.ImageWidth/ImageHeight, só com os dois válidos e até 100000", () => {
    assert.deepEqual(dims({ metadata: { File: { ImageWidth: 1024, ImageHeight: 768 } } }), [1024, 768]);
    assert.deepEqual(dims({ metadata: { File: { ImageWidth: 100001, ImageHeight: 768 } } }), [null, null]);
    assert.deepEqual(dims({ metadata: { File: { ImageWidth: 1024, ImageHeight: "768" } } }), [null, null]);
    assert.deepEqual(dims({ dimensions: "800x600", metadata: { File: { ImageWidth: 1024, ImageHeight: 768 } } }), [800, 600]);
  });
});

describe("lista permitida: localização (só o booleano)", () => {
  const located = (response: Record<string, unknown>): { located: boolean; dump: string } => {
    const signals = extractSignals({ success: true, ...response }, SHA);
    return { located: signals.containsLocation, dump: JSON.stringify(signals) };
  };
  const NO_VALUE = ["12.3", "45.6", "12 deg", "45 deg", "Rua", "PLUS"];

  for (const [name, response] of [
    ["só EXIF.GPSLatitude + GPSLongitude", { metadata: { EXIF: { GPSLatitude: "12 deg 20' S", GPSLongitude: "45 deg 40' W" } } }],
    ["só Composite", { metadata: { Composite: { GPSPosition: "12.3 S, 45.6 W" } } }],
    ["só XMP", { metadata: { XMP: { GPSLatitude: "12,18.0S" } } }],
    ["só gpsCoordinates", { gpsCoordinates: { lat: -12.3, lng: -45.6 } }],
    ["só latitude + longitude", { latitude: -12.3, longitude: -45.6 }],
    ["só address", { address: "Rua Fictícia, 1" }],
    ["só addressPlusCode", { addressPlusCode: "PLUS 58XX+YY" }],
    ["só latitude válida (longitude fora da faixa)", { latitude: -12.3, longitude: 999 }],
    ["só gpsCoordinates.lng válido", { gpsCoordinates: { lat: 999, lng: -45.6 } }],
    ["limites da faixa", { latitude: 90, longitude: -180 }],
  ] as const) {
    test(`${name}: true, sem nenhum valor na saída`, () => {
      const result = located(response);
      assert.equal(result.located, true);
      for (const value of NO_VALUE) assert.equal(result.dump.includes(value), false, `vazou: ${value}`);
    });
  }

  test("nenhuma fonte: false", () => {
    assert.equal(located({}).located, false);
    assert.equal(located({ metadata: { EXIF: { Make: "X" }, Composite: { ImageSize: "640x480" } } }).located, false);
  });

  const invalid: Array<[string, unknown[], (value: unknown) => Record<string, unknown>]> = [
    ["EXIF.GPSLatitude", ["", "   ", null, {}, [], false], (v) => ({ metadata: { EXIF: { GPSLatitude: v, GPSLongitude: v } } })],
    ["Composite.GPSPosition", ["", "   ", null, {}, [], false], (v) => ({ metadata: { Composite: { GPSPosition: v } } })],
    ["XMP.GPSLatitude", ["", "   ", null, {}, [], false], (v) => ({ metadata: { XMP: { GPSLatitude: v } } })],
    ["latitude", [91, -91, Number.NaN, Number.POSITIVE_INFINITY, "-23.5", null, {}, true], (v) => ({ latitude: v })],
    ["longitude", [181, -181, Number.NaN, Number.NEGATIVE_INFINITY, "-46.6", null, [], true], (v) => ({ longitude: v })],
    ["gpsCoordinates", [{ lat: 91, lng: 200 }, { lat: "x" }, { lat: null, lng: "y" }, {}, null, "23,46", [1, 2]], (v) => ({ gpsCoordinates: v })],
    ["address", ["", "  ", 42, null, {}, ["Rua X"]], (v) => ({ address: v })],
    ["addressPlusCode", ["", "  ", 42, null, {}], (v) => ({ addressPlusCode: v })],
  ];
  for (const [source, values, build] of invalid) {
    test(`${source} inválido: false`, () => {
      for (const value of values) assert.equal(located(build(value)).located, false, `${source} = ${String(JSON.stringify(value))}`);
    });
  }

  test("uma fonte inválida não anula outra válida", () => {
    assert.equal(located({ latitude: 999, address: "Rua Fictícia, 1" }).located, true);
    assert.equal(located({ gpsCoordinates: { lat: 999 }, metadata: { Composite: { GPSPosition: "12.3 S, 45.6 W" } } }).located, true);
    assert.equal(located({ address: "", metadata: { EXIF: { GPSLatitude: "12 deg S" } } }).located, true);
  });
});

describe("lista permitida: autoria do nível superior (só presença)", () => {
  const authored = (response: Record<string, unknown>): { authored: boolean; dump: string } => {
    const signals = extractSignals({ success: true, ...response }, SHA);
    return { authored: signals.containsAuthorship, dump: JSON.stringify(signals) };
  };

  test("só author: true, sem o nome na saída", () => {
    const result = authored({ author: "Fulano Fictício" });
    assert.equal(result.authored, true);
    assert.equal(result.dump.includes("Fulano"), false);
  });

  test("author vazio ou de tipo errado, sem outra fonte: false", () => {
    for (const value of ["", "   ", 42, {}, [], null, true]) {
      assert.equal(authored({ author: value }).authored, false, String(JSON.stringify(value)));
    }
  });
});
