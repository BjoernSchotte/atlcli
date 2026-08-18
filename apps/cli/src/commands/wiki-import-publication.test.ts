import { describe, expect, it, spyOn } from "bun:test";
import type { ConfluenceClient } from "@atlcli/confluence";
import { IMPORT_DOCUMENT_SCHEMA_V2, documentToAdf, type ImportBlock } from "@atlcli/import-core";
import {
  buildBaseline,
  digestAdfValue,
  resolveImportPolicy,
  type ImportComment,
  type ImportPagePlan,
  type ImportedDocument,
  type SplitResult,
} from "@atlcli/import-docx";
import { handleUpdateImport, publishComments, publishOnePage, publishTree } from "./wiki-import.js";

class CloudPublicationFake {
  readonly calls: string[] = [];
  readonly bodies = new Map<string, unknown>();
  private nextPage = 1;
  private nextComment = 1;
  drift = false;

  async createPageAdf(input: { title: string; adf: unknown; parentId?: string }): Promise<{ id: string; title: string; url: string; version: number }> {
    const id = `p${this.nextPage++}`;
    this.calls.push(`create:${id}:${input.parentId ?? "root"}`);
    this.bodies.set(id, input.adf);
    return { id, title: input.title, url: `https://example.invalid/${id}`, version: 1 };
  }
  async uploadAttachment(input: { pageId: string; filename: string }): Promise<void> {
    this.calls.push(`upload:${input.pageId}:${input.filename}`);
  }
  async listPageAttachmentMedia(pageId: string): Promise<{ attachments: Array<{ filename: string; fileId: string }> }> {
    this.calls.push(`media:${pageId}`);
    return { attachments: [{ filename: "figure.png", fileId: `file-${pageId}` }] };
  }
  async updatePageAdf(input: { id: string; title: string; adf: unknown; version: number }): Promise<{ id: string; title: string; version: number }> {
    this.calls.push(`update:${input.id}:${input.version}`);
    this.bodies.set(input.id, input.adf);
    return { id: input.id, title: input.title, version: input.version };
  }
  async getPageAdf(id: string): Promise<{ body: { value: string }; version: number }> {
    this.calls.push(`readback:${id}`);
    const body = structuredClone(this.bodies.get(id)) as { content?: Array<{ content?: Array<{ text?: string }> }> };
    if (this.drift && body.content?.[0]?.content?.[0]) body.content[0].content[0].text = "drift";
    return { body: { value: JSON.stringify(body) }, version: 2 };
  }
  async createInlineComment(input: { parentCommentId?: string }): Promise<{ id: string }> {
    const id = `c${this.nextComment++}`;
    this.calls.push(`inline:${id}:${input.parentCommentId ?? "root"}`);
    return { id };
  }
  async createFooterComment(input: { parentCommentId?: string }): Promise<{ id: string }> {
    const id = `c${this.nextComment++}`;
    this.calls.push(`footer:${id}:${input.parentCommentId ?? "root"}`);
    return { id };
  }
  async resolveComment(id: string, location: string): Promise<void> {
    this.calls.push(`resolve:${id}:${location}`);
  }
}

function client(fake: CloudPublicationFake): ConfluenceClient {
  return fake as unknown as ConfluenceClient;
}

function paragraph(id: string, text: string): ImportBlock {
  return { id, type: "paragraph", runs: [{ kind: "text", text }] };
}

describe("DOCX publication compatibility over the shared transaction", () => {
  it("preserves direct create and image shell/upload/finalize ordering", async () => {
    const direct = new CloudPublicationFake();
    const directOwned: string[] = [];
    await publishOnePage(client(direct), "s1", "Direct", undefined, [paragraph("p", "Text")], [], directOwned);
    expect(directOwned).toEqual(["p1"]);
    expect(direct.calls).toEqual(["create:p1:root", "readback:p1"]);

    const image = new CloudPublicationFake();
    const imageOwned: string[] = [];
    await publishOnePage(
      client(image),
      "s1",
      "Image",
      undefined,
      [{ id: "i", type: "image", assetId: "a", alt: "Figure" }],
      [{ id: "a", fileName: "figure.png", mediaType: "image/png", bytes: new Uint8Array([1]) }],
      imageOwned,
    );
    expect(imageOwned).toEqual(["p1"]);
    expect(image.calls).toEqual([
      "create:p1:root", "upload:p1:figure.png", "media:p1", "update:p1:2", "readback:p1",
    ]);
  });

  it("keeps split shell creation parent-first, finalization deterministic, and comments source-owned", async () => {
    const fake = new CloudPublicationFake();
    const root: ImportPagePlan = {
      title: "Root",
      blocks: [paragraph("root-p", "Root text")],
      assets: [],
      children: [{ title: "Child", blocks: [paragraph("child-p", "Child text")], assets: [], children: [] }],
    };
    const split: SplitResult = { root, issues: [], anchorOwners: new Map() };
    const doc: ImportedDocument = {
      schema: IMPORT_DOCUMENT_SCHEMA_V2,
      sourceKind: "docx",
      blocks: [],
      assets: [],
      issues: [],
      comments: [],
      commentOwners: new Map(),
    };
    const owned: string[] = [];
    const result = await publishTree(client(fake), "s1", split, undefined, owned, undefined, { doc, mode: "auto" });
    expect(owned).toEqual(["p1", "p2"]);
    expect(result.children?.[0]?.id).toBe("p2");
    expect(fake.calls).toEqual([
      "create:p1:root", "create:p2:p1", "update:p1:2", "readback:p1", "update:p2:2", "readback:p2",
    ]);
  });

  it("publishes inline replies and resolved state outside the shared publisher", async () => {
    const fake = new CloudPublicationFake();
    const reply: ImportComment = { id: "reply", author: "Author", text: "Reply", resolved: false, replies: [] };
    const comment: ImportComment = {
      id: "comment",
      author: "Author",
      text: "Comment",
      resolved: true,
      replies: [reply],
      anchorText: "Text",
    };
    const bindings = await publishComments(client(fake), "p1", [comment], "auto", []);
    expect(bindings).toEqual([
      { sourceCommentId: "comment", confluenceCommentId: "c1", location: "inline" },
      { sourceCommentId: "reply", confluenceCommentId: "c2", location: "inline" },
    ]);
    expect(fake.calls).toEqual(["inline:c1:root", "inline:c2:c1", "resolve:c1:inline"]);
  });

  it("rejects semantic body drift after create so the caller can roll back the registered id", async () => {
    const fake = new CloudPublicationFake();
    fake.drift = true;
    const owned: string[] = [];
    await expect(publishOnePage(client(fake), "s1", "Drift", undefined, [paragraph("p", "Text")], [], owned)).rejects.toThrow("semantic readback mismatch");
    expect(owned).toEqual(["p1"]);
  });

  it("keeps baseline-guarded in-place update and successor sealing in the DOCX shell", async () => {
    const oldDocument = {
      schema: IMPORT_DOCUMENT_SCHEMA_V2,
      sourceKind: "docx" as const,
      blocks: [paragraph("old", "Old")],
      assets: [],
      issues: [],
    };
    const oldBody = JSON.stringify(documentToAdf(oldDocument));
    const baseline = await buildBaseline({
      pageId: "p1",
      sourceSha256: "a".repeat(64),
      importPlanDigest: "b".repeat(64),
      bodyDigest: await digestAdfValue(oldBody),
      importedPageVersion: 3,
      assetBindings: [],
    });
    let currentBody = oldBody;
    let stored: unknown = baseline;
    const versions: number[] = [];
    const fake = {
      async getPage(): Promise<{ id: string; title: string }> { return { id: "p1", title: "Target" }; },
      async getPageAdf(): Promise<{ body: { value: string }; version: number }> { return { body: { value: currentBody }, version: versions.at(-1) ?? 3 }; },
      async getPagePropertyByKey(): Promise<unknown> { return stored; },
      async getInlineComments(): Promise<[]> { return []; },
      async updatePageAdf(input: { adf: unknown; version: number }): Promise<{ id: string; title: string; version: number }> {
        versions.push(input.version);
        currentBody = JSON.stringify(input.adf);
        return { id: "p1", title: "Target", version: input.version };
      },
      async upsertPageProperty(_id: string, _key: string, value: unknown): Promise<void> { stored = value; },
    } as unknown as ConfluenceClient;
    const nextDoc: ImportedDocument = {
      schema: IMPORT_DOCUMENT_SCHEMA_V2,
      sourceKind: "docx",
      blocks: [paragraph("next", "New")],
      assets: [],
      issues: [],
      comments: [],
      commentOwners: new Map(),
    };
    const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await handleUpdateImport(
        "p1",
        nextDoc,
        new Uint8Array([1, 2, 3]),
        { kind: "test" },
        {},
        { json: true },
        {} as never,
        true,
        resolveImportPolicy({}).policy,
        fake,
      );
    } finally {
      stdout.mockRestore();
    }
    expect(versions).toEqual([4]);
    expect(JSON.parse(currentBody).content[0].content[0].text).toBe("New");
    expect(stored).toMatchObject({ pageId: "p1", importedPageVersion: 4 });
  });
});
