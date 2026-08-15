import type { PdfJobKind } from "../messages.js";
import { cancelPdfJob, failPdfJob } from "./job-store.js";
import {
  isPdfWorkerResponse,
  type PdfWorkerRequest,
  type PdfWorkerResponse,
} from "./worker-protocol.js";

export type { PdfJobKind };

export interface PdfWorkerLike {
  postMessage(message: PdfWorkerRequest): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/**
 * The error a superseded preview resolves with.
 *
 * Travels back to the panel as `PdfWorkerResponse.error` →
 * `pdf:compile-result.error` → the thrown message from
 * `extensionPdfCompilePort`, so `utils/pdf/preview.ts` can tell "your preview
 * is stale, silently drop it" apart from a genuine compile failure without a
 * protocol change. {@link isPreviewSupersededError} is the matcher.
 */
export const PREVIEW_SUPERSEDED_ERROR = "PDF preview was superseded by a newer request.";

/** True when `error` is the cooperative-supersession signal, not a failure. */
export function isPreviewSupersededError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message === PREVIEW_SUPERSEDED_ERROR;
}

export interface PdfCompileJobOptions {
  /** Defaults to `"export"` — the conservative choice for any caller that has not opted in. */
  kind?: PdfJobKind;
  /**
   * Estimated *source* pages in this job (chapters, not compiled PDF pages),
   * used only to scale the hang timeout. Absent/invalid → 1.
   */
  pages?: number;
}

export interface ChromeWorkerCompilerHostOptions {
  createWorker: () => PdfWorkerLike;
  /** Timeout budget for a one-page job. Kept named `timeoutMs` for compatibility. */
  timeoutMs?: number;
  /** Added per source page beyond the first. */
  perPageTimeoutMs?: number;
  /** Hard ceiling, so a bogus page count cannot disable the hang detector. */
  maxTimeoutMs?: number;
  schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clear?: (id: ReturnType<typeof setTimeout>) => void;
  failJob?: (jobId: string, error: string) => Promise<unknown>;
  cancelJob?: (jobId: string) => Promise<unknown>;
}

interface QueueItem {
  jobId: string;
  kind: PdfJobKind;
  pages: number;
  resolve: (value: PdfWorkerResponse) => void;
  /** Set when a newer job made this preview's result irrelevant. */
  superseded: boolean;
}

/** Base timeout — one page, one compile. Unchanged from the pre-T5.3 flat value. */
export const PDF_COMPILE_BASE_TIMEOUT_MS = 60_000;
/** Added per source page beyond the first (a 200-page space export gets ~5.5 min). */
export const PDF_COMPILE_PER_PAGE_TIMEOUT_MS = 1_500;
/** Ceiling. Above this a compile is a hang whatever the page count claims. */
export const PDF_COMPILE_MAX_TIMEOUT_MS = 15 * 60_000;

function supersededResponse(jobId: string): PdfWorkerResponse {
  return {
    kind: "pdf-worker:complete",
    jobId,
    ok: false,
    error: PREVIEW_SUPERSEDED_ERROR,
    fatal: false,
  };
}

/**
 * Single-worker FIFO with hard timeout and cancellation — the **Chrome
 * offscreen-document adapter**, not an abstract compiler contract.
 *
 * Renamed from `PdfCompilerHost` in spec 010 Phase 0 to settle a name
 * collision: `forge-export-app/SPIKE.md` uses `PdfCompilerHost` for the
 * abstract `compile(bundle, signal)` seam, while this class is one host's
 * implementation of a job queue around a dedicated `Worker`. Two different
 * things at two different layers must not share a name. The generic name is
 * left free for the seam; the abstract contract this class ultimately serves is
 * already `PdfCompilePort` (`@atlcli/pdf`).
 *
 * ## The job-kind scheduling contract (spec 010 T5.3)
 *
 * Preview and export share one worker on purpose: `workers/pdf-compiler.ts`
 * memoizes `compilerPromise`, so wasm + font initialization is paid once per
 * worker lifetime and every later compile is warm. Three rules keep that true
 * while a debounced preview loop runs:
 *
 *   1. **An export always jumps the queue.** {@link takeNext} picks the first
 *      queued `export` ahead of any queued `preview`, so a preview can delay an
 *      export by at most the one compile already in flight — never by a queue
 *      of debounced ones.
 *   2. **Only a newer preview supersedes an older one, and it does so
 *      cooperatively.** `cancel()`'s {@link destroyWorker} branch drops the
 *      memoized `compilerPromise` with the worker, making the *next* compile
 *      pay a full cold wasm+font init. Preview churn must therefore never reach
 *      it: a queued stale preview is resolved with
 *      {@link PREVIEW_SUPERSEDED_ERROR} and removed before it ever becomes a
 *      compile, and an in-flight one runs to completion (keeping the worker
 *      warm) and *then* reports itself superseded so the caller discards it.
 *   3. **`destroyWorker()` stays reserved for a user-initiated export cancel**
 *      (and for the fatal/timeout paths, where the worker is already unusable).
 *
 * An **export deliberately does not supersede a preview**. Rule 1 already means
 * it never waits behind one, and the queued preview is still the latest thing
 * the user asked to see — discarding it would throw away work the user wants
 * and that the warm worker will produce cheaply. Only a *newer preview* makes
 * an older preview meaningless, and that is exactly what rule 2 keys on.
 *
 * ## Timeout scaling
 *
 * The flat 60 s timeout was written for single-page exports. A 200-page space
 * compile is not a hang, so the budget is
 * `base + perPage × (pages − 1)`, clamped to {@link PDF_COMPILE_MAX_TIMEOUT_MS}.
 * `pages` counts *source* pages (chapters), which is all the caller can know
 * before compiling — the compiled `pageCount` only exists after
 * `validatePdfOutput`.
 */
export class ChromeWorkerCompilerHost {
  private readonly queue: QueueItem[] = [];
  private worker: PdfWorkerLike | null = null;
  private active: QueueItem | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly baseTimeoutMs: number;
  private readonly perPageTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly schedule: NonNullable<ChromeWorkerCompilerHostOptions["schedule"]>;
  private readonly clear: NonNullable<ChromeWorkerCompilerHostOptions["clear"]>;

  constructor(private readonly options: ChromeWorkerCompilerHostOptions) {
    this.baseTimeoutMs = options.timeoutMs ?? PDF_COMPILE_BASE_TIMEOUT_MS;
    this.perPageTimeoutMs = options.perPageTimeoutMs ?? PDF_COMPILE_PER_PAGE_TIMEOUT_MS;
    this.maxTimeoutMs = options.maxTimeoutMs ?? PDF_COMPILE_MAX_TIMEOUT_MS;
    this.schedule = options.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.clear = options.clear ?? ((id) => clearTimeout(id));
  }

  /**
   * Enqueue a compile.
   *
   * A **preview** supersedes every preview already in the system: queued ones
   * are resolved and removed on the spot (so the caller stops waiting and its
   * job record is released immediately), the active one is marked and allowed
   * to finish. An **export** supersedes nothing; it simply takes priority.
   */
  compile(jobId: string, options: PdfCompileJobOptions = {}): Promise<PdfWorkerResponse> {
    const kind = options.kind ?? "export";
    const pages = normalizePages(options.pages);
    return new Promise((resolve) => {
      if (kind === "preview") this.supersedePreviews();
      this.queue.push({ jobId, kind, pages, resolve, superseded: false });
      this.pump();
    });
  }

  /**
   * Cancel a job.
   *
   * A queued job of either kind is removed and reported cancelled. An **active
   * export** is the only path that terminates the worker — that is a
   * user-initiated abort, where paying a cold restart is the correct trade. An
   * **active preview** is instead marked superseded: it keeps the worker warm
   * and resolves with {@link PREVIEW_SUPERSEDED_ERROR} when it finishes.
   */
  async cancel(jobId: string): Promise<boolean> {
    const queued = this.queue.findIndex((item) => item.jobId === jobId);
    if (queued >= 0) {
      const [item] = this.queue.splice(queued, 1);
      await (this.options.cancelJob ?? cancelPdfJob)(jobId).catch(() => undefined);
      item!.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error: "PDF export was cancelled.", fatal: false });
      return true;
    }
    if (this.active?.jobId !== jobId) return false;
    const item = this.active;
    if (item.kind === "preview") {
      // Cooperative: never tear down the warm worker for preview traffic. The
      // compile finishes and its result is discarded by the caller.
      item.superseded = true;
      return true;
    }
    await (this.options.cancelJob ?? cancelPdfJob)(jobId).catch(() => undefined);
    this.destroyWorker();
    this.active = null;
    item.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error: "PDF export was cancelled.", fatal: false });
    this.pump();
    return true;
  }

  get activeCount(): number {
    return this.active ? 1 : 0;
  }

  /** Observable scheduling state — used by tests and by offscreen diagnostics. */
  get pending(): { active: PdfJobKind | null; queued: readonly PdfJobKind[] } {
    return {
      active: this.active?.kind ?? null,
      queued: this.queue.filter((item) => !item.superseded).map((item) => item.kind),
    };
  }

  /** Compile budget for a job of `pages` source pages. Pure; exported for tests. */
  timeoutForPages(pages: number): number {
    const normalized = normalizePages(pages);
    return Math.min(
      this.maxTimeoutMs,
      this.baseTimeoutMs + this.perPageTimeoutMs * (normalized - 1)
    );
  }

  /**
   * Make every preview already in the system stale. Never touches the worker.
   *
   * Queued previews are resolved *now* rather than at their turn: a caller left
   * awaiting a result it can no longer use would hold its job record (and the
   * panel's "compiling" state) for the length of whatever runs before it.
   */
  private supersedePreviews(): void {
    if (this.active?.kind === "preview") this.active.superseded = true;
    const stale = this.queue.filter((item) => item.kind === "preview");
    if (stale.length === 0) return;
    for (let index = this.queue.length - 1; index >= 0; index -= 1) {
      if (this.queue[index]!.kind === "preview") this.queue.splice(index, 1);
    }
    for (const item of stale) item.resolve(supersededResponse(item.jobId));
  }

  private getWorker(): PdfWorkerLike {
    if (this.worker) return this.worker;
    const worker = this.options.createWorker();
    worker.onmessage = (event) => this.handleMessage(event.data);
    worker.onerror = (event) => this.handleFatal(event.message || "PDF compiler worker failed.");
    this.worker = worker;
    return worker;
  }

  /** Next job to run: the first queued export, else the head of the queue. */
  private takeNext(): QueueItem | undefined {
    if (this.queue.length === 0) return undefined;
    const exportIndex = this.queue.findIndex((item) => item.kind === "export");
    return this.queue.splice(exportIndex >= 0 ? exportIndex : 0, 1)[0];
  }

  private pump(): void {
    while (!this.active) {
      const item = this.takeNext();
      if (!item) return;
      if (item.superseded) {
        // Defensive: `supersedePreviews` removes queued previews eagerly, but a
        // re-entrant `compile()` from a synchronous `resolve` below could mark
        // one mid-drain. Never send a stale preview to the worker.
        item.resolve(supersededResponse(item.jobId));
        continue;
      }
      this.active = item;
      const worker = this.getWorker();
      this.timer = this.schedule(
        () => this.handleTimeout(item.jobId),
        this.timeoutForPages(item.pages)
      );
      worker.postMessage({ kind: "pdf-worker:compile", jobId: item.jobId });
      return;
    }
  }

  private handleMessage(value: unknown): void {
    if (!isPdfWorkerResponse(value) || !this.active || value.jobId !== this.active.jobId) return;
    const item = this.active;
    this.clearTimer();
    this.active = null;
    if (!value.ok && value.fatal) this.destroyWorker();
    // A superseded preview still ran to completion — that is what keeps the
    // worker (and its memoized compiler) warm — but its bytes are stale, so the
    // caller is told to discard rather than handed a result it must guess about.
    item.resolve(item.superseded ? supersededResponse(item.jobId) : value);
    this.pump();
  }

  private handleTimeout(jobId: string): void {
    if (!this.active || this.active.jobId !== jobId) return;
    const item = this.active;
    this.active = null;
    this.destroyWorker();
    const error = `PDF compilation timed out after ${this.timeoutForPages(item.pages)} ms.`;
    void (this.options.failJob ?? failPdfJob)(jobId, error).catch(() => undefined);
    item.resolve({ kind: "pdf-worker:complete", jobId, ok: false, error, fatal: true });
    this.pump();
  }

  private handleFatal(error: string): void {
    if (!this.active) return;
    const item = this.active;
    this.active = null;
    this.destroyWorker();
    void (this.options.failJob ?? failPdfJob)(item.jobId, error).catch(() => undefined);
    item.resolve({ kind: "pdf-worker:complete", jobId: item.jobId, ok: false, error, fatal: true });
    this.pump();
  }

  private clearTimer(): void {
    if (this.timer !== null) this.clear(this.timer);
    this.timer = null;
  }

  private destroyWorker(): void {
    this.clearTimer();
    if (this.worker) {
      this.worker.onmessage = null;
      this.worker.onerror = null;
      this.worker.terminate();
    }
    this.worker = null;
  }
}

function normalizePages(pages: number | undefined): number {
  if (typeof pages !== "number" || !Number.isFinite(pages)) return 1;
  return Math.max(1, Math.floor(pages));
}
