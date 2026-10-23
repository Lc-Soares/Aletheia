import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { globSync, readFileSync } from "node:fs";
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

function runRunner(glob: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string | undefined> = { ...process.env, ...extraEnv };
  delete env["NODE_TEST_CONTEXT"];
  delete env["NODE_OPTIONS"];
  if (!("FORCE_COLOR" in extraEnv)) delete env["FORCE_COLOR"];
  return spawnSync(process.execPath, [RUNNER, glob], { cwd: FIXTURES, env, encoding: "utf8" });
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
