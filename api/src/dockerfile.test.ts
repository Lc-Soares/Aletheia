import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, test } from "node:test";

// O .dockerignore remove *.test.ts e testing.ts do contexto do build, então rodar testes dentro de
// uma imagem executaria zero testes e passaria. Os testes rodam no job "check" do CI; as etapas
// "check" dos Dockerfiles fazem só typecheck.
const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

function instructions(dockerfile: string): string[] {
  return dockerfile
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

describe("Dockerfiles não rodam testes", () => {
  for (const workspace of ["api", "fetcher"]) {
    test(`${workspace}/Dockerfile: a etapa check faz typecheck e nenhuma instrução roda testes`, () => {
      const lines = instructions(read(`../../${workspace}/Dockerfile`));
      assert.ok(lines.some((line) => line.includes(`npm run typecheck --workspace ${workspace}`)));
      for (const line of lines) assert.doesNotMatch(line, /npm run test|npm test\b|--test\b/, line);
    });
  }

  test(".dockerignore continua removendo testing.ts e *.test.ts da API", () => {
    const patterns = read("../../.dockerignore")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    for (const path of ["api/src/testing.ts", "api/src/server.test.ts", "api/src/dockerfile.test.ts"]) {
      assert.ok(
        patterns.some((pattern) => posix.matchesGlob(path, pattern)),
        `${path} precisa ficar fora do contexto do build`,
      );
    }
  });
});
