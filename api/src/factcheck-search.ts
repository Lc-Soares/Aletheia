// Busca de checagens publicadas (Fact Check Tools) dentro de uma checagem: começa uma vez só, assim
// que a linha page do fetcher chega, e corre em paralelo com os downloads e a ExifTools. Nunca
// rejeita nem derruba a checagem: toda falha vira "unavailable" para o usuário, e a categoria exata
// fica só na contagem do log. O texto da busca nunca vai para o log.
import type { FactCheckCall, FactCheckOptions, FactCheckResult } from "./factcheck-client.ts";
import { type FactCheckClaim, factCheckQuery } from "./factcheck-response.ts";
import type { PageHeadline } from "./fetcher-contract.ts";

// Campo factCheck do relatório. query: o texto enviado (ok e unavailable); null quando nada foi enviado.
export type FactCheckView = {
  status: "ok" | "unavailable" | "skipped" | "not_configured";
  query: string | null;
  claims: FactCheckClaim[];
};
// tally: contagem por status (ok, skipped, not_configured ou a categoria da falha), só para o log.
export type FactCheckOutcome = { view: FactCheckView; tally: Record<string, number> };
export type FactCheckSearch = { start: (page: PageHeadline) => void; result: () => Promise<FactCheckOutcome> };

const SKIPPED: FactCheckOutcome = { view: { status: "skipped", query: null, claims: [] }, tally: { skipped: 1 } };

function toOutcome(query: string, result: FactCheckResult): FactCheckOutcome {
  switch (result.status) {
    case "ok":
      return { view: { status: "ok", query, claims: result.claims }, tally: { ok: 1 } };
    case "not_configured":
      return { view: { status: "not_configured", query: null, claims: [] }, tally: { not_configured: 1 } };
    case "unavailable":
      return { view: { status: "unavailable", query, claims: [] }, tally: { [result.reason]: 1 } };
  }
}

export function createFactCheckSearch(search: FactCheckCall, options: FactCheckOptions): FactCheckSearch {
  let pending: Promise<FactCheckOutcome> | null = null;
  const start = (page: PageHeadline): void => {
    if (pending !== null) return;
    const query = factCheckQuery(page);
    if (query === null) {
      pending = Promise.resolve(SKIPPED);
      return;
    }
    // A rejeição (inesperada) também vira status: a promessa guardada nunca rejeita.
    pending = Promise.resolve()
      .then(() => search(query, options))
      .then(
        (result) => toOutcome(query, result),
        () => toOutcome(query, { status: "unavailable", reason: "network" }),
      );
  };
  return { start, result: () => pending ?? Promise.resolve(SKIPPED) };
}
