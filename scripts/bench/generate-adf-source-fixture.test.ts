import { describe, expect, it } from "bun:test";
import { fetchExportTree, type ExportScope } from "@atlcli/confluence";
import {
  countingAdfSourceTree,
  loadAdfSourceBenchFixture,
  type BenchSourceRepresentation,
} from "./generate-adf-source-fixture.js";

async function fetch(
  scope: ExportScope,
  representation: BenchSourceRepresentation,
  pages: number,
) {
  const fixture = await loadAdfSourceBenchFixture(pages);
  const source = countingAdfSourceTree(fixture, representation);
  const result = await fetchExportTree(source, scope, { maxPages: pages + 1 });
  return { result, requests: source.snapshot(), fixture };
}

describe("paired ADF source benchmark fixture", () => {
  it("produces identical blocks and exactly one additional body request per page", async () => {
    const fixture = await loadAdfSourceBenchFixture(8);
    const scope: ExportScope = { kind: "tree", rootPageId: fixture.rootId };
    const adf = await fetch(scope, "adf-primary", 8);
    const storage = await fetch(scope, "storage-primary", 8);

    expect(adf.result.nodes.map((node) => node.kind === "page" ? node.blocks : [])).toEqual(
      storage.result.nodes.map((node) => node.kind === "page" ? node.blocks : []),
    );
    expect(adf.requests.adfBodyRequests).toBe(8);
    expect(adf.requests.storageBodyRequests).toBe(8);
    expect(storage.requests.adfBodyRequests).toBe(0);
    expect(storage.requests.storageBodyRequests).toBe(8);
    expect(adf.requests.totalRequests - storage.requests.totalRequests).toBe(8);
    expect(adf.result.sourceSummary.representations).toEqual({ atlas_doc_format: 8, storage: 0 });
    expect(storage.result.sourceSummary.representations).toEqual({ atlas_doc_format: 0, storage: 8 });
  });

  it("counts page, tree, and space request shapes using production adapter semantics", async () => {
    const pageFixture = await loadAdfSourceBenchFixture(1);
    const page = await fetch({ kind: "page", pageId: pageFixture.rootId }, "adf-primary", 1);
    expect(page.requests).toMatchObject({
      adfBodyRequests: 1,
      storageBodyRequests: 1,
      navigationRequests: 0,
      versionRequests: 1,
      spaceHomepageRequests: 0,
      totalRequests: 3,
    });

    const treeFixture = await loadAdfSourceBenchFixture(4);
    const tree = await fetch({ kind: "tree", rootPageId: treeFixture.rootId }, "storage-primary", 4);
    expect(tree.requests).toMatchObject({
      adfBodyRequests: 0,
      storageBodyRequests: 4,
      navigationRequests: 8,
      versionRequests: 1,
      spaceHomepageRequests: 0,
      totalRequests: 13,
    });

    const space = await fetch({ kind: "space", spaceKey: "BENCH" }, "adf-primary", 4);
    expect(space.requests).toMatchObject({
      adfBodyRequests: 4,
      storageBodyRequests: 4,
      navigationRequests: 8,
      versionRequests: 1,
      spaceHomepageRequests: 1,
      totalRequests: 18,
    });
  });
});
