import { describe, expect, it } from "bun:test";
import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  documentToAdf,
  documentToStorage,
  type ImportDocumentV2,
} from "@atlcli/import-core";
import {
  prepareConfluencePage,
  publishPreparedCloudPage,
  publishPreparedDcPage,
  rollbackOwnedPages,
  type CloudImportClientPort,
  type DcImportClientPort,
} from "./publisher.js";
import {
  ConfluenceSemanticReadbackError,
  verifyAdfSemanticReadback,
  verifyStorageSemanticReadback,
} from "./readback.js";

function document(sourceKind: "docx" | "pdf", withAsset = true): ImportDocumentV2 {
  return {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind,
    blocks: [
      { id: "h", type: "heading", level: 2, runs: [{ kind: "text", text: "Heading" }] },
      { id: "p", type: "paragraph", runs: [{ kind: "text", text: "Paragraph", marks: { bold: true } }] },
      {
        id: "l",
        type: "list",
        ordered: false,
        items: [{ blocks: [{ id: "lp", type: "paragraph", runs: [{ kind: "text", text: "Item" }] }] }],
      },
      {
        id: "t",
        type: "table",
        rows: [{ cells: [{ id: "c", header: true, colspan: 2, blocks: [{ id: "cp", type: "paragraph", runs: [{ kind: "text", text: "Cell" }] }] }] }],
      },
      ...(withAsset ? [{ id: "i", type: "image" as const, assetId: "asset", alt: "Figure" }] : []),
    ],
    assets: withAsset ? [{
      id: "asset",
      fileName: "figure.png",
      mediaType: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
    }] : [],
    issues: [],
  };
}

function mutateFirstText(adf: unknown): unknown {
  const clone = structuredClone(adf) as { content: Array<{ content?: Array<{ text?: string }> }> };
  clone.content[0]!.content![0]!.text = "Changed";
  return clone;
}

describe("semantic Confluence readback", () => {
  it("proves text, list, table span, and media semantics without returning bodies", async () => {
    const doc = document("pdf");
    const adf = documentToAdf(doc, { media: new Map([["asset", { fileId: "file-1", collection: "contentId-p1" }]]) });
    const storage = documentToStorage(doc);
    const adfReceipt = await verifyAdfSemanticReadback(adf, JSON.stringify(adf));
    const cloudNormalized = structuredClone(adf);
    cloudNormalized.content[3]!.content![0]!.content![0]!.attrs = {
      ...cloudNormalized.content[3]!.content![0]!.content![0]!.attrs,
      rowspan: 1,
    };
    await expect(verifyAdfSemanticReadback(adf, cloudNormalized)).resolves.toEqual(adfReceipt);
    const storageReceipt = await verifyStorageSemanticReadback(storage, storage);

    expect(adfReceipt.actual).toMatchObject({ headingCount: 1, listCount: 1, tableCount: 1, tableCellCount: 1, mediaCount: 1 });
    expect(storageReceipt.actual).toMatchObject({ headingCount: 1, listCount: 1, tableCount: 1, tableCellCount: 1, mediaCount: 1 });
    expect(JSON.stringify(adfReceipt)).not.toContain("Heading");
    expect(JSON.stringify(storageReceipt)).not.toContain("Paragraph");
  });

  it("detects text, table-span, and media identity loss", async () => {
    const doc = document("pdf");
    const adf = documentToAdf(doc, { media: new Map([["asset", { fileId: "file-1", collection: "contentId-p1" }]]) });
    await expect(verifyAdfSemanticReadback(adf, mutateFirstText(adf) as never)).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);

    const lostSpan = structuredClone(adf);
    delete lostSpan.content[3]!.content![0]!.content![0]!.attrs!.colspan;
    await expect(verifyAdfSemanticReadback(adf, lostSpan)).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);

    const lostMedia = structuredClone(adf);
    lostMedia.content[4]!.content![0]!.attrs!.id = "wrong-file";
    await expect(verifyAdfSemanticReadback(adf, lostMedia)).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);

    const storage = documentToStorage(doc);
    await expect(verifyStorageSemanticReadback(storage, storage.replace(' colspan="2"', ""))).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
    await expect(verifyStorageSemanticReadback(storage, storage.replace("Paragraph", "Changed"))).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
    await expect(verifyStorageSemanticReadback(storage, storage.replace("figure.png", "wrong.png"))).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
  });

  it("accepts only Cloud's presentation-slug removal for internal page links", async () => {
    const linked = (href: string) => ({
      version: 1,
      type: "doc",
      content: [{
        type: "paragraph",
        content: [{ type: "text", text: "Part One", marks: [{ type: "link", attrs: { href } }] }],
      }],
    }) as never;
    const withSlug = linked("https://example.atlassian.net/wiki/spaces/DOCSY/pages/123456/Part+One");
    const withoutSlug = linked("https://example.atlassian.net/wiki/spaces/DOCSY/pages/123456");
    await expect(verifyAdfSemanticReadback(withSlug, withoutSlug)).resolves.toBeDefined();

    await expect(verifyAdfSemanticReadback(
      withSlug,
      linked("https://example.atlassian.net/wiki/spaces/DOCSY/pages/654321"),
    )).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
    await expect(verifyAdfSemanticReadback(
      linked("https://example.com/guide/Part+One"),
      linked("https://example.com/guide"),
    )).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
  });
});

type CloudStep = "create" | "upload" | "media" | "update" | "readback" | "delete";

class CloudFake implements CloudImportClientPort {
  readonly calls: string[] = [];
  adf: unknown = { version: 1, type: "doc", content: [] };
  constructor(readonly failAt?: CloudStep, readonly drift = false) {}

  async createPageAdf(input: { adf: unknown }): Promise<{ id: string; title: string; url: string; version: number }> {
    this.calls.push("create");
    if (this.failAt === "create") throw new Error("create failed");
    this.adf = input.adf;
    return { id: "p1", title: "Target", url: "https://example.invalid/p1", version: 1 };
  }
  async uploadAttachment(): Promise<void> {
    this.calls.push("upload");
    if (this.failAt === "upload") throw new Error("upload failed");
  }
  async listPageAttachmentMedia(): Promise<{ attachments: Array<{ filename: string; fileId: string }> }> {
    this.calls.push("media");
    if (this.failAt === "media") throw new Error("media failed");
    return { attachments: [{ filename: "figure.png", fileId: "file-1" }] };
  }
  async updatePageAdf(input: { adf: unknown }): Promise<{ id: string; title: string; version: number }> {
    this.calls.push("update");
    if (this.failAt === "update") throw new Error("update failed");
    this.adf = input.adf;
    return { id: "p1", title: "Target", version: 2 };
  }
  async getPageAdf(): Promise<{ body: { value: string }; version: number }> {
    this.calls.push("readback");
    if (this.failAt === "readback") throw new Error("readback failed");
    return { body: { value: JSON.stringify(this.drift ? mutateFirstText(this.adf) : this.adf) }, version: 2 };
  }
  async deletePage(pageId: string): Promise<void> {
    this.calls.push(`delete:${pageId}`);
    if (this.failAt === "delete") throw new Error("delete failed");
  }
}

describe("shared Cloud publication transaction", () => {
  it("publishes DOCX and PDF prepared plans through the same media and semantic-readback seam", async () => {
    for (const sourceKind of ["docx", "pdf"] as const) {
      const client = new CloudFake();
      const owned: string[] = [];
      const result = await publishPreparedCloudPage(
        client,
        "space-1",
        prepareConfluencePage({ title: "Target", document: document(sourceKind) }),
        { onOwnedPage: (id) => owned.push(id) },
      );
      expect(owned).toEqual(["p1"]);
      expect(client.calls).toEqual(["create", "upload", "media", "update", "readback"]);
      expect(result.readback.actual).toMatchObject({ tableCount: 1, mediaCount: 1 });
    }
  });

  it("registers the exact owned id before every post-create failure and rolls it back", async () => {
    const cases: Array<CloudStep | "after-shell" | "semantic-drift"> = [
      "create", "after-shell", "upload", "media", "update", "readback", "semantic-drift",
    ];
    for (const failAt of cases) {
      const client = new CloudFake(failAt === "semantic-drift" || failAt === "after-shell" ? undefined : failAt, failAt === "semantic-drift");
      const owned: string[] = [];
      await expect(publishPreparedCloudPage(
        client,
        "space-1",
        prepareConfluencePage({ title: "Target", document: document("pdf") }),
        {
          forceShell: true,
          onOwnedPage: (id) => owned.push(id),
          ...(failAt === "after-shell" ? { afterShell: async () => { throw new Error("after shell failed"); } } : {}),
        },
      )).rejects.toThrow();
      const rollback = await rollbackOwnedPages(client, owned);
      expect(rollback.attempted).toEqual(failAt === "create" ? [] : ["p1"]);
      expect(rollback.failed).toEqual([]);
      expect(client.calls.filter((call) => call.startsWith("delete:"))).toEqual(failAt === "create" ? [] : ["delete:p1"]);
    }
  });

  it("deletes child-first once, reports exact misses, and never expands ownership", async () => {
    const client = new CloudFake("delete");
    const rollback = await rollbackOwnedPages(client, ["root", "child", "child"]);
    expect(rollback).toEqual({ attempted: ["child", "root"], deleted: [], failed: ["child", "root"] });
  });
});

class DcFake implements DcImportClientPort {
  storage = "<p/>";
  labels: string[] = [];
  readonly calls: string[] = [];
  constructor(readonly drift = false) {}
  async createPage(): Promise<{ id: string; title: string; url: string; version: number }> {
    this.calls.push("create");
    return { id: "dc1", title: "Target", url: "https://example.invalid/dc1", version: 1 };
  }
  async uploadAttachment(): Promise<void> { this.calls.push("upload"); }
  async updatePage(input: { storage: string }): Promise<{ id: string; title: string; version: number }> {
    this.calls.push("update");
    this.storage = input.storage;
    return { id: "dc1", title: "Target", version: 2 };
  }
  async getPageDetails(): Promise<{ storage: string }> {
    this.calls.push("readback");
    return { storage: this.drift ? this.storage.replace("Paragraph", "Changed") : this.storage };
  }
  async addLabels(_pageId: string, labels: string[]): Promise<void> { this.calls.push("labels"); this.labels = labels; }
  async getLabels(): Promise<Array<{ name: string }>> { this.calls.push("label-readback"); return this.labels.map((name) => ({ name })); }
}

describe("shared Data Center publication transaction", () => {
  it("publishes the supported semantic subset and verifies labels", async () => {
    const client = new DcFake();
    const owned: string[] = [];
    const result = await publishPreparedDcPage(
      client,
      "DOCSY",
      prepareConfluencePage({ title: "Target", document: document("pdf") }),
      { labels: ["neutral"], onOwnedPage: (id) => owned.push(id) },
    );
    expect(owned).toEqual(["dc1"]);
    expect(client.calls).toEqual(["create", "upload", "update", "readback", "labels", "label-readback"]);
    expect(result.readback.actual).toMatchObject({ tableCount: 1, mediaCount: 1 });
  });

  it("fails semantic readback drift after registering the owned page", async () => {
    const client = new DcFake(true);
    const owned: string[] = [];
    await expect(publishPreparedDcPage(
      client,
      "DOCSY",
      prepareConfluencePage({ title: "Target", document: document("docx") }),
      { onOwnedPage: (id) => owned.push(id) },
    )).rejects.toBeInstanceOf(ConfluenceSemanticReadbackError);
    expect(owned).toEqual(["dc1"]);
  });
});
