import { describe, expect, it } from "bun:test";
import type { ExportPageSource } from "./page-body.js";
import {
  ExportCompletenessError,
  ExportTreePlanError,
  fetchExportTree,
  type ExportTreePlanV1,
  type TreeSource,
} from "./tree-fetch.js";

const bodies: Record<string, ExportPageSource> = {
  root: {
    primary: {
      representation: "atlas_doc_format",
      value: JSON.stringify({
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Root body" }] }],
      }),
    },
    storageSidecar: "<p>raw root sidecar</p>",
    sourceVersion: 1,
  },
  child: {
    primary: {
      representation: "atlas_doc_format",
      value: JSON.stringify({
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: "Child body" }] }],
      }),
    },
    storageSidecar: "<p>raw child sidecar</p>",
    sourceVersion: 2,
  },
};

function freshSource(calls: string[]): TreeSource {
  return {
    async getPage(id, context) {
      context.signal?.throwIfAborted();
      calls.push(`body:${id}`);
      return {
        id,
        title: id === "root" ? "Root" : "Child",
        version: id === "root" ? 1 : 2,
        exportSource: bodies[id]!,
      };
    },
    async getPageVersion(id, context) {
      context.signal?.throwIfAborted();
      calls.push(`version:${id}`);
      return { title: "Root", version: 1 };
    },
    async getChildren(node, context) {
      context.signal?.throwIfAborted();
      calls.push(`children:${node.id}`);
      return node.id === "root"
        ? [{ id: "child", title: "Child", kind: "page", position: 0, observedVersion: 2 }]
        : [];
    },
    async getSpaceHomepageId() {
      throw new Error("unused");
    },
  };
}

function recoverySource(
  bodyVersions: Readonly<Record<string, number>>,
  bodyReads: string[],
): TreeSource {
  return {
    async getPage(id, context) {
      context.signal?.throwIfAborted();
      bodyReads.push(id);
      const version = bodyVersions[id]!;
      return {
        id,
        title: id === "root" ? "Root" : "Child",
        version,
        exportSource: { ...bodies[id]!, sourceVersion: version },
      };
    },
    async getPageVersion() {
      throw new Error("recovery must not rediscover page versions");
    },
    async getChildren() {
      throw new Error("recovery must not rediscover tree children");
    },
    async getSpaceHomepageId() {
      throw new Error("recovery must not resolve the space root");
    },
    async searchPages() {
      throw new Error("recovery must not repeat label queries");
    },
  };
}

describe("fetchExportTree durable pre-body plan", () => {
  it("awaits a body-free version-pinned plan before the first source body read", async () => {
    const calls: string[] = [];
    let persisted: ExportTreePlanV1 | undefined;
    const result = await fetchExportTree(
      freshSource(calls),
      { kind: "tree", rootPageId: "root" },
      {
        async onPlanPrepared(plan) {
          calls.push("checkpoint:start");
          await Promise.resolve();
          persisted = JSON.parse(JSON.stringify(plan)) as ExportTreePlanV1;
          calls.push("checkpoint:committed");
        },
      },
    );

    expect(result.nodes.map((node) => node.title)).toEqual(["Root", "Child"]);
    expect(calls).toEqual([
      "version:root",
      "children:root",
      "children:child",
      "checkpoint:start",
      "checkpoint:committed",
      "body:root",
      "body:child",
    ]);
    expect(persisted?.nodes).toEqual([
      expect.objectContaining({ kind: "page", pageId: "root", observedVersion: 1 }),
      expect.objectContaining({ kind: "page", pageId: "child", observedVersion: 2 }),
    ]);
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain("Root body");
    expect(serialized).not.toContain("raw root sidecar");
    expect(serialized).not.toContain("atlas_doc_format");
    expect(serialized).not.toContain("blocks");
  });

  it("recovers without discovery and reads only bodies matching the durable versions", async () => {
    let plan: ExportTreePlanV1 | undefined;
    await fetchExportTree(freshSource([]), { kind: "tree", rootPageId: "root" }, {
      onPlanPrepared(value) {
        plan = JSON.parse(JSON.stringify(value)) as ExportTreePlanV1;
      },
    });
    expect(plan).toBeDefined();

    const bodyReads: string[] = [];
    const recovered = await fetchExportTree(
      recoverySource({ root: 1, child: 2 }, bodyReads),
      { kind: "tree", rootPageId: "root" },
      { preparedPlan: plan },
    );
    expect(bodyReads).toEqual(["root", "child"]);
    expect(recovered.nodes.map((node) => node.title)).toEqual(["Root", "Child"]);
    expect(recovered.sourceSummary).toMatchObject({ pagesRead: 2 });
  });

  it("fails closed when a recovered body no longer matches its version pin", async () => {
    let plan: ExportTreePlanV1 | undefined;
    await fetchExportTree(freshSource([]), { kind: "tree", rootPageId: "root" }, {
      onPlanPrepared(value) { plan = value; },
    });

    const bodyReads: string[] = [];
    await expect(fetchExportTree(
      recoverySource({ root: 1, child: 3 }, bodyReads),
      { kind: "tree", rootPageId: "root" },
      { preparedPlan: plan },
    )).rejects.toBeInstanceOf(ExportCompletenessError);
    expect(bodyReads).toEqual(["root", "child"]);
  });

  it("rejects foreign or over-limit plans before any source operation", async () => {
    let plan: ExportTreePlanV1 | undefined;
    await fetchExportTree(freshSource([]), { kind: "tree", rootPageId: "root" }, {
      onPlanPrepared(value) { plan = value; },
    });
    const reads: string[] = [];
    const source = recoverySource({ root: 1, child: 2 }, reads);

    await expect(fetchExportTree(source, { kind: "page", pageId: "root" }, {
      preparedPlan: plan,
    })).rejects.toBeInstanceOf(ExportTreePlanError);
    await expect(fetchExportTree(source, { kind: "tree", rootPageId: "root" }, {
      preparedPlan: plan,
      maxPages: 1,
    })).rejects.toBeInstanceOf(ExportTreePlanError);
    expect(reads).toEqual([]);
  });

  it("binds recovery to the exact label and completeness policy", async () => {
    let plan: ExportTreePlanV1 | undefined;
    await fetchExportTree(freshSource([]), { kind: "tree", rootPageId: "root" }, {
      onPlanPrepared(value) { plan = value; },
    });
    const reads: string[] = [];
    const source = recoverySource({ root: 1, child: 2 }, reads);

    await expect(fetchExportTree(source, { kind: "tree", rootPageId: "root" }, {
      preparedPlan: plan,
      completenessMode: "partial",
    })).rejects.toBeInstanceOf(ExportTreePlanError);
    await expect(fetchExportTree(source, { kind: "tree", rootPageId: "root" }, {
      preparedPlan: plan,
      labels: { include: ["different"] },
    })).rejects.toBeInstanceOf(ExportTreePlanError);
    expect(reads).toEqual([]);
  });

  it("honors cancellation committed by the plan hook before body reads begin", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    await expect(fetchExportTree(
      freshSource(calls),
      { kind: "page", pageId: "root" },
      {
        signal: controller.signal,
        onPlanPrepared() {
          controller.abort(new DOMException("cancelled", "AbortError"));
        },
      },
    )).rejects.toThrow("cancelled");
    expect(calls).toEqual(["version:root"]);
  });

  it("fails closed instead of reading bodies for label fallback before the checkpoint", async () => {
    const calls: string[] = [];
    let checkpointed = false;
    await expect(fetchExportTree(
      freshSource(calls),
      { kind: "tree", rootPageId: "root" },
      {
        labels: { include: ["publish"] },
        onPlanPrepared() { checkpointed = true; },
      },
    )).rejects.toBeInstanceOf(ExportTreePlanError);
    expect(checkpointed).toBe(false);
    expect(calls).toEqual(["version:root", "children:root", "children:child"]);
  });

  it("enforces the durable plan byte budget before publishing or reading bodies", async () => {
    const calls: string[] = [];
    let checkpointed = false;
    await expect(fetchExportTree(
      freshSource(calls),
      { kind: "tree", rootPageId: "root" },
      {
        maxPlanBytes: 1,
        onPlanPrepared() { checkpointed = true; },
      },
    )).rejects.toBeInstanceOf(ExportTreePlanError);
    expect(checkpointed).toBe(false);
    expect(calls).toEqual(["version:root", "children:root", "children:child"]);
  });
});
