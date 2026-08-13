import { describe, test, expect } from "bun:test";
import {
  fetchExportTree,
  confluenceTreeSource,
  applyLabelFilter,
  nodeId,
  ExportCompletenessError,
  TreeLimitExceededError,
  LabelFilterError,
  SpaceHomepageError,
  type TreeSource,
  type TreeChild,
  type TreeFetchContext,
  type ExportNode,
  type ExportPageNode,
  type ExportTreeBodyResultV1,
  type ExportTreeBodyStoreV1,
  type TreeFetchProgress,
} from "./tree-fetch.js";
import type { ExportPageSource } from "./page-body.js";
import type { ExportScope } from "./export-scope.js";
import { composeChapters } from "./compose-document.js";
import type { ExportBlock } from "./export-blocks.js";

// ---------------------------------------------------------------------------
// In-memory TreeSource (a legitimate port implementation, NOT an API mock)
// ---------------------------------------------------------------------------

interface FixtureNode {
  id: string;
  kind: "page" | "folder" | "unsupported";
  unsupportedKind?: string;
  title: string;
  parent: string | null;
  position?: number | null;
  labels?: string[];
  storage?: string;
  /** Version reported at discovery (page-under-page) and by getPageVersion. */
  observedVersion?: number;
  // --- test knobs ---
  /** getPage throws `Confluence API error (status)`. */
  bodyStatus?: number;
  /** getChildren for THIS node (as a parent) throws with this status. */
  childrenStatus?: number;
  /** Version returned by the getPage body (to trigger page-version-changed). */
  bodyVersion?: number;
  /** Artificial getPage latency (ms) for pool-ordering tests. */
  latencyMs?: number;
}

interface InMemoryOptions {
  spaceHomepage?: Record<string, string | null>;
  /** Called with the current call counters after each port call. */
  onCall?: (kind: string, id: string) => void;
}

interface InMemorySource extends TreeSource {
  calls: { getPage: number; getPageVersion: number; getChildren: number; searchPages: number };
  getPageIds: string[];
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("Aborted"));
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Condition was not reached.");
}

function statusError(status: number): Error {
  return new Error(`Confluence API error (${status}): simulated`);
}

function inMemoryTreeSource(
  fixture: FixtureNode[],
  options: InMemoryOptions = {}
): InMemorySource {
  const byId = new Map(fixture.map((n) => [n.id, n]));
  const calls = { getPage: 0, getPageVersion: 0, getChildren: 0, searchPages: 0 };
  const getPageIds: string[] = [];

  const childrenOf = (parentId: string): FixtureNode[] =>
    fixture.filter((n) => n.parent === parentId);

  return {
    calls,
    getPageIds,

    async getPage(id, context: TreeFetchContext) {
      calls.getPage += 1;
      getPageIds.push(id);
      options.onCall?.("getPage", id);
      const node = byId.get(id);
      if (!node) throw statusError(404);
      if (node.latencyMs) await abortableSleep(node.latencyMs, context.signal);
      context.signal?.throwIfAborted();
      if (node.bodyStatus) throw statusError(node.bodyStatus);
      return {
        id: node.id,
        title: node.title,
        storage: node.storage ?? `<p>${node.title}</p>`,
        version: node.bodyVersion ?? node.observedVersion,
        labels: node.labels ?? [],
        spaceKey: "DOCSY",
      };
    },

    async getPageVersion(id, context: TreeFetchContext) {
      calls.getPageVersion += 1;
      options.onCall?.("getPageVersion", id);
      context.signal?.throwIfAborted();
      const node = byId.get(id);
      if (!node) throw statusError(404);
      return { version: node.observedVersion, title: node.title } as {
        version: number;
        title: string;
      };
    },

    async getChildren(nodeRef, context: TreeFetchContext) {
      calls.getChildren += 1;
      options.onCall?.("getChildren", nodeRef.id);
      context.signal?.throwIfAborted();
      const parent = byId.get(nodeRef.id);
      if (parent?.childrenStatus) throw statusError(parent.childrenStatus);
      return childrenOf(nodeRef.id).map((child): TreeChild => {
        const base = {
          id: child.id,
          title: child.title,
          position: child.position ?? null,
        };
        if (child.kind === "unsupported") {
          return { ...base, kind: "unsupported", unsupportedKind: child.unsupportedKind };
        }
        if (child.kind === "folder") {
          return { ...base, kind: "folder", position: null };
        }
        // page: page-under-page carries observedVersion; page-under-folder doesn't.
        return {
          ...base,
          kind: "page",
          observedVersion: nodeRef.kind === "page" ? child.observedVersion : undefined,
        };
      });
    },

    async getSpaceHomepageId(spaceKey, context: TreeFetchContext) {
      context.signal?.throwIfAborted();
      return options.spaceHomepage?.[spaceKey] ?? null;
    },

    async searchPages(cql, context: TreeFetchContext) {
      calls.searchPages += 1;
      context.signal?.throwIfAborted();
      const idMatch = cql.match(/id in \(([^)]*)\)/i);
      const labelMatch = cql.match(/label in \(([^)]*)\)/i);
      const ids = idMatch ? [...idMatch[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!) : [];
      const labels = labelMatch
        ? [...labelMatch[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
        : [];
      return ids
        .filter((id) => {
          const n = byId.get(id);
          return n ? (n.labels ?? []).some((l) => labels.includes(l)) : false;
        })
        .map((id) => ({ id }));
    },
  };
}

/** Extract just the ordered titles of the returned nodes. */
function titles(result: { nodes: readonly ExportNode[] }): string[] {
  return result.nodes.map((n) => n.title);
}

const tree = (rootPageId: string, extra?: Partial<Extract<ExportScope, { kind: "tree" }>>): ExportScope => ({
  kind: "tree",
  rootPageId,
  ...extra,
});

// ---------------------------------------------------------------------------
// Ordering + guards
// ---------------------------------------------------------------------------

describe("fetchExportTree — ordering & structure", () => {
  const basic: FixtureNode[] = [
    { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1 },
    { id: "a1", kind: "page", title: "A1", parent: "a", position: 0, observedVersion: 1 },
    { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1 },
    { id: "c", kind: "page", title: "C", parent: "root", position: 2, observedVersion: 1 },
  ];

  test("pre-order DFS follows UI positions", async () => {
    const source = inMemoryTreeSource(basic);
    const result = await fetchExportTree(source, tree("root"));
    expect(titles(result)).toEqual(["Root", "A", "A1", "B", "C"]);
    expect(result.complete).toBe(true);
    // Every page body fetched exactly once.
    expect(source.calls.getPage).toBe(5);
  });

  test("out-of-order positions are sorted (position, then title)", async () => {
    const shuffled: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "b", kind: "page", title: "B", parent: "root", position: 2, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 1, observedVersion: 1 },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(shuffled), tree("root"));
    expect(titles(result)).toEqual(["Root", "A", "B"]);
  });

  test("includeRoot:false makes the root's children the top-level chapters", async () => {
    const result = await fetchExportTree(
      inMemoryTreeSource(basic),
      tree("root", { includeRoot: false })
    );
    expect(titles(result)).toEqual(["A", "A1", "B", "C"]);
    // A, B, C become depth-0 top-level chapters.
    const topLevel = result.nodes.filter((n) => n.depth === 0).map((n) => n.title);
    expect(topLevel).toEqual(["A", "B", "C"]);
  });

  test("a page scope exports exactly one page (no descent)", async () => {
    const source = inMemoryTreeSource(basic);
    const result = await fetchExportTree(source, { kind: "page", pageId: "root" });
    expect(titles(result)).toEqual(["Root"]);
    expect(source.calls.getPage).toBe(1);
  });

  test("maxDepth cuts the traversal", async () => {
    const result = await fetchExportTree(inMemoryTreeSource(basic), tree("root", { maxDepth: 1 }));
    // Root (0) + its direct children (1); A1 (depth 2) excluded.
    expect(titles(result)).toEqual(["Root", "A", "B", "C"]);
  });

  test("maxPages is a hard early error", async () => {
    const source = inMemoryTreeSource(basic);
    await expect(fetchExportTree(source, tree("root"), { maxPages: 3 })).rejects.toBeInstanceOf(
      TreeLimitExceededError
    );
  });

  test("onProgress reports one event per fetched page reaching the total", async () => {
    const events: TreeFetchProgress[] = [];
    const result = await fetchExportTree(inMemoryTreeSource(basic), tree("root"), {
      onProgress: (e) => events.push(e),
    });
    expect(events.length).toBe(5);
    expect(events.map((e) => e.fetched)).toEqual([1, 2, 3, 4, 5]);
    expect(events.every((e) => e.total === 5)).toBe(true);
    expect(result.complete).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cycles, folders, unsupported children
// ---------------------------------------------------------------------------

describe("fetchExportTree — cycles, folders, unsupported", () => {
  test("a cycle emits tree-cycle and terminates", async () => {
    const cyclic: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1 },
    ];
    // Make A's child be Root again (via a hand-forged getChildren).
    const source = inMemoryTreeSource(cyclic);
    const original = source.getChildren.bind(source);
    source.getChildren = async (ref, ctx) => {
      if (ref.id === "a") {
        return [{ id: "root", title: "Root", kind: "page", position: 0, observedVersion: 1 }];
      }
      return original(ref, ctx);
    };
    const result = await fetchExportTree(source, tree("root"));
    expect(result.notes.some((n) => n.code === "tree-cycle")).toBe(true);
    // Root visited once; the cycle back-edge is skipped.
    expect(result.nodes.filter((n) => nodeId(n) === "root").length).toBe(1);
  });

  test("includeRoot:false seeds the excluded root into the cycle guard (no duplicate nodes)", async () => {
    // Regression (review MINOR 1): with the root excluded by explicit request,
    // a cycle root → a → root must hit the guard immediately — the root's
    // children must not be re-listed and no duplicate node may be emitted.
    const cyclic: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1 },
    ];
    const source = inMemoryTreeSource(cyclic);
    const original = source.getChildren.bind(source);
    let rootListings = 0;
    source.getChildren = async (ref, ctx) => {
      if (ref.id === "root") rootListings += 1;
      if (ref.id === "a") {
        // Adversarial back-edge to the (excluded) root.
        return [{ id: "root", title: "Root", kind: "page", position: 0, observedVersion: 1 }];
      }
      return original(ref, ctx);
    };
    const result = await fetchExportTree(source, tree("root", { includeRoot: false }));
    // Only A is emitted — the root never reappears as a duplicate node.
    expect(titles(result)).toEqual(["A"]);
    expect(result.nodes.filter((n) => nodeId(n) === "root").length).toBe(0);
    expect(result.notes.filter((n) => n.code === "tree-cycle").length).toBe(1);
    // The root's children were listed exactly once (the initial listing).
    expect(rootListings).toBe(1);
  });

  test("folder node becomes an empty-body chapter with a folder-position-unknown note", async () => {
    const withFolder: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "f", kind: "folder", title: "Folder", parent: "root", position: null },
      { id: "p", kind: "page", title: "In Folder", parent: "f", observedVersion: 3 },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(withFolder), tree("root"));
    expect(titles(result)).toEqual(["Root", "Folder", "In Folder"]);
    const folder = result.nodes.find((n) => n.kind === "folder");
    expect(folder).toBeDefined();
    expect(folder && "blocks" in folder).toBe(false);
    expect(result.notes.some((n) => n.code === "folder-position-unknown")).toBe(true);
  });

  test("page-under-folder version is backfilled via getPageVersion", async () => {
    const withFolder: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "f", kind: "folder", title: "Folder", parent: "root" },
      { id: "p", kind: "page", title: "In Folder", parent: "f", observedVersion: 7 },
    ];
    const source = inMemoryTreeSource(withFolder);
    await fetchExportTree(source, tree("root"));
    // getPageVersion called for the root (no discovery snapshot) AND the
    // page-under-folder child (folder listing carries no version).
    expect(source.calls.getPageVersion).toBe(2);
  });

  test("a folder cycle is guarded", async () => {
    const source = inMemoryTreeSource([
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "f", kind: "folder", title: "F", parent: "root" },
    ]);
    const original = source.getChildren.bind(source);
    source.getChildren = async (ref, ctx) => {
      if (ref.id === "f") return [{ id: "f", title: "F", kind: "folder", position: null }];
      return original(ref, ctx);
    };
    const result = await fetchExportTree(source, tree("root"));
    expect(result.notes.some((n) => n.code === "tree-cycle")).toBe(true);
  });

  test("maxFolders is a hard early error even under the page cap", async () => {
    const wide: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    ];
    for (let i = 0; i < 10; i += 1) {
      wide.push({ id: `f${i}`, kind: "folder", title: `F${i}`, parent: "root" });
    }
    await expect(
      fetchExportTree(inMemoryTreeSource(wide), tree("root"), { maxFolders: 3, maxPages: 500 })
    ).rejects.toBeInstanceOf(TreeLimitExceededError);
  });

  test("unsupported children under page and folder parents are reported and skipped", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "wb", kind: "unsupported", unsupportedKind: "whiteboard", title: "WB", parent: "root" },
      { id: "f", kind: "folder", title: "Folder", parent: "root" },
      { id: "db", kind: "unsupported", unsupportedKind: "database", title: "DB", parent: "f" },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"));
    expect(titles(result)).toEqual(["Root", "Folder"]);
    const unsupported = result.notes.filter((n) => n.code === "unsupported-child-type");
    expect(unsupported.length).toBe(2);
    // Dropping a child the user asked for is a WARNING, not an informational
    // aside: note level drives issue severity and therefore `--strict`'s exit
    // code, so `info` here would let a silent content loss pass CI. Contrast
    // `label-filtered`, which stays `info` because the user asked for it.
    expect(unsupported.every((n) => n.level === "warning")).toBe(true);
    const whiteboard = unsupported.find((note) =>
      note.message.includes("direct Whiteboard child")
    );
    expect(whiteboard).toBeDefined();
    expect(whiteboard?.message).not.toContain("wb");
    expect(whiteboard?.message).not.toContain("WB");
    expect(whiteboard?.message).toContain("not traversable");
    expect(whiteboard?.message).toContain("Embedded Whiteboard links");
  });
});

// ---------------------------------------------------------------------------
// Abort
// ---------------------------------------------------------------------------

describe("fetchExportTree — abort", () => {
  test("an already-aborted signal stops before any fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = inMemoryTreeSource([
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    ]);
    await expect(
      fetchExportTree(source, tree("root"), { signal: controller.signal })
    ).rejects.toThrow();
    expect(source.calls.getPage).toBe(0);
  });

  test("aborting mid-walk stops the traversal", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1 },
    ];
    const controller = new AbortController();
    const source = inMemoryTreeSource(fixture, {
      onCall: (kind) => {
        // Abort as soon as discovery starts.
        if (kind === "getChildren") controller.abort();
      },
    });
    await expect(
      fetchExportTree(source, tree("root"), { signal: controller.signal })
    ).rejects.toThrow();
  });

  test("aborting mid-pool lets started jobs settle without starting new ones", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1, latencyMs: 5 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, latencyMs: 40 },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, latencyMs: 40 },
      { id: "c", kind: "page", title: "C", parent: "root", position: 2, observedVersion: 1, latencyMs: 40 },
    ];
    const controller = new AbortController();
    const source = inMemoryTreeSource(fixture);
    const promise = fetchExportTree(source, tree("root"), {
      signal: controller.signal,
      concurrency: 1,
    });
    setTimeout(() => controller.abort(), 15);
    await expect(promise).rejects.toThrow();
    // Not all four pages were fetched — abort prevented later jobs from starting.
    expect(source.calls.getPage).toBeLessThan(4);
  });
});

// ---------------------------------------------------------------------------
// Completeness contract
// ---------------------------------------------------------------------------

describe("fetchExportTree — completeness", () => {
  const withBadPage = (knob: Partial<FixtureNode>): FixtureNode[] => [
    { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    { id: "bad", kind: "page", title: "Bad", parent: "root", position: 0, observedVersion: 1, ...knob },
  ];

  const cases: Array<{ name: string; knob: Partial<FixtureNode>; code: string }> = [
    { name: "page-unreadable (403 body)", knob: { bodyStatus: 403 }, code: "page-unreadable" },
    { name: "page-ambiguous-404 (404 body)", knob: { bodyStatus: 404 }, code: "page-ambiguous-404" },
    { name: "page-version-changed (version bump)", knob: { observedVersion: 1, bodyVersion: 2 }, code: "page-version-changed" },
  ];

  for (const c of cases) {
    test(`strict aborts on ${c.name}`, async () => {
      const source = inMemoryTreeSource(withBadPage(c.knob));
      const error = await fetchExportTree(source, tree("root")).catch((e) => e);
      expect(error).toBeInstanceOf(ExportCompletenessError);
      expect((error as ExportCompletenessError).code).toBe(c.code as any);
    });

    test(`partial downgrades ${c.name} to a note + placeholder`, async () => {
      const source = inMemoryTreeSource(withBadPage(c.knob));
      const result = await fetchExportTree(source, tree("root"), { completenessMode: "partial" });
      expect(result.complete).toBe(false);
      expect(result.notes.some((n) => n.code === c.code)).toBe(true);
      const bad = result.nodes.find((n) => nodeId(n) === "bad") as ExportPageNode;
      expect(bad.placeholder).toBe(true);
      expect(bad.blocks.length).toBeGreaterThan(0);
      // The rest of the tree still comes through.
      expect(result.nodes.find((n) => nodeId(n) === "root")).toBeDefined();
    });
  }

  test("strict aborts on subtree-unreadable during discovery, collecting the affected node", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1, childrenStatus: 403 },
    ];
    const error = await fetchExportTree(inMemoryTreeSource(fixture), tree("root")).catch((e) => e);
    expect(error).toBeInstanceOf(ExportCompletenessError);
    expect((error as ExportCompletenessError).code).toBe("subtree-unreadable");
    expect((error as ExportCompletenessError).affected[0]?.id).toBe("root");
  });

  test("partial downgrades subtree-unreadable and omits the subtree", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, childrenStatus: 403 },
      { id: "a1", kind: "page", title: "A1", parent: "a", position: 0, observedVersion: 1 },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"), {
      completenessMode: "partial",
    });
    expect(result.complete).toBe(false);
    expect(result.notes.some((n) => n.code === "subtree-unreadable")).toBe(true);
    // A stays (it was discovered), but A1 (behind the unreadable listing) is gone.
    expect(titles(result)).toEqual(["Root", "A"]);
  });
});

// ---------------------------------------------------------------------------
// Pool ordering & deterministic error
// ---------------------------------------------------------------------------

describe("fetchExportTree — pool ordering & drain", () => {
  test("inverted latency still yields pre-order nodes", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1, latencyMs: 40 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, latencyMs: 30 },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, latencyMs: 20 },
      { id: "c", kind: "page", title: "C", parent: "root", position: 2, observedVersion: 1, latencyMs: 5 },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"), {
      concurrency: 4,
    });
    // C resolves first, Root last, but output is pre-order regardless.
    expect(titles(result)).toEqual(["Root", "A", "B", "C"]);
  });

  test("primary error is the earliest pre-order slot, not whichever settled first", async () => {
    // Slot 0 (earliest) is a slow version-changed; slot 1 is a fast 403 that
    // settles first. The reported code must be the earliest slot's.
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, bodyVersion: 9, latencyMs: 40 },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, bodyStatus: 403, latencyMs: 5 },
    ];
    const error = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"), {
      concurrency: 4,
    }).catch((e) => e);
    expect(error).toBeInstanceOf(ExportCompletenessError);
    // Slot order: root(ok), A(version-changed), B(unreadable). Earliest failing
    // slot is A.
    expect((error as ExportCompletenessError).code).toBe("page-version-changed");
    expect((error as ExportCompletenessError).affected[0]?.id).toBe("a");
  });

  test("a slow first page backpressures a 500-page tree at the configured result window", async () => {
    const first = deferred();
    const fixture: FixtureNode[] = [
      {
        id: "root",
        kind: "page",
        title: "Page 0",
        parent: null,
        observedVersion: 1,
      },
      ...Array.from({ length: 499 }, (_, index): FixtureNode => ({
        id: `page-${index + 1}`,
        kind: "page",
        title: `Page ${index + 1}`,
        parent: "root",
        position: index,
        observedVersion: 1,
      })),
    ];
    const source = inMemoryTreeSource(fixture);
    const originalGetPage = source.getPage.bind(source);
    const startedIds: string[] = [];
    source.getPage = async (id, context) => {
      startedIds.push(id);
      if (id === "root") await first.promise;
      return originalGetPage(id, context);
    };

    const run = fetchExportTree(source, tree("root"), {
      concurrency: 4,
      maxResultSlots: 8,
    });
    await waitUntil(() => startedIds.length === 8);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(startedIds).toHaveLength(8);
    expect(startedIds.at(-1)).toBe("page-7");

    first.resolve();
    const result = await run;
    expect(result.nodes).toHaveLength(500);
    expect(source.calls.getPage).toBe(500);
    expect(titles(result).slice(0, 3)).toEqual(["Page 0", "Page 1", "Page 2"]);
    expect(titles(result).at(-1)).toBe("Page 499");
  });

  test("a durable body store reuses committed normalized slots without refetching them", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1 },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1 },
    ];
    const source = inMemoryTreeSource(fixture);
    const committed = new Map<number, ExportTreeBodyResultV1>([
      [0, {
        ok: true,
        pageId: "root",
        title: "Root",
        source: { representation: "storage", degraded: false },
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "Recovered root" }] }],
        notes: [],
        meta: { version: 1, labels: [], spaceKey: "TEST" },
      }],
      [1, {
        ok: true,
        pageId: "a",
        title: "A",
        source: { representation: "storage", degraded: false },
        blocks: [{ type: "paragraph", content: [{ type: "text", text: "Recovered A" }] }],
        notes: [],
        meta: { version: 1, labels: [], spaceKey: "TEST" },
      }],
    ]);
    const prepared: string[][] = [];
    const committedOrdinals: number[] = [];
    const bodyStore: ExportTreeBodyStoreV1 = {
      async prepare(entries) {
        prepared.push(entries.map((entry) => entry.key));
      },
      async load(entry) {
        return committed.get(entry.ordinal);
      },
      async commit(entry, result) {
        committedOrdinals.push(entry.ordinal);
        committed.set(entry.ordinal, result);
      },
    };

    const result = await fetchExportTree(source, tree("root"), { bodyStore });
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toHaveLength(3);
    expect(source.getPageIds).toEqual(["b"]);
    expect(committedOrdinals).toEqual([2]);
    expect(
      (result.nodes[0] as ExportPageNode).blocks[0],
    ).toMatchObject({ content: [{ text: "Recovered root" }] });
    expect(
      (result.nodes[1] as ExportPageNode).blocks[0],
    ).toMatchObject({ content: [{ text: "Recovered A" }] });
    expect(
      (result.nodes[2] as ExportPageNode).blocks[0],
    ).toMatchObject({ content: [{ text: "B" }] });
  });
});

// ---------------------------------------------------------------------------
// Space scope
// ---------------------------------------------------------------------------

describe("fetchExportTree — space scope", () => {
  test("resolves the homepage as the included root", async () => {
    const fixture: FixtureNode[] = [
      { id: "home", kind: "page", title: "Home", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "home", position: 0, observedVersion: 1 },
    ];
    const source = inMemoryTreeSource(fixture, { spaceHomepage: { DOCSY: "home" } });
    const result = await fetchExportTree(source, { kind: "space", spaceKey: "DOCSY" });
    expect(titles(result)).toEqual(["Home", "A"]);
  });

  test("errors with guidance when a space has no homepage", async () => {
    const source = inMemoryTreeSource([], { spaceHomepage: { EMPTY: null } });
    await expect(
      fetchExportTree(source, { kind: "space", spaceKey: "EMPTY" })
    ).rejects.toBeInstanceOf(SpaceHomepageError);
  });
});

// ---------------------------------------------------------------------------
// Label filter
// ---------------------------------------------------------------------------

describe("fetchExportTree — label filter", () => {
  const labelled: FixtureNode[] = [
    { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, labels: ["public"] },
    { id: "a1", kind: "page", title: "A1", parent: "a", position: 0, observedVersion: 1, labels: ["public"] },
    { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, labels: ["internal"] },
    { id: "b1", kind: "page", title: "B1", parent: "b", position: 0, observedVersion: 1, labels: ["public"] },
    { id: "c", kind: "page", title: "C", parent: "root", position: 2, observedVersion: 1, labels: ["public"] },
  ];

  test("exclude prune-subtree removes descendants and never fetches their bodies", async () => {
    const source = inMemoryTreeSource(labelled);
    const result = await fetchExportTree(source, tree("root"), {
      labels: { exclude: ["internal"] },
    });
    // B and its child B1 are gone.
    expect(titles(result)).toEqual(["Root", "A", "A1", "C"]);
    expect(result.notes.some((n) => n.code === "label-filtered")).toBe(true);
    // Behavioral proof: B and B1 bodies were never fetched.
    expect(source.getPageIds).not.toContain("b");
    expect(source.getPageIds).not.toContain("b1");
  });

  test("exclude page-only keeps children (reparented)", async () => {
    const source = inMemoryTreeSource(labelled);
    const result = await fetchExportTree(source, tree("root"), {
      labels: { exclude: ["internal"], excludeMode: "page-only" },
    });
    // B removed, B1 kept and reparented under Root.
    expect(titles(result)).toEqual(["Root", "A", "A1", "B1", "C"]);
    const b1 = result.nodes.find((n) => nodeId(n) === "b1")!;
    expect(b1.parentId).toBe("root");
    expect(b1.effectiveDepth).toBe(1);
  });

  test("include OR semantics keep any page carrying an include label", async () => {
    const source = inMemoryTreeSource(labelled);
    const result = await fetchExportTree(source, tree("root"), {
      labels: { include: ["public"] },
    });
    // B (internal only) removed; B1 (public) reparented; root kept as structure.
    expect(titles(result)).toEqual(["Root", "A", "A1", "B1", "C"]);
    expect(result.notes.some((n) => n.code === "root-filter-bypassed")).toBe(true);
  });

  test("include + exclude combine (exclude wins the subtree)", async () => {
    const source = inMemoryTreeSource(labelled);
    const result = await fetchExportTree(source, tree("root"), {
      labels: { include: ["public"], exclude: ["internal"] },
    });
    // internal subtree (B, B1) pruned; public pages kept.
    expect(titles(result)).toEqual(["Root", "A", "A1", "C"]);
  });

  test("an include filter matching nothing is a hard error", async () => {
    const source = inMemoryTreeSource(labelled);
    await expect(
      fetchExportTree(source, tree("root"), { labels: { include: ["nonexistent"] } })
    ).rejects.toBeInstanceOf(LabelFilterError);
  });

  test("id chunking at >100 nodes exercises multiple searchPages queries", async () => {
    const many: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    ];
    for (let i = 0; i < 150; i += 1) {
      many.push({
        id: `p${i}`,
        kind: "page",
        title: `P${i}`,
        parent: "root",
        position: i,
        observedVersion: 1,
        labels: i === 130 ? ["internal"] : ["public"],
      });
    }
    const source = inMemoryTreeSource(many);
    const result = await fetchExportTree(source, tree("root"), {
      labels: { exclude: ["internal"] },
    });
    // 151 ids → 2 chunks of 100 → 2 searchPages calls for the single exclude list.
    expect(source.calls.searchPages).toBe(2);
    // The one internal page (in the 2nd chunk) was filtered out.
    expect(result.nodes.find((n) => nodeId(n) === "p130")).toBeUndefined();
  });

  test("includeRoot:false + exclude on the first top-level child: NO bypass immunity (prune-subtree)", async () => {
    // Regression (review CRITICAL): with the true root removed by explicit
    // request, the first-sorted sibling must NOT inherit the root's filter
    // immunity — an explicit exclude must remove it and its subtree, and its
    // body must never be fetched.
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, labels: ["internal"] },
      { id: "a1", kind: "page", title: "A1", parent: "a", position: 0, observedVersion: 1, labels: ["public"] },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, labels: ["public"] },
    ];
    const source = inMemoryTreeSource(fixture);
    const result = await fetchExportTree(source, tree("root", { includeRoot: false }), {
      labels: { exclude: ["internal"] },
    });
    // A (first-positioned, internal) and its subtree are gone; only B remains.
    expect(titles(result)).toEqual(["B"]);
    expect(result.notes.some((n) => n.code === "root-filter-bypassed")).toBe(false);
    expect(result.notes.some((n) => n.code === "label-filtered")).toBe(true);
    // Privacy proof: neither A nor its child ever had a body fetched.
    expect(source.getPageIds).not.toContain("a");
    expect(source.getPageIds).not.toContain("a1");
  });

  test("includeRoot:false + exclude on the first top-level child: NO bypass immunity (page-only)", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, labels: ["internal"] },
      { id: "a1", kind: "page", title: "A1", parent: "a", position: 0, observedVersion: 1, labels: ["public"] },
      { id: "b", kind: "page", title: "B", parent: "root", position: 1, observedVersion: 1, labels: ["public"] },
    ];
    const source = inMemoryTreeSource(fixture);
    const result = await fetchExportTree(source, tree("root", { includeRoot: false }), {
      labels: { exclude: ["internal"], excludeMode: "page-only" },
    });
    // A removed (no immunity), its child A1 kept and reparented to top level.
    expect(titles(result)).toEqual(["A1", "B"]);
    expect(result.notes.some((n) => n.code === "root-filter-bypassed")).toBe(false);
    const a1 = result.nodes.find((n) => nodeId(n) === "a1")!;
    expect(a1.parentId).toBeNull();
    expect(a1.effectiveDepth).toBe(0);
    // A's own body was never fetched.
    expect(source.getPageIds).not.toContain("a");
  });

  test("root excluded by label is kept as structure (root-filter-bypassed), not an error", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1, labels: ["internal"] },
      { id: "a", kind: "page", title: "A", parent: "root", position: 0, observedVersion: 1, labels: ["public"] },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"), {
      labels: { exclude: ["internal"] },
    });
    expect(titles(result)).toEqual(["Root", "A"]);
    expect(result.notes.some((n) => n.code === "root-filter-bypassed")).toBe(true);
  });

  test("fallback without searchPages: labels honored via getPage, at the documented cost of loading bodies", async () => {
    // Review MINOR 2(a): the getPage-based fallback trades the "filtered pages
    // are never loaded" invariant for working without a search port — the
    // filter decision is still correct, but bodies ARE fetched during label
    // resolution (including the eventually-excluded page's).
    const source = inMemoryTreeSource(labelled);
    (source as { searchPages?: unknown }).searchPages = undefined;
    const result = await fetchExportTree(source, tree("root"), {
      labels: { exclude: ["internal"] },
    });
    // Filter semantics identical to the searchPages path: B + subtree pruned.
    expect(titles(result)).toEqual(["Root", "A", "A1", "C"]);
    expect(result.notes.some((n) => n.code === "label-filtered")).toBe(true);
    expect(source.calls.searchPages).toBe(0);
    // Documented tradeoff: the excluded page's body WAS loaded on this path.
    expect(source.getPageIds).toContain("b");
  });

  test("fails closed when filtering is requested but neither searchPages nor getPage exist", async () => {
    // Review MINOR 2(b): never silently skip a requested filter.
    const source = inMemoryTreeSource(labelled);
    (source as { searchPages?: unknown }).searchPages = undefined;
    (source as { getPage?: unknown }).getPage = undefined;
    const error = await fetchExportTree(source, tree("root"), {
      labels: { exclude: ["internal"] },
    }).catch((e) => e);
    expect(error).toBeInstanceOf(LabelFilterError);
    expect((error as LabelFilterError).code).toBe("labels-unavailable");
  });

  test("intermediate folder removed by a non-matching include reparents its page children", async () => {
    const fixture: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1, labels: ["public"] },
      { id: "f", kind: "folder", title: "Folder", parent: "root" },
      { id: "p", kind: "page", title: "In Folder", parent: "f", observedVersion: 1, labels: ["public"] },
    ];
    const result = await fetchExportTree(inMemoryTreeSource(fixture), tree("root"), {
      labels: { include: ["public"] },
    });
    // Folder (no labels) doesn't match include → removed; its page reparents.
    expect(titles(result)).toEqual(["Root", "In Folder"]);
    const p = result.nodes.find((n) => nodeId(n) === "p")!;
    expect(p.parentId).toBe("root");
    expect(p.effectiveDepth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// applyLabelFilter — pure unit tests (reparenting matrix)
// ---------------------------------------------------------------------------

describe("applyLabelFilter — pure", () => {
  const mkPage = (
    id: string,
    depth: number,
    parentId: string | null
  ): ExportPageNode => ({
    kind: "page",
    pageId: id,
    title: id.toUpperCase(),
    depth,
    effectiveDepth: depth,
    parentId,
    position: 0,
    blocks: [],
    notes: [],
    meta: { labels: [] },
  });

  test("reparents survivors to the nearest surviving ancestor with effectiveDepth", () => {
    // root -> mid -> leaf ; remove mid (page-only) → leaf reparents to root.
    const nodes: ExportNode[] = [
      mkPage("root", 0, null),
      mkPage("mid", 1, "root"),
      mkPage("leaf", 2, "mid"),
    ];
    const labels = new Map<string, string[]>([
      ["root", ["keep"]],
      ["mid", []],
      ["leaf", ["keep"]],
    ]);
    const { nodes: out } = applyLabelFilter(nodes, labels, {
      include: ["keep"],
    });
    const leaf = out.find((n) => nodeId(n) === "leaf")!;
    expect(out.map(nodeId)).toEqual(["root", "leaf"]);
    expect(leaf.parentId).toBe("root");
    expect(leaf.effectiveDepth).toBe(1);
  });

  test("multiple survivors at effectiveDepth 0 each become top-level", () => {
    const nodes: ExportNode[] = [mkPage("a", 0, null), mkPage("b", 0, null)];
    const labels = new Map<string, string[]>();
    const { nodes: out } = applyLabelFilter(nodes, labels, {});
    // No filter → unchanged, both depth 0.
    expect(out.every((n) => n.effectiveDepth === 0)).toBe(true);
  });

  test("root that matches exclude is bypassed, not removed", () => {
    const nodes: ExportNode[] = [mkPage("root", 0, null), mkPage("a", 1, "root")];
    const labels = new Map<string, string[]>([
      ["root", ["internal"]],
      ["a", ["public"]],
    ]);
    const { nodes: out, notes } = applyLabelFilter(nodes, labels, { exclude: ["internal"] });
    expect(out.map(nodeId)).toEqual(["root", "a"]);
    expect(notes.some((n) => n.code === "root-filter-bypassed")).toBe(true);
  });

  test("rootId: null disables the bypass — no node is immune", () => {
    // Two top-level siblings after the caller removed the true root
    // (includeRoot: false). The first-sorted sibling must be excludable.
    const nodes: ExportNode[] = [mkPage("a", 0, null), mkPage("b", 0, null)];
    const labels = new Map<string, string[]>([
      ["a", ["internal"]],
      ["b", ["public"]],
    ]);
    const { nodes: out, notes } = applyLabelFilter(
      nodes,
      labels,
      { exclude: ["internal"] },
      { rootId: null }
    );
    expect(out.map(nodeId)).toEqual(["b"]);
    expect(notes.some((n) => n.code === "root-filter-bypassed")).toBe(false);
    expect(notes.some((n) => n.code === "label-filtered")).toBe(true);
  });

  test("an explicit rootId string protects exactly that node", () => {
    const nodes: ExportNode[] = [mkPage("a", 0, null), mkPage("b", 0, null)];
    const labels = new Map<string, string[]>([
      ["a", ["internal"]],
      ["b", ["internal"]],
    ]);
    const { nodes: out, notes } = applyLabelFilter(
      nodes,
      labels,
      { exclude: ["internal"] },
      { rootId: "b" }
    );
    expect(out.map(nodeId)).toEqual(["b"]);
    expect(notes.filter((n) => n.code === "root-filter-bypassed").length).toBe(1);
  });

  // PLAN reparenting matrix: reparented effectiveDepth must drive chapter levels
  // THROUGH composeChapters (not just be present on the raw fetch result) — proof
  // that a filtered-out intermediate page never leaves an orphaned deep chapter.
  test("reparented effectiveDepth drives chapter levels through composeChapters", () => {
    // root(0) -> mid(1) -> leaf(2); remove mid page-only → leaf reparents to
    // effectiveDepth 1. Its chapter heading must land at level 2, not level 3.
    const nodes: ExportNode[] = [
      { ...mkPage("root", 0, null), title: "Root", blocks: [] },
      { ...mkPage("mid", 1, "root"), title: "Mid", blocks: [] },
      {
        ...mkPage("leaf", 2, "mid"),
        title: "Leaf",
        blocks: [
          { type: "heading", level: 2, content: [{ type: "text", text: "Body" }] },
        ] as ExportBlock[],
      },
    ];
    const labels = new Map<string, string[]>([
      ["root", []],
      ["mid", ["internal"]],
      ["leaf", []],
    ]);
    const { nodes: filtered } = applyLabelFilter(nodes, labels, {
      exclude: ["internal"],
      excludeMode: "page-only",
    });
    const leaf = filtered.find((n) => nodeId(n) === "leaf")!;
    expect(leaf.effectiveDepth).toBe(1);

    const { blocks } = composeChapters(filtered, { chapterBreak: "none" });
    // Chapter headings: Root at level 1 (eff 0), Leaf at level 2 (eff 1 → clamp+1).
    const chapters = blocks.filter(
      (b): b is Extract<ExportBlock, { type: "heading" }> =>
        b.type === "heading" && b.explicitAnchor !== undefined
    );
    const rootChapter = chapters.find((h) => h.explicitAnchor === "page-root")!;
    const leafChapter = chapters.find((h) => h.explicitAnchor === "page-leaf")!;
    expect(rootChapter.level).toBe(1);
    expect(leafChapter.level).toBe(2);
    // The leaf's own body H2 shifts to sit directly below its level-2 chapter (→ 3),
    // never orphaned at a level with no surviving ancestor chapter.
    const bodyHeading = blocks.find(
      (b) => b.type === "heading" && b.explicitAnchor === "pleaf-body"
    ) as Extract<ExportBlock, { type: "heading" }>;
    expect(bodyHeading.level).toBe(3);
  });
});


// ---------------------------------------------------------------------------
// spec 011 round 3 — an unparseable page must not kill the run
// ---------------------------------------------------------------------------

describe("fetchExportTree — storage parse budget degradation", () => {
  /** Storage that blows the depth limit — the cheapest way to trip the budget. */
  const OVERSIZED = "<div>".repeat(1000) + "deep" + "</div>".repeat(1000);

  const withOversizedPage = (): FixtureNode[] => [
    { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    { id: "big", kind: "page", title: "Big", parent: "root", position: 0, observedVersion: 1, storage: OVERSIZED },
    { id: "ok", kind: "page", title: "Ok", parent: "root", position: 1, observedVersion: 1 },
  ];

  test("partial mode: one unparseable page degrades, its NEIGHBOURS still export", async () => {
    // The regression this guards: `storageToBlocks` threw straight out of the
    // body-fetch job, the rejection scan re-threw it, and the whole tree export
    // died on one page. The budget's own docs promised the opposite.
    const source = inMemoryTreeSource(withOversizedPage());
    const result = await fetchExportTree(source, tree("root"), { completenessMode: "partial" });

    expect(result.complete).toBe(false);
    const note = result.notes.find((n) => n.code === "page-unreadable");
    expect(note).toBeDefined();
    // The note must say WHY — "page-unreadable" alone hides "too big to parse".
    expect(note!.message).toContain("parse budget");
    expect(note!.message).toContain("too-deep");

    const big = result.nodes.find((n) => nodeId(n) === "big") as ExportPageNode;
    expect(big.placeholder).toBe(true);
    expect(big.blocks.length).toBeGreaterThan(0);

    // The whole point: everything else came through.
    expect(titles(result)).toEqual(["Root", "Big", "Ok"]);
    const ok = result.nodes.find((n) => nodeId(n) === "ok") as ExportPageNode;
    expect(ok.placeholder).toBeUndefined();
  });

  test("strict mode: aborts with a typed completeness error, not a raw parse error", async () => {
    const source = inMemoryTreeSource(withOversizedPage());
    const error = await fetchExportTree(source, tree("root")).catch((e) => e);
    expect(error).toBeInstanceOf(ExportCompletenessError);
    expect((error as ExportCompletenessError).code).toBe("page-unreadable");
    expect((error as ExportCompletenessError).affected[0]?.id).toBe("big");
  });

  test("a non-budget error still propagates untouched", async () => {
    // The catch must be narrow: only StorageParseError is a completeness
    // failure. Anything else is a real bug and must not be swallowed.
    const source = inMemoryTreeSource(withOversizedPage());
    const boom = new Error("unrelated failure");
    const original = source.getPage.bind(source);
    source.getPage = async (id, ctx) => {
      if (id === "ok") throw boom;
      return original(id, ctx);
    };
    const error = await fetchExportTree(source, tree("root"), {
      completenessMode: "partial",
    }).catch((e) => e);
    expect(error).toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// ADF-primary representation-neutral body orchestration
// ---------------------------------------------------------------------------

function adfSource(
  text: string,
  version = 1,
  content?: unknown[],
): ExportPageSource {
  return {
    primary: {
      representation: "atlas_doc_format",
      value: JSON.stringify({
        type: "doc",
        version: 1,
        content: content ?? [{ type: "paragraph", content: [{ type: "text", text }] }],
      }),
    },
    storageSidecar: `<p>${text}</p>`,
    sourceVersion: version,
  };
}

describe("fetchExportTree — representation-neutral sources", () => {
  const fixture: FixtureNode[] = [
    { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
    { id: "a", kind: "page", title: "ADF", parent: "root", position: 0, observedVersion: 1 },
    { id: "s", kind: "page", title: "Storage", parent: "root", position: 1, observedVersion: 1 },
  ];

  test("accepts ADF-only, Storage-only, and mixed pages with aggregate body-free counts", async () => {
    const source = inMemoryTreeSource(fixture);
    const original = source.getPage.bind(source);
    source.getPage = async (id, context) => {
      const page = await original(id, context);
      if (id === "s") return page;
      return {
        id: page.id,
        title: page.title,
        version: page.version,
        labels: page.labels,
        spaceKey: page.spaceKey,
        exportSource: adfSource(page.title, page.version),
      };
    };

    const result = await fetchExportTree(source, tree("root"));
    expect(titles(result)).toEqual(["Root", "ADF", "Storage"]);
    expect(result.sourceSummary).toEqual({
      pagesRead: 3,
      representations: { atlas_doc_format: 2, storage: 1 },
      degradedPages: 0,
    });
    expect((result.nodes[1] as ExportPageNode).blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "ADF" }] },
    ]);
    expect(JSON.stringify(result.sourceSummary)).not.toContain("<p>");
  });

  test("keeps ADF unknown-extension notes and visible content bound to page provenance", async () => {
    const source = inMemoryTreeSource(fixture.slice(0, 1));
    source.getPage = async () => ({
      id: "root",
      title: "Root",
      version: 1,
      labels: [],
      spaceKey: "S",
      exportSource: adfSource("ignored", 1, [
        {
          type: "extension",
          attrs: { extensionKey: "example", extensionType: "com.example", localId: "local-1" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Visible" }] }],
        },
        {
          type: "mediaSingle",
          content: [{
            type: "media",
            attrs: { type: "file", id: "media-1", collection: "content-1", alt: "Image" },
          }],
        },
        {
          type: "paragraph",
          content: [{
            type: "text",
            text: "Page",
            marks: [{ type: "link", attrs: { href: "/wiki/spaces/S/pages/42/Linked+Page" } }],
          }],
        },
      ]),
      mediaAttachments: [{ fileId: "media-1", filename: "image.png", pageId: "root" }],
      mediaAttachmentsComplete: true,
    });

    const result = await fetchExportTree(source, tree("root"));
    const node = result.nodes[0] as ExportPageNode;
    expect(node.blocks[0]?.type).toBe("unknown");
    expect(node.blocks[0]).toMatchObject({
      adfExtension: {
        extensionType: "com.example",
        extensionKey: "example",
        localId: "local-1",
      },
      sourcePage: { id: "root", version: 1, spaceKey: "S" },
    });
    expect(node.blocks[1]).toMatchObject({
      type: "image",
      source: { kind: "attachment", filename: "image.png", pageId: "root" },
    });
    expect(node.blocks[2]).toMatchObject({
      type: "paragraph",
      content: [{ type: "link", target: { kind: "page", contentId: "42" } }],
    });
    expect(node.notes.length).toBeGreaterThan(0);
    expect(node.notes.every((note) => note.source?.pageId === "root")).toBe(true);
    expect(node.notes.every((note) => note.source?.pageTitle === "Root")).toBe(true);
    // The extension note is provisional and owned by the later macro resolver;
    // sourceSummary counts lossy decoding, not an unresolved pass that has not
    // run yet.
    expect(result.sourceSummary.degradedPages).toBe(0);
  });

  test("does not mark an embedded Whiteboard page source-degraded before macro resolution", async () => {
    const source = inMemoryTreeSource(fixture.slice(0, 1));
    source.getPage = async () => ({
      id: "root",
      title: "Root",
      version: 1,
      labels: [],
      spaceKey: "SYNTHETIC",
      exportSource: adfSource("ignored", 1, [{
        type: "extension",
        attrs: {
          extensionType: "com.atlassian.confluence.macro.core",
          extensionKey: "native-embed:whiteboard",
          parameters: {
            macroParams: {
              url: { value: "/wiki/spaces/SYNTHETIC/whiteboard/41" },
            },
          },
        },
      }]),
    });

    const result = await fetchExportTree(source, tree("root"));
    const node = result.nodes[0] as ExportPageNode;
    expect(node.blocks).toEqual([expect.objectContaining({
      type: "unknown",
      macroName: "native-embed:whiteboard",
    })]);
    expect(node.notes.map((note) => note.code)).toEqual(["macro-not-rendered"]);
    expect(result.sourceSummary.degradedPages).toBe(0);
  });

  for (const mode of ["strict", "partial"] as const) {
    test(`${mode} routes malformed ADF through the established completeness policy`, async () => {
      const source = inMemoryTreeSource(fixture.slice(0, 1));
      source.getPage = async () => ({
        id: "root",
        title: "Root",
        version: 1,
        exportSource: {
          primary: { representation: "atlas_doc_format", value: "not-json" },
          sourceVersion: 1,
        },
      });
      const outcome = await fetchExportTree(source, tree("root"), {
        completenessMode: mode,
      }).catch((error) => error);
      if (mode === "strict") {
        expect(outcome).toBeInstanceOf(ExportCompletenessError);
        expect(outcome.code).toBe("page-unreadable");
      } else {
        expect(outcome.complete).toBe(false);
        expect(outcome.notes[0]?.message).toContain("ADF validation failed: invalid-json");
        expect(outcome.sourceSummary.representations.atlas_doc_format).toBe(1);
      }
    });
  }

  test("applies the ADF parse budget independently", async () => {
    const source = inMemoryTreeSource(fixture.slice(0, 1));
    source.getPage = async () => ({
      id: "root",
      title: "Root",
      version: 1,
      exportSource: adfSource("too many nodes"),
    });
    const result = await fetchExportTree(source, tree("root"), {
      completenessMode: "partial",
      bodyOptions: { adfParseBudget: { maxNodes: 1 } },
    });
    expect(result.complete).toBe(false);
    expect(result.notes[0]?.message).toContain("node-budget-exceeded");
  });

  test("uses the representation source version for the discovery race", async () => {
    const source = inMemoryTreeSource(fixture.slice(0, 1));
    source.getPage = async () => ({
      id: "root",
      title: "Root",
      version: 1,
      exportSource: adfSource("newer", 2),
    });
    const error = await fetchExportTree(source, tree("root")).catch((value) => value);
    expect(error).toBeInstanceOf(ExportCompletenessError);
    expect(error.code).toBe("page-version-changed");
  });

  test("bounds representation reads and preserves preorder despite inverted latency", async () => {
    const many: FixtureNode[] = [
      { id: "root", kind: "page", title: "Root", parent: null, observedVersion: 1 },
      ...Array.from({ length: 7 }, (_, index): FixtureNode => ({
        id: `p${index}`,
        kind: "page",
        title: `P${index}`,
        parent: "root",
        position: index,
        observedVersion: 1,
      })),
    ];
    const source = inMemoryTreeSource(many);
    const original = source.getPage.bind(source);
    let active = 0;
    let peak = 0;
    source.getPage = async (id, context) => {
      active += 1;
      peak = Math.max(peak, active);
      try {
        await abortableSleep(id === "root" ? 20 : 8 - Number(id.slice(1)), context.signal);
        const page = await original(id, context);
        return {
          id: page.id,
          title: page.title,
          version: page.version,
          exportSource: adfSource(page.title, page.version),
        };
      } finally {
        active -= 1;
      }
    };

    const result = await fetchExportTree(source, tree("root"), { concurrency: 2 });
    expect(peak).toBeLessThanOrEqual(2);
    expect(titles(result)).toEqual(["Root", "P0", "P1", "P2", "P3", "P4", "P5", "P6"]);
  });

  test("progress contains metadata only and abort reaches an ADF/sidecar source read", async () => {
    const source = inMemoryTreeSource(fixture.slice(0, 1));
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    source.getPage = async (_id, context) => {
      observedSignal = context.signal;
      await abortableSleep(100, context.signal);
      throw new Error("unreachable");
    };
    const progress: TreeFetchProgress[] = [];
    const pending = fetchExportTree(source, tree("root"), {
      signal: controller.signal,
      onProgress: (event) => progress.push(event),
    });
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toThrow();
    expect(observedSignal?.aborted).toBe(true);
    expect(progress).toEqual([]);
  });

  test("the Node adapter prefers media-aware export reads and retains older source clients", async () => {
    const calls: string[] = [];
    const baseClient = {
      async getPageDetails(id: string) {
        calls.push(`storage:${id}`);
        return { id, title: "Title", storage: "<p>Storage</p>", version: 1 };
      },
      async getPageVersion() { return { title: "Title", version: 1 }; },
      async getChildrenWithPosition() { return []; },
      async getPageDirectChildren() { return []; },
      async getFolderChildren() { return []; },
      async getSpaceHomepageId() { return null; },
      async searchPages() { return []; },
    };
    const legacy = await confluenceTreeSource(baseClient).getPage("1", {});
    expect(legacy.storage).toBe("<p>Storage</p>");

    const modern = confluenceTreeSource({
      ...baseClient,
      async getExportPageDetails(id: string) {
        calls.push(`export:${id}`);
        return {
          id,
          title: "Title",
          storage: "<p>Sidecar</p>",
          version: 1,
          exportSource: adfSource("ADF"),
        };
      },
    });
    const page = await modern.getPage("2", {});
    expect(page.exportSource?.primary.representation).toBe("atlas_doc_format");

    const mediaAware = confluenceTreeSource({
      ...baseClient,
      async getExportPageDetails() {
        throw new Error("less capable read must not win");
      },
      async getExportPageDetailsWithMedia(id: string) {
        calls.push(`media:${id}`);
        return {
          id,
          title: "Title",
          storage: "<p>Sidecar</p>",
          version: 1,
          exportSource: adfSource("ADF"),
          mediaAttachments: [{ fileId: "file-1", filename: "image.png", pageId: id }],
          mediaAttachmentsComplete: true,
        };
      },
    });
    const mediaPage = await mediaAware.getPage("3", {});
    expect(mediaPage.mediaAttachments).toEqual([
      { fileId: "file-1", filename: "image.png", pageId: "3" },
    ]);
    expect(calls).toEqual(["storage:1", "export:2", "media:3"]);
  });

  test.each([
    ["tree", { kind: "tree", rootPageId: "root" } as const],
    ["space", { kind: "space", spaceKey: "DOCS" } as const],
  ])("Data Center %s traversal uses only the v1 page hierarchy", async (_name, scope) => {
    const calls: string[] = [];
    const pages = new Map([
      ["root", { title: "Root", version: 2 }],
      ["child", { title: "Child", version: 3 }],
    ]);
    const source = confluenceTreeSource({
      deploymentType: "data-center",
      async getPageDetails(id: string) {
        const page = pages.get(id)!;
        return {
          id,
          title: page.title,
          version: page.version,
          storage: `<p>${page.title}</p>`,
          labels: [],
          spaceKey: "DOCS",
        };
      },
      async getPageVersion(id: string) {
        calls.push(`version:${id}`);
        return pages.get(id)!;
      },
      async getChildrenWithPosition(id: string) {
        calls.push(`v1-children:${id}`);
        return id === "root"
          ? [{ id: "child", title: "Child", version: 3, position: 7 }]
          : [];
      },
      async getPageDirectChildren() {
        calls.push("cloud-direct-children");
        throw new Error("Cloud REST v2 must not be called for Data Center");
      },
      async getFolderChildren() {
        calls.push("cloud-folder-children");
        throw new Error("Cloud REST v2 must not be called for Data Center");
      },
      async getSpaceHomepageId(key: string) {
        calls.push(`homepage:${key}`);
        return "root";
      },
      async searchPages() { return []; },
    });

    const result = await fetchExportTree(source, scope);

    expect(result.nodes.map((node) => node.kind === "page" ? node.pageId : node.folderId))
      .toEqual(["root", "child"]);
    expect(calls).not.toContain("cloud-direct-children");
    expect(calls).not.toContain("cloud-folder-children");
    expect(calls.filter((call) => call.startsWith("v1-children:")))
      .toEqual(["v1-children:root", "v1-children:child"]);
    if (scope.kind === "space") expect(calls).toContain("homepage:DOCS");
  });

  test("Cloud traversal preserves mixed direct-child kinds and page positions", async () => {
    const calls: string[] = [];
    const source = confluenceTreeSource({
      deploymentType: "cloud",
      async getPageDetails(id: string) {
        return { id, title: id, storage: `<p>${id}</p>`, version: 1 };
      },
      async getPageVersion() { return { title: "Title", version: 1 }; },
      async getChildrenWithPosition(id: string) {
        calls.push(`positions:${id}`);
        return [{ id: "page", title: "Page", version: 4, position: 2 }];
      },
      async getPageDirectChildren(id: string) {
        calls.push(`direct:${id}`);
        return [
          { id: "page", title: "Page", type: "page" },
          { id: "folder", title: "Folder", type: "folder" },
          { id: "board", title: "Board", type: "whiteboard" },
        ];
      },
      async getFolderChildren(id: string) {
        calls.push(`folder:${id}`);
        return [];
      },
      async getSpaceHomepageId() { return null; },
      async searchPages() { return []; },
    });

    await expect(source.getChildren({ id: "root", kind: "page" }, {})).resolves.toEqual([
      { id: "page", title: "Page", kind: "page", position: 2, observedVersion: 4 },
      { id: "folder", title: "Folder", kind: "folder", position: null },
      {
        id: "board",
        title: "Board",
        kind: "unsupported",
        unsupportedKind: "whiteboard",
        position: null,
      },
    ]);
    expect(calls).toEqual(["direct:root", "positions:root"]);
  });

  test("Cloud traversal falls back to depth-1 descendants for a large page id", async () => {
    const calls: string[] = [];
    const diagnostics: unknown[] = [];
    const directFailure = Object.assign(new Error("private response body"), {
      status: 404,
      requestId: "request-direct",
    });
    const source = confluenceTreeSource({
      deploymentType: "cloud",
      async getPageDetails(id: string) {
        return { id, title: id, storage: `<p>${id}</p>`, version: 1 };
      },
      async getPageVersion() { return { title: "Title", version: 1 }; },
      async getChildrenWithPosition(id: string) {
        calls.push(`positions:${id}`);
        return [{ id: "page", title: "Page", version: 4, position: 2 }];
      },
      async getPageDirectChildren(id: string) {
        calls.push(`direct:${id}`);
        throw directFailure;
      },
      async getPageDescendants(id: string, options) {
        calls.push(`descendants:${id}:depth=${options?.depth}`);
        return [
          { id: "page", title: "Page", type: "page", position: 8 },
          { id: "folder", title: "Folder", type: "folder", position: 3 },
        ];
      },
      async getFolderChildren() { return []; },
      async getSpaceHomepageId() { return null; },
      async searchPages() { return []; },
    });

    await expect(source.getChildren(
      { id: "2819653636", kind: "page" },
      { onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); } },
    )).resolves.toEqual([
      { id: "page", title: "Page", kind: "page", position: 2, observedVersion: 4 },
      { id: "folder", title: "Folder", kind: "folder", position: 3 },
    ]);
    expect(calls).toEqual([
      "direct:2819653636",
      "descendants:2819653636:depth=1",
      "positions:2819653636",
    ]);
    expect(diagnostics).toEqual([{
      code: "hierarchy-fallback",
      deployment: "cloud",
      operation: "page-direct-children",
      status: 404,
      requestId: "request-direct",
      fallback: "page-descendants",
    }]);
    expect(JSON.stringify(diagnostics)).not.toContain("private response body");
  });

  test.each([401, 403, 429, 500])(
    "Cloud traversal does not hide a %d direct-children failure behind fallback",
    async (status) => {
      const calls: string[] = [];
      const diagnostics: unknown[] = [];
      const failure = Object.assign(new Error("private response body"), {
        status,
        requestId: `request-${status}`,
      });
      const source = confluenceTreeSource({
        deploymentType: "cloud",
        async getPageDetails(id: string) {
          return { id, title: id, storage: "", version: 1 };
        },
        async getPageVersion() { return { title: "Title", version: 1 }; },
        async getChildrenWithPosition() { return []; },
        async getPageDirectChildren() { throw failure; },
        async getPageDescendants() {
          calls.push("descendants");
          return [];
        },
        async getFolderChildren() { return []; },
        async getSpaceHomepageId() { return null; },
        async searchPages() { return []; },
      });

      await expect(source.getChildren(
        { id: "root", kind: "page" },
        { onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); } },
      )).rejects.toBe(failure);
      expect(calls).toEqual([]);
      expect(diagnostics).toEqual([{
        code: "hierarchy-request-failed",
        deployment: "cloud",
        operation: "page-direct-children",
        status,
        requestId: `request-${status}`,
      }]);
      expect(JSON.stringify(diagnostics)).not.toContain("private response body");
    },
  );

  test("Cloud traversal reports a failed descendants fallback without retaining response data", async () => {
    const diagnostics: unknown[] = [];
    const fallbackFailure = Object.assign(new Error("private descendants response"), {
      status: 404,
      requestId: "request-descendants",
    });
    const source = confluenceTreeSource({
      deploymentType: "cloud",
      async getPageDetails(id: string) {
        return { id, title: id, storage: "", version: 1 };
      },
      async getPageVersion() { return { title: "Title", version: 1 }; },
      async getChildrenWithPosition() { return []; },
      async getPageDirectChildren() {
        throw Object.assign(new Error("private direct response"), {
          status: 404,
          requestId: "request-direct",
        });
      },
      async getPageDescendants() { throw fallbackFailure; },
      async getFolderChildren() { return []; },
      async getSpaceHomepageId() { return null; },
      async searchPages() { return []; },
    });

    await expect(source.getChildren(
      { id: "root", kind: "page" },
      { onDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); } },
    )).rejects.toBe(fallbackFailure);
    expect(diagnostics).toEqual([
      {
        code: "hierarchy-fallback",
        deployment: "cloud",
        operation: "page-direct-children",
        status: 404,
        requestId: "request-direct",
        fallback: "page-descendants",
      },
      {
        code: "hierarchy-request-failed",
        deployment: "cloud",
        operation: "page-descendants",
        status: 404,
        requestId: "request-descendants",
      },
    ]);
    expect(JSON.stringify(diagnostics)).not.toContain("private");
  });
});
