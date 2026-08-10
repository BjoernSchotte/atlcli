import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const experience = process.argv[2] ?? "starlight";
const port = Number.parseInt(process.argv[3] ?? "4327", 10);
const root = resolve(fileURLToPath(new URL(`../sites/${experience}/dist/`, import.meta.url)));
const types = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".wasm", "application/wasm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
]);
const csp = "default-src 'self'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'";

async function serveFile(response, target, status = 200) {
  const file = await stat(target);
  response.writeHead(status, {
    "content-length": file.size,
    "content-type": types.get(extname(target)) ?? "application/octet-stream",
    "content-security-policy": csp,
    "x-content-type-options": "nosniff",
  });
  createReadStream(target).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (!url.pathname.startsWith("/docs/")) {
      response.writeHead(302, { location: "/docs/publish/" });
      response.end();
      return;
    }
    const relative = decodeURIComponent(url.pathname.slice("/docs/".length));
    let target = resolve(root, relative || "index.html");
    if (target !== root && !target.startsWith(`${root}${sep}`)) throw new Error("path escape");
    const details = await stat(target);
    if (details.isDirectory()) target = resolve(target, "index.html");
    await serveFile(response, target);
  } catch {
    try {
      await serveFile(response, resolve(root, "404.html"), 404);
    } catch {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found\n");
    }
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`T0 ${experience} site: http://127.0.0.1:${port}/docs/publish/`);
});
