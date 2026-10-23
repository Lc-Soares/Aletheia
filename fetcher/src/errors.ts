// Categorias fechadas: a mensagem nunca carrega IP, URL nem texto vindo do sistema operacional.
export type FetchErrorCategory =
  | "invalid_url"
  | "blocked"
  | "timeout"
  | "too_large"
  | "unsupported_type"
  | "too_many_redirects"
  | "upstream_status"
  | "network";

const MESSAGES: Record<FetchErrorCategory, string> = {
  invalid_url: "URL inválida",
  blocked: "Destino bloqueado",
  timeout: "Tempo esgotado",
  too_large: "Conteúdo grande demais",
  unsupported_type: "Tipo não suportado",
  too_many_redirects: "Redirecionamentos demais",
  upstream_status: "O site respondeu com erro",
  network: "Falha de rede",
};

export class FetchError extends Error {
  readonly category: FetchErrorCategory;

  constructor(category: FetchErrorCategory) {
    super(MESSAGES[category]);
    this.name = "FetchError";
    this.category = category;
  }
}

// Converte qualquer falha em categoria genérica; o erro original é descartado de propósito.
export function toFetchError(error: unknown, signal?: AbortSignal): FetchError {
  if (error instanceof FetchError) return error;
  if (signal?.aborted) return new FetchError("timeout");
  return new FetchError("network");
}

// Rejeita com "timeout" quando o sinal abortar, mesmo que a promessa original ignore o sinal.
export async function withDeadline<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new FetchError("timeout"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
