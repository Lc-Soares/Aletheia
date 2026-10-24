// Seleção das mídias principais. Roda no worker, junto da extração, sobre texto hostil: cada
// atributo é cortado antes de ser lido, e nada aqui usa regex com repetição aninhada.
// As regras são heurísticas; pesos, motivos e limitações em docs/fetcher.md.
import { MAX_SCORE, MIN_SCORE, type MediaKind, type MediaRef, type MediaSource, type SkipReason } from "./media.ts";

// Sinais de um grupo, como bits: cada sinal conta uma vez por grupo, venha de qual membro vier.
export const SIGNAL = {
  META: 1, // og:image, og:video, twitter:image
  CONTENT: 2, // ancestral <article>, <main> ou <figure>
  LAYOUT: 4, // ancestral <nav>/<aside>, ou <header>/<footer> fora de article/main
  HIDDEN: 8, // role=presentation ou aria-hidden=true no elemento ou no <picture>
  ICON_WORD: 16, // icon, logo, sprite, avatar, favicon em class, id, alt ou no nome do arquivo
  SMALL: 32, // width ou height declarado <= 64
  PIXEL: 64, // width e height declarados <= 2 (pixel de rastreamento)
} as const;

const WEIGHTS: readonly (readonly [number, number])[] = [
  [SIGNAL.META, 100],
  [SIGNAL.CONTENT, 20],
  [SIGNAL.LAYOUT, -30],
  [SIGNAL.HIDDEN, -40],
  [SIGNAL.ICON_WORD, -40],
  [SIGNAL.SMALL, -60],
  [SIGNAL.PIXEL, -100],
];

// Grupo com pontuação até aqui nunca é baixado (motivo "icon"), mesmo sobrando vaga. Qualquer
// pontuação negativa também não é (motivo "low_score"); 0, a base de um <img> comum, é elegível.
export const ICON_THRESHOLD = -40;
const SMALL_PX = 64;
const PIXEL_PX = 2;
const MAX_SCANNED_CHARS = 1024;
const MAX_DIMENSION_CHARS = 32;
const MAX_DIMENSION_DIGITS = 6;
const ICON_WORDS: ReadonlySet<string> = new Set(["icon", "icons", "logo", "logos", "sprite", "sprites", "avatar", "avatars", "favicon"]);

export function scoreOf(signals: number): number {
  let score = 0;
  for (const [bit, weight] of WEIGHTS) if (signals & bit) score += weight;
  return Math.max(MIN_SCORE, Math.min(MAX_SCORE, score));
}

const isWordChar = (code: number): boolean => (code >= 97 && code <= 122) || (code >= 48 && code <= 57);

// Tokens são trechos de [a-z0-9] no primeiro 1 KiB, em minúsculas. Laço simples, tempo linear.
export function hasIconWord(value: string | null): boolean {
  if (value === null) return false;
  const text = value.slice(0, MAX_SCANNED_CHARS).toLowerCase();
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && isWordChar(text.charCodeAt(i))) continue;
    if (i > start && ICON_WORDS.has(text.slice(start, i))) return true;
    start = i + 1;
  }
  return false;
}

// Dígitos iniciais de width/height, como o navegador lê "100px" ou "1.5". Porcentagem não conta.
export function parseDimension(value: string | null): number | null {
  if (value === null) return null;
  const text = value.slice(0, MAX_DIMENSION_CHARS).trim();
  let end = 0;
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++;
  if (end === 0 || end > MAX_DIMENSION_DIGITS || text[end] === "%") return null;
  return Number(text.slice(0, end));
}

export function sizeSignals(width: string | null, height: string | null): number {
  const w = parseDimension(width);
  const h = parseDimension(height);
  let signals = 0;
  if ((w !== null && w <= SMALL_PX) || (h !== null && h <= SMALL_PX)) signals |= SIGNAL.SMALL;
  if (w !== null && h !== null && w <= PIXEL_PX && h <= PIXEL_PX) signals |= SIGNAL.PIXEL;
  return signals;
}

// Nome do arquivo (último segmento do caminho), para as palavras de ícone e a extensão SVG.
export function fileName(pathname: string): string {
  return pathname.slice(pathname.lastIndexOf("/") + 1).slice(0, MAX_SCANNED_CHARS);
}

export function isSvgName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith(".svg") || lower.endsWith(".svgz");
}

// Referência já resolvida e listada. root é o grupo (depois das uniões); signals, os sinais
// próprios dela (palavra no nome do arquivo); w/x, o descritor do srcset.
export type ListedRef = {
  url: string;
  kind: MediaKind;
  source: MediaSource;
  root: number;
  signals: number;
  w: number | null;
  x: number | null;
  svg: boolean;
};

type Group = { members: number[]; first: number; score: number; representative: number | null };

const maxBy = (refs: ListedRef[], members: number[], key: "w" | "x"): number | null => {
  let best: number | null = null;
  for (const i of members) {
    const value = refs[i]?.[key] ?? null;
    if (value !== null && (best === null || value > (refs[best]?.[key] ?? 0))) best = i;
  }
  return best;
};

// Maior w; senão maior x; senão a primeira. Empate fica com a primeira. SVG nunca é escolhido.
function representativeOf(refs: ListedRef[], members: number[]): number | null {
  const usable = members.filter((i) => refs[i]?.svg === false);
  if (usable.length === 0) return null;
  return maxBy(refs, usable, "w") ?? maxBy(refs, usable, "x") ?? usable[0] ?? null;
}

function buildGroups(refs: ListedRef[], signalsOf: (root: number) => number): Group[] {
  const byRoot = new Map<number, number[]>();
  refs.forEach((ref, i) => {
    const members = byRoot.get(ref.root);
    if (members) members.push(i);
    else byRoot.set(ref.root, [i]);
  });
  const groups: Group[] = [];
  for (const [root, members] of byRoot) {
    let signals = signalsOf(root);
    for (const i of members) signals |= refs[i]?.signals ?? 0;
    groups.push({ members, first: members[0] ?? 0, score: scoreOf(signals), representative: representativeOf(refs, members) });
  }
  // Pontuação decrescente; empate pela ordem da lista (og primeiro, depois o documento).
  return groups.sort((a, b) => b.score - a.score || a.first - b.first);
}

function groupReason(group: Group, selectedSoFar: number, maxSelected: number): SkipReason | null {
  if (group.representative === null) return "unsupported_format";
  if (group.score <= ICON_THRESHOLD) return "icon";
  if (group.score < 0) return "low_score";
  return selectedSoFar < maxSelected ? null : "limit";
}

// Devolve as referências na ordem recebida, com grupo, pontuação e o que será baixado.
export function selectMedia(refs: ListedRef[], signalsOf: (root: number) => number, maxSelected: number): MediaRef[] {
  const out: MediaRef[] = [];
  let selectedCount = 0;
  buildGroups(refs, signalsOf).forEach((group, rank) => {
    const reason = groupReason(group, selectedCount, maxSelected);
    if (reason === null) selectedCount++;
    const lead = group.representative ?? group.first;
    for (const i of group.members) {
      const ref = refs[i];
      if (ref === undefined) continue;
      const skipReason = i === lead ? reason : "variant";
      out[i] = { url: ref.url, kind: ref.kind, source: ref.source, group: rank + 1, score: group.score, selected: skipReason === null, skipReason };
    }
  });
  return out;
}
