// Script de DESENVOLVIMENTO: envia UM arquivo local à ExifTools real, pelo mesmo cliente de produção
// (createExifToolsClient: endereço fixo, limites padrão, só multipart/file, chave só no cabeçalho),
// e imprime os sinais da lista permitida e só os NOMES dos grupos e tags da resposta bruta, para
// conferir se os nomes da lista permitida batem. Nunca imprime valores brutos (coordenadas, nomes,
// números de série), a chave nem os bytes. A chave vem da variável EXIFTOOLS_API_KEY do processo;
// nenhum arquivo de ambiente é lido. Não grava nada em disco. Fica fora da imagem (.dockerignore).
// Uso: docs/desenvolvimento-local.md.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { createExifToolsClient, type ExtractResult } from "../src/exiftools-client.ts";
import { extractSignals } from "../src/metadata-allowlist.ts";

// env, readFile, write e endpoint existem só para os testes (servidor falso); não há flag de linha
// de comando que mude destino, limites ou proteção.
export type MainIo = {
  env?: Record<string, string | undefined>;
  readFile?: (path: string) => Promise<Buffer>;
  write?: (text: string) => void;
  endpoint?: string;
};

const USAGE = `Uso: npm run try-exiftools -w api -- <arquivo local>
Envia o arquivo à ExifTools real (chave em EXIFTOOLS_API_KEY) e mostra os sinais da lista permitida
e os nomes dos grupos e tags da resposta, sem valores.
Aviso: o arquivo sai desta máquina e vai para a ExifTools, um serviço de terceiros que guarda
resultados. Use só arquivos próprios, nunca de outras pessoas.
`;

const MAX_FILE_BYTES = 15 * 1024 * 1024; // o mesmo teto de mídia do fetcher
const DEADLINE_MS = 50_000;
const MAX_DEPTH = 4;
const MAX_NAMES_PER_PATH = 200;
const MAX_NAME_LENGTH = 80;

// Só os formatos que o fetcher baixa (MEDIA_TYPES de fetcher/src/safe-fetch.ts).
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".heic", "image/heic"],
  [".heif", "image/heif"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".mp4", "video/mp4"],
  [".webm", "video/webm"],
  [".mov", "video/quicktime"],
]);

export function contentTypeFor(path: string): string | null {
  return CONTENT_TYPES.get(extname(path).toLowerCase()) ?? null;
}

// Texto antes do terminal (como no try-fetch): sem sequências ANSI, quebras viram espaço, sem
// controles C0/C1 nem caracteres de formato Unicode (inclusive os de direção, como U+202E).
export function sanitize(text: string): string {
  return stripVTControlCharacters(text)
    .replace(/[\t\n\r]/g, " ")
    .replace(/[\p{Cc}\p{Cf}]/gu, "");
}

type PlainObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is PlainObject =>
  typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype;

function nameList(objects: PlainObject[]): string[] {
  const names = new Set<string>();
  for (const object of objects) for (const key of Object.keys(object)) names.add(sanitize(key).slice(0, MAX_NAME_LENGTH));
  const sorted = [...names].sort();
  const extra = sorted.length - MAX_NAMES_PER_PATH;
  return extra > 0 ? [...sorted.slice(0, MAX_NAMES_PER_PATH), `… (+${extra})`] : sorted;
}

// Só os NOMES: uma linha por caminho ("metadata.GPS: GPSLatitude, ..."), com listas de objetos como
// "caminho[]" (nomes de todos os itens juntos). Nenhum valor é lido para a saída.
export function tagNames(response: unknown): string[] {
  const lines: string[] = [];
  const visit = (objects: PlainObject[], path: string, depth: number): void => {
    if (objects.length === 0 || depth > MAX_DEPTH) return;
    lines.push(`${path === "" ? "(nível superior)" : path}: ${nameList(objects).join(", ")}`);
    const keys = new Set(objects.flatMap((object) => Object.keys(object)));
    for (const key of [...keys].sort()) {
      const childPath = path === "" ? sanitize(key) : `${path}.${sanitize(key)}`;
      const children = objects.map((object) => object[key]);
      visit(children.filter(isPlainObject), childPath, depth + 1);
      visit(children.filter(Array.isArray).flat().filter(isPlainObject), `${childPath}[]`, depth + 1);
    }
  };
  if (isPlainObject(response)) visit([response], "", 0);
  return lines;
}

function formatResult(name: string, contentType: string, bytes: Buffer, result: ExtractResult): string {
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const lines = [
    `Arquivo: ${sanitize(name)} (${contentType}, ${bytes.length} bytes, sha256 ${sha256.slice(0, 12)})`,
    `Resultado da ExifTools: ${result.status}`,
  ];
  if (result.status === "ok") {
    lines.push("Sinais (lista permitida):");
    const signals = JSON.stringify(extractSignals(result.response, sha256), null, 2);
    for (const line of signals.split("\n")) lines.push(`  ${sanitize(line)}`);
    lines.push("Grupos e tags na resposta bruta (só nomes, sem valores):");
    for (const line of tagNames(result.response)) lines.push(`  ${line}`);
  }
  return `${lines.join("\n")}\n`;
}

// Devolve o código de saída: 0 quando rodou (uma falha da ExifTools aparece no resultado), 2 para
// uso errado, chave ausente ou arquivo recusado.
export async function main(argv: string[], io: MainIo = {}): Promise<number> {
  const write = io.write ?? ((output: string) => void process.stdout.write(output));
  const read = io.readFile ?? ((path: string) => readFile(path));
  if (argv.length === 1 && (argv[0] === "-h" || argv[0] === "--help")) {
    write(USAGE);
    return 0;
  }
  const path = argv[0];
  if (argv.length !== 1 || path === undefined || path.startsWith("-")) {
    write(USAGE);
    return 2;
  }
  // Só esta variável do processo é lida; a chave nunca é impressa.
  const apiKey = (io["env"] === undefined ? process.env["EXIFTOOLS_API_KEY"] : io["env"]["EXIFTOOLS_API_KEY"])?.trim();
  if (!apiKey) {
    write("Defina a variável EXIFTOOLS_API_KEY no ambiente do terminal.\n");
    return 2;
  }
  const contentType = contentTypeFor(path);
  if (contentType === null) {
    write("Extensão não suportada: use um dos formatos de imagem ou vídeo que o fetcher baixa.\n");
    return 2;
  }
  let bytes: Buffer;
  try {
    bytes = await read(path);
  } catch {
    write("Não foi possível ler o arquivo.\n");
    return 2;
  }
  if (bytes.length > MAX_FILE_BYTES) {
    write("Arquivo acima de 15 MiB, o limite de mídia do fetcher.\n");
    return 2;
  }
  const extract = createExifToolsClient(io.endpoint === undefined ? { apiKey } : { apiKey, endpoint: io.endpoint });
  const result = await extract({ bytes, contentType }, { signal: new AbortController().signal, deadlineAt: performance.now() + DEADLINE_MS });
  write(formatResult(basename(path), contentType, bytes, result));
  return 0;
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
