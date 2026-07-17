#!/usr/bin/env bun
import { resolve, sep } from "node:path";

export const HARNESS_MOUNT_PATH = "/browser-export-harness/";
export const HARNESS_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' blob: data:",
  "worker-src 'self'",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
].join("; ");

const distRoot = resolve(import.meta.dir, "..", "dist");
const rawPort = process.env.ATLCLI_HARNESS_PORT ?? "4179";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error(`Invalid ATLCLI_HARNESS_PORT: ${rawPort}`);
}

function responseHeaders(contentType?: string): Headers {
  const headers = new Headers({
    "Content-Security-Policy": HARNESS_CSP,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  if (contentType) headers.set("Content-Type", contentType);
  return headers;
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === HARNESS_MOUNT_PATH.slice(0, -1)) {
      return Response.redirect(new URL(HARNESS_MOUNT_PATH, url), 308);
    }
    if (!url.pathname.startsWith(HARNESS_MOUNT_PATH)) {
      return new Response("Not found", { status: 404, headers: responseHeaders("text/plain") });
    }

    let requested: string;
    try {
      requested = decodeURIComponent(url.pathname.slice(HARNESS_MOUNT_PATH.length));
    } catch {
      return new Response("Bad request", { status: 400, headers: responseHeaders("text/plain") });
    }
    if (requested === "" || requested.endsWith("/")) requested += "index.html";
    if (requested.includes("\0") || requested.split("/").some((part) => part === "..")) {
      return new Response("Bad request", { status: 400, headers: responseHeaders("text/plain") });
    }

    const path = resolve(distRoot, requested);
    if (path !== distRoot && !path.startsWith(`${distRoot}${sep}`)) {
      return new Response("Bad request", { status: 400, headers: responseHeaders("text/plain") });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return new Response("Not found", { status: 404, headers: responseHeaders("text/plain") });
    }
    return new Response(file, { headers: responseHeaders(file.type) });
  },
});

console.log(`Browser export harness: http://127.0.0.1:${server.port}${HARNESS_MOUNT_PATH}`);
