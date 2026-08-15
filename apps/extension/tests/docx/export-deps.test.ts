import { describe, expect, it, mock } from "bun:test";
import type { ScanResult } from "@atlcli/docx/scan";
import type { ExportBlock, TreeSource } from "@atlcli/confluence/browser";
import {
  prepareExportDeps,
  resolveDocxExportScope,
  scanDependencies,
} from "../../utils/docx/export-deps.js";

function scan(...raw: string[]): ScanResult {
  return {
    supported: raw.map((value) => ({
      base: value.replace(/\.?\(.*$/, ""),
      status: "supported" as const,
      count: 1,
      raw: [value],
    })),
    unsupported: [],
    never: [],
    parts: ["word/document.xml"],
    hasContentPlaceholder: true,
    stylerefStyleNames: [],
  };
}

function loaders() {
  return {
    getSpaceWithIcon: mock(async (key: string) => ({
      space: { id: "1", key, name: key, type: "global" as const },
      icon: { path: `/download/${key}?version=1` },
    })),
    getCurrentUser: mock(async () => ({ accountId: "u", displayName: "User" })),
    getPageOwner: mock(async () => ({ accountId: "o", displayName: "Owner" })),
    getSpaceHomepageStorage: mock(async () => "<p>home</p>"),
    // Plain in-memory closure (spec 005 D1): a document-pass loader, never
    // pre-started, so a real closure — not a spy — is enough here.
    getIncludedPage: async () => ({ kind: "not-found-or-forbidden" as const }),
  };
}

describe("scanDependencies", () => {
  it("recognizes only the resolver/logo calls required by supported placeholders", () => {
    const deps = scanDependencies(
      scan(
        "$scroll.title",
        "$scroll.space.name",
        "$scroll.exporter.fullName",
        "$scroll.pageowner.fullName",
        "$scroll.spacelogo",
        "$scroll.pageproperty.(Status,false)",
        "$scroll.pageproperty.(Owner,macro-id,true,Unknown)"
      )
    );
    expect([...deps].sort().join(",")).toBe(
      ["currentUser", "owner", "space", "spaceHomepage", "spaceLogo"].sort().join(",")
    );
  });

  it("does NOT add a dependency for $scroll.includepage (it is a document pass, spec 005 D1)", () => {
    const deps = scanDependencies(scan("$scroll.includepage.(ENG:Imprint)", "$scroll.title"));
    expect(deps.size).toBe(0);
  });
});

describe("prepareExportDeps", () => {
  it("pre-starts only scan-indicated calls and coalesces space + logo", async () => {
    const host = loaders();
    const deps = prepareExportDeps(
      scan("$scroll.space.name", "$scroll.spacelogo"),
      { id: "42", spaceKey: "DOCSY" },
      host
    );

    expect(host.getSpaceWithIcon).toHaveBeenCalledTimes(1);
    expect(host.getCurrentUser).not.toHaveBeenCalled();
    expect(host.getPageOwner).not.toHaveBeenCalled();
    expect(host.getSpaceHomepageStorage).not.toHaveBeenCalled();
    expect(await deps.getSpace!("DOCSY")).toMatchObject({ key: "DOCSY" });
    expect(await deps.getSpaceLogo!("DOCSY")).toEqual({
      url: "/download/DOCSY?version=1",
    });
    expect(host.getSpaceWithIcon).toHaveBeenCalledTimes(1);
  });

  it("keeps current-user and homepage loads per-export while preserving rejection", async () => {
    const host = loaders();
    host.getCurrentUser.mockImplementation(async () => {
      throw new Error("logged out");
    });
    const deps = prepareExportDeps(
      scan("$scroll.exporter", "$scroll.pageproperty.(Status,true)"),
      { id: "42", spaceKey: "DOCSY" },
      host
    );

    expect(host.getCurrentUser).toHaveBeenCalledTimes(1);
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
    await expect(deps.getCurrentUser!()).rejects.toThrow("logged out");
    expect(await deps.getSpaceHomepageStorage!("DOCSY")).toBe("<p>home</p>");
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(1);
  });

  it("wires getIncludedPage straight through, lazy (never pre-started)", async () => {
    let includeCalls = 0;
    const host = {
      ...loaders(),
      getIncludedPage: async () => {
        includeCalls += 1;
        return { kind: "not-found-or-forbidden" as const };
      },
    };
    const deps = prepareExportDeps(
      scan("$scroll.includepage.(ENG:Imprint)"),
      { id: "42", spaceKey: "DOCSY" },
      host
    );
    // Not called during prepare (unlike the pre-started resolver loaders).
    expect(includeCalls).toBe(0);
    // Present on the ResolveDeps bag and callable on demand.
    const outcome = await deps.getIncludedPage!({ title: "Imprint" });
    expect(outcome.kind).toBe("not-found-or-forbidden");
    expect(includeCalls).toBe(1);
  });

  it("does not retain auth/content-sensitive values across exports", async () => {
    const host = loaders();
    const templateScan = scan("$scroll.exporter", "$scroll.pageproperty.(Status,true)");

    prepareExportDeps(templateScan, { id: "42", spaceKey: "DOCSY" }, host);
    prepareExportDeps(templateScan, { id: "42", spaceKey: "DOCSY" }, host);

    expect(host.getCurrentUser).toHaveBeenCalledTimes(2);
    expect(host.getSpaceHomepageStorage).toHaveBeenCalledTimes(2);
  });
});

/**
 * Scope wiring for the DOCX host (spec 010 T5.1).
 *
 * No HTTP: the walk runs against an in-memory `TreeSource`, which is a real
 * implementation of folder 002's port. What is under test is the *contract* the
 * DOCX host relies on — that a page scope contributes NOTHING (so the engine
 * keeps walking `details.storage` exactly as before) and a tree scope
 * contributes the same composed blocks the PDF host gets.
 */
describe("resolveDocxExportScope (T5.1)", () => {
  const PAGE_URL = "https://fixture.atlassian.net/wiki/spaces/DOCSY/pages/1/Root";
  const root = { id: "1", title: "Root", version: 4, spaceKey: "DOCSY" };

  const fixture: Record<string, { title: string; parent: string | null }> = {
    "1": { title: "Root", parent: null },
    "2": { title: "Alpha", parent: "1" },
  };

  const source: TreeSource = {
    async getPage(id) {
      return {
        id,
        title: fixture[id]!.title,
        storage: `<p>${fixture[id]!.title} body.</p>`,
        version: 1,
        labels: [],
        spaceKey: "DOCSY",
      };
    },
    async getPageVersion(id) {
      return { version: 1, title: fixture[id]!.title };
    },
    async getChildren(nodeRef) {
      return Object.entries(fixture)
        .filter(([, page]) => page.parent === nodeRef.id)
        .map(([id, page], index) => ({
          id,
          title: page.title,
          kind: "page" as const,
          position: index,
          observedVersion: 1,
        }));
    },
    async getSpaceHomepageId() {
      return "1";
    },
  };

  const deps = { createTreeSource: () => source };

  it("contributes nothing for a page scope — the engine keeps its own walk", async () => {
    expect(
      await resolveDocxExportScope(
        { root, pageUrl: PAGE_URL, scope: { kind: "page", pageId: "1" } },
        deps
      )
    ).toBeUndefined();
    // …and the same for no scope at all, which is every pre-T5.1 caller.
    expect(await resolveDocxExportScope({ root, pageUrl: PAGE_URL }, deps)).toBeUndefined();
  });

  it("contributes composed chapters, notes and the anchor map for a tree scope", async () => {
    const contribution = await resolveDocxExportScope(
      {
        root,
        pageUrl: PAGE_URL,
        scope: { kind: "tree", rootPageId: "1", includeRoot: true, maxDepth: 5 },
      },
      deps
    );
    expect(contribution).toBeDefined();
    expect(contribution!.pageCount).toBe(2);
    expect(contribution!.complete).toBe(true);
    const headings = contribution!.blocks
      .filter((block): block is Extract<ExportBlock, { type: "heading" }> => block.type === "heading")
      .map((block) => block.content.map((node) => ("text" in node ? node.text : "")).join(""));
    expect(headings).toEqual(["Root", "Alpha"]);
    // The anchor map is what lets a macro renderer link INTO this document.
    expect([...contribution!.chapterAnchorById.keys()].sort()).toEqual(["1", "2"]);
  });

  it("threads onProgress through the walk", async () => {
    const progress: number[] = [];
    await resolveDocxExportScope(
      {
        root,
        pageUrl: PAGE_URL,
        scope: { kind: "tree", rootPageId: "1", includeRoot: true, maxDepth: 5 },
        onProgress: (p) => progress.push(p.fetched),
      },
      deps
    );
    expect(progress).toEqual([1, 2]);
  });
});
