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
] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];
export type MediaSource = (typeof MEDIA_SOURCES)[number];
export type MediaRef = { url: string; kind: MediaKind; source: MediaSource };
export type ExtractedPage = { title: string | null; headline: string | null; media: MediaRef[] };

// Teto de título e manchete, em unidades UTF-16 (o mesmo que String.prototype.slice conta).
export const MAX_TEXT_LENGTH = 300;
