import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

// Guarda global de testes (test-support/). Roda num processo-filho fora do test runner, porque o
// node:test reprovaria este próprio teste ao ver a rejeição deliberada.
const GUARD = new URL("../../test-support/fail-on-unhandled-rejection.js", import.meta.url);
const GUARD_FLAG = "--import ../test-support/fail-on-unhandled-rejection.js";

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

  test("os scripts de teste de todos os workspaces carregam o guarda", () => {
    for (const workspace of ["api", "web", "fetcher"]) {
      const manifest = JSON.parse(readFileSync(new URL(`../../${workspace}/package.json`, import.meta.url), "utf8")) as {
        scripts: { test: string };
      };
      assert.ok(manifest.scripts.test.startsWith(`node ${GUARD_FLAG} --test `), `${workspace}: ${manifest.scripts.test}`);
    }
  });
});
