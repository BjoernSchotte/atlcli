/**
 * Determinism + shape regression tests for the end-to-end-tier storage fixture
 * (spec 011). Same seed → identical storage; the macro/table/image cadence is
 * pinned; and the in-memory `TreeSource` is proven to be a real port by driving
 * the REAL `fetchExportTree` + `storageToBlocks` through it — no mocks.
 */
import { describe, expect, it } from "bun:test";
import { fetchExportTree } from "@atlcli/confluence";
import {
  benchPageStorage,
  generateStorageFixture,
  storageFixtureTreeSource,
} from "./generate-storage-fixture.js";

describe("generateStorageFixture", () => {
  it("is deterministic: same seed produces byte-identical storage", () => {
    const a = generateStorageFixture({ pages: 40, seed: 123 });
    const b = generateStorageFixture({ pages: 40, seed: 123 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("diverges on a different seed", () => {
    const a = generateStorageFixture({ pages: 20, seed: 1 });
    const b = generateStorageFixture({ pages: 20, seed: 2 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it("emits exactly the requested page count with the root first", () => {
    const fixture = generateStorageFixture({ pages: 500, seed: 7 });
    expect(fixture.pageList).toHaveLength(500);
    expect(fixture.rootId).toBe(fixture.pageList[0]!.id);
  });

  it("emits storage XHTML, not pre-parsed blocks — that is the point of this tier", () => {
    const fixture = generateStorageFixture({ pages: 3, seed: 7 });
    for (const page of fixture.pageList) {
      expect(page.storage).toContain("<h1>");
      expect(page.storage).toContain("<p>");
    }
  });

  it("places a 200-row table on every 10th page", () => {
    const fixture = generateStorageFixture({ pages: 30, seed: 7 });
    const withTable = fixture.pageList.filter((p) => p.storage.includes("<table>"));
    // Pages 8, 16, 24 carry a scroll-title table too, so count the big one by rows.
    const bigTables = fixture.pageList.filter((p) => (p.storage.match(/<tr>/g) ?? []).length >= 200);
    expect(bigTables).toHaveLength(3); // pages 10, 20, 30
    expect(withTable.length).toBeGreaterThanOrEqual(3);
  });

  it("places a resolvable Jira macro on every 12th page", () => {
    const fixture = generateStorageFixture({ pages: 36, seed: 7 });
    const jira = fixture.pageList.filter((p) => p.storage.includes('ac:name="jira"'));
    expect(jira).toHaveLength(3); // pages 12, 24, 36
  });

  it("places a draw.io macro (placeholder-floor path) on every 20th page", () => {
    const fixture = generateStorageFixture({ pages: 40, seed: 7 });
    const drawio = fixture.pageList.filter((p) => p.storage.includes('ac:name="drawio"'));
    expect(drawio).toHaveLength(2); // pages 20, 40
  });

  it("places a code macro + attachment image on every 25th page", () => {
    const fixture = generateStorageFixture({ pages: 50, seed: 7 });
    const withImage = fixture.pageList.filter((p) => p.storage.includes("<ac:image"));
    expect(withImage).toHaveLength(2); // pages 25, 50
    for (const page of withImage) {
      expect(page.storage).toContain('ac:name="code"');
      expect(page.storage).toMatch(/ri:filename="bench-asset-\d+\.png"/);
    }
  });

  it("labels every third child page so the label-filter path has input", () => {
    const fixture = generateStorageFixture({ pages: 10, seed: 7 });
    const labelled = fixture.pageList.filter((p) => p.labels.length > 0);
    expect(labelled.map((p) => p.id)).toEqual(["bench-page-4", "bench-page-7", "bench-page-10"]);
  });

  it("benchPageStorage is pure over its rand + page number", () => {
    const rand = () => 0.5;
    expect(benchPageStorage(rand, 10)).toBe(benchPageStorage(rand, 10));
    expect(benchPageStorage(rand, 10)).not.toBe(benchPageStorage(rand, 11));
  });
});

describe("storageFixtureTreeSource", () => {
  it("drives the REAL fetchExportTree end to end (traversal + storageToBlocks)", async () => {
    const fixture = generateStorageFixture({ pages: 12, seed: 7 });
    const result = await fetchExportTree(
      storageFixtureTreeSource(fixture),
      { kind: "tree", rootPageId: fixture.rootId },
      { maxPages: 50 },
    );
    expect(result.complete).toBe(true);
    expect(result.nodes).toHaveLength(12);
    // The port produced storage; the real walker turned it into blocks.
    const root = result.nodes[0]!;
    expect(root.kind).toBe("page");
    if (root.kind === "page") {
      expect(root.blocks.length).toBeGreaterThan(0);
      expect(root.blocks[0]!.type).toBe("heading");
    }
  });

  it("preserves child order (position) so composed chapter order is stable", async () => {
    const fixture = generateStorageFixture({ pages: 6, seed: 7 });
    const result = await fetchExportTree(
      storageFixtureTreeSource(fixture),
      { kind: "tree", rootPageId: fixture.rootId },
      { maxPages: 50 },
    );
    expect(result.nodes.map((n) => (n.kind === "page" ? n.pageId : n.folderId))).toEqual(
      fixture.pageList.map((p) => p.id),
    );
  });

  it("resolves the space homepage to the fixture root", async () => {
    const fixture = generateStorageFixture({ pages: 3, seed: 7 });
    const source = storageFixtureTreeSource(fixture);
    expect(await source.getSpaceHomepageId("BENCH", {})).toBe(fixture.rootId);
  });

  it("throws on an unknown page rather than inventing an empty one", async () => {
    const source = storageFixtureTreeSource(generateStorageFixture({ pages: 2, seed: 7 }));
    await expect(source.getPage("nope", {})).rejects.toThrow(/unknown page/);
  });
});
