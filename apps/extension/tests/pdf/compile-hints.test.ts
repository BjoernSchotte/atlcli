/**
 * The scheduling hints that ride the compile message (spec 010 T5.3).
 *
 * They are **scalars only** — `job` and `pages`. The invariant that no PDF or
 * asset byte ever crosses `chrome.runtime.sendMessage` (IndexedDB is the byte
 * channel) is what makes background compiles survive a panel close, and adding
 * a scheduling field must not be the thing that erodes it.
 */
import { describe, expect, it } from "bun:test";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { isExtRequest, isOffscreenRequest } from "../../utils/messages.js";
import { routeMessage } from "../../utils/router.js";
import { handleExtMessage, handleOffscreenMessage } from "../../utils/listeners.js";
import { estimateSourcePages, extensionPdfCompilePort } from "../../utils/pdf/compile-port.js";
import type { StoredPdfJob } from "../../utils/pdf/job-store.js";

const JOB_ID = "123e4567-e89b-42d3-a456-426614174000";

function bundle(blockTypes: string[]): PdfSourceBundle {
  return {
    main: "= Doc",
    template: "t",
    assets: [],
    sourceMap: blockTypes.map((blockType) => ({
      blockPath: "0",
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
      blockType: blockType as never,
    })),
    notes: [],
  };
}

describe("estimateSourcePages", () => {
  it("counts chapters as 1 + page breaks", () => {
    expect(estimateSourcePages(bundle([]))).toBe(1);
    expect(estimateSourcePages(bundle(["heading", "paragraph"]))).toBe(1);
    expect(
      estimateSourcePages(bundle(["heading", "pageBreak", "heading", "pageBreak", "heading"]))
    ).toBe(3);
  });
});

describe("compile-hint validation", () => {
  it("accepts a compile request with and without hints", () => {
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID })).toBe(true);
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID, job: "preview", pages: 12 })).toBe(true);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId: JOB_ID, job: "export" })).toBe(true);
  });

  it("rejects a malformed hint rather than silently coercing it", () => {
    // Silent coercion would make "the sender lied" indistinguishable from "the
    // sender never set one" — and the bus is reachable by any extension page.
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID, job: "urgent" })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID, pages: "many" })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID, pages: 0 })).toBe(false);
    expect(isExtRequest({ kind: "pdf:compile", jobId: JOB_ID, pages: Number.NaN })).toBe(false);
    expect(isOffscreenRequest({ kind: "offscreen:pdf-compile", jobId: JOB_ID, job: 1 })).toBe(false);
  });

  it("carries no byte-bearing field", () => {
    const message = { kind: "pdf:compile" as const, jobId: JOB_ID, job: "preview" as const, pages: 3 };
    for (const value of Object.values(message)) {
      expect(typeof value === "string" || typeof value === "number").toBe(true);
    }
  });
});

describe("extensionPdfCompilePort emits the hints", () => {
  async function sentMessage(kind?: "preview" | "export"): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> = {};
    const stored: StoredPdfJob = {
      id: JOB_ID,
      sourceIdentity: "page:1",
      createdAt: 1,
      status: "complete",
      inputBytes: 1,
      outputBytes: 1,
      pdf: new Uint8Array([1]),
      diagnostics: [],
      compilerVersion: "test",
    };
    const port = extensionPdfCompilePort({
      sourceIdentity: "page:1",
      ...(kind ? { kind } : {}),
      makeJobId: () => JOB_ID,
      deps: {
        cleanupJobs: async () => 0,
        createJob: async () => ({ ...stored, status: "prepared" }),
        sendMessage: async (message) => {
          sent = message as unknown as Record<string, unknown>;
          return { kind: "pdf:compile-result", jobId: JOB_ID, ok: true };
        },
        getJob: async () => stored,
        deleteJob: async () => undefined,
      },
    });
    await port.compile(bundle(["heading", "pageBreak", "heading"]));
    return sent;
  }

  it("tags a preview port's compiles as previews and estimates the page count", async () => {
    expect(await sentMessage("preview")).toMatchObject({ job: "preview", pages: 2 });
  });

  it("defaults to export when the caller did not opt in", async () => {
    expect(await sentMessage()).toMatchObject({ job: "export" });
  });
});

describe("hint routing", () => {
  it("threads the hints through the router to the compile effect", async () => {
    const seen: unknown[] = [];
    await routeMessage(
      { kind: "pdf:compile", jobId: JOB_ID, job: "preview", pages: 7 },
      {
        runWasmSmoke: async () => 0,
        getCurrentEntity: async () => ({ windowId: 1, url: null, entity: null, seq: 1 }),
        runPdfCompile: async (_jobId, hints) => {
          seen.push(hints);
          return { ok: true };
        },
        runPdfCancel: async () => true,
      }
    );
    expect(seen).toEqual([{ job: "preview", pages: 7 }]);
  });

  it("threads the hints through the panel-facing listener", async () => {
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      handleExtMessage(
        { kind: "pdf:compile", jobId: JOB_ID, job: "export", pages: 2 },
        () => resolve(),
        {
          runWasmSmoke: async () => 0,
          getCurrentEntity: async () => ({ windowId: 1, url: null, entity: null, seq: 1 }),
          runPdfCompile: async (_jobId, hints) => {
            seen.push(hints);
            return { ok: true };
          },
          runPdfCancel: async () => true,
        }
      );
    });
    expect(seen).toEqual([{ job: "export", pages: 2 }]);
  });

  it("threads the hints through the offscreen listener", async () => {
    const seen: unknown[] = [];
    await new Promise<void>((resolve) => {
      handleOffscreenMessage(
        { kind: "offscreen:pdf-compile", jobId: JOB_ID, job: "preview", pages: 5 },
        () => resolve(),
        {
          runWasmAdd: async () => 0,
          runPdfCompile: async (_jobId, hints) => {
            seen.push(hints);
            return { ok: true };
          },
          runPdfCancel: async () => true,
        }
      );
    });
    expect(seen).toEqual([{ job: "preview", pages: 5 }]);
  });
});
