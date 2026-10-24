// Fixtures do relatório, baseadas nos exemplos de docs/api.md ("Resposta 200"). Nenhuma vem de um
// arquivo ou de um site real. Cada função devolve uma cópia nova: o teste pode alterá-la à vontade.

/**
 * Relatório cru da API. O tipo é solto de propósito (`any` nos campos): os testes alteram campos
 * aninhados e injetam valores de tipo errado para exercitar a validação.
 * @typedef {{ page: Record<string, any>, media: Array<Record<string, any>>, notices: string[] }} RawReport
 */

/** @template T @param {T} value @returns {T} */
const copy = (value) => globalThis.structuredClone(value);

export const SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

export const FIXED_NOTICE_TEXT =
  "Este relatório mostra sinais encontrados nos arquivos da página. Ele não diz se o conteúdo é verdadeiro ou falso. A ausência de metadados não indica fraude: redes sociais e mensageiros costumam removê-los.";

export const API_NOTICES = [
  "A seleção de mídias é automática e heurística; uma mídia ignorada pode ser relevante.",
  "A revogação de certificados C2PA não é verificada online.",
  "Um signatário confiável indica quem gerou o arquivo, não que o conteúdo seja verdadeiro.",
];

/** Sinais de um arquivo sem localização, sem autoria e sem C2PA (exemplo de docs/api.md). */
export function okSignals() {
  return copy({
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
}

/**
 * C2PA SINTÉTICO: montado à mão a partir do exemplo de docs/apis/documentacao-exif.md. Nenhum
 * arquivo C2PA real foi testado (docs/pendencias.md, "Validação pendente").
 */
export function syntheticC2pa() {
  return copy({
    state: "trusted_legacy",
    reason: null,
    signer: "Assinante Sintético Ltda.",
    certificateName: "cert-sintetico",
    trustList: "itl",
    signedAt: "2023-10-02T16:51:02+00:00",
    timestamped: true,
    generator: "Gerador Sintético 1.0",
    aiGenerated: true,
    digitalSourceTypes: ["ai"],
    actions: [{ action: "c2pa.created", softwareAgent: "Gerador Sintético", digitalSourceType: "ai" }],
    checks: [
      { code: "assertion.dataHash.match", outcome: "success" },
      { code: "claimSignature.validated", outcome: "success" },
      { code: "assertion.hashedURI.mismatch", outcome: "failure" },
      { code: "signingCredential.ocsp.skipped", outcome: "info" },
    ],
    ingredientCount: 0,
    remoteHost: null,
  });
}

/**
 * Exemplo de docs/api.md: uma mídia analisada, uma com erro de download e um ícone ignorado.
 * @returns {RawReport}
 */
export function apiExample() {
  return copy({
    page: {
      finalUrl: "https://exemplo.com.br/materia",
      title: "Título da matéria",
      headline: "Manchete da matéria",
      possiblyNeedsJavaScript: false,
    },
    media: [
      {
        url: "https://exemplo.com.br/foto.jpg",
        kind: "image",
        source: "og:image",
        group: 1,
        score: 100,
        selected: true,
        skipReason: null,
        download: { status: "ok", contentType: "image/jpeg", size: 12345, sha256: SHA },
        metadata: { status: "ok", signals: okSignals() },
      },
      {
        url: "https://exemplo.com.br/outra.jpg",
        kind: "image",
        source: "img",
        group: 2,
        score: 20,
        selected: true,
        skipReason: null,
        download: { status: "error", error: "unreachable", message: "Não foi possível acessar este endereço." },
        metadata: null,
      },
      {
        url: "https://exemplo.com.br/icone.png",
        kind: "image",
        source: "img",
        group: 3,
        score: -70,
        selected: false,
        skipReason: "icon",
        download: null,
        metadata: null,
      },
    ],
    notices: API_NOTICES,
  });
}

/** @param {number} group @param {string} url @param {string | null} skipReason @returns {Record<string, any>} */
function ref(group, url, skipReason) {
  return {
    url,
    kind: "image",
    source: "img-srcset",
    group,
    score: 10,
    selected: skipReason === null,
    skipReason,
    download: null,
    metadata: null,
  };
}

/**
 * Página com variantes (grupo 1 com 2 variantes, grupo 2 com 1) e uma mídia de cada motivo de descarte.
 * @returns {RawReport}
 */
export function variantsPage() {
  const report = apiExample();
  report.media = [
    { ...ref(1, "https://exemplo.com.br/a-480.jpg", "variant") },
    {
      ...ref(1, "https://exemplo.com.br/a-1600.jpg", null),
      download: { status: "ok", contentType: "image/jpeg", size: 100, sha256: SHA },
      metadata: { status: "ok", signals: okSignals() },
    },
    { ...ref(1, "https://exemplo.com.br/a-800.jpg", "variant") },
    { ...ref(2, "https://exemplo.com.br/logo-1x.png", "icon") },
    { ...ref(2, "https://exemplo.com.br/logo-2x.png", "variant") },
    { ...ref(3, "https://exemplo.com.br/figura.svg", "unsupported_format") },
    { ...ref(4, "https://exemplo.com.br/rodape.jpg", "low_score") },
    { ...ref(5, "https://exemplo.com.br/extra.jpg", "limit") },
    { ...ref(6, "https://exemplo.com.br/estranha.jpg", "other") },
  ];
  return report;
}

/**
 * Relatório com uma única mídia analisada, com o `metadata` dado.
 * @param {Record<string, unknown>} metadata
 * @returns {RawReport}
 */
export function singleMedia(metadata) {
  const report = apiExample();
  report.media = [{ ...report.media[0], metadata }];
  return report;
}
