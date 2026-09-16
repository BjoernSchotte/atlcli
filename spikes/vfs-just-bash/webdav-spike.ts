/**
 * WP0.5 spike: does webdav-server 2.6.3 run under Bun on loopback, and do
 * PROPFIND / GET / PUT / LOCK behave well enough for a Finder mount?
 *
 * Run: bun spikes/vfs-just-bash/webdav-spike.ts
 */
import { v2 as webdav } from "webdav-server";

const server = new webdav.WebDAVServer({
  port: 0,
  hostname: "127.0.0.1",
  // Anonymous on loopback; a real binding gets a bearer token (WP7.4).
  requireAuthentification: false,
});

const root = new webdav.VirtualFileSystem();
await new Promise<void>((resolve, reject) =>
  server.setFileSystem("/", root, (ok) => (ok ? resolve() : reject(new Error("setFileSystem failed")))),
);

// Seed one directory and one file through the public v2 API.
const ctx = server.createExternalContext();
await new Promise<void>((resolve, reject) =>
  root.create(ctx, new webdav.Path("/DOCSY"), webdav.ResourceType.Directory, (e) =>
    e ? reject(e) : resolve(),
  ),
);
await new Promise<void>((resolve, reject) =>
  root.create(ctx, new webdav.Path("/DOCSY/page-1.md"), webdav.ResourceType.File, (e) =>
    e ? reject(e) : resolve(),
  ),
);
await new Promise<void>((resolve, reject) =>
  root.openWriteStream(ctx, new webdav.Path("/DOCSY/page-1.md"), (e, stream) => {
    if (e || !stream) return reject(e ?? new Error("no stream"));
    stream.end("# Page one\n", () => resolve());
  }),
);

const port: number = await new Promise((resolve) => {
  server.start((httpServer) => {
    const address = httpServer.address();
    resolve(typeof address === "object" && address ? address.port : 0);
  });
});

const base = `http://127.0.0.1:${port}`;
const results: { name: string; ok: boolean; note: string }[] = [];

async function probe(name: string, init: RequestInit & { path: string }, check: (res: Response, body: string) => boolean) {
  try {
    const res = await fetch(`${base}${init.path}`, init);
    const body = await res.text();
    results.push({ name, ok: check(res, body), note: `${res.status} ${body.slice(0, 90).replace(/\s+/g, " ")}` });
  } catch (error) {
    results.push({ name, ok: false, note: `threw: ${String(error).slice(0, 140)}` });
  }
}

await probe(
  "PROPFIND depth 1",
  { path: "/DOCSY", method: "PROPFIND", headers: { Depth: "1" } },
  (res, body) => res.status === 207 && body.includes("page-1.md"),
);
await probe("GET file", { path: "/DOCSY/page-1.md", method: "GET" }, (res, body) => res.status === 200 && body.includes("# Page one"));
await probe(
  "PUT file",
  { path: "/DOCSY/page-2.md", method: "PUT", body: "# Page two\n" },
  (res) => res.status === 201 || res.status === 200 || res.status === 204,
);
await probe("GET after PUT", { path: "/DOCSY/page-2.md", method: "GET" }, (res, body) => res.status === 200 && body.includes("# Page two"));
await probe(
  "LOCK",
  {
    path: "/DOCSY/page-1.md",
    method: "LOCK",
    headers: { "Content-Type": "application/xml", Timeout: "Second-600" },
    body: `<?xml version="1.0" encoding="utf-8" ?><D:lockinfo xmlns:D="DAV:"><D:lockscope><D:exclusive/></D:lockscope><D:locktype><D:write/></D:locktype><D:owner><D:href>atlcli</D:href></D:owner></D:lockinfo>`,
  },
  (res, body) => res.status === 200 && body.includes("locktoken"),
);
await probe("OPTIONS", { path: "/", method: "OPTIONS" }, (res) => res.status === 200);
await probe(
  "AppleDouble 404",
  { path: "/DOCSY/._page-1.md", method: "GET" },
  (res) => res.status === 404,
);

console.log(`Bun ${Bun.version}, webdav-server 2.6.3, 127.0.0.1:${port}\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(18)} ${r.note}`);
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);

await new Promise<void>((resolve) => server.stop(() => resolve()));
process.exit(failed.length === 0 ? 0 : 1);
