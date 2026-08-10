import { resolve, sep } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const port = Number(process.env.ATLCLI_WEB_PUBLISH_VISUAL_PORT ?? "4387");
const fixtureRoots = {
  starlight: resolve(packageRoot, "fixtures/starlight/dist"),
  plain: resolve(packageRoot, "fixtures/plain-experience/dist"),
} as const;

function headers(type?: string): Headers {
  const value = new Headers({
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; worker-src 'self'; object-src 'none'; base-uri 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  if (type) value.set("Content-Type", type);
  return value;
}

function safePath(root: string, raw: string): string | undefined {
  let pathname: string;
  try { pathname = decodeURIComponent(raw); } catch { return undefined; }
  if (pathname.includes("\0") || pathname.split("/").some((part) => part === "..")) return undefined;
  const file = resolve(root, pathname === "" || pathname.endsWith("/") ? `${pathname}index.html` : pathname);
  return file === root || file.startsWith(`${root}${sep}`) ? file : undefined;
}

const server = Bun.serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_astro/") || url.pathname === "/favicon.svg" || url.pathname.startsWith("/pagefind/") || url.pathname.startsWith("/assets/")) {
      const requested = url.pathname.slice(1);
      for (const root of Object.values(fixtureRoots)) {
        const path = safePath(root, requested);
        if (!path) continue;
        const file = Bun.file(path);
        if (await file.exists()) return new Response(file, { headers: headers(file.type) });
      }
      return new Response("Not found", { status: 404, headers: headers("text/plain") });
    }
    const [, scope, ...parts] = url.pathname.split("/");
    // The published Starlight fixture intentionally uses Astro's root base.
    // Keep the namespaced entry URL convenient for the visual matrix while
    // making its root-relative generated navigation links executable as well.
    const namedRoot = fixtureRoots[scope as keyof typeof fixtureRoots];
    const root = namedRoot ?? fixtureRoots.starlight;
    const relativePath = namedRoot === undefined ? url.pathname.slice(1) : parts.join("/");
    const path = safePath(root, relativePath);
    if (!path) return new Response("Bad request", { status: 400, headers: headers("text/plain") });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404, headers: headers("text/plain") });
    return new Response(file, { headers: headers(file.type) });
  },
});

console.log(`Web publishing visual fixtures: http://127.0.0.1:${server.port}/starlight/`);
