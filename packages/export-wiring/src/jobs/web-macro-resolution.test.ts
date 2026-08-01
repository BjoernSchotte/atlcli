import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportBlock, ExportPageNode } from "@atlcli/confluence";
import {
  createRegistry,
  type MacroResolutionOptions,
  type MacroRenderer,
} from "@atlcli/export-macros";
import { exportViewFallbackRenderer } from "@atlcli/export-macros/internal";
import {
  digestPublicationPageV1,
  digestPublicationRefreshPlanV1,
} from "@atlcli/web-publish";
import { materializeNodePublicationBundleV1 } from "@atlcli/web-publish/node";
import { resolveWebPageMacrosV1, type ResolvedWebMacroPageV1 } from "./web-macro-resolution.js";

function page(
  pageId: string,
  blocks: ExportBlock[],
  version = 1,
): ExportPageNode {
  return {
    kind: "page",
    pageId,
    title: pageId,
    depth: 0,
    effectiveDepth: 0,
    parentId: null,
    position: 0,
    blocks,
    notes: [{ level: "warning", code: "unknown-macro", message: "pending", macroName: "widget" }],
    meta: { version, labels: [], spaceKey: "DOCSY" },
  };
}

function macroOptions(calls: string[]): MacroResolutionOptions {
  const renderer: MacroRenderer = {
    id: "page-identity",
    macros: ["widget"],
    requiresLivePort: true,
    webRenderModel: { kind: "jira-data", dependencies: ["jira"] },
    async render(_macro, context) {
      const headings = context.documentBlocks
        ?.filter((block) => block.type === "heading")
        .map((block) => block.content.map((node) => node.type === "text" ? node.text : "").join(""))
        .join(",") ?? "";
      calls.push(`${context.page.id}:${headings}`);
      return {
        kind: "blocks",
        blocks: [{ type: "paragraph", content: [{ type: "text", text: `resolved:${context.page.id}` }] }],
      };
    },
  };
  return {
    registry: createRegistry([renderer]),
    contextFor(pageContext) {
      return { page: pageContext, depth: 0, visited: new Set() };
    },
  };
}

describe("resolveWebPageMacrosV1", () => {
  test("resolves each page against its own context and page-local TOC tree", async () => {
    const calls: string[] = [];
    const pages = [
      page("root", [
        { type: "unknown", macroName: "widget" },
        { type: "heading", level: 1, content: [{ type: "text", text: "Root only" }] },
      ]),
      page("child", [
        { type: "unknown", macroName: "widget", sourcePage: { id: "child", version: 1, spaceKey: "DOCSY" } },
        { type: "heading", level: 1, content: [{ type: "text", text: "Child only" }] },
      ]),
    ];
    const resolved = await resolveWebPageMacrosV1(pages, {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      now: () => 1_000,
    });

    expect(calls).toEqual(["root:Root only", "child:Child only"]);
    expect(resolved.map((entry) => entry.blocks[0])).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "resolved:root" }] },
      { type: "paragraph", content: [{ type: "text", text: "resolved:child" }] },
    ]);
    expect(resolved.every((entry) => entry.usedLive)).toBe(true);
    expect(resolved.map((entry) => entry.frozenProvenance)).toEqual([
      {
        sourceId: "root",
        sourceVersion: 1,
        resolvedAtEpochMs: 1_000,
        dependencies: ["jira"],
      },
      {
        sourceId: "child",
        sourceVersion: 1,
        resolvedAtEpochMs: 1_000,
        dependencies: ["jira"],
      },
    ]);
    expect(resolved.map((entry) => entry.renderModels)).toEqual([
      [{
        sourceId: "root",
        macroName: "widget",
        kind: "jira-data",
        rendererId: "page-identity",
        provenance: "frozen-live",
        dependencies: ["jira"],
      }],
      [{
        sourceId: "child",
        macroName: "widget",
        kind: "jira-data",
        rendererId: "page-identity",
        provenance: "frozen-live",
        dependencies: ["jira"],
      }],
    ]);
  });

  test("static-only permits pure output but never invokes a live renderer", async () => {
    const calls: string[] = [];
    const resolved = await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }]),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "static-only" },
      now: () => 2_000,
    });

    expect(calls).toEqual([]);
    expect(resolved[0]?.usedLive).toBe(false);
    expect(resolved[0]?.renderModels).toEqual([{
      sourceId: "guide",
      macroName: "widget",
      kind: "unknown",
      provenance: "fallback",
      dependencies: [],
    }]);
    expect(resolved[0]?.blocks).toEqual([{ type: "unknown", macroName: "widget" }]);
  });

  test("keeps an unsupported requested chart as a closed visible fallback", async () => {
    const resolved = await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "chart", plainBody: "<raw-chart/>" }]),
    ], {
      macros: macroOptions([]),
      policy: { mode: "static-only" },
      now: () => 2_000,
    });

    expect(resolved[0]?.renderModels).toEqual([{
      sourceId: "guide",
      macroName: "chart",
      kind: "unknown",
      requestedKind: "chart",
      provenance: "fallback",
      dependencies: [],
    }]);
    // The model does not become a second source payload; rendering consumes the
    // normalized blocks and cannot retrieve an opaque chart body from metadata.
    expect(JSON.stringify(resolved[0]?.renderModels)).not.toContain("raw-chart");
  });

  test("never retains raw export_view HTML in a serializable web page result", async () => {
    const rawExportViewHtml = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
    const seenHtml: string[] = [];
    const resolved = await resolveWebPageMacrosV1([
      page("macro-page", [{
        type: "unknown",
        macroName: "third-party-widget",
        macroId: "macro-42",
        plainBody: rawExportViewHtml,
      }]),
    ], {
      macros: {
        registry: createRegistry([exportViewFallbackRenderer({
          htmlToExportBlocks(html) {
            seenHtml.push(html);
            // The real host-owned decoder is the only place that receives the
            // HTML. Its normalized result is all a publication page may keep.
            return {
              blocks: [{ type: "paragraph", content: [{ type: "text", text: "Safely converted widget" }] }],
              notes: [],
            };
          },
        })]),
        contextFor(pageContext) {
          return {
            page: pageContext,
            depth: 0,
            visited: new Set(),
            exportView: {
              async renderMacroHtml(pageId, macroId) {
                expect(pageId).toBe("macro-page");
                expect(macroId).toBe("macro-42");
                return rawExportViewHtml;
              },
            },
          };
        },
      },
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      now: () => 2_000,
    });

    expect(seenHtml).toEqual([rawExportViewHtml]);
    expect(resolved[0]?.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "Safely converted widget" }] },
    ]);
    const persistedPage = JSON.stringify(resolved[0]);
    expect(persistedPage).not.toContain("onerror");
    expect(persistedPage).not.toContain("<script>");
    expect(persistedPage).not.toContain("macro-42");
    expect(persistedPage).not.toContain("rawExportViewHtml");
  });

  test("never writes raw export_view HTML into an activated publication bundle", async () => {
    const rawExportViewHtml = '<img src=x onerror="globalThis.pwned=1"><script>globalThis.pwned=1</script>';
    const resolved = await resolveWebPageMacrosV1([
      page("macro-page", [{
        type: "unknown",
        macroName: "third-party-widget",
        macroId: "macro-42",
        plainBody: rawExportViewHtml,
      }]),
    ], {
      macros: {
        registry: createRegistry([exportViewFallbackRenderer({
          htmlToExportBlocks() {
            return {
              blocks: [{ type: "paragraph", content: [{ type: "text", text: "Safely converted widget" }] }],
              notes: [],
            };
          },
        })]),
        contextFor(pageContext) {
          return {
            page: pageContext,
            depth: 0,
            visited: new Set(),
            exportView: {
              async renderMacroHtml() {
                return rawExportViewHtml;
              },
            },
          };
        },
      },
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      now: () => 2_000,
    });
    const macroPage = resolved[0];
    if (macroPage === undefined) throw new Error("expected resolved macro page");

    const pageDraft = {
      schema: "atlcli.publication-page/1" as const,
      sourceId: macroPage.sourceId,
      sourceVersion: String(macroPage.sourceVersion ?? 1),
      title: "Macro page",
      position: 0,
      depth: 0,
      route: "/macro-page/",
      blocks: macroPage.blocks,
      notes: macroPage.notes,
      labels: [],
      links: [],
      assetIds: [],
      renderDependencies: [],
      pageDigest: "pending",
    };
    const publicationPage = {
      ...pageDraft,
      pageDigest: await digestPublicationPageV1(pageDraft),
    };
    const sourceSnapshot = {
      sourceDigest: "macro-source-digest",
      complete: true,
      deletionAuthority: "complete-scan" as const,
      rootIds: [macroPage.sourceId],
      pages: [{
        sourceId: macroPage.sourceId,
        sourceVersion: String(macroPage.sourceVersion ?? 1),
        representation: "atlas_doc_format" as const,
        position: 0,
        depth: 0,
        title: "Macro page",
        contentDigest: "macro-content-digest",
        metadataDigest: "macro-metadata-digest",
        assetMetadataDigest: "macro-assets-digest",
        macroDependencyDigest: "macro-dependencies-digest",
        state: "included" as const,
      }],
    };
    const refreshPlanDraft = {
      schema: "atlcli.publication-refresh-plan/1" as const,
      sourceSnapshot,
      changes: [{ kind: "add" as const, sourceId: macroPage.sourceId, nextDigest: "macro-content-digest" }],
      complete: true,
      issues: [],
      planDigest: "pending",
    };
    const refreshPlan = {
      ...refreshPlanDraft,
      planDigest: await digestPublicationRefreshPlanV1(refreshPlanDraft),
    };
    const workspaceDirectory = await mkdtemp(join(tmpdir(), "atlcli-web-macro-bundle-"));
    try {
      const result = await materializeNodePublicationBundleV1({
        workspaceDirectory,
        refreshPlan,
        createdBy: { name: "atlcli", version: "0.1.0-test" },
        sourcePolicyDigest: "a".repeat(64),
        rootIds: [macroPage.sourceId],
        pages: [publicationPage],
        routes: [{
          sourceId: macroPage.sourceId,
          route: "/macro-page/",
          state: "active",
          assignedBy: "generated",
          previousRoutes: [],
        }],
        assets: [],
        assetPolicy: { maxAssetBytes: 1_024, maxTotalBytes: 1_024 },
      });
      const bundleJson = await readFile(join(result.bundleDirectory, "publication.json"), "utf8");
      const pagePath = result.bundle.pages[0]?.path;
      if (pagePath === undefined) throw new Error("expected bundled page");
      const bundledPageJson = await readFile(join(result.bundleDirectory, pagePath), "utf8");
      const persistedBundle = `${bundleJson}\n${bundledPageJson}`;
      expect(persistedBundle).toContain("Safely converted widget");
      expect(persistedBundle).not.toContain("onerror");
      expect(persistedBundle).not.toContain("<script>");
      expect(persistedBundle).not.toContain("macro-42");
      expect(persistedBundle).not.toContain(rawExportViewHtml);
    } finally {
      await rm(workspaceDirectory, { recursive: true, force: true });
    }
  });

  test("reuses only a version-matching, explicitly fresh frozen live result", async () => {
    const calls: string[] = [];
    const previous: ResolvedWebMacroPageV1 = {
      sourceId: "guide",
      sourceVersion: 1,
      blocks: [{ type: "paragraph", content: [{ type: "text", text: "frozen" }] }],
      notes: [],
      renderModels: [],
      resolvedAtEpochMs: 1_000,
      usedLive: true,
      frozenProvenance: {
        sourceId: "guide",
        sourceVersion: 1,
        resolvedAtEpochMs: 1_000,
        dependencyDigest: "a".repeat(64),
        dependencies: ["jira"],
      },
    };
    const fresh = await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }]),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      previousBySourceId: new Map([["guide", previous]]),
      dependencyDigestForPage: () => "a".repeat(64),
      now: () => 61_000,
    });
    expect(fresh).toEqual([previous]);
    expect(calls).toEqual([]);

    await resolveWebPageMacrosV1([
      page("guide", [{ type: "unknown", macroName: "widget" }], 2),
    ], {
      macros: macroOptions(calls),
      policy: { mode: "allow-frozen-live", liveFreshnessSeconds: 60 },
      previousBySourceId: new Map([["guide", previous]]),
      dependencyDigestForPage: () => "b".repeat(64),
      now: () => 61_001,
    });
    expect(calls).toEqual(["guide:"]);
  });

  test("rejects ambiguous duplicate pages and invalid freshness combinations", async () => {
    const options = { macros: macroOptions([]), policy: { mode: "static-only", liveFreshnessSeconds: 1 } as const };
    await expect(resolveWebPageMacrosV1([], options)).rejects.toThrow("static-only");
    await expect(resolveWebPageMacrosV1([
      page("duplicate", []), page("duplicate", []),
    ], { macros: macroOptions([]), policy: { mode: "static-only" } })).rejects.toThrow("duplicate page");
    await expect(resolveWebPageMacrosV1([
      page("digest", []),
    ], {
      macros: macroOptions([]),
      policy: { mode: "static-only" },
      dependencyDigestForPage: () => "not-a-digest",
    })).rejects.toThrow("dependency digest");
  });
});
