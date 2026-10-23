// Runner dos scripts "test" de api, web e fetcher: node ../test-support/run-tests.js "<glob>".
// Roda o node:test com o guarda de unhandled rejection e reprova a execução quando nenhum teste
// passou de verdade. Motivo: "node --test" sem nenhum teste (glob vazio, ou *.test.ts removidos
// pelo .dockerignore) imprime "tests 0" e sai com 0, e um arquivo sem nenhum test() aparece no
// resumo como 1 teste que passou. Falha fechado: se a contagem ou o resumo não forem
// encontrados, também reprova.
import { spawn } from "node:child_process";
import { relative } from "node:path";

import { COUNT_PREFIX } from "./count-reporter.js";
import { specSummary, verdict } from "./verdict.js";

const GUARD = new URL("./fail-on-unhandled-rejection.js", import.meta.url);
const COUNTER = new URL("./count-reporter.js", import.meta.url);
const globs = process.argv.slice(2);

// spec explícito no stdout (o formato não depende de terminal ou pipe); a contagem vai no stderr.
const reporters = ["--test-reporter=spec", "--test-reporter-destination=stdout"];
reporters.push(`--test-reporter=${COUNTER.href}`, "--test-reporter-destination=stderr");
const child = spawn(process.execPath, ["--import", GUARD.href, "--test", ...reporters, ...globs], {
  stdio: ["inherit", "pipe", "pipe"],
});

const stdoutChunks = [];
child.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  stdoutChunks.push(chunk);
});

// O stderr passa direto, menos a linha de contagem, que é guardada.
let count = null;
let pending = "";
function handleStderrLine(line) {
  if (line.startsWith(COUNT_PREFIX)) count = JSON.parse(line.slice(COUNT_PREFIX.length));
  else process.stderr.write(`${line}\n`);
}
child.stderr.on("data", (chunk) => {
  const lines = (pending + chunk.toString("utf8")).split("\n");
  pending = lines.pop() ?? "";
  for (const line of lines) handleStderrLine(line.replace(/\r$/, ""));
});

child.on("close", (code, signal) => {
  if (pending !== "") handleStderrLine(pending);
  if (signal !== null || code !== 0) {
    process.exitCode = code === null || code === 0 ? 1 : code;
    return;
  }
  const result = verdict(specSummary(Buffer.concat(stdoutChunks).toString("utf8")), count);
  if (result.ok) return;
  for (const file of result.emptyFiles) console.error(`Arquivo de teste sem nenhum teste: ${relative(process.cwd(), file)}`);
  const where = result.emptyFiles.length > 0 ? ` em ${result.emptyFiles.length} arquivo(s)` : "";
  console.error(`Nenhum teste executado${where}: ${globs.join(" ")}`);
  process.exitCode = 1;
});
