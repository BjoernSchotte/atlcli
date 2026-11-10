/**
 * The sync daemon's webhook server (`wiki docs sync --webhook-port`).
 *
 * A webhook request is untrusted: it names a page and claims a space. The
 * daemon used to believe the claim (space scope), or check nothing at all
 * (tree scope), so one POST made it pull any page the profile could read into
 * the sync directory. It also listened on every interface with no secret.
 *
 * Each test drives the real CLI daemon against a local Bun server standing in
 * for Confluence, as sync-conflict.test.ts does.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

/** What the stub Confluence holds. 900 is outside every scope used below. */
const PAGES: Record<string, { title: string; space: string; ancestors: string[]; body: string }> = {
  "200": { title: "Root", space: "DOC", ancestors: [], body: "<p>root-body</p>" },
  "300": { title: "Child", space: "DOC", ancestors: ["200"], body: "<p>child-body</p>" },
  "900": { title: "Elsewhere", space: "OTHER", ancestors: ["800"], body: "<p>out-of-scope-body</p>" },
};

interface Harness {
  dir: string;
  lines: string[];
  webhook: string;
  cleanup(): Promise<void>;
}

let harness: Harness | null = null;

afterEach(async () => {
  await harness?.cleanup();
  harness = null;
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await Bun.sleep(50);
  }
  return predicate();
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}

async function sandbox(): Promise<{ root: string; home: string; dir: string; confluence: ReturnType<typeof Bun.serve> }> {
  const confluence = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch(req) {
      const { pathname } = new URL(req.url);
      const page = /^\/rest\/api\/content\/(\d+)$/.exec(pathname);
      if (page) {
        const found = PAGES[page[1]!];
        if (!found) return Response.json({ message: "not found" }, { status: 404 });
        return Response.json({
          id: page[1],
          title: found.title,
          type: "page",
          space: { key: found.space },
          version: { number: 1 },
          ancestors: found.ancestors.map((id) => ({ id, title: `Page ${id}` })),
          body: { storage: { value: found.body, representation: "storage" } },
          _links: { base: "http://example.invalid", webui: `/pages/${page[1]}` },
        });
      }
      const space = /^\/rest\/api\/space\/(\w+)$/.exec(pathname);
      if (space) return Response.json({ id: 1, key: space[1], name: space[1] });
      // Searches and listings: the scope starts out empty, so nothing is tracked.
      return Response.json({ results: [] });
    },
  });
  const root = await mkdtemp(join(tmpdir(), "atlcli-sync-webhook-"));
  const home = join(root, "home");
  const dir = join(root, "docs");
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: {
          name: "stub",
          baseUrl: confluence.url.origin,
          deploymentType: "data-center",
          auth: { type: "bearer", pat: "stub-token" },
        },
      },
      logging: { level: "off", global: false, project: false },
    })
  );
  return { root, home, dir, confluence };
}

function spawnSync(box: { root: string; home: string; dir: string }, args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(
    [process.execPath, "--conditions=development", "run", CLI, "wiki", "docs", "sync", box.dir, ...args],
    {
      cwd: box.root,
      env: {
        ...process.env,
        HOME: box.home,
        USERPROFILE: box.home,
        ATLCLI_API_TOKEN: "stub-token",
        ATLCLI_DISABLE_UPDATE_CHECK: "1",
        ATLCLI_WEBHOOK_SECRET: "",
        ...env,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

async function startDaemon(scope: string[], env: Record<string, string> = {}): Promise<Harness> {
  const box = await sandbox();
  const port = await freePort();
  const proc = spawnSync(box, [...scope, "--no-watch", "--no-poll", "--webhook-port", String(port)], env);

  const lines: string[] = [];
  void (async () => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of proc.stdout as AsyncIterable<Uint8Array>) {
        for (const line of decoder.decode(chunk).split("\n")) if (line.trim()) lines.push(line.trim());
      }
    } catch {
      // Stream closes when the daemon is killed.
    }
  })();

  const h: Harness = {
    dir: box.dir,
    lines,
    webhook: `http://127.0.0.1:${port}/webhook`,
    async cleanup() {
      proc.kill("SIGKILL");
      await proc.exited;
      await box.confluence.stop(true);
      await rm(box.root, { recursive: true, force: true });
    },
  };
  const started = await waitFor(() => lines.some((l) => l.includes("Webhook server listening")), 30_000);
  expect(started, `daemon never started; stdout:\n${lines.join("\n")}`).toBe(true);
  return h;
}

/** A page event that claims to belong to the synced space, whatever is true. */
function event(pageId: string, headers: Record<string, string> = {}, eventType = "page_updated"): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({
      eventType,
      timestamp: "2026-01-01T00:00:00Z",
      page: { id: pageId, title: "Child", spaceKey: "DOC", version: 2 },
    }),
  };
}

async function syncedText(dir: string): Promise<string> {
  const names = (await readdir(dir, { recursive: true })).filter((name) => name.endsWith(".md"));
  return (await Promise.all(names.map((name) => readFile(join(dir, name), "utf-8")))).join("\n");
}

describe("wiki docs sync webhook scope", () => {
  for (const [name, scope] of [
    ["page", ["--page-id", "300"]],
    ["tree", ["--ancestor", "200"]],
    ["space", ["--space", "DOC"]],
  ] as const) {
    it(`${name} scope: a forged event for a page outside the scope pulls nothing`, async () => {
      const h = (harness = await startDaemon([...scope]));

      // The handler runs before the response, so the answer means "done".
      expect((await fetch(h.webhook, event("900"))).status).toBe(200);
      expect(h.lines.join("\n")).toContain("page 900 is outside the sync scope");
      expect(await syncedText(h.dir)).not.toContain("out-of-scope-body");

      // A page Confluence places inside the scope is still pulled.
      expect((await fetch(h.webhook, event("300"))).status).toBe(200);
      expect(await syncedText(h.dir)).toContain("child-body");
      expect(await syncedText(h.dir)).not.toContain("out-of-scope-body");
    }, 90_000);
  }
});

describe("wiki docs sync webhook event type", () => {
  // The event type is the caller's string; it used to be printed and put into
  // the JSON event before the allow-list was consulted.
  it("ignores an unknown event type without echoing it", async () => {
    const h = (harness = await startDaemon(["--ancestor", "200"]));

    expect((await fetch(h.webhook, event("300", {}, "forged\u001b]0;pwned\u0007-type"))).status).toBe(200);
    // The handler runs before the response; a known event still gets through.
    expect((await fetch(h.webhook, event("300", {}, "page_trashed"))).status).toBe(200);
    const out = h.lines.join("\n");
    expect(out).toContain("Webhook received: page_trashed for page 300");
    expect(out).not.toContain("forged");
    expect(out).not.toContain("pwned");
    expect(await syncedText(h.dir)).not.toContain("child-body");
  }, 90_000);

  it("answers 415 to a POST a browser could send without a preflight", async () => {
    const h = (harness = await startDaemon(["--ancestor", "200"]));
    expect((await fetch(h.webhook, event("300", { "Content-Type": "text/plain" }))).status).toBe(415);
    expect(await syncedText(h.dir)).not.toContain("child-body");
  }, 90_000);
});

describe("wiki docs sync webhook authentication", () => {
  it("answers 401 to an event that does not prove the secret", async () => {
    const h = (harness = await startDaemon(["--ancestor", "200"], { ATLCLI_WEBHOOK_SECRET: "fixture-secret" }));

    expect((await fetch(h.webhook, event("300"))).status).toBe(401);
    expect((await fetch(h.webhook, event("300", { Authorization: "Bearer wrong" }))).status).toBe(401);
    expect(await syncedText(h.dir)).not.toContain("child-body");

    expect((await fetch(h.webhook, event("300", { Authorization: "Bearer fixture-secret" }))).status).toBe(200);
    expect(await syncedText(h.dir)).toContain("child-body");
    expect(h.lines.join("\n")).not.toContain("no webhook secret");
  }, 90_000);

  it("warns when no secret is set", async () => {
    const h = (harness = await startDaemon(["--page-id", "300"]));
    expect(await waitFor(() => h.lines.some((l) => l.includes("no webhook secret is set")), 5_000)).toBe(true);
  }, 90_000);

  it("refuses a non-loopback interface without a secret", async () => {
    const box = await sandbox();
    try {
      const proc = spawnSync(box, ["--page-id", "300", "--webhook-port", "3999", "--webhook-host", "0.0.0.0"]);
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      expect(exitCode).toBe(1);
      expect(`${stdout}${stderr}`).toContain("--webhook-host 0.0.0.0 needs a webhook secret");
    } finally {
      await box.confluence.stop(true);
      await rm(box.root, { recursive: true, force: true });
    }
  }, 60_000);
});
