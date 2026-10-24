import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs, { readdirSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, test } from "node:test";

import {
  contentCredentials,
  exifSuccess,
  type FakeExifToolsHandler,
  parseMultipart,
  sendJsonResponse,
  startFakeExifTools,
  TEST_EXIFTOOLS_KEY,
} from "../src/testing.ts";
import { contentTypeFor, main, sanitize, tagNames } from "./try-exiftools.ts";

const FILE_BYTES = Buffer.from("BYTES-DO-ARQUIVO-QUE-NAO-PODEM-APARECER");

// Resposta com dados pessoais e identificadores: só os NOMES podem aparecer na saída.
function hostileResponse(): Record<string, unknown> {
  return exifSuccess({
    author: "Fulano de Tal",
    metadata: {
      File: { FileType: "JPEG", MIMEType: "image/jpeg", ImageWidth: 4000, ImageHeight: 3000 },
      EXIF: { Make: "Canon", Model: "EOS", SerialNumber: "SN-998877", Artist: "Fulano de Tal" },
      GPS: { GPSLatitude: "23 deg 33' 1.00\" S", GPSLongitude: "46 deg 38' 2.00\" W" },
      Composite: { GPSPosition: "23.5501 S, 46.6339 W" },
      XMP: { Creator: ["Fulano de Tal"], CreatorTool: "Editor X", "Tag\u001b[31mHostil‮": "valor-da-tag-hostil" },
      IPTC: { "By-line": "Fulano de Tal" },
    },
    contentCredentials: contentCredentials({ creator: ["Fulano de Tal"], ingredients: [{ title: "ingrediente-privado.jpg", relationship: "parentOf" }] }),
  });
}

const SECRETS = [
  "Fulano",
  "SN-998877",
  "23 deg",
  "23.5501",
  "46.6339",
  "valor-da-tag-hostil",
  "ingrediente-privado",
  "manifest?format",
  "123e4567",
  TEST_EXIFTOOLS_KEY,
  FILE_BYTES.toString(),
  FILE_BYTES.toString("base64"),
];

type Run = { code: number; output: string; requests: number; lastRequest: Awaited<ReturnType<typeof startFakeExifTools>>["requests"][number] | undefined };

async function run(
  argv: string[],
  handler: FakeExifToolsHandler = (_req, res) => sendJsonResponse(res, 200, hostileResponse()),
  { env = { EXIFTOOLS_API_KEY: TEST_EXIFTOOLS_KEY }, files = { "foto.jpg": FILE_BYTES } }: { env?: Record<string, string | undefined>; files?: Record<string, Buffer> } = {},
): Promise<Run> {
  const fake = await startFakeExifTools(handler);
  let output = "";
  try {
    const code = await main(argv, {
      env,
      endpoint: fake.endpoint,
      readFile: async (path) => {
        const content = files[path];
        if (content === undefined) throw new Error("arquivo não existe");
        return content;
      },
      write: (text) => {
        output += text;
      },
    });
    return { code, output, requests: fake.requests.length, lastRequest: fake.requests.at(-1) };
  } finally {
    await fake.close();
  }
}

describe("try-exiftools: saída", () => {
  test("imprime os sinais da lista permitida e os nomes de grupos e tags, sem valores", async () => {
    const { code, output } = await run(["foto.jpg"]);
    assert.equal(code, 0);
    for (const expected of [
      "Arquivo: foto.jpg",
      "image/jpeg",
      "Resultado da ExifTools: ok",
      '"containsLocation": true',
      '"containsAuthorship": true',
      '"make": "Canon"',
      "metadata.GPS: GPSLatitude, GPSLongitude",
      "metadata.Composite: GPSPosition",
      "metadata.EXIF: Artist, Make, Model, SerialNumber",
      "contentCredentials.actions[]: action, digitalSourceType, softwareAgent",
      "contentCredentials.checks[]: code, outcome",
      "contentCredentials.ingredients[]: relationship, title",
    ]) {
      assert.ok(output.includes(expected), `faltou: ${expected}\n${output}`);
    }
    for (const secret of SECRETS) assert.equal(output.includes(secret), false, `vazou: ${secret}`);
  });

  test("nomes de tag hostis são higienizados antes do terminal", async () => {
    const { output } = await run(["foto.jpg"]);
    assert.ok(output.includes("metadata.XMP: Creator, CreatorTool, TagHostil"), output);
    for (const line of output.split("\n")) assert.doesNotMatch(line, /[\p{Cc}\p{Cf}]/u, JSON.stringify(line));
  });

  test("envia o arquivo pelo cliente real: multipart com um campo file e chave no cabeçalho", async () => {
    const { lastRequest } = await run(["foto.jpg"]);
    assert.ok(lastRequest);
    assert.equal(lastRequest.headers["x-api-key"], TEST_EXIFTOOLS_KEY);
    assert.equal(lastRequest.path, "/api/v1/extract");
    const form = await parseMultipart(lastRequest);
    assert.deepEqual([...form.keys()], ["file"]);
    const file = form.get("file");
    assert.ok(file instanceof File);
    assert.equal(file.name, "media.jpg", "nome genérico, não o nome do arquivo local");
    assert.ok(Buffer.from(await file.arrayBuffer()).equals(FILE_BYTES));
  });

  test("falha da ExifTools: mostra só o status, sem nomes de tags, e sai com 0", async () => {
    const { code, output } = await run(["foto.jpg"], (_req, res) => sendJsonResponse(res, 415, { success: false, error: "segredo do servidor" }));
    assert.equal(code, 0);
    assert.match(output, /Resultado da ExifTools: unsupported/);
    assert.equal(output.includes("Grupos e tags"), false);
    assert.equal(output.includes("segredo do servidor"), false);
  });

  test("sanitize remove ANSI, controles e caracteres de formato e troca quebras por espaço", () => {
    assert.equal(sanitize("a\u001b[31mb\u0007c\u009bd‮e​f\nlinha\ttab"), "abcdef linha tab");
  });

  test("tagNames: só nomes, ordenados, com listas de objetos como caminho[]", () => {
    const lines = tagNames({ success: true, metadata: { GPS: { B: 1, A: "x" } }, contentCredentials: { checks: [{ code: "c" }, { outcome: "o" }] } });
    assert.ok(lines.includes("(nível superior): contentCredentials, metadata, success"));
    assert.ok(lines.includes("metadata.GPS: A, B"));
    assert.ok(lines.includes("contentCredentials.checks[]: code, outcome"));
    assert.equal(lines.join("\n").includes("x"), false);
  });
});

describe("try-exiftools: argumentos e entrada", () => {
  test("contentTypeFor deriva o tipo da extensão; extensão desconhecida devolve null", () => {
    assert.equal(contentTypeFor("a/b/FOTO.JPEG"), "image/jpeg");
    assert.equal(contentTypeFor("x.jpg"), "image/jpeg");
    assert.equal(contentTypeFor("x.png"), "image/png");
    assert.equal(contentTypeFor("x.tif"), "image/tiff");
    assert.equal(contentTypeFor("x.mov"), "video/quicktime");
    assert.equal(contentTypeFor("x.mp4"), "video/mp4");
    assert.equal(contentTypeFor("x.txt"), null);
    assert.equal(contentTypeFor("sem-extensao"), null);
  });

  test("uso errado: código 2, uso impresso e nenhuma requisição", async () => {
    for (const argv of [[], ["a.jpg", "b.jpg"], ["--sem-protecao"], ["--url", "https://x.example/a.jpg"]]) {
      const result = await run(argv);
      assert.equal(result.code, 2, JSON.stringify(argv));
      assert.match(result.output, /Uso:/);
      assert.equal(result.requests, 0);
    }
  });

  test("-h mostra o uso e o aviso, e sai com 0", async () => {
    const { code, output } = await run(["-h"]);
    assert.equal(code, 0);
    assert.match(output, /Uso:/);
    assert.match(output, /sai desta máquina/);
  });

  test("sem EXIFTOOLS_API_KEY: código 2 e nenhuma requisição", async () => {
    for (const env of [{}, { EXIFTOOLS_API_KEY: "  " }]) {
      const result = await run(["foto.jpg"], undefined, { env });
      assert.equal(result.code, 2);
      assert.match(result.output, /EXIFTOOLS_API_KEY/);
      assert.equal(result.requests, 0);
    }
  });

  test("extensão não suportada, arquivo ilegível ou grande demais: código 2 e nenhuma requisição", async () => {
    const files = { "nota.txt": Buffer.from("x"), "grande.jpg": Buffer.alloc(15 * 1024 * 1024 + 1) };
    for (const path of ["nota.txt", "nao-existe.jpg", "grande.jpg"]) {
      const result = await run([path], undefined, { files });
      assert.equal(result.code, 2, path);
      assert.equal(result.requests, 0, path);
    }
  });

  test("não grava nada em disco e não usa o console", async (t) => {
    const writers = ["writeFile", "writeFileSync", "appendFile", "appendFileSync", "createWriteStream", "open", "openSync"] as const;
    const mocked = [
      ...writers.map((name) => t.mock.method(fs, name)),
      ...(["writeFile", "appendFile", "open"] as const).map((name) => t.mock.method(fs.promises, name)),
    ];
    const consoleCalls = (["log", "info", "warn", "error", "debug"] as const).map((name) => t.mock.method(console, name, () => {}));
    await run(["foto.jpg"]);
    for (const writer of mocked) assert.equal(writer.mock.callCount(), 0);
    for (const call of consoleCalls) assert.equal(call.mock.callCount(), 0);
  });
});

describe("try-exiftools: termina sozinho", () => {
  test("o processo sai depois de imprimir, sem process.exit", { timeout: 30_000 }, async () => {
    const fake = await startFakeExifTools((_req, res) => sendJsonResponse(res, 200, exifSuccess()));
    try {
      const script = `
        import { main } from ${JSON.stringify(new URL("./try-exiftools.ts", import.meta.url).href)};
        process.exitCode = await main(["foto.jpg"], {
          env: { EXIFTOOLS_API_KEY: "chave-filho" },
          endpoint: ${JSON.stringify(fake.endpoint)},
          readFile: async () => Buffer.from("bytes"),
          write: (text) => process.stdout.write(text),
        });`;
      const env: Record<string, string | undefined> = { ...process.env };
      delete env["NODE_TEST_CONTEXT"];
      delete env["NODE_OPTIONS"];
      const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
      const killer = setTimeout(() => child.kill(), 15_000);
      const [status, signal] = (await once(child, "exit")) as [number | null, NodeJS.Signals | null];
      clearTimeout(killer);
      assert.equal(signal, null, `não saiu sozinho a tempo: ${stdout}`);
      assert.equal(status, 0, stdout);
      assert.match(stdout, /Resultado da ExifTools: ok/);
    } finally {
      await fake.close();
    }
  });
});

describe("try-exiftools: fora da imagem e sem relaxar proteção", () => {
  const SCRIPT_SOURCE = readFileSync(new URL("./try-exiftools.ts", import.meta.url), "utf8");

  test(".dockerignore remove api/scripts inteiro", () => {
    const patterns = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    const excluded = (path: string): boolean =>
      patterns.some((pattern) => {
        const parts = path.split("/");
        return parts.some((_, i) => posix.matchesGlob(parts.slice(0, i + 1).join("/"), pattern));
      });
    for (const file of ["try-exiftools.ts", "try-exiftools.test.ts"]) assert.ok(excluded(`api/scripts/${file}`), file);
  });

  test("nenhum módulo de produção importa algo de scripts/", () => {
    const srcDir = new URL("../src/", import.meta.url);
    const production = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts");
    assert.ok(production.includes("main.ts"));
    for (const file of production) {
      assert.doesNotMatch(readFileSync(new URL(file, srcDir), "utf8"), /from\s+["'][^"']*scripts\//, file);
    }
  });

  test("usa o cliente de produção, sem testing.ts, sem limites próprios, e só lê EXIFTOOLS_API_KEY do ambiente", () => {
    assert.doesNotMatch(SCRIPT_SOURCE, /testing(\.ts)?["']/);
    assert.match(SCRIPT_SOURCE, /createExifToolsClient\(/);
    assert.doesNotMatch(SCRIPT_SOURCE, /limits\s*:/);
    assert.doesNotMatch(SCRIPT_SOURCE, /\.env\b(?!\[)|dotenv|readFileSync\([^)]*env/);
    const envReads = SCRIPT_SOURCE.match(/process\.env\[[^\]]*\]|process\.env\.\w+/g) ?? [];
    assert.ok(envReads.length > 0);
    for (const read of envReads) assert.equal(read, 'process.env["EXIFTOOLS_API_KEY"]');
  });

  test("o tsconfig e o script de testes da API incluem scripts/", () => {
    assert.match(readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"), /"include":\s*\[[^\]]*"scripts"/);
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    assert.equal(pkg.scripts["try-exiftools"], "node scripts/try-exiftools.ts");
    assert.match(pkg.scripts["test"] ?? "", /"scripts\/\*\*\/\*\.test\.ts"/);
  });
});
