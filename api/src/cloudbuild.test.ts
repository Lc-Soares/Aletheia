import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";

// deploy/cloudbuild.yaml constrói as imagens da API e do fetcher no Cloud Build. O gcloud builds
// submit --tag só aceita Dockerfile na raiz do contexto; os nossos ficam em <serviço>/Dockerfile e
// o contexto é a raiz do repositório (como no CI), então o build usa --config, parametrizado por
// serviço. A decisão está em docs/deploy.md, "Etapa 2". Sem biblioteca de YAML: só texto.
const root = (path: string): URL => new URL(`../../${path}`, import.meta.url);
const CONFIG = "deploy/cloudbuild.yaml";

describe("deploy/cloudbuild.yaml", () => {
  test("existe, e os dois Dockerfiles que ele usa também", () => {
    for (const path of [CONFIG, "api/Dockerfile", "fetcher/Dockerfile"]) assert.ok(existsSync(root(path)), `falta ${path}`);
  });

  test("contexto é a raiz (.) e o Dockerfile vem de ${_SERVICE}/Dockerfile", () => {
    const text = readFileSync(root(CONFIG), "utf8");
    assert.match(text, /args:\s*\["build",\s*"-f",\s*"\$\{_SERVICE\}\/Dockerfile",\s*"-t",\s*"\$\{_IMAGE\}",\s*"\."\]/);
  });

  test("lista ${_IMAGE} em images (o Cloud Build publica a imagem no registro)", () => {
    const text = readFileSync(root(CONFIG), "utf8");
    assert.match(text, /^images:\s*\n\s*-\s*"\$\{_IMAGE\}"\s*$/m);
  });

  test("substituições definidas pelo usuário começam com _", () => {
    const text = readFileSync(root(CONFIG), "utf8");
    const used = [...text.matchAll(/\$\{(\w+)\}/g)].map((match) => match[1]);
    assert.deepEqual([...new Set(used)].sort(), ["_IMAGE", "_SERVICE"]);
  });

  test("sem --build-arg, sem --push e sem nada de segredo (secret, key, token, password)", () => {
    const text = readFileSync(root(CONFIG), "utf8");
    assert.doesNotMatch(text, /--build-arg|--push/);
    assert.doesNotMatch(text, /secret|key|token|password/i);
  });
});
