import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  composeChapters,
  fetchExportTree,
  type TreeSource,
} from "@atlcli/confluence";
import { runPdfExport } from "@atlcli/pdf";
import { validatePdfOutput } from "@atlcli/pdf/internal";
import type { Profile } from "@atlcli/core";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../../pdf-compiler-browser/scripts/vendor-typst.js";
import { nodePdfEnv } from "./pdf-env.js";
import { confluenceTreeSource } from "./tree-source.js";

/**
 * The BASELINE-DESIGN §A5 target DX, executed for real (spec 009): tree →
 * chapters → `runPdfExport(…, nodePdfEnv(profile, { outDir }))` producing a
 * real, validated PDF. The tree comes from an in-memory `TreeSource` — a
 * legitimate port per the tree-fetch contract — because the unit test cannot
 * talk to a live Confluence; `confluenceTreeSource(profile)` is separately
 * asserted to build the client-backed port.
 */

const dir = mkdtempSync(join(tmpdir(), "atlcli-export-node-a5-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
});

const PAGES: Record<string, { title: string; storage: string; children: string[] }> = {
  "123": {
    title: "Handbook",
    storage: "<h1>Welcome</h1><p>The A5 handbook root.</p>",
    children: ["124"],
  },
  "124": {
    title: "Install Guide",
    storage: "<h1>Install</h1><p>Chapter two body.</p>",
    children: [],
  },
};

function memoryTreeSource(): TreeSource {
  return {
    async getPage(id) {
      const page = PAGES[id];
      if (!page) throw new Error(`no such page ${id}`);
      return { id, title: page.title, storage: page.storage, version: 1, labels: [] };
    },
    async getChildren(nodeRef) {
      const page = PAGES[nodeRef.id];
      return (page?.children ?? []).map((childId, index) => ({
        id: childId,
        title: PAGES[childId]!.title,
        kind: "page" as const,
        position: index,
        observedVersion: 1,
      }));
    },
    async getPageVersion(id) {
      return { version: 1, title: PAGES[id]!.title };
    },
    async getSpaceHomepageId() {
      return null;
    },
  };
}

const profile: Profile = {
  name: "a5-example",
  baseUrl: "https://example.invalid",
  auth: { type: "apiToken", email: "a5@example.invalid", token: "unused" },
};

describe("BASELINE-DESIGN §A5 example (spec 009)", () => {
  it("tree → composeChapters → runPdfExport(nodePdfEnv) produces a real PDF file", async () => {
    const tree = await fetchExportTree(
      memoryTreeSource(),
      { kind: "tree", rootPageId: "123" },
      { labels: { exclude: ["internal"] } },
    );
    expect(tree.complete).toBe(true);
    const doc = composeChapters(tree.nodes);
    expect(doc.blocks.length).toBeGreaterThan(2);

    const report = await runPdfExport(
      {
        blocks: doc.blocks,
        metadata: { title: "Handbook", exportedAt: new Date("2026-07-15T10:00:00.000Z") },
        filename: "handbook.pdf",
      },
      nodePdfEnv(profile, {
        outDir: dir,
        // The fixture has no attachments; a resolver that throws proves the
        // env override seam without touching the network.
        assets: {
          resolve: async () => {
            throw new Error("the A5 example fixture has no external assets");
          },
        },
      }),
    );

    expect(report.filename).toBe("handbook.pdf");
    const bytes = new Uint8Array(readFileSync(join(dir, "handbook.pdf")));
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const inspection = validatePdfOutput(bytes);
    expect(inspection.tagged).toBe(true);
    expect(inspection.pageCount).toBeGreaterThanOrEqual(2);
  }, 30000);

  it("confluenceTreeSource(profile) builds a client-backed TreeSource", () => {
    const source = confluenceTreeSource(profile);
    for (const method of ["getPage", "getChildren", "getPageVersion", "getSpaceHomepageId"] as const) {
      expect(typeof source[method]).toBe("function");
    }
  });
});
