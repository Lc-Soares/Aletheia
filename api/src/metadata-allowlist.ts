// Lista permitida dos sinais extraídos da resposta da ExifTools. Nada é repassado em bloco: cada
// campo é escolhido aqui, com tipo conferido e texto higienizado. Localização e autoria viram só
// booleanos (LGPD), sem coordenadas e sem nomes. Um campo com tipo inesperado vira null (ou lista
// vazia) e não derruba os outros. Grupos e tags seguem os nomes do ExifTool, como diz a
// documentação; os nomes dentro de XMP, GPS e Composite ainda precisam ser confirmados com a
// ExifTools real (docs/api.md).

export type C2paSignals = {
  state: string | null;
  reason: string | null;
  signer: string | null;
  certificateName: string | null;
  trustList: string | null;
  signedAt: string | null;
  timestamped: boolean | null;
  generator: string | null;
  aiGenerated: boolean | null;
  digitalSourceTypes: string[];
  actions: Array<{ action: string; softwareAgent: string | null; digitalSourceType: string | null }>;
  checks: Array<{ code: string; outcome: string | null }>;
  ingredientCount: number | null;
  remoteHost: string | null;
};

export type MediaSignals = {
  fileType: string | null;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  sha256: string; // o calculado pelo fetcher e conferido pela API, não o da ExifTools
  dates: Array<{ tag: string; value: string }>;
  camera: { make: string | null; model: string | null } | null;
  software: string[];
  containsLocation: boolean;
  containsAuthorship: boolean;
  c2pa: C2paSignals | null;
};

type PlainObject = Record<string, unknown>;

const MAX_TEXT = 256;
const MAX_SHORT_TEXT = 64;
const MAX_DIMENSION = 1_000_000;
const MAX_SOFTWARE = 10;
const MAX_SOURCE_TYPES = 10;
const MAX_ACTIONS = 20;
const MAX_CHECKS = 50;

const DATE_TAGS: ReadonlyArray<readonly [group: string, tag: string]> = [
  ["EXIF", "DateTimeOriginal"],
  ["EXIF", "CreateDate"],
  ["EXIF", "ModifyDate"],
  ["XMP", "CreateDate"],
  ["XMP", "ModifyDate"],
  ["XMP", "MetadataDate"],
];
const SOFTWARE_TAGS: ReadonlyArray<readonly [group: string, tag: string]> = [
  ["EXIF", "Software"],
  ["EXIF", "ProcessingSoftware"],
  ["XMP", "CreatorTool"],
  ["XMP", "HistorySoftwareAgent"],
];
const LOCATION_TAGS: ReadonlyArray<readonly [group: string, tag: string]> = [
  ["GPS", "GPSLatitude"],
  ["GPS", "GPSLongitude"],
  ["Composite", "GPSPosition"],
  ["Composite", "GPSLatitude"],
  ["Composite", "GPSLongitude"],
  ["XMP", "GPSLatitude"],
  ["XMP", "GPSLongitude"],
];
const AUTHORSHIP_TAGS: ReadonlyArray<readonly [group: string, tag: string]> = [
  ["IPTC", "By-line"],
  ["IPTC", "CopyrightNotice"],
  ["EXIF", "Artist"],
  ["EXIF", "Copyright"],
  ["XMP", "Creator"],
  ["XMP", "Rights"],
];

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

const objectOrEmpty = (value: unknown): PlainObject => (isPlainObject(value) ? value : {});

// Texto de terceiros: sem controles (C0, DEL, C1) nem caracteres de formato Unicode (como o
// U+202E, que inverte o texto), cortado e bem formado. HTML continua texto: quem exibe escapa.
function cleanText(value: unknown, max = MAX_TEXT): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/[\p{Cc}\p{Cf}]/gu, "").trim().slice(0, max).toWellFormed();
  return text === "" ? null : text;
}

function cleanTextList(value: unknown, max: number, itemMax = MAX_TEXT): string[] {
  const items = Array.isArray(value) ? value : [value];
  const texts: string[] = [];
  for (const item of items) {
    const text = cleanText(item, itemMax);
    if (text !== null && !texts.includes(text)) texts.push(text);
    if (texts.length >= max) break;
  }
  return texts;
}

const dimension = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= MAX_DIMENSION ? value : null;

const booleanOrNull = (value: unknown): boolean | null => (typeof value === "boolean" ? value : null);

// Presença de valor, sem olhar o conteúdo: texto não vazio, número, lista ou objeto com algo dentro.
function hasValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.some(hasValue);
  if (isPlainObject(value)) return Object.values(value).some(hasValue);
  return false;
}

const anyTag = (groups: PlainObject, tags: ReadonlyArray<readonly [string, string]>): boolean =>
  tags.some(([group, tag]) => hasValue(objectOrEmpty(groups[group])[tag]));

function dates(groups: PlainObject): MediaSignals["dates"] {
  const found: MediaSignals["dates"] = [];
  for (const [group, tag] of DATE_TAGS) {
    const value = cleanText(objectOrEmpty(groups[group])[tag], MAX_SHORT_TEXT);
    if (value !== null) found.push({ tag: `${group}:${tag}`, value });
  }
  return found;
}

function software(groups: PlainObject): string[] {
  const found: string[] = [];
  for (const [group, tag] of SOFTWARE_TAGS) {
    for (const text of cleanTextList(objectOrEmpty(groups[group])[tag], MAX_SOFTWARE)) {
      if (!found.includes(text)) found.push(text);
    }
  }
  return found.slice(0, MAX_SOFTWARE);
}

function camera(exif: PlainObject): MediaSignals["camera"] {
  const make = cleanText(exif["Make"]);
  const model = cleanText(exif["Model"]);
  return make === null && model === null ? null : { make, model };
}

function actions(value: unknown): C2paSignals["actions"] {
  if (!Array.isArray(value)) return [];
  const found: C2paSignals["actions"] = [];
  for (const item of value.slice(0, MAX_ACTIONS)) {
    const entry = objectOrEmpty(item);
    const action = cleanText(entry["action"]);
    if (action === null) continue;
    found.push({ action, softwareAgent: cleanText(entry["softwareAgent"]), digitalSourceType: cleanText(entry["digitalSourceType"]) });
  }
  return found;
}

function checks(value: unknown): C2paSignals["checks"] {
  if (!Array.isArray(value)) return [];
  const found: C2paSignals["checks"] = [];
  for (const item of value.slice(0, MAX_CHECKS)) {
    const entry = objectOrEmpty(item);
    const code = cleanText(entry["code"]);
    if (code !== null) found.push({ code, outcome: cleanText(entry["outcome"], MAX_SHORT_TEXT) });
  }
  return found;
}

// De contentCredentials, só o que ajuda a ler a proveniência. Ficam de fora manifestUrl (link com o
// UUID do resultado guardado na ExifTools), creator (autoria), title, aiTraining, algorithm e checkedAt.
// ingredients: a árvore não é documentada, então só a contagem.
function c2pa(value: unknown): C2paSignals | null {
  if (!isPlainObject(value)) return null;
  return {
    state: cleanText(value["state"], MAX_SHORT_TEXT),
    reason: cleanText(value["reason"], MAX_SHORT_TEXT),
    signer: cleanText(value["signer"]),
    certificateName: cleanText(value["certificateName"]),
    trustList: cleanText(value["trustList"], MAX_SHORT_TEXT),
    signedAt: cleanText(value["signedAt"], MAX_SHORT_TEXT),
    timestamped: booleanOrNull(value["timestamped"]),
    generator: cleanText(value["generator"]),
    aiGenerated: booleanOrNull(value["aiGenerated"]),
    digitalSourceTypes: Array.isArray(value["digitalSourceTypes"]) ? cleanTextList(value["digitalSourceTypes"], MAX_SOURCE_TYPES, MAX_SHORT_TEXT) : [],
    actions: actions(value["actions"]),
    checks: checks(value["checks"]),
    ingredientCount: Array.isArray(value["ingredients"]) ? value["ingredients"].length : null,
    remoteHost: cleanText(value["remoteHost"]),
  };
}

export function extractSignals(response: unknown, sha256: string): MediaSignals {
  const root = objectOrEmpty(response);
  const groups = objectOrEmpty(root["metadata"]);
  const file = objectOrEmpty(groups["File"]);
  const credentials = root["contentCredentials"];
  const credentialCreator = isPlainObject(credentials) && hasValue(credentials["creator"]);
  return {
    fileType: cleanText(file["FileType"], MAX_SHORT_TEXT),
    mimeType: cleanText(root["mimeType"], MAX_SHORT_TEXT) ?? cleanText(file["MIMEType"], MAX_SHORT_TEXT),
    width: dimension(file["ImageWidth"]),
    height: dimension(file["ImageHeight"]),
    sha256,
    dates: dates(groups),
    camera: camera(objectOrEmpty(groups["EXIF"])),
    software: software(groups),
    containsLocation: anyTag(groups, LOCATION_TAGS),
    containsAuthorship: hasValue(root["author"]) || anyTag(groups, AUTHORSHIP_TAGS) || credentialCreator,
    c2pa: c2pa(credentials),
  };
}
