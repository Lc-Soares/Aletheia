import { type DefaultTreeAdapterTypes, html as parse5Html, parse } from "parse5";

import { DEFAULT_LIMITS } from "./limits.ts";

type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.Node;

export type MediaKind = "image" | "video";
export type MediaSource =
  | "og:image"
  | "og:video"
  | "img"
  | "img-srcset"
  | "source"
  | "source-srcset"
  | "video"
  | "video-poster";
export type MediaRef = { url: string; kind: MediaKind; source: MediaSource };
export type ExtractedPage = { title: string | null; headline: string | null; media: MediaRef[] };
export type ExtractLimits = { maxMediaRefs: number; maxUrlLength: number; maxHtmlNodes: number };

const MAX_TEXT_LENGTH = 300;
const MAX_SRCSET_LENGTH = 16 * 1024;
const MAX_SRCSET_CANDIDATES = 20;

const OG_IMAGE = new Set(["og:image", "og:image:url", "og:image:secure_url"]);
const OG_VIDEO = new Set(["og:video", "og:video:url", "og:video:secure_url"]);

type RawRef = { value: string; kind: MediaKind; source: MediaSource };

type Collected = {
  baseHref: string | null;
  title: string | null;
  ogTitle: string | null;
  h1: string | null;
  og: RawRef[];
  body: RawRef[];
};

function attr(element: Element, name: string): string | null {
  return element.attrs.find((a) => a.name === name)?.value ?? null;
}

function isHtmlElement(node: Node): node is Element {
  return "tagName" in node && node.namespaceURI === parse5Html.NS.HTML;
}

function normalizeText(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
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
// descritores até a vírgula fora de parênteses. Os descritores são ignorados.
export function parseSrcset(value: string): string[] {
  const urls: string[] = [];
  const input = value.slice(0, MAX_SRCSET_LENGTH);
  const isSpace = (c: string | undefined): boolean => c === " " || c === "\t" || c === "\n" || c === "\r" || c === "\f";
  let pos = 0;
  while (pos < input.length && urls.length < MAX_SRCSET_CANDIDATES) {
    while (pos < input.length && (isSpace(input[pos]) || input[pos] === ",")) pos++;
    if (pos >= input.length) break;
    const start = pos;
    while (pos < input.length && !isSpace(input[pos])) pos++;
    let url = input.slice(start, pos);
    if (url.endsWith(",")) {
      // Laço em vez de /,+$/: a regex volta atrás em cada vírgula e fica quadrática (ReDoS).
      let end = url.length;
      while (end > 0 && url[end - 1] === ",") end--;
      url = url.slice(0, end);
    } else {
      let inParens = false;
      for (; pos < input.length; pos++) {
        const c = input[pos];
        if (c === "(") inParens = true;
        else if (c === ")") inParens = false;
        else if (c === "," && !inParens) {
          pos++;
          break;
        }
      }
    }
    if (url !== "") urls.push(url);
  }
  return urls;
}

function collectMeta(element: Element, found: Collected): void {
  const property = (attr(element, "property") ?? attr(element, "name") ?? "").trim().toLowerCase();
  const content = attr(element, "content");
  if (content === null) return;
  if (property === "og:title" && found.ogTitle === null) found.ogTitle = normalizeText(content);
  else if (OG_IMAGE.has(property)) found.og.push({ value: content, kind: "image", source: "og:image" });
  else if (OG_VIDEO.has(property)) found.og.push({ value: content, kind: "video", source: "og:video" });
}

function collectSource(element: Element, found: Collected): void {
  const parentTag = element.parentNode && "tagName" in element.parentNode ? element.parentNode.tagName : "";
  if (parentTag !== "picture" && parentTag !== "video") return; // <audio> e afins ficam de fora
  const kind: MediaKind = parentTag === "video" ? "video" : "image";
  const src = attr(element, "src");
  if (src !== null) found.body.push({ value: src, kind, source: "source" });
  const srcset = attr(element, "srcset");
  if (srcset !== null) {
    for (const value of parseSrcset(srcset)) found.body.push({ value, kind, source: "source-srcset" });
  }
}

function collectElement(element: Element, found: Collected): void {
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
    case "img": {
      const src = attr(element, "src");
      if (src !== null) found.body.push({ value: src, kind: "image", source: "img" });
      const srcset = attr(element, "srcset");
      if (srcset !== null) {
        for (const value of parseSrcset(srcset)) found.body.push({ value, kind: "image", source: "img-srcset" });
      }
      return;
    }
    case "video": {
      const src = attr(element, "src");
      if (src !== null) found.body.push({ value: src, kind: "video", source: "video" });
      const poster = attr(element, "poster");
      if (poster !== null) found.body.push({ value: poster, kind: "image", source: "video-poster" });
      return;
    }
    case "source":
      return collectSource(element, found);
  }
}

// Percorre a árvore com pilha explícita (sem recursão) e teto de nós.
function walk(document: Node, maxNodes: number): Collected {
  const found: Collected = { baseHref: null, title: null, ogTitle: null, h1: null, og: [], body: [] };
  const stack: Node[] = [document];
  let visited = 0;
  while (stack.length > 0 && visited < maxNodes) {
    const node = stack.pop();
    if (node === undefined) break;
    visited++;
    if (isHtmlElement(node)) collectElement(node, found);
    // Conteúdo de <template> fica em node.content, fora de childNodes: não é percorrido.
    if ("childNodes" in node) {
      for (let i = node.childNodes.length - 1; i >= 0; i--) {
        const child = node.childNodes[i];
        if (child) stack.push(child);
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

function resolveRef(value: string, base: string, maxUrlLength: number): string | null {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > maxUrlLength) return null;
  try {
    const url = new URL(trimmed, base);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null; // data:, javascript:, blob:...
    url.hash = "";
    return url.href.length > maxUrlLength ? null : url.href;
  } catch {
    return null;
  }
}

// Extrai título, manchete e referências de mídia. Não executa script nem busca nada:
// as URLs devolvidas são tão hostis quanto a do usuário e passam por safeFetch antes de baixar.
export function extractPage(
  htmlText: string,
  pageUrl: string,
  limits: ExtractLimits = DEFAULT_LIMITS,
): ExtractedPage {
  const found = walk(parse(htmlText), limits.maxHtmlNodes);
  const base = resolveBase(found.baseHref, pageUrl);
  const seen = new Set<string>();
  const media: MediaRef[] = [];
  for (const ref of [...found.og, ...found.body]) {
    if (media.length >= limits.maxMediaRefs) break;
    const url = resolveRef(ref.value, base, limits.maxUrlLength);
    if (url === null || seen.has(url)) continue;
    seen.add(url);
    media.push({ url, kind: ref.kind, source: ref.source });
  }
  return { title: found.title, headline: found.ogTitle ?? found.h1, media };
}
