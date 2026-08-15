import { describe, expect, it } from "bun:test";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import { extensionPdfCompilePort } from "../../utils/pdf/compile-port.js";
import type { StoredPdfJob } from "../../utils/pdf/job-store.js";

const jobId = "123e4567-e89b-42d3-a456-426614174000";
const bundle: PdfSourceBundle = { main: "= Test", template: "template", assets: [], sourceMap: [], notes: [] };

/**
 * A record watch that never resolves, so these tests exercise the *message*
 * path in isolation. The record path has its own file
 * (`tests/pdf/job-durability.test.ts`), where it runs against a real
 * `fake-indexeddb` store rather than a stub.
 */
const neverSettlingWatch = (): { promise: Promise<undefined>; stop: () => void } => ({
  promise: new Promise<undefined>(() => undefined),
  stop: () => undefined,
});

describe("extensionPdfCompilePort", () => {
  it("persists, compiles, reads and deletes a correlated job", async () => {
    const events: string[] = [];
    let stored: StoredPdfJob | undefined;
    const port = extensionPdfCompilePort({
      sourceIdentity: "page:1",
      makeJobId: () => jobId,
      // The id is announced as soon as the durable record exists — that is the
      // seam a progress producer needs to name the job it is ticking.
      onJobCreated: (id) => events.push(id === jobId ? "created" : "wrong-id"),
      onQueued: () => events.push("queued"),
      onCompiling: () => events.push("compiling"),
      deps: {
        cleanupJobs: async () => { events.push("cleanup"); return 0; },
        createJob: async (input) => {
          events.push("store");
          stored = { ...input, createdAt: 1, status: "prepared", inputBytes: 1, outputBytes: 0 };
          return stored;
        },
        sendMessage: async (message) => {
          events.push(message.kind);
          stored = { ...stored!, status: "complete", pdf: new Uint8Array([1]), diagnostics: [], compilerVersion: "test" };
          return { kind: "pdf:compile-result", jobId, ok: true };
        },
        getJob: async () => stored,
        deleteJob: async () => { events.push("delete"); },
      },
    });
    const result = await port.compile(bundle);
    expect(result.compilerVersion).toBe("test");
    expect(events).toEqual(["cleanup", "store", "created", "queued", "compiling", "pdf:compile", "delete"]);
  });

  it("returns normalized diagnostics for a compiler failure", async () => {
    const diagnostic = { severity: "error" as const, message: "bad source", blockPath: "blocks[0]" };
    const failed: StoredPdfJob = {
      id: jobId, sourceIdentity: "page:1", createdAt: 1, status: "failed", inputBytes: 1, outputBytes: 0,
      bundle, diagnostics: [diagnostic], error: "bad source",
    };
    const port = extensionPdfCompilePort({
      sourceIdentity: "page:1",
      makeJobId: () => jobId,
      deps: {
        cleanupJobs: async () => 0,
        createJob: async () => ({ ...failed, status: "prepared" }),
        sendMessage: async () => ({ kind: "pdf:compile-result", jobId, ok: false, error: "bad source" }),
        getJob: async () => failed,
        deleteJob: async () => undefined,
      },
    });
    expect((await port.compile(bundle)).diagnostics).toEqual([diagnostic]);
  });

  /**
   * Cancellation, after T5.6 moved cleanup ownership off the panel.
   *
   * The message still goes out and the late completion is still rejected — but
   * the panel no longer deletes the record. It never consumed those bytes, and
   * `cancelPdfJob` (which runs on the offscreen side, the context that outlives
   * this panel) is what releases the bundle *and* leaves the `cancelled` meta
   * record the re-attach UI needs to tell "cancelled" from "never existed".
   */
  it("sends cancellation, rejects late completion and leaves cleanup to the compiler side", async () => {
    const controller = new AbortController();
    let finish: (() => void) | undefined;
    let cancels = 0;
    let deleted = 0;
    const prepared: StoredPdfJob = {
      id: jobId, sourceIdentity: "page:1", createdAt: 1, status: "prepared", inputBytes: 1, outputBytes: 0, bundle,
    };
    const port = extensionPdfCompilePort({
      sourceIdentity: "page:1",
      makeJobId: () => jobId,
      deps: {
        cleanupJobs: async () => 0,
        createJob: async () => prepared,
        sendMessage: (message) => {
          if (message.kind === "pdf:cancel") {
            cancels += 1;
            return Promise.resolve({ kind: "pdf:cancel-result", jobId, cancelled: true });
          }
          return new Promise((resolve) => { finish = () => resolve({ kind: "pdf:compile-result", jobId, ok: true }); });
        },
        getJob: async () => ({ ...prepared, status: "complete", pdf: new Uint8Array([1]) }),
        deleteJob: async () => { deleted += 1; },
        watchJob: neverSettlingWatch,
      },
    });
    const pending = port.compile(bundle, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    finish?.();
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(cancels).toBe(1);
    expect(deleted).toBe(0);
  });

  /**
   * A preview is the one job the panel still owns end to end: nobody
   * re-attaches to one, so leaving debounced churn in the shared store would be
   * a leak with no reader.
   */
  it("deletes a superseded preview even though it consumed nothing", async () => {
    let deleted = 0;
    const port = extensionPdfCompilePort({
      sourceIdentity: "page:1",
      kind: "preview",
      makeJobId: () => jobId,
      deps: {
        cleanupJobs: async () => 0,
        createJob: async () => ({
          id: jobId, sourceIdentity: "page:1", createdAt: 1, status: "prepared",
          inputBytes: 1, outputBytes: 0, bundle,
        }),
        sendMessage: async () => ({ kind: "pdf:compile-result", jobId, ok: false, error: "superseded" }),
        getJob: async () => ({
          id: jobId, sourceIdentity: "page:1", createdAt: 1, status: "cancelled",
          inputBytes: 0, outputBytes: 0, error: "superseded",
        }),
        deleteJob: async () => { deleted += 1; },
        watchJob: neverSettlingWatch,
      },
    });
    await expect(port.compile(bundle)).rejects.toThrow("superseded");
    expect(deleted).toBe(1);
  });
});
