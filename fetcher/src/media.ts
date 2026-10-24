// Formato do resultado da extração, compartilhado entre o worker (extract.ts) e o processo
// principal, que valida a mensagem do worker sem carregar o parse5 (extract-pool.ts).
export const MEDIA_KINDS = ["image", "video"] as const;
export const MEDIA_SOURCES = [
  "og:image",
  "og:video",
  "img",
  "img-srcset",
  "source",
  "source-srcset",
  "video",
  "video-poster",
  "twitter:image",
] as const;
// Por que uma mídia listada não foi baixada. "other" é reservado: aceito, mas não emitido hoje.
export const SKIP_REASONS = ["variant", "icon", "unsupported_format", "low_score", "limit", "other"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaSource = (typeof MEDIA_SOURCES)[number];
export type SkipReason = (typeof SKIP_REASONS)[number];
// group: posição do grupo no ranking (1 = melhor); score: pontuação do grupo (heurística, ver
// docs/fetcher.md); skipReason é null exatamente quando selected é true.
export type MediaRef = {
  url: string;
  kind: MediaKind;
  source: MediaSource;
  group: number;
  score: number;
  selected: boolean;
  skipReason: SkipReason | null;
};
export type ExtractedPage = {
  title: string | null;
  headline: string | null;
  media: MediaRef[];
  possiblyNeedsJavaScript: boolean;
};

// Faixa fixa da pontuação, conferida também pelo validador da mensagem do worker.
export const MIN_SCORE = -1000;
export const MAX_SCORE = 1000;

// Teto de título e manchete, em unidades UTF-16 (o mesmo que String.prototype.slice conta).
export const MAX_TEXT_LENGTH = 300;
