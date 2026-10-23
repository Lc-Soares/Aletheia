// Proxy de desenvolvimento: serve web/public e encaminha /api/** para a API local, como o Firebase
// Hosting faz em produção. Aplica os cabeçalhos do firebase.json para testar a CSP de verdade.
// Uso: GOOGLE_CLIENT_ID=... PORT=8080 npm start -w api   (em outro terminal)  e   npm run dev -w web
// Escuta só em 127.0.0.1. Autorize no cliente OAuth do Google a origem http://localhost
// e http://localhost:5000 (ou a porta de DEV_PORT).
import { readFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

/** Cabeçalhos da regra "**" do firebase.json. */
export function loadSecurityHeaders(firebaseJsonPath = join(here, "..", "firebase.json")) {
  const config = JSON.parse(readFileSync(firebaseJsonPath, "utf8"));
  const rule = config.hosting.headers.find((/** @type {{ source: string }} */ h) => h.source === "**");
  return Object.fromEntries(rule.headers.map((/** @type {{ key: string, value: string }} */ h) => [h.key, h.value]));
}

/**
 * @param {object} options
 * @param {string} options.publicDir
 * @param {{ host: string, port: number }} options.api
 * @param {Record<string, string>} options.headers
 */
export function createDevProxy({ publicDir, api, headers }) {
  const root = resolve(publicDir);

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  function proxyToApi(req, res) {
    const upstream = request(
      { host: api.host, port: api.port, path: req.url, method: req.method, headers: req.headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, { ...upstreamRes.headers, ...headers });
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      res.writeHead(502, headers);
      res.end();
    });
    req.pipe(upstream);
  }

  /** @param {import("node:http").IncomingMessage} req @param {import("node:http").ServerResponse} res */
  function serveStatic(req, res) {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...headers, Allow: "GET, HEAD" });
      res.end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    } catch {
      res.writeHead(400, headers);
      res.end();
      return;
    }
    const file = resolve(root, normalize(`.${pathname === "/" ? "/index.html" : pathname}`));
    const type = CONTENT_TYPES[/** @type {keyof typeof CONTENT_TYPES} */ (extname(file))];
    if ((file !== root && !file.startsWith(root + sep)) || !type) {
      res.writeHead(404, headers);
      res.end();
      return;
    }
    try {
      const body = readFileSync(file);
      res.writeHead(200, { ...headers, "Content-Type": type });
      res.end(req.method === "HEAD" ? undefined : body);
    } catch {
      res.writeHead(404, headers);
      res.end();
    }
  }

  return createServer((req, res) => {
    if ((req.url ?? "").startsWith("/api/")) proxyToApi(req, res);
    else serveStatic(req, res);
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const devPort = Number(process.env["DEV_PORT"] ?? 5000);
  const apiPort = Number(process.env["API_PORT"] ?? 8080);
  const server = createDevProxy({
    publicDir: join(here, "public"),
    api: { host: "127.0.0.1", port: apiPort },
    headers: loadSecurityHeaders(),
  });
  server.listen(devPort, "127.0.0.1", () => {
    console.log(`Dev: http://localhost:${devPort} (API em 127.0.0.1:${apiPort})`);
  });
}
