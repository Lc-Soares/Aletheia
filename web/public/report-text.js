// Textos fixos do relatório, em português do Brasil. Falam de sinais e limitações, nunca de veredito.

export const FIXED_NOTICE =
  "Este relatório mostra sinais encontrados nos arquivos da página. Ele não diz se o conteúdo é verdadeiro ou falso. A ausência de metadados não indica fraude: redes sociais e mensageiros costumam removê-los.";

/** Motivo de a mídia não ter sido analisada (skipReason, exceto "variant", que não é mostrado). */
export const IGNORED_TEXT = {
  icon: "Parece ícone ou elemento de interface",
  low_score: "Parece elemento secundário da página",
  unsupported_format: "Formato que não conseguimos analisar (SVG)",
  limit: "Fora do limite de mídias analisadas por verificação",
  other: "Não analisada",
};

export const IGNORED_NOTE =
  "A escolha das mídias analisadas é automática e heurística. Uma mídia ignorada pode ser relevante, inclusive um logo.";

/** metadata.status diferente de "ok". Mapa próprio: a message do servidor só entra para status desconhecido. */
export const METADATA_TEXT = {
  unavailable: "Análise de metadados indisponível no momento.",
  unsupported: "Formato não suportado pela análise de metadados.",
  too_large: "Arquivo grande demais para a análise de metadados.",
  error: "Não foi possível analisar os metadados deste arquivo.",
  not_analyzed: "Fora do limite de mídias analisadas por verificação.",
};

export const TEXT = {
  title: "Relatório de sinais",
  notices: "Avisos",
  page: "Página analisada",
  media: "Mídias",
  mediaLabel: "Endereço da mídia",
  notInformed: "Não informado",
  noMedia: "Nenhuma mídia encontrada nesta página.",
  allIgnored: "Todas as mídias encontradas foram ignoradas pela seleção automática. Isso não significa que elas não sejam relevantes.",
  downloadFailed: "Não foi possível baixar esta mídia.",
  noMetadata: "Metadados não disponíveis para esta mídia.",
  signalsHeading: "Sinais encontrados",
  noC2pa: "Nenhuma assinatura C2PA encontrada. Isso não indica fraude.",
  c2paEmpty: "Assinatura C2PA presente, sem detalhes legíveis.",
  location: { yes: "Contém dados de localização (não exibidos)", no: "Não encontramos dados de localização" },
  authorship: { yes: "Contém autoria declarada nos metadados (não exibida)", no: "Não encontramos autoria declarada" },
  aiYes: "Marcado como gerado por IA nos metadados C2PA",
  aiNo: "Não marcado como gerado por IA nos metadados C2PA",
};

/**
 * Marcação ClaimReview declarada pela página. Tudo que vem da marcação é citação de terceiro: o
 * rótulo da avaliação sai entre aspas, e a fonte (a página que declarou) fica sempre visível.
 */
export const CLAIM_REVIEW_TEXT = {
  heading: "Marcação de checagem declarada pela página (ClaimReview)",
  notice: "A página se apresenta como uma checagem. Isso não indica que a checagem esteja correta.",
  explanation: "Qualquer site pode publicar essa marcação. O conteúdo abaixo foi declarado pela página, não pelo Aletheia.",
  limit: "Mostramos no máximo 5 marcações.",
  source: "Declarada por",
  claim: "Afirmação checada (segundo a página)",
  rating: "Avaliação declarada pela página",
  score: "Nota declarada",
  author: "Quem publicou a checagem (declarado)",
  date: "Data da checagem (declarada)",
  url: "Endereço da checagem (declarado)",
};

/**
 * Checagens publicadas por terceiros (Google Fact Check Tools), achadas pela manchete da página.
 * O rótulo é do publicador e sai entre aspas, com o nome dele e o link: citação, nunca conclusão.
 */
export const FACT_CHECK_TEXT = {
  heading: "Checagens publicadas sobre afirmações parecidas (Google Fact Check Tools)",
  searchedFor: "Buscamos por:",
  sent: "Esse texto foi enviado ao Google Fact Check Tools.",
  notice:
    "Estas checagens foram publicadas por terceiros sobre afirmações parecidas com a manchete. Parecido não significa que seja a mesma afirmação, e o Aletheia não conclui nada.",
  empty:
    "Nenhuma checagem encontrada para esse texto. Isso não diz nada sobre a matéria: a busca depende das palavras usadas e só cobre checagens que o Google indexou.",
  unavailable: "Não foi possível consultar as checagens agora.",
  skipped: "Não buscamos checagens: a página não tem manchete nem título.",
  notConfigured: "A busca de checagens não está ativa neste ambiente.",
  claim: "Afirmação checada (segundo o publicador)",
  claimant: "Quem afirmou (segundo o publicador)",
  claimDate: "Data da afirmação",
  publisher: "Publicado por",
  rating: "Avaliação do publicador",
  title: "Título da checagem",
  reviewDate: "Data da checagem",
  language: "Idioma da checagem",
  url: "Endereço da checagem",
};

/** Tags de data da lista permitida da API (docs/api.md, "Lista permitida de sinais"). */
export const DATE_LABELS = {
  "EXIF:DateTimeOriginal": "Data original da captura (EXIF)",
  "EXIF:CreateDate": "Data de criação (EXIF)",
  "EXIF:ModifyDate": "Data de modificação (EXIF)",
  "XMP:CreateDate": "Data de criação (XMP)",
  "XMP:ModifyDate": "Data de modificação (XMP)",
  "XMP:MetadataDate": "Data dos metadados (XMP)",
};

/** Estados documentados em docs/apis/documentacao-exif.md, "Content Credentials". */
export const C2PA_STATE_LABELS = {
  trusted: "Signatário em lista de confiança C2PA",
  trusted_legacy: "Signatário na lista anterior de Content Credentials",
  valid: "Assinatura e arquivo íntegros; signatário fora das listas de confiança",
  invalid: "Assinatura inválida",
  remote: "Credenciais guardadas online (não consultadas)",
  unchecked: "Não verificado",
  error: "Erro ao verificar as credenciais",
};

export const C2PA_REASON_LABELS = {
  changed: "arquivo alterado depois da assinatura",
  signature: "problema na assinatura",
  expired: "certificado expirado",
};

/**
 * Procura a chave só entre as próprias propriedades (evita "constructor", "__proto__" etc.).
 * @template {Record<string, string>} T
 * @param {T} map
 * @param {string} key
 * @returns {string | undefined}
 */
export function lookup(map, key) {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}
