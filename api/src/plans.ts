// Tabela de planos. Hoje só existe o gratuito; resolvePlan é o ponto de extensão para planos
// futuros (sem cobrança nem cadastro nesta fase).
export type PlanId = "free";
export type Plan = { readonly checksPerHour: number; readonly maxMediaPerCheck: number };

export const PLANS: Readonly<Record<PlanId, Plan>> = Object.freeze({
  free: Object.freeze({ checksPerHour: 10, maxMediaPerCheck: 8 }),
});

export function resolvePlan(user: { sub: string }): PlanId {
  void user; // todo usuário está no plano gratuito por enquanto
  return "free";
}
