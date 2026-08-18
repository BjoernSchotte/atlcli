import { chromium } from "playwright";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = resolve(ROOT, "dist-browser");
const types: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".pdf": "application/pdf" };
const requests: string[] = [];
const server = Bun.serve({
  port: 0,
  async fetch(request) {
    requests.push(request.url);
    const url = new URL(request.url);
    const relative = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (relative.includes("..")) return new Response("invalid", { status: 400 });
    const file = Bun.file(resolve(DIST, relative));
    if (!(await file.exists())) return new Response("missing", { status: 404 });
    return new Response(file, { headers: { "content-type": types[extname(relative)] ?? "application/octet-stream" } });
  },
});

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.ATLCLI_PDF_PROBE_CHROMIUM,
});
try {
  const page = await browser.newPage();
  const remoteRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") remoteRequests.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "networkidle" });
  const result = await page.evaluate(() => window.runPdfiumProbe());
  const cancellation = await page.evaluate(() => window.cancelPdfiumProbe());
  if (remoteRequests.length > 0) throw new Error(`remote requests observed: ${remoteRequests.join(", ")}`);
  if ((result as { pageCount?: number }).pageCount !== 1 || !(result as { tokenFound?: boolean }).tokenFound) {
    throw new Error(`unexpected browser result: ${JSON.stringify(result)}`);
  }
  if (!cancellation.terminated || cancellation.elapsedMs > 250) throw new Error(`cancellation exceeded budget: ${JSON.stringify(cancellation)}`);
  console.log(JSON.stringify({ result, cancellation, remoteRequests, localRequestCount: requests.length }, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
