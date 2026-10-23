import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { posix } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const FETCHER_DIR = fileURLToPath(new URL("..", import.meta.url));

async function freePort(): Promise<number> {
  const server = createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  server.close();
  return typeof address === "object" && address !== null ? address.port : assert.fail("sem porta");
}

describe("inicialização como em produção", () => {
  // Mesmo comando do Dockerfile e do "npm start": `node src/main.ts`, sem flags nem test runner.
  // main.ts faz uma extração no worker antes de escutar, então "listening" prova que o worker subiu.
  test("node src/main.ts sobe o worker de extração e responde /healthz", { timeout: 30_000 }, async () => {
    const port = await freePort();
    const env: Record<string, string | undefined> = {
      ...process.env,
      PORT: String(port),
      FETCHER_AUDIENCE: "http://localhost",
      API_SERVICE_ACCOUNT_EMAIL: "api@projeto-teste.iam.gserviceaccount.com",
    };
    delete env["NODE_OPTIONS"];
    delete env["NODE_TEST_CONTEXT"];
    const child = spawn(process.execPath, ["src/main.ts"], { cwd: FETCHER_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
    try {
      let output = "";
      await new Promise<void>((resolve, reject) => {
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes('"event":"listening"')) resolve();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.once("exit", (code) => reject(new Error(`saiu com ${code}: ${output}`)));
      });
      const res = await fetch(`http://127.0.0.1:${port}/healthz`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { status: "ok" });
    } finally {
      child.kill();
    }
  });

  test("o .dockerignore não remove nenhum módulo de produção (inclui o worker)", () => {
    const patterns = readFileSync(new URL("../../.dockerignore", import.meta.url), "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!"));
    const production = readdirSync(new URL(".", import.meta.url)).filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "testing.ts",
    );
    assert.ok(production.includes("extract-worker.ts"));
    for (const file of production) {
      for (const pattern of patterns) {
        assert.equal(posix.matchesGlob(`fetcher/src/${file}`, pattern), false, `${pattern} remove ${file}`);
      }
    }
    // E continua removendo o que não pode ir para a imagem.
    assert.ok(patterns.some((p) => posix.matchesGlob("fetcher/src/testing.ts", p)));
    assert.ok(patterns.some((p) => posix.matchesGlob("fetcher/src/main.test.ts", p)));
  });
});
