/**
 * Regression: `docs pull --page-id <id>` for a page nested in folders
 * materialized the folder tree of the whole space.
 *
 * Folder discovery walked the children of every folder it had found, including
 * the folders that are merely ancestors of the pulled page. From the topmost
 * ancestor folder that walk reaches every folder in the space, and each one was
 * written as an `index.md` stub next to the single requested page.
 *
 * Runs the real CLI against a Bun HTTP server standing in for Confluence Cloud
 * (no Atlassian traffic, sandboxed HOME).
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldersToTraverse } from "./docs.js";

const CLI = fileURLToPath(new URL("../index.ts", import.meta.url));

// Space layout:
//   Area (folder)
//   ├── Team (folder)
//   │   ├── Target Page        <- pulled with --page-id
//   │   │   └── Below Target (folder)
//   │   └── Team Sibling (folder)
//   └── Other Area (folder)
//       └── Other Nested (folder)
type Folder = { id: string; title: string; parentId: string | null; children: string[] };
const FOLDERS: Record<string, Folder> = {
  "f-area": { id: "f-area", title: "Area", parentId: null, children: ["f-team", "f-other"] },
  "f-team": { id: "f-team", title: "Team", parentId: "f-area", children: ["p-target", "f-sibling"] },
  "f-sibling": { id: "f-sibling", title: "Team Sibling", parentId: "f-team", children: [] },
  "f-other": { id: "f-other", title: "Other Area", parentId: "f-area", children: ["f-nested"] },
  "f-nested": { id: "f-nested", title: "Other Nested", parentId: "f-other", children: [] },
  "f-below": { id: "f-below", title: "Below Target", parentId: "p-target", children: [] },
};

const PAGE_ID = "p-target";
const PAGE = {
  id: PAGE_ID,
  type: "page",
  title: "Target Page",
  space: { key: "DOCSY" },
  version: { number: 1, when: "2026-07-20T00:00:00.000Z" },
  ancestors: [
    { id: "f-area", title: "Area", type: "folder" },
    { id: "f-team", title: "Team", type: "folder" },
  ],
  history: {
    createdDate: "2026-07-19T00:00:00.000Z",
    createdBy: { accountId: "acc-1", displayName: "Fixture Author" },
    lastUpdated: { when: "2026-07-20T00:00:00.000Z", by: { accountId: "acc-2", displayName: "Other Author" } },
  },
  metadata: { labels: { results: [] }, properties: {} },
  body: { storage: { value: "<p>Body.</p>", representation: "storage" } },
  _links: { base: "http://stub.invalid", webui: `/pages/${PAGE_ID}` },
};

function child(id: string) {
  const folder = FOLDERS[id];
  return folder
    ? { id, title: folder.title, type: "folder", status: "current" }
    : { id, title: PAGE.title, type: "page", status: "current" };
}

let server: ReturnType<typeof Bun.serve>;
let home: string;
let tree: string;
let writes: string[] = [];

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const pathname = new URL(req.url).pathname.replace(/^\/wiki/, "");
      if (req.method !== "GET") writes.push(`${req.method} ${pathname}`);

      if (pathname === `/rest/api/content/${PAGE_ID}`) return Response.json(PAGE);
      if (pathname === `/rest/api/content/${PAGE_ID}/child/attachment`) return Response.json({ results: [], size: 0 });
      if (pathname === `/api/v2/pages/${PAGE_ID}/direct-children`) {
        return Response.json({ results: [child("f-below")], _links: {} });
      }
      const folder = pathname.match(/^\/api\/v2\/folders\/([^/]+)(\/direct-children)?$/);
      if (folder && FOLDERS[folder[1]]) {
        const f = FOLDERS[folder[1]];
        if (folder[2]) return Response.json({ results: f.children.map(child), _links: {} });
        return Response.json({ id: f.id, title: f.title, spaceId: "1", parentId: f.parentId });
      }
      return new Response(JSON.stringify({ message: `stub: no route for ${pathname}` }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    },
  });

  home = await mkdtemp(join(tmpdir(), "atlcli-pageid-home-"));
  tree = await mkdtemp(join(tmpdir(), "atlcli-pageid-tree-"));
  await mkdir(join(home, ".atlcli"), { recursive: true });
  await writeFile(
    join(home, ".atlcli", "config.json"),
    JSON.stringify({
      currentProfile: "stub",
      profiles: {
        stub: {
          name: "stub",
          baseUrl: server.url.origin,
          deploymentType: "cloud",
          auth: { type: "bearer" },
          space: "DOCSY",
        },
      },
    })
  );
});

afterAll(async () => {
  server?.stop(true);
  if (home) await rm(home, { recursive: true, force: true });
  if (tree) await rm(tree, { recursive: true, force: true });
});

async function markdownFiles(): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, prefix = "") => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else if (entry.name.endsWith(".md")) found.push(rel);
    }
  };
  await walk(tree);
  return found.sort();
}

describe("docs pull --page-id: only the page's ancestor path is materialized", () => {
  it("writes the page and its ancestor folders, nothing else", async () => {
    const proc = Bun.spawn(
      [process.execPath, "--conditions=development", "run", CLI, "wiki", "docs", "pull", tree, "--page-id", PAGE_ID, "--skip-user-check"],
      {
        cwd: tree,
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          ATLCLI_API_TOKEN: "stub-token",
          ATLCLI_DISABLE_UPDATE_CHECK: "1",
        },
        stdout: "pipe",
        stderr: "pipe",
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    expect(exitCode, `${stdout}${stderr}`).toBe(0);
    expect(await markdownFiles()).toEqual([
      "area/index.md",
      "area/team/index.md",
      "area/team/target-page.md",
    ]);
    expect(writes).toEqual([]);
  }, 90_000);
});

describe("foldersToTraverse", () => {
  const folders = Object.values(FOLDERS).map((f) => ({ id: f.id, title: f.title, spaceId: "1", parentId: f.parentId }));
  const ids = (scope: Parameters<typeof foldersToTraverse>[0]) =>
    foldersToTraverse(scope, [PAGE], folders).map((f) => f.id).sort();

  it("walks no ancestor folders for a single page", () => {
    expect(ids({ type: "page", pageId: PAGE_ID })).toEqual([]);
  });

  it("walks only ancestor folders from the tree root down", () => {
    expect(ids({ type: "tree", ancestorId: "f-team" })).toEqual(["f-below", "f-nested", "f-other", "f-sibling", "f-team"]);
  });

  it("walks every folder for a space", () => {
    expect(ids({ type: "space", spaceKey: "DOCSY" })).toHaveLength(folders.length);
  });
});
