import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

// Guarda global de testes (test-support/). Roda num processo-filho fora do test runner, porque o
// node:test reprovaria este próprio teste ao ver a rejeição deliberada.
const GUARD = new URL("../../test-support/fail-on-unhandled-rejection.js", import.meta.url);

function runWithGuard(code: string) {
  return spawnSync(process.execPath, ["--import", GUARD.href, "--input-type=module", "-e", code], { encoding: "utf8" });
}

describe("guarda global de unhandled rejection", () => {
  test("rejeição sem tratamento: avisa e a execução sai com código 1", () => {
    const result = runWithGuard(`void Promise.reject(new Error("deliberada")); setTimeout(() => {}, 20);`);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Teste reprovado: unhandled rejection/);
    assert.match(result.stderr, /deliberada/);
  });

  test("rejeição tratada a tempo: sai com código 0", () => {
    const result = runWithGuard(`Promise.reject(new Error("tratada")).catch(() => {}); setTimeout(() => {}, 20);`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });

  test("os scripts de teste de todos os workspaces usam o runner, e a raiz não pula workspace", () => {
    const testScript = (path: string): string =>
      (JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8")) as { scripts: { test: string } }).scripts.test;
    for (const { name, glob } of WORKSPACES) {
      assert.equal(testScript(`../../${name}/package.json`), `node ../test-support/run-tests.js "${glob}"`, name);
    }
    const root = testScript("../../package.json");
    assert.equal(root, "npm run test --workspaces");
    assert.doesNotMatch(root, /--if-present/);
  });

  test("nenhum glob de workspace alcança test-support (fixtures ficam fora do npm run test)", () => {
    for (const { name, glob } of WORKSPACES) {
      const found = globSync(glob, { cwd: fileURLToPath(new URL(`../../${name}/`, import.meta.url)) });
      assert.ok(found.length > 0, `${name}: o glob precisa achar os testes do próprio workspace`);
      assert.deepEqual(found.filter((path) => path.includes("test-support")), [], name);
    }
  });
});

// Runner dos workspaces (test-support/run-tests.js). Roda num processo-filho com o ambiente limpo:
// com NODE_TEST_CONTEXT herdado, o node --test de dentro viraria filho deste runner.
const RUNNER = fileURLToPath(new URL("../../test-support/run-tests.js", import.meta.url));
const FIXTURES = fileURLToPath(new URL("../../test-support/fixtures/", import.meta.url));
const WORKSPACES = [
  { name: "api", glob: "src/**/*.test.ts" },
  { name: "web", glob: "test/**/*.test.js" },
  { name: "fetcher", glob: "src/**/*.test.ts" },
];

function runRunner(globs: string | string[], extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env["NODE_TEST_CONTEXT"];
  delete env["NODE_OPTIONS"];
  if (!("FORCE_COLOR" in extraEnv)) delete env["FORCE_COLOR"];
  return spawnSync(process.execPath, [RUNNER, ...[globs].flat()], { cwd: FIXTURES, env, encoding: "utf8" });
}

describe("runner de testes: reprova quando nenhum teste passou", () => {
  test("um teste que passa: código 0 e o resumo mostra tests 1", () => {
    const result = runRunner("passing.test.js");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /ℹ tests 1\b/);
  });

  test("arquivo sem nenhum teste: código 1 e aviso", () => {
    const result = runRunner("no-tests.test.js");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nenhum teste executado: no-tests\.test\.js/);
  });

  test("arquivo sem testes junto com um que tem: código 1 e o arquivo vazio apontado", () => {
    // O node:test conta o arquivo vazio como 1 teste que passou; o total não basta.
    const result = runRunner(["passing.test.js", "no-tests.test.js"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Arquivo de teste sem nenhum teste: no-tests\.test\.js/);
    assert.doesNotMatch(result.stderr, /aletheia-test-count/, "a linha de contagem não vaza para o terminal");
  });

  test("glob que não encontra arquivo: código 1 e aviso", () => {
    const result = runRunner("nao-existe/**/*.test.js");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nenhum teste executado/);
  });

  test("teste que falha: código diferente de 0 (o runner não esconde falha)", () => {
    const result = runRunner("failing.test.js");
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /Nenhum teste executado/);
  });

  test("todos os testes pulados: código 1 (pass precisa ser pelo menos 1)", () => {
    const result = runRunner("all-skipped.test.js");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Nenhum teste executado/);
  });

  test("com cor forçada (FORCE_COLOR=1) não há falso alarme", () => {
    const result = runRunner("passing.test.js", { FORCE_COLOR: "1" });
    assert.ok(result.stdout.includes("\u001b["), "a cor precisa ter sido forçada de verdade");
    assert.equal(result.status, 0, result.stderr);
  });

  test("rejeição sem tratamento depois de testes que passam: código 1 (guarda carregado)", () => {
    const result = runRunner("unhandled-rejection.test.js");
    assert.equal(result.status, 1);
    assert.match(result.stderr + result.stdout, /rejeição deliberada da fixture/);
  });
});

// count-reporter e decisão do runner. Importados por URL (são .js de test-support, fora do tsconfig).
type Count = { real: number; passed: number; emptyFiles: string[] };
type Summary = { tests: number | null; pass: number | null };
const COUNTER_URL = new URL("../../test-support/count-reporter.js", import.meta.url).href;
const VERDICT_URL = new URL("../../test-support/verdict.js", import.meta.url).href;
const counter = (await import(COUNTER_URL)) as {
  COUNT_PREFIX: string;
  default: (source: AsyncIterable<unknown>) => AsyncGenerator<string>;
};
const decision = (await import(VERDICT_URL)) as {
  specSummary: (output: string) => Summary;
  verdict: (summary: Summary, count: Count | null) => { ok: boolean; emptyFiles: string[] };
};

async function countOf(events: unknown[]): Promise<Count> {
  async function* source() {
    yield* events;
  }
  let output = "";
  for await (const chunk of counter.default(source())) output += chunk;
  assert.ok(output.startsWith(counter.COUNT_PREFIX));
  return JSON.parse(output.slice(counter.COUNT_PREFIX.length)) as Count;
}

const GOOD_SUMMARY: Summary = { tests: 1, pass: 1 };

describe("count-reporter e decisão do runner: falha fechada", () => {
  test("nenhum evento de teste de arquivo nenhum: contagem zerada e o runner reprova", async () => {
    const count = await countOf([]);
    assert.deepEqual(count, { real: 0, passed: 0, emptyFiles: [] });
    assert.equal(decision.verdict(GOOD_SUMMARY, count).ok, false, "mesmo com o resumo do spec dizendo que passou");
  });

  test("só eventos que não são de teste (plan, diagnostic): o runner reprova", async () => {
    const count = await countOf([{ type: "test:plan", data: { count: 0 } }, { type: "test:diagnostic", data: { message: "x" } }]);
    assert.equal(decision.verdict(GOOD_SUMMARY, count).ok, false);
  });

  test("linha de contagem ausente: o runner reprova", () => {
    assert.equal(decision.verdict(GOOD_SUMMARY, null).ok, false);
  });

  test("resumo do spec ausente ou zerado: o runner reprova", () => {
    const count: Count = { real: 1, passed: 1, emptyFiles: [] };
    assert.equal(decision.verdict({ tests: null, pass: null }, count).ok, false);
    assert.equal(decision.verdict({ tests: 0, pass: 0 }, count).ok, false);
    assert.equal(decision.verdict(GOOD_SUMMARY, count).ok, true);
  });

  test("resumo com cores: specSummary tira o ANSI antes de procurar as linhas", () => {
    assert.deepEqual(decision.specSummary("\u001b[34mℹ tests 3\u001b[39m\n\u001b[34mℹ pass 2\u001b[39m\n"), { tests: 3, pass: 2 });
  });
});

// O count-reporter contra o node:test de verdade (Node desta máquina e do CI), com as fixtures.
function realCount(files: string[]): Count {
  const env: Record<string, string | undefined> = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  delete env["NODE_OPTIONS"];
  const args = ["--test", `--test-reporter=${COUNTER_URL}`, "--test-reporter-destination=stdout", ...files];
  const result = spawnSync(process.execPath, args, { cwd: FIXTURES, env, encoding: "utf8" });
  const line = result.stdout.split(/\r?\n/).find((l) => l.startsWith(counter.COUNT_PREFIX));
  assert.ok(line !== undefined, `sem linha de contagem: ${result.stdout}${result.stderr}`);
  return JSON.parse(line.slice(counter.COUNT_PREFIX.length)) as Count;
}

const fixture = (name: string): string => join(FIXTURES, name);

describe("count-reporter contra o node:test real (fixtures)", () => {
  test(`Node ${process.version}: um teste que passa`, () => {
    assert.deepEqual(realCount(["passing.test.js"]), { real: 1, passed: 1, emptyFiles: [] });
  });

  test("arquivo sem testes: o invólucro do arquivo não conta como teste", () => {
    assert.deepEqual(realCount(["no-tests.test.js"]), { real: 0, passed: 0, emptyFiles: [fixture("no-tests.test.js")] });
  });

  test("arquivo vazio junto com outro: só o vazio é apontado", () => {
    assert.deepEqual(realCount(["passing.test.js", "no-tests.test.js"]), {
      real: 1,
      passed: 1,
      emptyFiles: [fixture("no-tests.test.js")],
    });
  });

  test("todos pulados: contam como testes, mas nenhum passou", () => {
    assert.deepEqual(realCount(["all-skipped.test.js"]), { real: 2, passed: 0, emptyFiles: [] });
  });

  test("teste que falha: conta como teste, sem passar", () => {
    assert.deepEqual(realCount(["failing.test.js"]), { real: 1, passed: 0, emptyFiles: [] });
  });
});
