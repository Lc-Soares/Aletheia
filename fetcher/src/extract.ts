import { type DefaultTreeAdapterTypes, html as parse5Html, parse } from "parse5";

import { DEFAULT_LIMITS } from "./limits.ts";
import { type ExtractedPage, MAX_TEXT_LENGTH, type MediaKind, type MediaSource } from "./media.ts";
import { fileName, hasIconWord, isSvgName, type ListedRef, selectMedia, SIGNAL, sizeSignals } from "./select.ts";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

// maxSelectedMedia é opcional só para os testes que chamam extractPage direto; o worker sempre o recebe.
export type ExtractLimits = { maxMediaRefs: number; maxUrlLength: number; maxHtmlNodes: number; maxSelectedMedia?: number };

const MAX_SRCSET_LENGTH = 16 * 1024;
const MAX_SRCSET_CANDIDATES = 20;

const OG_IMAGE = new Set(["og:image", "og:image:url", "og:image:secure_url"]);
const OG_VIDEO = new Set(["og:video", "og:video:url", "og:video:secure_url"]);
const TWITTER_IMAGE = new Set(["twitter:image", "twitter:image:src"]);

// Sinal de página montada por JavaScript (heurística, ver docs/fetcher.md).
const VISIBLE_TEXT_THRESHOLD = 500;
const MOUNT_IDS: ReadonlySet<string> = new Set(["root", "app", "__next", "__nuxt", "___gatsby"]);
const HIDDEN_TEXT_PARENTS: ReadonlySet<string> = new Set(["script", "style", "noscript", "template", "title", "textarea"]);

// Teto de valores brutos por lista (og e corpo), antes de resolver e deduplicar as URLs: sem ele,
// 100 mil nós com srcset geram milhões de entradas e de new URL. A folga cobre inválidas e repetidas.
const RAW_REFS_PER_MEDIA_REF = 4;

// group é um grupo provisório (um por elemento, ou o do <picture>/<video> pai); w/x vêm do srcset.
type RawRef = { value: string; kind: MediaKind; source: MediaSource; group: number; w: number | null; x: number | null; svg: boolean };
type RefList = { refs: RawRef[]; seen: Map<string, RawRef>; max: number };

// Grupos provisórios com união (union-find): a mesma URL em dois elementos une os dois grupos.
type Groups = { parent: number[]; signals: number[] };

type Collected = {
  baseHref: string | null;
  title: string | null;
  ogTitle: string | null;
  h1: string | null;
  og: RefList;
  body: RefList;
  groups: Groups;
  parentGroup: Map<Element, number>; // grupo de cada <picture>/<video>, para os filhos diretos
  hasScript: boolean;
  emptyMount: boolean;
  visibleChars: number;
};

const newRefList = (max: number): RefList => ({ refs: [], seen: new Map(), max });
const isFull = (list: RefList): boolean => list.refs.length >= list.max;

function newGroup(groups: Groups, signals: number): number {
  groups.parent.push(groups.parent.length);
  groups.signals.push(signals);
  return groups.parent.length - 1;
}

function findGroup(groups: Groups, id: number): number {
  let root = id;
  while ((groups.parent[root] ?? root) !== root) root = groups.parent[root] ?? root;
  while (id !== root) {
    const next = groups.parent[id] ?? root;
    groups.parent[id] = root;
    id = next;
  }
  return root;
}

function unionGroups(groups: Groups, a: number, b: number): void {
  const ra = findGroup(groups, a);
  const rb = findGroup(groups, b);
  if (ra === rb) return;
  groups.parent[rb] = ra;
  groups.signals[ra] = (groups.signals[ra] ?? 0) | (groups.signals[rb] ?? 0);
}

const addSignals = (groups: Groups, id: number, signals: number): void => {
  groups.signals[id] = (groups.signals[id] ?? 0) | signals;
};

// Deduplica o valor bruto já na coleta: repetir o mesmo src não consome o teto. Valor repetido
// do mesmo tipo une os grupos (é a mesma mídia).
function pushRef(list: RefList, groups: Groups, ref: RawRef): void {
  const key = ref.value.trim();
  const prior = list.seen.get(key);
  if (prior !== undefined) {
    if (prior.kind === ref.kind) unionGroups(groups, prior.group, ref.group);
    return;
  }
  if (isFull(list)) return;
  list.seen.set(key, ref);
  list.refs.push(ref);
}

function attr(element: Element, name: string): string | null {
  return element.attrs.find((a) => a.name === name)?.value ?? null;
}

function isHtmlElement(node: Node): node is Element {
  return "tagName" in node && node.namespaceURI === parse5Html.NS.HTML;
}

// O corte conta unidades UTF-16 e pode partir um par surrogate; toWellFormed troca a metade solta
// por U+FFFD (o validador do processo principal recusa texto mal formado).
function normalizeText(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH).toWellFormed();
  return normalized === "" ? null : normalized;
}

// Texto de um elemento, iterativo e com teto, sem descer em <script>/<style>/<template>.
function textContent(root: Element): string | null {
  let text = "";
  const stack: Node[] = [root];
  while (stack.length > 0 && text.length < MAX_TEXT_LENGTH * 4) {
    const node = stack.pop();
    if (node === undefined) break;
    if (node.nodeName === "#text" && "value" in node) text += node.value;
    if ("childNodes" in node && !["script", "style", "template"].includes(node.nodeName)) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child) stack.push(child);
      }
    }
  }
  return normalizeText(text);
}

// Microssintaxe do srcset (HTML "parse a srcset attribute", simplificado): URL até o espaço,
// descritores até a vírgula fora de parênteses.
export type SrcsetCandidate = { url: string; w: number | null; x: number | null };

// Um descritor w (inteiro > 0) ou x (número > 0); sem descritor vale 1x. Qualquer outra
// combinação é inválida e fica sem tamanho (w e x null).
function parseDescriptors(text: string): { w: number | null; x: number | null } {
  const tokens = text.trim() === "" ? [] : text.trim().split(/\s+/);
  if (tokens.length === 0) return { w: null, x: 1 };
  if (tokens.length > 1) return { w: null, x: null };
  const token = tokens[0] ?? "";
  const number = Number(token.slice(0, -1));
  const valid = token.length > 1 && Number.isFinite(number) && number > 0;
  if (token.endsWith("w") && valid && Number.isInteger(number)) return { w: number, x: null };
  if (token.endsWith("x") && valid) return { w: null, x: number };
  return { w: null, x: null };
}

export function parseSrcsetCandidates(value: string): SrcsetCandidate[] {
  const candidates: SrcsetCandidate[] = [];
  const input = value.slice(0, MAX_SRCSET_LENGTH);
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  let pos = 0;
  while (pos < input.length && candidates.length < MAX_SRCSET_CANDIDATES) {
    while (pos < input.length && (isSpace(input[pos]) || input[pos] === ",")) pos++;
    if (pos >= input.length) break;
    const start = pos;
    while (pos < input.length && !isSpace(input[pos])) pos++;
    let url = input.slice(start, pos);
    let descriptors = "";
    if (url.endsWith(",")) {
      // Laço em vez de /,+$/: a regex volta atrás em cada vírgula e fica quadrática (ReDoS).
      let end = url.length;
      while (end > 0 && url[end - 1] === ",") end--;
      url = url.slice(0, end);
    } else {
      const descriptorStart = pos;
      let descriptorEnd = input.length;
      let inParens = false;
      for (; pos < input.length; pos++) {
        const c = input[pos];
        if (c === "(") inParens = true;
        else if (c === ")") inParens = false;
        else if (c === "," && !inParens) {
          descriptorEnd = pos;
          pos++;
          break;
        }
      }
      descriptors = input.slice(descriptorStart, descriptorEnd);
    }
    if (url !== "") candidates.push({ url, ...parseDescriptors(descriptors) });
  }
  return candidates;
}

export function parseSrcset(value: string): string[] {
  return parseSrcsetCandidates(value).map((candidate) => candidate.url);
}

// Bits de ancestrais que os filhos herdam. O <header> de um article é o topo da matéria.
function contextFor(element: Element, ctx: number): number {
  switch (element.tagName) {
    case "article":
    case "main":
    case "figure":
      return ctx | SIGNAL.CONTENT;
    case "nav":
    case "aside":
      return ctx | SIGNAL.LAYOUT;
    case "header":
    case "footer":
      return ctx & SIGNAL.CONTENT ? ctx : ctx | SIGNAL.LAYOUT;
    default:
      return ctx;
  }
}

const lowerAttr = (element: Element, name: string): string => (attr(element, name) ?? "").slice(0, 64).trim().toLowerCase();

// Sinais do próprio elemento somados aos herdados dos ancestrais.
function elementSignals(element: Element, ctx: number): number {
  let signals = ctx | sizeSignals(attr(element, "width"), attr(element, "height"));
  if (lowerAttr(element, "role") === "presentation" || lowerAttr(element, "aria-hidden") === "true") signals |= SIGNAL.HIDDEN;
  if (hasIconWord(attr(element, "class")) || hasIconWord(attr(element, "id")) || hasIconWord(attr(element, "alt"))) {
    signals |= SIGNAL.ICON_WORD;
  }
  return signals;
}

function parentElement(element: Element): Element | null {
  const parent = element.parentNode;
  return parent && isHtmlElement(parent) ? parent : null;
}

function rawRef(value: string, kind: MediaKind, source: MediaSource, group: number, size: { w?: number | null; x?: number | null } = {}, svg = false): RawRef {
  return { value, kind, source, group, w: size.w ?? null, x: size.x ?? null, svg };
}

function pushSrcset(found: Collected, srcset: string, source: MediaSource, kind: MediaKind, group: number, svg: boolean): void {
  if (isFull(found.body)) return;
  for (const { url, w, x } of parseSrcsetCandidates(srcset)) pushRef(found.body, found.groups, rawRef(url, kind, source, group, { w, x }, svg));
}

// og:image, twitter:image e og:video: cada valor distinto é um grupo próprio, no topo do ranking.
function collectMeta(element: Element, found: Collected): void {
  const property = (attr(element, "property") ?? attr(element, "name") ?? "").trim().toLowerCase();
  const content = attr(element, "content");
  if (content === null) return;
  if (property === "og:title" && found.ogTitle === null) {
    found.ogTitle = normalizeText(content);
    return;
  }
  const match: [MediaKind, MediaSource] | null = OG_IMAGE.has(property)
    ? ["image", "og:image"]
    : TWITTER_IMAGE.has(property)
      ? ["image", "twitter:image"]
      : OG_VIDEO.has(property)
        ? ["video", "og:video"]
        : null;
  if (match === null) return;
  pushRef(found.og, found.groups, rawRef(content, match[0], match[1], newGroup(found.groups, SIGNAL.META)));
}

// <picture> e <video> abrem um grupo que os filhos diretos (<source>, <img>) usam.
function openParentGroup(element: Element, ctx: number, found: Collected): number {
  const group = newGroup(found.groups, elementSignals(element, ctx));
  found.parentGroup.set(element, group);
  return group;
}

function groupFromParent(element: Element, ctx: number, found: Collected): number {
  const parent = parentElement(element);
  const group = parent === null ? undefined : found.parentGroup.get(parent);
  if (group === undefined) return newGroup(found.groups, elementSignals(element, ctx));
  addSignals(found.groups, group, elementSignals(element, ctx));
  return group;
}

function collectImg(element: Element, ctx: number, found: Collected): void {
  const group = groupFromParent(element, ctx, found);
  const src = attr(element, "src");
  if (src !== null) pushRef(found.body, found.groups, rawRef(src, "image", "img", group, { x: 1 }));
  const srcset = attr(element, "srcset");
  if (srcset !== null) pushSrcset(found, srcset, "img-srcset", "image", group, false);
}

function collectVideo(element: Element, ctx: number, found: Collected): void {
  const group = openParentGroup(element, ctx, found);
  const src = attr(element, "src");
  if (src !== null) pushRef(found.body, found.groups, rawRef(src, "video", "video", group));
  const poster = attr(element, "poster");
  if (poster !== null) {
    pushRef(found.body, found.groups, rawRef(poster, "image", "video-poster", newGroup(found.groups, elementSignals(element, ctx))));
  }
}

function collectSource(element: Element, ctx: number, found: Collected): void {
  const parentTag = parentElement(element)?.tagName ?? "";
  if (parentTag !== "picture" && parentTag !== "video") return; // <audio> e afins ficam de fora
  const kind: MediaKind = parentTag === "video" ? "video" : "image";
  const group = groupFromParent(element, ctx, found);
  const svg = lowerAttr(element, "type").startsWith("image/svg+xml");
  const src = attr(element, "src");
  if (src !== null) pushRef(found.body, found.groups, rawRef(src, kind, "source", group, {}, svg));
  const srcset = attr(element, "srcset");
  if (srcset !== null) pushSrcset(found, srcset, "source-srcset", kind, group, svg);
}

function noteSpaMarkers(element: Element, found: Collected): void {
  if (element.tagName === "script") found.hasScript = true;
  const id = attr(element, "id");
  if (id !== null && MOUNT_IDS.has(id.trim()) && element.childNodes.every((child) => !("tagName" in child))) found.emptyMount = true;
}

function collectElement(element: Element, ctx: number, found: Collected): void {
  noteSpaMarkers(element, found);
  switch (element.tagName) {
    case "base": {
      const href = attr(element, "href");
      if (found.baseHref === null && href !== null) found.baseHref = href;
      return;
    }
    case "title":
      if (found.title === null) found.title = textContent(element);
      return;
    case "h1":
      if (found.h1 === null) found.h1 = textContent(element);
      return;
    case "meta":
      return collectMeta(element, found);
    case "picture":
      openParentGroup(element, ctx, found);
      return;
    case "img":
      return collectImg(element, ctx, found);
    case "video":
      return collectVideo(element, ctx, found);
    case "source":
      return collectSource(element, ctx, found);
  }
}

// Conta caracteres visíveis (sem espaço) até o limiar do sinal de JavaScript; depois para.
function countVisibleText(node: Node, found: Collected): void {
  if (found.visibleChars >= VISIBLE_TEXT_THRESHOLD || !("value" in node)) return;
  if (node.parentNode && HIDDEN_TEXT_PARENTS.has(node.parentNode.nodeName)) return;
  const text = node.value;
  for (let i = 0; i < text.length && found.visibleChars < VISIBLE_TEXT_THRESHOLD; i++) {
    const code = text.charCodeAt(i);
    if (code !== 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13 && code !== 160) found.visibleChars++;
  }
}

// Percorre a árvore com pilha explícita (sem recursão) e teto de nós. A pilha de contextos, em
// paralelo, guarda só os bits dos ancestrais (um número por item, sem objeto).
function walk(document: Node, limits: ExtractLimits): Collected {
  const maxRaw = limits.maxMediaRefs * RAW_REFS_PER_MEDIA_REF;
  const found: Collected = {
    baseHref: null,
    title: null,
    ogTitle: null,
    h1: null,
    og: newRefList(maxRaw),
    body: newRefList(maxRaw),
    groups: { parent: [], signals: [] },
    parentGroup: new Map(),
    hasScript: false,
    emptyMount: false,
    visibleChars: 0,
  };
  const nodes: Node[] = [document];
  const contexts: number[] = [0];
  let visited = 0;
  while (nodes.length > 0 && visited < limits.maxHtmlNodes) {
    const node = nodes.pop();
    const ctx = contexts.pop() ?? 0;
    if (node === undefined) break;
    visited++;
    let childCtx = ctx;
    if (isHtmlElement(node)) {
      collectElement(node, ctx, found);
      childCtx = contextFor(node, ctx);
    } else if (node.nodeName === "#text") countVisibleText(node, found);
    // Conteúdo de <template> fica em node.content, fora de childNodes: não é percorrido.
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child) {
          nodes.push(child);
          contexts.push(childCtx);
        }
      }
    }
  }
  return found;
}

function resolveBase(baseHref: string | null, pageUrl: string): string {
  if (baseHref === null) return pageUrl;
  try {
    const base = new URL(baseHref.trim(), pageUrl);
    return base.protocol === "http:" || base.protocol === "https:" ? base.href : pageUrl;
  } catch {
    return pageUrl;
  }
}

function resolveRef(value: string, base: string, maxUrlLength: number): URL | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxUrlLength) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null; // data:, javascript:, blob:...
    url.hash = "";
    return url.href.length > maxUrlLength ? null : url;
  } catch {
    return null;
  }
}

const larger = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

// A mesma URL já listada: une os grupos (se for do mesmo tipo) e guarda o maior descritor.
function mergeDuplicate(groups: Groups, prior: ListedRef, ref: RawRef): void {
  if (prior.kind !== ref.kind) return;
  unionGroups(groups, prior.root, ref.group);
  prior.w = larger(prior.w, ref.w);
  prior.x = larger(prior.x, ref.x);
}

// Resolve, deduplica e corta em maxMediaRefs, na ordem de sempre: og primeiro, depois o documento.
function listRefs(found: Collected, base: string, limits: ExtractLimits): ListedRef[] {
  const listed: ListedRef[] = [];
  const byUrl = new Map<string, ListedRef>();
  for (const ref of [...found.og.refs, ...found.body.refs]) {
    if (listed.length >= limits.maxMediaRefs) break;
    const url = resolveRef(ref.value, base, limits.maxUrlLength);
    if (url === null) continue;
    const prior = byUrl.get(url.href);
    if (prior !== undefined) {
      mergeDuplicate(found.groups, prior, ref);
      continue;
    }
    const name = fileName(url.pathname);
    const entry: ListedRef = {
      url: url.href,
      kind: ref.kind,
      source: ref.source,
      root: ref.group,
      signals: hasIconWord(name) ? SIGNAL.ICON_WORD : 0,
      w: ref.w,
      x: ref.x,
      svg: ref.svg || isSvgName(name),
    };
    byUrl.set(url.href, entry);
    listed.push(entry);
  }
  return listed;
}

// Extrai título, manchete e referências de mídia, agrupa as variantes e escolhe o que baixar.
// Não executa script nem busca nada: as URLs devolvidas são tão hostis quanto a do usuário e
// passam por safeFetch antes de baixar.
export function extractPage(
  htmlText: string,
  pageUrl: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedPage {
  const found = walk(parse(htmlText), limits);
  const listed = listRefs(found, resolveBase(found.baseHref, pageUrl), limits);
  for (const ref of listed) ref.root = findGroup(found.groups, ref.root);
  const maxSelected = limits.maxSelectedMedia ?? DEFAULT_LIMITS.maxSelectedMedia;
  const media = selectMedia(listed, (root) => found.groups.signals[root] ?? 0, maxSelected);
  const possiblyNeedsJavaScript =
    media.length === 0 && found.visibleChars < VISIBLE_TEXT_THRESHOLD && (found.hasScript || found.emptyMount);
  return { title: found.title, headline: found.ogTitle ?? found.h1, media, possiblyNeedsJavaScript };
}
