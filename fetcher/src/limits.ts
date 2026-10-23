// Justificativa de cada valor em docs/fetcher.md.
export type Limits = {
  hopHeadersMs: number;
  htmlTotalMs: number;
  mediaTotalMs: number;
  pageTotalMs: number;
  maxHtmlBytes: number;
  maxMediaBytes: number;
  maxAggregateMediaBytes: number;
  maxMediaDownloads: number;
  maxMediaRefs: number;
  mediaConcurrency: number;
  maxRedirects: number;
  maxResponseHeaderBytes: number;
  maxUrlLength: number;
  maxHtmlNodes: number;
};

const MIB = 1024 * 1024;

export const DEFAULT_LIMITS: Readonly<Limits> = Object.freeze({
  hopHeadersMs: 5_000,
  htmlTotalMs: 10_000,
  mediaTotalMs: 20_000,
  pageTotalMs: 30_000,
  maxHtmlBytes: 2 * MIB,
  maxMediaBytes: 15 * MIB,
  maxAggregateMediaBytes: 60 * MIB,
  maxMediaDownloads: 20,
  maxMediaRefs: 200,
  mediaConcurrency: 4,
  maxRedirects: 5,
  maxResponseHeaderBytes: 16 * 1024,
  maxUrlLength: 2048,
  maxHtmlNodes: 100_000,
});

// Só deixa reduzir: qualquer valor acima do padrão, inválido ou ausente vira o padrão.
// Assim nenhum chamador (nem teste) consegue afrouxar ou desligar um limite.
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  const result = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value = overrides[key];
    if (typeof value === "number" && Number.isInteger(value) && value >= 1) {
      result[key] = Math.min(value, DEFAULT_LIMITS[key]);
    }
  }
  return result;
}
