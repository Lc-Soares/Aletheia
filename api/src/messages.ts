import { type FetcherCategory, isHttpStatus } from "./fetcher-contract.ts";

// Textos ao usuário. Nunca carregam a categoria interna, IP, hostname ou corpo de resposta.
export type UserErrorView = { error: string; message: string; httpStatus?: number };

export const USER_MESSAGES = Object.freeze({
  unreachable: "Não foi possível acessar este endereço.",
  invalidUrl: "Endereço inválido.",
  tooLarge: "O conteúdo é grande demais para ser analisado.",
  unsupportedType: "Tipo de conteúdo não suportado.",
  tooManyRedirects: "O endereço redirecionou vezes demais.",
  busy: "Serviço ocupado, tente novamente em instantes.",
  internal: "Não foi possível concluir a análise. Tente novamente.",
  timeout: "A análise demorou demais. Tente novamente.",
});

export const NOTICES = Object.freeze({
  selection:
    "A seleção de mídias é automática e heurística; mídias ignoradas (inclusive logotipos) podem ser relevantes.",
  javascript: "A página possivelmente depende de JavaScript; algumas mídias podem não ter sido vistas.",
  c2paRevocation: "A revogação de certificados C2PA não é verificada online.",
  c2paSigner: "Um signatário confiável indica quem gerou o arquivo, não que o conteúdo seja verdadeiro.",
});

// Situação da análise de metadados de cada mídia. Uma chave inválida (erro nosso) aparece como
// "indisponível", sem detalhe.
export const METADATA_MESSAGES = Object.freeze({
  unavailable: "Análise de metadados indisponível no momento.",
  unsupported: "Formato não suportado pela análise de metadados.",
  tooLarge: "Arquivo grande demais para a análise de metadados.",
  error: "Não foi possível analisar os metadados deste arquivo.",
  notAnalyzed: "Fora do limite de mídias analisadas por verificação.",
});

// blocked, network e timeout têm a mesma resposta: um nome que resolve para IP interno (blocked),
// um nome inexistente (network) e um DNS mudo (network ou timeout) não podem ser distinguidos,
// senão o usuário enumera nomes internos (requisito 1 de docs/fetcher.md).
export function fetchErrorView(category: FetcherCategory, httpStatus?: number): UserErrorView {
  switch (category) {
    case "blocked":
    case "network":
    case "timeout":
      return { error: "unreachable", message: USER_MESSAGES.unreachable };
    case "invalid_url":
      return { error: category, message: USER_MESSAGES.invalidUrl };
    case "too_large":
      return { error: category, message: USER_MESSAGES.tooLarge };
    case "unsupported_type":
      return { error: category, message: USER_MESSAGES.unsupportedType };
    case "too_many_redirects":
      return { error: category, message: USER_MESSAGES.tooManyRedirects };
    case "upstream_status":
      return isHttpStatus(httpStatus)
        ? { error: category, message: `O site respondeu com erro (HTTP ${httpStatus}).`, httpStatus }
        : { error: category, message: "O site respondeu com erro." };
  }
}

export function rateLimitedMessage(limit: number, retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  const unit = minutes === 1 ? "minuto" : "minutos";
  return `Você atingiu o limite de ${limit} verificações por hora. Tente novamente em ${minutes} ${unit}.`;
}
