/**
 * Watching a job through its durable record (spec 010 T5.6).
 *
 * `extensionPdfCompilePort` used to hold one `await chrome.runtime.sendMessage`
 * open for the entire compile and treat its resolution as the result. That is a
 * promise across a **service worker Chrome may terminate at any time**: a
 * terminated worker drops the open message with no response and no rejection
 * anyone can attribute, so the panel hangs while the job itself is fine and its
 * record in `atlcli-pdf` is being updated by the offscreen worker throughout.
 *
 * So the message becomes an optimization and the record becomes the truth. This
 * module is the "read the truth" half: poll the meta record (numbers and short
 * strings — the cheap read the store split exists to provide) until the job is
 * terminal, gone, or past its deadline.
 *
 * The deadline is the part that makes the guarantee complete: a job whose worker
 * never reports back **ends `failed` with a recoverable error**, never stuck at
 * `queued`/`compiling` forever.
 */
import {
  failPdfJob,
  getPdfJobMeta,
  type StoredPdfJobMeta,
} from "../pdf/job-store.js";
import { PDF_JOB_TIMED_OUT_ERROR, isPdfJobTerminal } from "./model.js";

/** How often the record is re-read while a job runs. */
export const PDF_JOB_POLL_MS = 750;

export interface WatchPdfJobOptions {
  /** Wall clock past which an unfinished job is declared failed. */
  deadlineAt: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  getMeta?: (id: string) => Promise<StoredPdfJobMeta | undefined>;
  fail?: (id: string, error: string) => Promise<StoredPdfJobMeta | undefined>;
}

export interface PdfJobWatch {
  /**
   * Resolves with the terminal record, or `undefined` when the record vanished
   * (deleted by a sweep, or by another watcher that consumed it) or the watch
   * was stopped.
   */
  promise: Promise<StoredPdfJobMeta | undefined>;
  /** Stop polling. The promise resolves with `undefined`. */
  stop(): void;
}

/**
 * A sleep that can be cut short.
 *
 * `stop()` must actually stop: a watch left sitting in a plain `setTimeout` for
 * its full poll interval keeps a timer (and, in a test runner, the process)
 * alive after the caller has already moved on.
 */
function cancellableSleeper(): { sleep: (ms: number) => Promise<void>; wake: () => void } {
  let wake: (() => void) | null = null;
  return {
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
        wake = () => {
          clearTimeout(timer);
          wake = null;
          resolve();
        };
      }),
    wake: () => wake?.(),
  };
}

/**
 * Watch one job to a terminal state.
 *
 * Never rejects: an unreadable store is a reason to keep waiting for the
 * deadline, not to fail a compile that may well be succeeding. The caller races
 * this against the message channel and reads the record afterwards either way.
 */
export function watchPdfJob(id: string, options: WatchPdfJobOptions): PdfJobWatch {
  const pollMs = options.pollMs ?? PDF_JOB_POLL_MS;
  const now = options.now ?? (() => Date.now());
  const sleeper = cancellableSleeper();
  const sleep = options.sleep ?? sleeper.sleep;
  const getMeta = options.getMeta ?? ((jobId: string) => getPdfJobMeta(jobId));
  const fail = options.fail ?? ((jobId: string, error: string) => failPdfJob(jobId, error));
  let stopped = false;

  const promise = (async (): Promise<StoredPdfJobMeta | undefined> => {
    for (;;) {
      if (stopped) return undefined;
      // A read that THREW is transient (the store may be busy, or unavailable in
      // this context); a read that SUCCEEDED and found nothing means the record
      // is gone. Collapsing the two would turn every unreadable store into
      // "your export vanished".
      let meta: StoredPdfJobMeta | undefined;
      let read = true;
      try {
        meta = await getMeta(id);
      } catch {
        read = false;
      }
      if (stopped) return undefined;
      if (read && !meta) return undefined;
      if (meta && isPdfJobTerminal(meta.status)) return meta;
      if (now() > options.deadlineAt) {
        // The worker never reported back. Ending the record is what keeps
        // "durable" from meaning "stuck": the panel gets a failure it can
        // explain and the user gets a job they can start again.
        const failed = await fail(id, PDF_JOB_TIMED_OUT_ERROR).catch(() => undefined);
        return failed ?? meta;
      }
      await sleep(pollMs);
    }
  })();

  return {
    promise,
    stop: () => {
      stopped = true;
      sleeper.wake();
    },
  };
}
