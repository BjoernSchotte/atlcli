import { describe, expect, it } from "bun:test";
import { sha256Hex } from "@atlcli/core";
import type { ConfluenceClient } from "@atlcli/confluence";
import type { ImportAsset, ImportBlock } from "@atlcli/import-core";
import type { DestinationGovernance } from "@atlcli/import-docx";
import {
  PDF_SPLIT_EDITABILITY_REVISION,
  PDF_SPLIT_PLAN_SCHEMA_V1,
  PDF_SPLIT_POLICY_SCHEMA_V1,
  type PdfPlannedPageV1,
  type PdfSplitPlanV1,
} from "@atlcli/import-pdf";
import { publishPdfCloud, publishPdfDc, PdfPublicationTransactionError } from "./wiki-import-pdf-publication.js";

const governance: DestinationGovernance = {
  schema: "atlcli.docx-destination-governance/1",
  restriction: { mode: "private" },
  staging: { mode: "none" },
  labels: ["pdf-import"],
  contentProperties: [{ key: "atlcli.import.kind", value: "pdf" }],
};

function paragraph(id: string, text: string): ImportBlock {
  return { id, type: "paragraph", runs: [{ kind: "text", text }] };
}

function plannedPage(input: {
  id: string;
  title: string;
  sourcePages: number[];
  blocks?: ImportBlock[];
  assets?: ImportAsset[];
  children?: PdfPlannedPageV1[];
  basis?: PdfPlannedPageV1["splitBasis"];
}): PdfPlannedPageV1 {
  return {
    id: input.id,
    title: input.title,
    sourcePageIndexes: input.sourcePages,
    sourcePageLabels: input.sourcePages.map((page) => String(page + 1)),
    splitBasis: input.basis ?? "page-range",
    blocks: input.blocks ?? [paragraph(`${input.id}:p`, `${input.title} text`)],
    assets: input.assets ?? [],
    children: input.children ?? [],
    estimate: { adfBytes: 64, storageBytes: 64, nodes: 2, tableCells: 0, assets: input.assets?.length ?? 0, editability: "ok" },
    bodyDigest: input.id.padEnd(64, "0").slice(0, 64),
  };
}

function plan(root: PdfPlannedPageV1): PdfSplitPlanV1 {
  const content = [root, ...root.children.flatMap(function flatten(page): PdfPlannedPageV1[] {
    return [page, ...page.children.flatMap(flatten)];
  })].filter((page) => page.sourcePageIndexes.length > 0);
  const assignments = content.flatMap((page) => page.sourcePageIndexes.map((pageIndex) => ({ pageIndex, plannedPageId: page.id })))
    .sort((a, b) => a.pageIndex - b.pageIndex);
  return {
    schema: PDF_SPLIT_PLAN_SCHEMA_V1,
    requested: {
      schema: PDF_SPLIT_POLICY_SCHEMA_V1,
      mode: { kind: "auto" },
      maxWikiPages: 50,
      autoSinglePageMaxSourcePages: 20,
      absoluteSinglePageMaxSourcePages: 40,
      editabilityBudgetRevision: PDF_SPLIT_EDITABILITY_REVISION,
    },
    resolved: root.children.length > 0
      ? { kind: "page-tree", reason: "auto-long-or-complex" }
      : { kind: "single-page", reason: "short-and-editable" },
    root,
    contentPageCount: content.length,
    totalWikiPages: root.children.length > 0 ? content.length + 1 : 1,
    sourceAssignments: assignments,
    issues: [],
    blockers: [],
    digest: "d".repeat(64),
  };
}

class PdfCloudFake {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, unknown>();
  readonly pages = new Map<string, { title: string; parentId?: string }>();
  readonly attachments = new Map<string, Uint8Array>();
  readonly labels = new Map<string, string[]>();
  readonly properties = new Map<string, unknown>();
  readonly storage = new Map<string, string>();
  private nextPage = 1;
  failAt?: string;
  corruptDownload = false;

  private call(value: string): void {
    this.calls.push(value);
    if (this.failAt === value) throw new Error(`injected:${value}`);
  }

  async createPageAdf(input: { title: string; adf: unknown; parentId?: string }): Promise<{ id: string; title: string; url: string; version: number; parentId?: string }> {
    const id = `p${this.nextPage++}`;
    this.call(`create:${id}:${input.parentId ?? "root"}`);
    this.pages.set(id, { title: input.title, ...(input.parentId ? { parentId: input.parentId } : {}) });
    this.bodies.set(id, input.adf);
    return { id, title: input.title, url: `https://example.invalid/${id}`, version: 1, ...(input.parentId ? { parentId: input.parentId } : {}) };
  }
  async updatePageAdf(input: { id: string; title: string; adf: unknown; version: number }): Promise<{ id: string; title: string; url: string; version: number; parentId?: string }> {
    this.call(`update:${input.id}`);
    this.bodies.set(input.id, input.adf);
    return {
      id: input.id,
      title: input.title,
      url: `https://example.invalid/${input.id}`,
      version: input.version,
      ...(this.pages.get(input.id)?.parentId ? { parentId: this.pages.get(input.id)!.parentId } : {}),
    };
  }
  async getPageAdf(id: string): Promise<{ body: { value: string }; version: number }> {
    this.call(`body:${id}`);
    return { body: { value: JSON.stringify(this.bodies.get(id)) }, version: 2 };
  }
  async getPageDetails(id: string): Promise<{ title: string; parentId?: string }> {
    this.call(`details:${id}`);
    return { ...this.pages.get(id)!, ...(this.storage.has(id) ? { storage: this.storage.get(id) } : {}) };
  }
  async uploadAttachment(input: { pageId: string; filename: string; data: Uint8Array }): Promise<{ pageId: string; filename: string }> {
    const kind = input.filename.endsWith(".pdf") ? "source" : "asset";
    this.call(`${kind}:${input.pageId}:${input.filename}`);
    this.attachments.set(`${input.pageId}:${input.filename}`, input.data);
    return { pageId: input.pageId, filename: input.filename };
  }
  async downloadAttachment(input: { pageId: string; filename: string }): Promise<Uint8Array> {
    this.call(`download:${input.pageId}:${input.filename}`);
    const bytes = this.attachments.get(`${input.pageId}:${input.filename}`)!;
    return this.corruptDownload ? new Uint8Array([...bytes, 0]) : bytes;
  }
  async listPageAttachmentMedia(pageId: string): Promise<{ attachments: Array<{ filename: string; fileId: string }> }> {
    this.call(`media:${pageId}`);
    return {
      attachments: [...this.attachments.keys()]
        .filter((key) => key.startsWith(`${pageId}:`) && !key.endsWith(".pdf"))
        .map((key) => ({ filename: key.slice(pageId.length + 1), fileId: `file-${key}` })),
    };
  }
  async getCurrentUser(): Promise<{ accountId: string }> { this.call("current-user"); return { accountId: "importer" }; }
  async setContentRestrictions(pageId: string): Promise<void> { this.call(`restrict:${pageId}`); }
  async getContentRestrictions(pageId: string): Promise<{ read: { accountIds: string[]; groupIds: string[] }; update: { accountIds: string[]; groupIds: string[] } }> {
    this.call(`restriction-readback:${pageId}`);
    return { read: { accountIds: ["importer"], groupIds: [] }, update: { accountIds: ["importer"], groupIds: [] } };
  }
  async addLabels(pageId: string, labels: string[]): Promise<void> { this.call(`labels:${pageId}`); this.labels.set(pageId, labels); }
  async getLabels(pageId: string): Promise<Array<{ name: string }>> { this.call(`labels-readback:${pageId}`); return (this.labels.get(pageId) ?? []).map((name) => ({ name })); }
  async createPageProperty(pageId: string, key: string, value: unknown): Promise<void> { this.call(`property:${pageId}:${key}`); this.properties.set(`${pageId}:${key}`, value); }
  async getPagePropertyByKey(pageId: string, key: string): Promise<unknown> { this.call(`property-readback:${pageId}:${key}`); return this.properties.get(`${pageId}:${key}`); }
  async deletePage(id: string): Promise<void> { this.call(`delete:${id}`); this.pages.delete(id); }
  async createPage(input: { title: string; storage: string; parentId?: string }): Promise<{ id: string; title: string; url: string; version: number }> {
    const id = `p${this.nextPage++}`;
    this.call(`dc-create:${id}:${input.parentId ?? "root"}`);
    this.pages.set(id, { title: input.title, ...(input.parentId ? { parentId: input.parentId } : {}) });
    this.storage.set(id, input.storage);
    return { id, title: input.title, url: `https://example.invalid/${id}`, version: 1 };
  }
  async updatePage(input: { id: string; title: string; storage: string; version: number }): Promise<{ id: string; title: string; version: number }> {
    this.call(`dc-update:${input.id}`);
    this.storage.set(input.id, input.storage);
    return { id: input.id, title: input.title, version: input.version };
  }
}

function cloudClient(fake: PdfCloudFake): ConfluenceClient {
  return fake as unknown as ConfluenceClient;
}

describe("PDF publication transaction", () => {
  it("proves restriction and source digest before content, then verifies body and metadata", async () => {
    const fake = new PdfCloudFake();
    const source = new Uint8Array([37, 80, 68, 70, 45]);
    const sourceSha256 = await sha256Hex(source);
    const asset: ImportAsset = { id: "figure", fileName: "figure.png", mediaType: "image/png", bytes: new Uint8Array([1, 2, 3]) };
    const root = plannedPage({
      id: "root",
      title: "Guide",
      sourcePages: [0],
      blocks: [{ id: "image", type: "image", assetId: "figure", alt: "Diagram" }],
      assets: [asset],
    });
    const result = await publishPdfCloud({
      client: cloudClient(fake), spaceId: "space", plan: plan(root), governance,
      sourceBytes: source, sourceSha256, attachSource: true, issues: [],
    });
    expect(result.pagesCreated).toBe(1);
    expect(result.sourceAttachment).toEqual({
      role: "source-pdf", filename: `source-${sourceSha256.slice(0, 16)}.pdf`, sha256: sourceSha256, byteLength: 5,
    });
    expect(fake.calls).toEqual([
      "current-user", "create:p1:root", "restrict:p1", "restriction-readback:p1",
      `source:p1:source-${sourceSha256.slice(0, 16)}.pdf`, `download:p1:source-${sourceSha256.slice(0, 16)}.pdf`,
      "asset:p1:figure.png", "media:p1", "update:p1", "body:p1",
      "labels:p1", "labels-readback:p1", "property:p1:atlcli.import.kind", "property-readback:p1:atlcli.import.kind",
    ]);
  });

  it("creates a parent-first tree, resolves root index links, and verifies every parent", async () => {
    const childA = plannedPage({ id: "a", title: "Chapter A", sourcePages: [0] });
    const childB = plannedPage({ id: "b", title: "Chapter B", sourcePages: [1] });
    const root = plannedPage({
      id: "root", title: "Guide", sourcePages: [], basis: "root-index", children: [childA, childB],
      blocks: [{
        id: "index", type: "list", ordered: false, items: [childA, childB].map((child) => ({
          id: `item-${child.id}`,
          blocks: [{ id: `p-${child.id}`, type: "paragraph", runs: [{
            kind: "text", text: child.title, marks: { reference: { namespace: "pdf-page", target: child.id } },
          }] }],
        })),
      }],
    });
    const fake = new PdfCloudFake();
    const source = new Uint8Array([1]);
    const result = await publishPdfCloud({
      client: cloudClient(fake), spaceId: "space", plan: plan(root),
      governance: { ...governance, restriction: { mode: "inherit" }, labels: [], contentProperties: [] },
      sourceBytes: source, sourceSha256: await sha256Hex(source), attachSource: false, issues: [],
    });
    expect(result.pagesCreated).toBe(3);
    expect(result.root.children?.map((child) => child.parentId)).toEqual(["p1", "p1"]);
    expect(fake.calls.slice(0, 3)).toEqual(["create:p1:root", "create:p2:p1", "create:p3:p1"]);
    const rootAdf = JSON.stringify(fake.bodies.get("p1"));
    expect(rootAdf).toContain("https://example.invalid/p2");
    expect(rootAdf).toContain("https://example.invalid/p3");
    expect(fake.calls.filter((call) => call.startsWith("details:"))).toEqual(["details:p1", "details:p2", "details:p3"]);
  });

  it("creates and proves a private staging parent before the import root", async () => {
    const fake = new PdfCloudFake();
    const source = new Uint8Array([1]);
    const result = await publishPdfCloud({
      client: cloudClient(fake), spaceId: "space", plan: plan(plannedPage({ id: "root", title: "Guide", sourcePages: [0] })),
      governance: { ...governance, staging: { mode: "private-parent", title: "Imports" }, labels: [], contentProperties: [] },
      stagingTitle: "Imports (2)", sourceBytes: source, sourceSha256: await sha256Hex(source), attachSource: false, issues: [],
    });
    expect(result.pagesCreated).toBe(2);
    expect(result.root.parentId).toBe("p1");
    expect(fake.calls.slice(0, 9)).toEqual([
      "current-user", "create:p1:root", "restrict:p1", "restriction-readback:p1",
      "property:p1:atlcli.import.staging", "property-readback:p1:atlcli.import.staging",
      "create:p2:p1", "restrict:p2", "restriction-readback:p2",
    ]);
  });

  it("rejects a mismatched source attachment digest and rolls back", async () => {
    const fake = new PdfCloudFake();
    fake.corruptDownload = true;
    const source = new Uint8Array([1, 2, 3]);
    try {
      await publishPdfCloud({
        client: cloudClient(fake), spaceId: "space", plan: plan(plannedPage({ id: "root", title: "Guide", sourcePages: [0] })),
        governance, sourceBytes: source, sourceSha256: await sha256Hex(source), attachSource: true, issues: [],
      });
      throw new Error("expected source digest failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfPublicationTransactionError);
      expect((error as Error).cause).toBeInstanceOf(Error);
      expect(((error as Error).cause as Error).message).toContain("byte-digest readback failed");
      expect((error as PdfPublicationTransactionError).rollback.deleted).toEqual(["p1"]);
    }
  });

  it("rejects a source/content attachment name collision before mutation", async () => {
    const fake = new PdfCloudFake();
    const source = new Uint8Array([1, 2, 3]);
    const digest = await sha256Hex(source);
    const filename = `source-${digest.slice(0, 16)}.pdf`;
    const asset: ImportAsset = { id: "collision", fileName: filename, mediaType: "application/pdf", bytes: new Uint8Array([9]) };
    await expect(publishPdfCloud({
      client: cloudClient(fake), spaceId: "space",
      plan: plan(plannedPage({ id: "root", title: "Guide", sourcePages: [0], assets: [asset] })),
      governance, sourceBytes: source, sourceSha256: digest, attachSource: true, issues: [],
    })).rejects.toThrow("collides");
    expect(fake.calls).toEqual([]);
  });

  it("rolls back the exact owned page after every sensitive single-page failure stage", async () => {
    const source = new Uint8Array([1, 2]);
    const digest = await sha256Hex(source);
    const asset: ImportAsset = { id: "figure", fileName: "figure.png", mediaType: "image/png", bytes: new Uint8Array([3]) };
    const root = plannedPage({ id: "root", title: "Guide", sourcePages: [0], blocks: [{ id: "i", type: "image", assetId: "figure" }], assets: [asset] });
    for (const failure of [
      "restrict:p1", `source:p1:source-${digest.slice(0, 16)}.pdf`, "asset:p1:figure.png", "update:p1", "body:p1", "labels:p1",
    ]) {
      const fake = new PdfCloudFake();
      fake.failAt = failure;
      try {
        await publishPdfCloud({
          client: cloudClient(fake), spaceId: "space", plan: plan(root), governance,
          sourceBytes: source, sourceSha256: digest, attachSource: true, issues: [],
        });
        throw new Error("expected publication failure");
      } catch (error) {
        expect(error).toBeInstanceOf(PdfPublicationTransactionError);
        expect((error as PdfPublicationTransactionError).rollback).toEqual({ attempted: ["p1"], deleted: ["p1"], failed: [] });
      }
    }
  });

  it("rolls a partially created tree back child-first", async () => {
    const root = plannedPage({
      id: "root", title: "Guide", sourcePages: [], basis: "root-index",
      children: [plannedPage({ id: "a", title: "A", sourcePages: [0] }), plannedPage({ id: "b", title: "B", sourcePages: [1] })],
      blocks: [],
    });
    const fake = new PdfCloudFake();
    fake.failAt = "update:p1";
    try {
      await publishPdfCloud({
        client: cloudClient(fake), spaceId: "space", plan: plan(root),
        governance: { ...governance, restriction: { mode: "inherit" }, labels: [], contentProperties: [] },
        sourceBytes: new Uint8Array([1]), sourceSha256: "a".repeat(64), attachSource: false, issues: [],
      });
      throw new Error("expected publication failure");
    } catch (error) {
      expect(error).toBeInstanceOf(PdfPublicationTransactionError);
      expect((error as PdfPublicationTransactionError).rollback.attempted).toEqual(["p3", "p2", "p1"]);
      expect(fake.calls.slice(-3)).toEqual(["delete:p3", "delete:p2", "delete:p1"]);
    }
  });

  it("rejects a Data Center page tree before mutation", async () => {
    const root = plannedPage({ id: "root", title: "Guide", sourcePages: [], children: [plannedPage({ id: "a", title: "A", sourcePages: [0] })] });
    const fake = new PdfCloudFake();
    await expect(publishPdfDc({
      client: cloudClient(fake), spaceKey: "DOCSY", plan: plan(root), labels: [], sourceBytes: new Uint8Array([1]),
      sourceSha256: "a".repeat(64), attachSource: false, issues: [],
    })).rejects.toThrow("cannot publish");
    expect(fake.calls).toEqual([]);
  });

  it("publishes a safe one-page Data Center plan with source digest readback and labels", async () => {
    const fake = new PdfCloudFake();
    const source = new Uint8Array([37, 80, 68, 70]);
    const digest = await sha256Hex(source);
    const result = await publishPdfDc({
      client: cloudClient(fake), spaceKey: "DOCSY",
      plan: plan(plannedPage({ id: "root", title: "Guide", sourcePages: [0] })),
      labels: ["pdf-import"], sourceBytes: source, sourceSha256: digest, attachSource: true, issues: [],
    });
    expect(result.pagesCreated).toBe(1);
    expect(result.sourceAttachment?.sha256).toBe(digest);
    expect(fake.calls).toEqual([
      "dc-create:p1:root", `source:p1:source-${digest.slice(0, 16)}.pdf`, `download:p1:source-${digest.slice(0, 16)}.pdf`,
      "dc-update:p1", "details:p1", "labels:p1", "labels-readback:p1",
    ]);
  });
});
