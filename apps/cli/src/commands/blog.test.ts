/**
 * Blog post support: `wiki blog create|delete|list`, `page update` / `docs push`
 * preserving the `blogpost` content type (Confluence 400s on a `page` PUT for a
 * blog post), and two `docs push` regressions (ignored --dry-run, relative
 * workspace root auto-created as a folder).
 *
 * Runs the real CLI against a Bun HTTP stub with a sandboxed HOME.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, setDefaultTimeout } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { blogListCql } from "./blog.js";

setDefaultTimeout(60_000);

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));
const BLOG_ID = "77001";
const PAGE_ID = "77002";
const ME = "acct-me";

const content = (id: string, type: string) => ({
  id,
  type,
  status: "current",
  title: `${type} fixture`,
  space: { key: "DOCSY" },
  version: { number: 3 },
  ancestors: [],
  body: { storage: { value: "<p>old</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/x/${id}` },
});

let server: ReturnType<typeof Bun.serve>;
let home: string;
let work: string;
let requests: { method: string; path: string; query: string; body?: any }[] = [];
let restrictions: any[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" || req.method === "DELETE" ? undefined : await req.json().catch(() => undefined);
      requests.push({ method: req.method, path: url.pathname, query: url.search, body });
      const p = url.pathname;
      if (p === "/rest/api/user/current") return Response.json({ accountId: ME, displayName: "Me" });
      if (p === "/rest/api/content" && req.method === "POST") {
        return Response.json({ ...content("77100", body.type), title: body.title, status: body.status ?? "current", version: { number: 1 } });
      }
      if (p === "/rest/api/content/77100/restriction" && req.method === "PUT") {
        restrictions = body;
        return Response.json({});
      }
      if (p === "/rest/api/content/77100/restriction/byOperation") {
        const pick = (op: string) => restrictions.find((r) => r.operation === op)?.restrictions.user ?? [];
        return Response.json({
          read: { restrictions: { user: { results: pick("read") }, group: { results: [] } } },
          update: { restrictions: { user: { results: pick("update") }, group: { results: [] } } },
        });
      }
      for (const [id, type] of [[BLOG_ID, "blogpost"], [PAGE_ID, "page"], ["77100", "blogpost"]] as const) {
        if (p !== `/rest/api/content/${id}`) continue;
        if (req.method === "PUT") return Response.json({ ...content(id, body.type), title: body.title, version: body.version });
        if (req.method === "DELETE") return new Response(null, { status: 204 });
        return Response.json(content(id, type));
      }
      return Response.json({ message: `stub: no route for ${p}` }, { status: 404 });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-blog-home-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: { name: "stub", baseUrl: server.url.origin, deploymentType: "data-center", auth: { type: "bearer" }, space: "DOCSY" },
      },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
  if (work) await rm(work, { recursive: true, force: true });
});

beforeEach(async () => {
  if (work) await rm(work, { recursive: true, force: true });
  work = await mkdtemp(join(tmpdir(), "atlcli-blog-work-"));
  await writeFile(join(work, "post.md"), "# Hello\n\natlcli blog test\n");
  requests = [];
  restrictions = [];
});

async function runCli(args: string[], cwd = work) {
  const proc = Bun.spawn([process.execPath, "--conditions=development", "run", CLI, ...args], {
    cwd,
    env: { ...process.env, HOME: home, USERPROFILE: home, ATLCLI_API_TOKEN: "stub-token", ATLCLI_DISABLE_UPDATE_CHECK: "1" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode, all: `${stdout}${stderr}` };
}

const puts = () => requests.filter((r) => r.method === "PUT" && !r.path.endsWith("/restriction"));

describe("page update / blog update preserve the content type", () => {
  for (const cmd of [["page", "update"], ["blog", "update"]]) {
    it(`wiki ${cmd.join(" ")} sends type blogpost and version + 1`, async () => {
      const r = await runCli(["wiki", ...cmd, "--id", BLOG_ID, "--body", "post.md", "--title", "New title", "--json"]);
      expect(r.exitCode, r.all).toBe(0);
      const [put] = puts();
      expect(put.body.type).toBe("blogpost");
      expect(put.body.version.number).toBe(4);
      expect(put.body.title).toBe("New title");
      expect(put.body.body.storage.value).toContain("atlcli blog test");
    });
  }

  it("still sends type page for a page", async () => {
    const r = await runCli(["wiki", "page", "update", "--id", PAGE_ID, "--body", "post.md"]);
    expect(r.exitCode, r.all).toBe(0);
    expect(puts()[0].body.type).toBe("page");
  });

  it("title-only update keeps the current body", async () => {
    const r = await runCli(["wiki", "blog", "update", "--id", BLOG_ID, "--title", "Only title"]);
    expect(r.exitCode, r.all).toBe(0);
    expect(puts()[0].body.body.storage.value).toBe("<p>old</p>");
  });

  it("docs push of a blog post sends type blogpost", async () => {
    await writeFile(join(work, "post.md"), `---\natlcli:\n  id: "${BLOG_ID}"\n  title: "blogpost fixture"\n---\n\nPushed body\n`);
    const r = await runCli(["wiki", "docs", "push", "post.md", "--force"]);
    expect(r.exitCode, r.all).toBe(0);
    expect(puts()[0]?.body.type).toBe("blogpost");
  });
});

describe("wiki blog create", () => {
  it("creates a published blogpost without a parent", async () => {
    const r = await runCli(["wiki", "blog", "create", "--space", "~me", "--title", "Hi", "--body", "post.md", "--json"]);
    expect(r.exitCode, r.all).toBe(0);
    const post = requests.find((q) => q.method === "POST")!;
    expect(post.body).toMatchObject({ type: "blogpost", title: "Hi", space: { key: "~me" } });
    expect(post.body.status).toBeUndefined();
    expect(post.body.ancestors).toBeUndefined();
    expect(JSON.parse(r.stdout).blogpost.id).toBe("77100");
  });

  it("--restriction private: empty draft, restrict + verify, then publish with body", async () => {
    const r = await runCli(["wiki", "blog", "create", "--space", "TEAM", "--title", "Secret", "--body", "post.md", "--restriction", "private", "--json"]);
    expect(r.exitCode, r.all).toBe(0);
    const order = requests.map((q) => `${q.method} ${q.path}`);
    const post = requests.find((q) => q.method === "POST")!;
    expect(post.body.status).toBe("draft");
    expect(post.body.body.storage.value).toBe("");
    expect(restrictions.map((x) => [x.operation, x.restrictions.user.map((u: any) => u.accountId)])).toEqual([["read", [ME]], ["update", [ME]]]);
    const publish = puts()[0];
    expect(publish.query).toBe("?status=draft");
    expect(publish.body).toMatchObject({ status: "current", type: "blogpost", space: { key: "TEAM" }, version: { number: 1 } });
    expect(publish.body.body.storage.value).toContain("atlcli blog test");
    expect(order.indexOf("PUT /rest/api/content/77100/restriction")).toBeLessThan(order.indexOf("PUT /rest/api/content/77100"));
  });

  it("rejects an unknown --restriction before any request", async () => {
    const r = await runCli(["wiki", "blog", "create", "--space", "X", "--title", "t", "--body", "post.md", "--restriction", "public"]);
    expect(r.exitCode).not.toBe(0);
    expect(requests).toEqual([]);
  });
});

describe("wiki blog delete", () => {
  it("requires --confirm", async () => {
    const r = await runCli(["wiki", "blog", "delete", "--id", BLOG_ID]);
    expect(r.exitCode).not.toBe(0);
    expect(requests).toEqual([]);
  });

  it("deletes a blog post", async () => {
    const r = await runCli(["wiki", "blog", "delete", "--id", BLOG_ID, "--confirm"]);
    expect(r.exitCode, r.all).toBe(0);
    expect(requests.some((q) => q.method === "DELETE" && q.path === `/rest/api/content/${BLOG_ID}`)).toBe(true);
  });

  it("refuses to delete a page", async () => {
    const r = await runCli(["wiki", "blog", "delete", "--id", PAGE_ID, "--confirm"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toMatch(/not a blog post/);
    expect(requests.some((q) => q.method === "DELETE")).toBe(false);
  });
});

describe("blogListCql", () => {
  it("scopes to a space and escapes quotes", () => {
    expect(blogListCql(undefined)).toBe("type = blogpost");
    expect(blogListCql('~a"b')).toBe('space = "~a\\"b" AND type = blogpost');
  });
});

describe("docs push regressions", () => {
  it("rejects --dry-run instead of pushing for real", async () => {
    const r = await runCli(["wiki", "docs", "push", ".", "--dry-run"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.all).toMatch(/no --dry-run/);
    expect(requests).toEqual([]);
  });

  it("push ./ws from outside does not auto-create the workspace root as a folder", async () => {
    const ws = join(work, "ws");
    await mkdir(ws);
    const init = await runCli(["wiki", "docs", "init", ".", "--page-id", BLOG_ID, "--space", "DOCSY"], ws);
    expect(init.exitCode, init.all).toBe(0);
    await writeFile(join(ws, "post.md"), `---\natlcli:\n  id: "${BLOG_ID}"\n  title: "blogpost fixture"\n---\n\nBody\n`);
    requests = [];
    const r = await runCli(["wiki", "docs", "push", "./ws", "--force"]);
    expect(r.all).not.toMatch(/Auto-created folder|Created folder/);
    expect(existsSync(join(ws, "index.md"))).toBe(false);
    expect(requests.some((q) => q.method === "POST")).toBe(false);
  });
});
