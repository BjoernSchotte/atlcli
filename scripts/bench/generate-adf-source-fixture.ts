/**
 * Deterministic paired ADF/Storage source fixture for the ADF rollout benchmark.
 *
 * The bodies are the same synthetic semantic pair used by the dispatcher
 * differential test. The source reports logical HTTP requests according to the
 * production adapter: one version snapshot for the root, two page-child reads
 * per traversed page, one homepage lookup for space scope, and either one
 * Storage body read or the correctness-first ADF + Storage dual read per page.
 */
import type {
  ExportPageSource,
  TreeChild,
  TreeNodeRef,
  TreeSource,
  TreeSourcePage,
  TreeSourceVersion,
} from "@atlcli/confluence";

export type BenchSourceRepresentation = "adf-primary" | "storage-primary";

export interface AdfSourceBenchPage {
  id: string;
  title: string;
  version: number;
}

export interface AdfSourceBenchFixture {
  pages: readonly AdfSourceBenchPage[];
  rootId: string;
  adf: string;
  storage: string;
}

export interface SourceRequestSnapshot {
  adfBodyRequests: number;
  storageBodyRequests: number;
  navigationRequests: number;
  versionRequests: number;
  spaceHomepageRequests: number;
  adfBodyBytes: number;
  storageBodyBytes: number;
  totalRequests: number;
  totalBodyBytes: number;
}

export interface CountingTreeSource extends TreeSource {
  snapshot(): SourceRequestSnapshot;
}

const encoder = new TextEncoder();

export async function loadAdfSourceBenchFixture(pageCount: number): Promise<AdfSourceBenchFixture> {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    throw new Error(`ADF source benchmark page count must be a positive integer (got ${pageCount}).`);
  }
  const fixtureRoot = new URL("../../packages/confluence/test-fixtures/adf-pairs/", import.meta.url);
  const [adf, storage] = await Promise.all([
    Bun.file(new URL("basic.adf.json", fixtureRoot)).text(),
    Bun.file(new URL("basic.storage.xml", fixtureRoot)).text(),
  ]);
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    id: `source-bench-page-${index + 1}`,
    title: index === 0 ? "Source Benchmark" : `Source Benchmark Chapter ${index + 1}`,
    version: 1,
  }));
  return { pages, rootId: pages[0]!.id, adf, storage };
}

function exportSource(
  fixture: AdfSourceBenchFixture,
  representation: BenchSourceRepresentation,
): ExportPageSource {
  if (representation === "adf-primary") {
    return {
      primary: { representation: "atlas_doc_format", value: fixture.adf },
      storageSidecar: fixture.storage,
      sourceVersion: 1,
    };
  }
  return {
    primary: { representation: "storage", value: fixture.storage },
    sourceVersion: 1,
  };
}

export function countingAdfSourceTree(
  fixture: AdfSourceBenchFixture,
  representation: BenchSourceRepresentation,
): CountingTreeSource {
  const byId = new Map(fixture.pages.map((page) => [page.id, page]));
  const adfBytes = encoder.encode(fixture.adf).byteLength;
  const storageBytes = encoder.encode(fixture.storage).byteLength;
  const counters = {
    adfBodyRequests: 0,
    storageBodyRequests: 0,
    navigationRequests: 0,
    versionRequests: 0,
    spaceHomepageRequests: 0,
    adfBodyBytes: 0,
    storageBodyBytes: 0,
  };

  const source: CountingTreeSource = {
    async getPage(id: string): Promise<TreeSourcePage> {
      const page = byId.get(id);
      if (!page) throw new Error(`ADF source benchmark: unknown page ${id}.`);
      counters.storageBodyRequests += 1;
      counters.storageBodyBytes += storageBytes;
      if (representation === "adf-primary") {
        counters.adfBodyRequests += 1;
        counters.adfBodyBytes += adfBytes;
      }
      return {
        id: page.id,
        title: page.title,
        version: page.version,
        labels: [],
        spaceKey: "BENCH",
        storage: fixture.storage,
        exportSource: exportSource(fixture, representation),
      };
    },

    async getChildren(nodeRef: TreeNodeRef): Promise<TreeChild[]> {
      // confluenceTreeSource performs child-kind discovery and position lookup.
      counters.navigationRequests += 2;
      if (nodeRef.id !== fixture.rootId) return [];
      return fixture.pages.slice(1).map((page, index) => ({
        id: page.id,
        title: page.title,
        kind: "page",
        position: index,
        observedVersion: page.version,
      }));
    },

    async getPageVersion(id: string): Promise<TreeSourceVersion> {
      counters.versionRequests += 1;
      const page = byId.get(id);
      if (!page) throw new Error(`ADF source benchmark: unknown page ${id}.`);
      return { title: page.title, version: page.version };
    },

    async getSpaceHomepageId(): Promise<string> {
      counters.spaceHomepageRequests += 1;
      return fixture.rootId;
    },

    snapshot(): SourceRequestSnapshot {
      const totalRequests =
        counters.adfBodyRequests +
        counters.storageBodyRequests +
        counters.navigationRequests +
        counters.versionRequests +
        counters.spaceHomepageRequests;
      return {
        ...counters,
        totalRequests,
        totalBodyBytes: counters.adfBodyBytes + counters.storageBodyBytes,
      };
    },
  };
  return source;
}
