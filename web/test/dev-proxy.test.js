import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { createDevProxy, loadSecurityHeaders } from "../dev-proxy.mjs";

describe("proxy de desenvolvimento", () => {
  /** @type {Array<{ url?: string, auth?: string }>} */
  const seen = [];
  const fakeApi = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end('{"email":"a@b.c"}');
  });
  const headers = loadSecurityHeaders();
  let base = "";
  /** @type {import("node:http").Server} */
  let proxy;

  before(async () => {
    await new Promise((resolve) => fakeApi.listen(0, "127.0.0.1", () => resolve(undefined)));
    const apiPort = /** @type {import("node:net").AddressInfo} */ (fakeApi.address()).port;
    proxy = createDevProxy({
      publicDir: fileURLToPath(new URL("../public", import.meta.url)),
      api: { host: "127.0.0.1", port: apiPort },
      headers,
    });
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(undefined)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (proxy.address()).port}`;
  });

  after(() => {
    proxy.close();
    fakeApi.close();
  });

  test("serve index.html com os cabeçalhos do firebase.json", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.equal(res.headers.get("content-security-policy"), headers["Content-Security-Policy"]);
  });

  test("encaminha /api/** à API com o header Authorization", async () => {
    const res = await fetch(`${base}/api/me`, { headers: { Authorization: "Bearer a.b.c" } });
    assert.deepEqual(await res.json(), { email: "a@b.c" });
    assert.deepEqual(seen.at(-1), { url: "/api/me", auth: "Bearer a.b.c" });
  });

  test("não sai de web/public (path traversal) nem serve tipos desconhecidos", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2f..%2ffirebase.json", "/gis.d.ts"]) {
      const res = await fetch(`${base}${path}`);
      assert.equal(res.status, 404, path);
    }
  });

  test("API fora do ar → 502", async () => {
    const orphan = createDevProxy({ publicDir: ".", api: { host: "127.0.0.1", port: 1 }, headers });
    await new Promise((resolve) => orphan.listen(0, "127.0.0.1", () => resolve(undefined)));
    try {
      const port = /** @type {import("node:net").AddressInfo} */ (orphan.address()).port;
      assert.equal((await fetch(`http://127.0.0.1:${port}/api/me`)).status, 502);
    } finally {
      orphan.close();
    }
  });
});
