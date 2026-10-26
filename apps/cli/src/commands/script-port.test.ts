import { expect, test, beforeAll } from "bun:test";
import { initJinja } from "@atlcli/core";
import { createCliScriptPort } from "./script-port.js";

beforeAll(() => initJinja());

const unused = (): never => {
  throw new Error("no client call expected");
};

// Regression: the page id becomes a positional argument of the `wiki export`
// child process, and a plan file can be edited, so a flag must not get through.
test.each([["--output=/tmp/x"], ["--template=evil.docx"], ["123 --json"], ["plan:3"]])(
  "export refuses a page id that is not one (%s)",
  async (pageId) => {
    const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: "/tmp" });
    await expect(port.confluenceExport({ pageId, format: "pdf", path: "x.pdf" })).rejects.toThrow("Not a Confluence page id");
  },
);

test("render uses the core engine with the frozen clock", async () => {
  const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: "/tmp" });
  const out = await port.render!("{{ today }} {{v}} {{nope}}", { vars: { v: 1 }, unit: "u", now: "2026-10-25T00:00:00.000Z", strict: false });
  expect(out.value).toBe("2026-10-25 1 {{nope}}");
  expect(out.warnings.map((w) => w.code)).toEqual(["unresolved"]);
});

import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPrivateAddress } from "./script-port.js";

const tempDir = () => mkdtemp(join(tmpdir(), "atlcli-port-"));

test("files stay below the output directory, also through links", async () => {
  const root = await tempDir();
  const outside = await tempDir();
  await writeFile(join(outside, "secret.txt"), "nope");
  await symlink(outside, join(root, "out"));
  await symlink(join(outside, "secret.txt"), join(root, "link.txt"));
  await writeFile(join(root, "in.txt"), "hello");
  const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: root });
  expect(await port.fileRead!("in.txt", { encoding: "utf8" })).toBe("hello");
  expect(await port.fileRead!("in.txt", { encoding: "base64" })).toBe(Buffer.from("hello").toString("base64"));
  await expect(port.fileRead!("out/secret.txt", { encoding: "utf8" })).rejects.toThrow(/outside the working directory/);
  await expect(port.fileRead!("link.txt", { encoding: "utf8" })).rejects.toThrow(/outside the working directory/);
  await expect(port.fileWrite!("out/new.txt", "x", { encoding: "utf8" })).rejects.toThrow(/outside the working directory/);
  await expect(port.fileWrite!("link.txt", "x", { encoding: "utf8" })).rejects.toThrow(/symbolic link/);
  expect(await readFile(join(outside, "secret.txt"), "utf8")).toBe("nope");
  expect(await port.fileWrite!("deep/dir/a.txt", "data", { encoding: "utf8" })).toEqual({ path: "deep/dir/a.txt", bytes: 4 });
  expect((await port.fileList!("deep/dir")).map((f) => f.name)).toEqual(["a.txt"]);
});

test("state persists per store as JSON and deletes keys", async () => {
  const home = await tempDir();
  {
    const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: home, stateDir: join(home, ".atlcli", "state") });
    expect(await port.stateGet!("nightly", "since")).toBeUndefined();
    await port.stateSet!("nightly", "since", "2026-10-26");
    await port.stateSet!("nightly", "n", { a: [1] });
    await port.stateSet!("nightly", "n", undefined);
    expect(JSON.parse(await readFile(join(home, ".atlcli", "state", "nightly.json"), "utf8"))).toEqual({ since: "2026-10-26" });
    await expect(port.stateGet!("../escape", "k")).rejects.toThrow(/Invalid state store name/);
  }
});

test("private addresses are refused for HTTP, public ones pass", () => {
  for (const a of ["10.0.0.1", "127.0.0.1", "172.16.5.4", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.1.2.3", "0.0.0.0", "::ffff:7f00:1", "::ffff:a9fe:a9fe", "0:0:0:0:0:ffff:7f00:1", "::FFFF:C0A8:0101", "febf::1"]) {
    expect([a, isPrivateAddress(a)]).toEqual([a, true]);
  }
  for (const a of ["8.8.8.8", "172.32.0.1", "2606:4700::1", "::ffff:808:808", "fec0::1"]) expect([a, isPrivateAddress(a)]).toEqual([a, false]);
});

test("httpFetch refuses a host that resolves privately and returns redirects unfollowed", async () => {
  const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: "/tmp" });
  await expect(port.httpFetch!({ method: "GET", url: "https://127.0.0.1.nip.io/", headers: {} }, {})).rejects.toThrow(/private address|ENOTFOUND|getaddrinfo/);
  const server = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "https://elsewhere.test/" } }) });
  try {
    const response = await port.httpFetch!({ method: "GET", url: `http://localhost:${server.port}/`, headers: {} }, {});
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("https://elsewhere.test/");
  } finally {
    server.stop(true);
  }
});

test("httpFetch refuses private IP literals without a DNS lookup; sends bodies and undoes gzip", async () => {
  const port = createCliScriptPort(unused, unused, "https://example.atlassian.net", { profileName: "p", outDir: "/tmp" });
  for (const url of ["http://127.0.0.2:1/", "https://10.1.2.3/", "https://[fd00::1]/", "https://169.254.169.254/latest/meta-data", "https://0x0a000001/"]) {
    await expect(port.httpFetch!({ method: "GET", url, headers: {} }, {})).rejects.toThrow(/private address; refused/);
  }
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const text = `${req.method} ${await req.text()} ${req.headers.get("x-a")}`;
      return new Response(Bun.gzipSync(text), { headers: { "content-encoding": "gzip", "set-cookie": "a=1" } });
    },
  });
  try {
    const response = await port.httpFetch!({ method: "POST", url: `http://localhost:${server.port}/x`, headers: { "x-a": "1" }, body: "payload" }, {});
    expect(response).toEqual(expect.objectContaining({ status: 200, text: "POST payload 1" }));
    expect(response.headers["content-encoding"]).toBe("gzip");
  } finally {
    server.stop(true);
  }
});
