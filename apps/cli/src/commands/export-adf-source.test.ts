import { describe, expect, it } from "bun:test";
import type {
  ConfluenceClient,
  ConfluenceExportPageDetails,
} from "@atlcli/confluence";
import type { Profile } from "@atlcli/core";
import { parseExportRequest } from "./export-request.js";
import { resolveScope } from "./export-pdf.js";
import { decodeTsPageSource } from "./export.js";

const profile: Profile = {
  name: "fixture",
  baseUrl: "https://example.invalid",
  deploymentType: "cloud",
  auth: { type: "apiToken", email: "fixture@example.invalid", token: "unused" },
};

function adfPage(content: unknown[], storage = "<p>STORAGE_POISON</p>"): ConfluenceExportPageDetails {
  return {
    id: "1",
    title: "Root",
    version: 7,
    spaceKey: "S",
    storage,
    exportSource: {
      primary: {
        representation: "atlas_doc_format",
        value: JSON.stringify({ type: "doc", version: 1, content }),
      },
      storageSidecar: storage,
      sourceVersion: 7,
    },
  };
}

function args(client: ConfluenceClient, flags: Record<string, string> = {}) {
  return {
    client,
    profile,
    request: parseExportRequest("1", { engine: "ts", ...flags }),
    baseUrl: profile.baseUrl,
    outputPath: "/tmp/out.pdf",
    force: true,
    strict: false,
    noCache: true,
    opts: { json: true },
  };
}

describe("CLI PDF source resolution is ADF-primary", () => {
  it("decodes the export source and never walks the root Storage sidecar", async () => {
    const page = adfPage([{
      type: "paragraph",
      content: [{ type: "text", text: "ADF_PRIMARY" }],
    }]);
    const client = {
      getExportPageDetailsWithMedia: async () => page,
    } as unknown as ConfluenceClient;

    const result = await resolveScope(args(client), new AbortController().signal, () => undefined);
    expect(result.blocks).toEqual([
      { type: "paragraph", content: [{ type: "text", text: "ADF_PRIMARY" }] },
    ]);
    expect(JSON.stringify(result.blocks)).not.toContain("STORAGE_POISON");
    expect(result.sourcePages[0]?.notes).toEqual([]);
  });

  it("correlates ADF media through prefetched v2 fileId metadata", async () => {
    const page = {
      ...adfPage([{
        type: "mediaSingle",
        content: [{
          type: "media",
          attrs: { type: "file", id: "file-1", collection: "content-1", alt: "Diagram" },
        }],
      }]),
      mediaAttachments: [{ fileId: "file-1", filename: "diagram.png", pageId: "1" }],
      mediaAttachmentsComplete: true,
    };
    const client = {
      getExportPageDetailsWithMedia: async () => page,
    } as unknown as ConfluenceClient;

    const result = await resolveScope(args(client), new AbortController().signal, () => undefined);
    expect(result.blocks).toEqual([{
      type: "image",
      source: { kind: "attachment", filename: "diagram.png", pageId: "1" },
      media: {
        mediaType: "file",
        id: "file-1",
        collection: "content-1",
        filename: "diagram.png",
        pageId: "1",
      },
      alt: "Diagram",
      mediaPresentation: { layout: "center" },
    }]);
    expect(result.sourceNotes.map((note) => note.code)).not.toContain("adf-media-unresolved");
  });

  it("correlates ADF annotation ranges through the prefetched comment sidecar", async () => {
    const page = {
      ...adfPage([{
        type: "paragraph",
        content: [{
          type: "text",
          text: "Annotated",
          marks: [{
            type: "annotation",
            attrs: { id: "marker-1", annotationType: "inlineComment" },
          }],
        }],
      }]),
      inlineComments: [{
        id: "comment-resource-1",
        author: { displayName: "Fixture" },
        created: "2026-01-01T00:00:00.000Z",
        body: "<p>Review this</p>",
        status: "open" as const,
        replies: [],
        textSelection: "Annotated",
        inlineMarkerRef: "marker-1",
      }],
      inlineCommentsComplete: true,
    };
    const client = {
      getExportPageDetailsWithMedia: async () => page,
    } as unknown as ConfluenceClient;

    const result = await resolveScope(args(client), new AbortController().signal, () => undefined);
    expect(result.blocks[0]).toMatchObject({
      content: [{
        annotations: [{
          id: "marker-1",
          comment: { bodyText: "Review this", status: "open", replies: [] },
        }],
      }],
    });
    expect(result.sourceNotes.map((note) => note.code)).not.toContain("adf-annotation-unresolved");
  });

  it("threads the PDF exporter identity through the shared tree source", async () => {
    const control = (target: string, text: string) => ({
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "scroll-only",
        parameters: { macroParams: { exporter: { value: target } } },
      },
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const page = adfPage([
      control("pdf", "PDF_ONLY"),
      control("word", "WORD_ONLY"),
    ]);
    const client = {
      getExportPageDetails: async () => page,
      getPageDetails: async () => page,
      getPageVersion: async () => ({ title: page.title, version: page.version! }),
      getChildrenWithPosition: async () => [],
      getPageDirectChildren: async () => [],
      getFolderChildren: async () => [],
      getSpaceHomepageId: async () => null,
      searchPages: async () => [],
    } as unknown as ConfluenceClient;

    const result = await resolveScope(
      args(client, { scope: "tree", "max-depth": "0" }),
      new AbortController().signal,
      () => undefined,
    );
    expect(JSON.stringify(result.blocks)).toContain("PDF_ONLY");
    expect(JSON.stringify(result.blocks)).not.toContain("WORD_ONLY");
  });
});

describe("CLI TypeScript DOCX prewalk is ADF-primary", () => {
  it("passes predecoded ADF blocks to the engine boundary and ignores Storage", () => {
    const page = adfPage([{
      type: "paragraph",
      content: [{ type: "text", text: "DOCX_ADF_PRIMARY", marks: [{ type: "code" }] }],
    }]);
    const result = decodeTsPageSource(page);
    expect(result.blocks).toEqual([{
      type: "paragraph",
      content: [{ type: "text", text: "DOCX_ADF_PRIMARY", marks: ["code"] }],
    }]);
    expect(JSON.stringify(result.blocks)).not.toContain("STORAGE_POISON");
  });

  it("preserves keep-ignored passthrough on ADF extensions", () => {
    const page = adfPage([{
      type: "bodiedExtension",
      attrs: {
        extensionType: "com.atlassian.confluence.macro.core",
        extensionKey: "scroll-ignore",
      },
      content: [{ type: "paragraph", content: [{ type: "text", text: "IGNORED_BODY" }] }],
    }]);
    expect(JSON.stringify(decodeTsPageSource(page).blocks)).not.toContain("IGNORED_BODY");
    const kept = decodeTsPageSource(page, true);
    expect(JSON.stringify(kept.blocks)).toContain("IGNORED_BODY");
    expect(kept.notes.map((note) => note.code)).toContain("export-controls-passthrough");
  });

  it("uses the same v2 fileId correlation in the DOCX prewalk", () => {
    const page = {
      ...adfPage([{
        type: "mediaSingle",
        content: [{
          type: "media",
          attrs: { type: "file", id: "file-2", collection: "content-1" },
        }],
      }]),
      mediaAttachments: [{ fileId: "file-2", filename: "docx-image.png", pageId: "1" }],
    };
    expect(decodeTsPageSource(page).blocks).toEqual([{
      type: "image",
      source: { kind: "attachment", filename: "docx-image.png", pageId: "1" },
      media: {
        mediaType: "file",
        id: "file-2",
        collection: "content-1",
        filename: "docx-image.png",
        pageId: "1",
      },
      mediaPresentation: { layout: "center" },
    }]);
  });

  it("uses the same inline-comment correlation in the DOCX prewalk", () => {
    const page = {
      ...adfPage([{
        type: "paragraph",
        content: [{
          type: "text",
          text: "Annotated",
          marks: [{
            type: "annotation",
            attrs: { id: "marker-2", annotationType: "inlineComment" },
          }],
        }],
      }]),
      inlineComments: [{
        id: "comment-resource-2",
        author: { displayName: "Fixture" },
        created: "2026-01-01T00:00:00.000Z",
        body: "<p>DOCX review</p>",
        status: "resolved" as const,
        replies: [],
        textSelection: "Annotated",
        inlineMarkerRef: "marker-2",
      }],
      inlineCommentsComplete: true,
    };
    expect(decodeTsPageSource(page).blocks[0]).toMatchObject({
      content: [{
        annotations: [{
          id: "marker-2",
          comment: { bodyText: "DOCX review", status: "resolved", replies: [] },
        }],
      }],
    });
  });
});
