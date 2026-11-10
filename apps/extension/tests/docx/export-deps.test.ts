import { describe, expect, it } from "bun:test";
import type { ExportBlock, TreeSource } from "@atlcli/confluence/browser";
import { resolveDocxExportScope } from "../../utils/docx/export-deps.js";

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
