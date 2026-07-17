import { describe, expect, it } from "bun:test";
import type { ExportBlock } from "@atlcli/confluence/browser";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../../utils/read-path.js";
import {
  normalizePdfLocale,
  resolvePdfMentionNames,
  runPdfExport,
  type PdfExportPhase,
} from "../../utils/pdf/run-export.js";
import type { StoredPdfJob } from "../../utils/pdf/job-store.js";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const validPdf = new TextEncoder().encode(
  "%PDF-1.7\n/Type/Page /StructTreeRoot /MarkInfo /Outlines /FontFile2\n%%EOF\n"
);
const page: LoadedPage = {
  details: {
    id: "123",
    title: "Guide: A/B?",
    spaceKey: "DOCSY",
    version: 4,
    modifiedBy: { accountId: "a1", displayName: "Ada" },
    storage: "<h2>Overview</h2><p>Hello <strong>PDF</strong>.</p>",
  },
  markdown: "## Overview\n\nHello **PDF**.",
  wordCount: 4,
  attachments: [],
};

describe("runPdfExport", () => {
  it("normalizes browser locales for Typst language and region metadata", () => {
    expect(normalizePdfLocale("de-DE")).toEqual({ language: "de", region: "DE" });
    expect(normalizePdfLocale("pt_BR")).toEqual({ language: "pt", region: "BR" });
    expect(normalizePdfLocale("zh-Hant-TW")).toEqual({ language: "zh", region: "TW" });
    expect(normalizePdfLocale("invalid-locale")).toEqual({ language: "en" });
  });

  it("resolves unique missing mention names throughout nested export blocks", async () => {
    const blocks: ExportBlock[] = [
      {
        type: "table",
        rows: [{
          cells: [{
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [{
              type: "list",
              ordered: false,
              items: [{
                content: [{
                  type: "paragraph",
                  content: [
                    { type: "mention", accountId: "synthetic-user-a" },
                    { type: "text", text: " and " },
                    { type: "link", target: { kind: "external", href: "https://example.invalid" }, content: [
                      { type: "mention", accountId: "synthetic-user-a" },
                    ] },
                    { type: "mention", accountId: "synthetic-user-b", displayName: "Existing Name" },
                    { type: "mention", accountId: "synthetic-user-c" },
                  ],
                }],
              }],
            }],
          }],
        }],
      },
    ];
    let requestedIds: string[] = [];

    const resolved = await resolvePdfMentionNames(blocks, async (accountIds) => {
      requestedIds = accountIds;
      return new Map([
        ["synthetic-user-a", { displayName: "Example Person" }],
        ["synthetic-user-c", null],
      ]);
    });

    expect(requestedIds).toEqual(["synthetic-user-a", "synthetic-user-c"]);
    expect(resolved.unresolved).toBe(1);
    expect(JSON.stringify(resolved.blocks)).toContain('"displayName":"Example Person"');
    expect(JSON.stringify(resolved.blocks)).toContain('"displayName":"Existing Name"');
    expect(JSON.stringify(resolved.blocks)).not.toContain('"synthetic-user-b","displayName":"Example Person"');
  });

  it("serializes a resolved display name instead of a technical mention identifier", async () => {
    const mentionPage: LoadedPage = {
      ...page,
      details: {
        ...page.details,
        storage: '<p>Owner: <ac:link><ri:user ri:account-id="synthetic-user-id"/></ac:link></p>',
      },
    };
    let stored: StoredPdfJob | undefined;
    let bundle: PdfSourceBundle | undefined;
    const requestedUrls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        accountId: "synthetic-user-id",
        displayName: "Example Person",
        accountStatus: "active",
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    try {
      await runPdfExport(
        { page: mentionPage, pageUrl: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123/Guide" },
        {
          makeJobId: () => jobId,
          cleanupJobs: async () => 0,
          createJob: async (input) => {
            bundle = input.bundle;
            stored = {
              id: input.id,
              sourceIdentity: input.sourceIdentity,
              createdAt: 1,
              status: "prepared",
              inputBytes: 1,
              bundle: input.bundle,
            };
            return stored;
          },
          sendMessage: async () => {
            stored = { ...stored!, status: "complete", pdf: validPdf, compilerVersion: "test" };
            return { kind: "pdf:compile-result", jobId, ok: true };
          },
          getJob: async () => stored,
          deleteJob: async () => undefined,
          download: async () => undefined,
        }
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain("/wiki/rest/api/user?accountId=synthetic-user-id");
    expect(bundle?.main).toContain("@Example Person");
    expect(bundle?.main).not.toContain("synthetic-user-id");
  });

  it("prepares, compiles, downloads and cleans a correlated job", async () => {
    let bundle: PdfSourceBundle | undefined;
    let stored: StoredPdfJob | undefined;
    let deleted = false;
    const phases: PdfExportPhase[] = [];
    const downloads: Array<{ name: string; bytes: number[] }> = [];
    let clock = 1_000;

    const report = await runPdfExport(
      {
        page,
        pageUrl: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123/Guide",
        theme: { colors: { paper: "#FFFDF5", ink: "#102040" } },
        onPhase: (phase) => phases.push(phase),
      },
      {
        now: () => (clock += 5),
        makeJobId: () => jobId,
        cleanupJobs: async () => 0,
        createJob: async (input) => {
          bundle = input.bundle;
          stored = {
            id: input.id,
            sourceIdentity: input.sourceIdentity,
            createdAt: 1,
            status: "prepared",
            inputBytes: 1,
            bundle: input.bundle,
          };
          return stored;
        },
        sendMessage: async (message) => {
          if (message.kind === "pdf:compile") {
            stored = {
              ...stored!,
              status: "complete",
              pdf: validPdf,
              compilerVersion: "test",
            };
            return { kind: "pdf:compile-result", jobId, ok: true };
          }
          return { kind: "pdf:cancel-result", jobId, cancelled: true };
        },
        getJob: async () => stored,
        deleteJob: async () => { deleted = true; },
        download: async (name, bytes) => { downloads.push({ name, bytes: [...bytes] }); },
      }
    );

    expect(bundle?.main).toContain("#heading(level: 1");
    expect(bundle?.template).toContain('let cover-paper = rgb("#FFFDF5")');
    expect(bundle?.template).toContain('fill: rgb("#102040")');
    expect(phases).toEqual([
      "preparing",
      "fetching",
      "queued",
      "compiling",
      "validating",
      "downloading",
    ]);
    expect(downloads).toEqual([{ name: "Guide- A-B-.pdf", bytes: [...validPdf] }]);
    expect(report.filename).toBe("Guide- A-B-.pdf");
    expect(report.compilerVersion).toBe("test");
    expect(report.pageCount).toBe(1);
    expect(deleted).toBe(true);
  });

  it("cancels and never downloads after navigation abort", async () => {
    const controller = new AbortController();
    let resolveCompile: ((value: unknown) => void) | undefined;
    let cancelMessages = 0;
    let downloads = 0;
    let stored: StoredPdfJob | undefined;
    const promise = runPdfExport(
      { page, pageUrl: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123/Guide", signal: controller.signal },
      {
        makeJobId: () => jobId,
        cleanupJobs: async () => 0,
        createJob: async (input) => {
          stored = { id: input.id, sourceIdentity: input.sourceIdentity, createdAt: 1, status: "prepared", inputBytes: 1, bundle: input.bundle };
          return stored;
        },
        sendMessage: (message) => {
          if (message.kind === "pdf:cancel") {
            cancelMessages += 1;
            return Promise.resolve({ kind: "pdf:cancel-result", jobId, cancelled: true });
          }
          return new Promise((resolve) => { resolveCompile = resolve; });
        },
        getJob: async () => stored,
        deleteJob: async () => undefined,
        download: async () => { downloads += 1; },
      }
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    resolveCompile?.({ kind: "pdf:compile-result", jobId, ok: false, error: "cancelled" });
    await expect(promise).rejects.toHaveProperty("name", "AbortError");
    expect(cancelMessages).toBe(1);
    expect(downloads).toBe(0);
  });

  it("cleans a job when navigation aborts while it is being stored", async () => {
    const controller = new AbortController();
    let deleted = false;
    let compileMessages = 0;
    await expect(
      runPdfExport(
        { page, pageUrl: "https://acme.atlassian.net/wiki/spaces/DOCSY/pages/123/Guide", signal: controller.signal },
        {
          makeJobId: () => jobId,
          cleanupJobs: async () => 0,
          createJob: async (input) => {
            controller.abort();
            return {
              id: input.id,
              sourceIdentity: input.sourceIdentity,
              createdAt: 1,
              status: "prepared",
              inputBytes: 1,
              bundle: input.bundle,
            };
          },
          sendMessage: async () => {
            compileMessages += 1;
            return undefined;
          },
          deleteJob: async () => {
            deleted = true;
          },
        }
      )
    ).rejects.toHaveProperty("name", "AbortError");
    expect(compileMessages).toBe(0);
    expect(deleted).toBe(true);
  });
});
