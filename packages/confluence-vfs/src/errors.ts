/**
 * REST failure to POSIX error mapping (WP1.5).
 *
 * One rule decides most of this: **the filesystem must not reveal what the
 * caller may not see.** Confluence answers 404 for a page that exists but is
 * restricted, and so do we — a restricted page is `ENOENT`, never `EACCES`.
 * `EACCES` is reserved for failures of *our own* credentials (401) and for
 * denials Confluence itself chose to make visible (403).
 */
import { parseRetryAfterMs } from "@atlcli/core/internal";
import { VfsError, type VfsErrorCode } from "./types.js";

/** Pulls an HTTP status off whatever the client threw. */
export function httpStatusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number" && status >= 100 && status < 600) return status;
  // The client's error classes are module-private, so fall back to the shape of
  // the message they build: "Confluence API error (404): ...".
  const message = (error as { message?: unknown }).message;
  if (typeof message === "string") {
    const match = /\((\d{3})\)/.exec(message);
    if (match) {
      const parsed = Number(match[1]);
      if (parsed >= 100 && parsed < 600) return parsed;
    }
  }
  return undefined;
}

/** Retry-After in milliseconds, when the thrown error or its response carried one. */
export function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const direct = (error as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof direct === "number" && Number.isFinite(direct) && direct >= 0) return direct;
  const header = (error as { retryAfter?: unknown }).retryAfter;
  if (typeof header === "string") return parseRetryAfterMs(header);
  return undefined;
}

const STATUS_CODES: Record<number, VfsErrorCode> = {
  400: "EINVAL",
  401: "EACCES",
  403: "EACCES",
  404: "ENOENT",
  405: "EROFS",
  409: "EBUSY",
  413: "ENOSPC",
  429: "EAGAIN",
  507: "ENOSPC",
};

function describe(status: number, path: string | undefined): string {
  const at = path ? ` at ${path}` : "";
  switch (status) {
    case 400:
      return `Confluence rejected the request${at} as invalid (400)`;
    case 401:
      return `Not authenticated${at}: the profile's API token was rejected (401). Re-run 'atlcli auth login'`;
    case 403:
      return `Not permitted${at} (403)`;
    case 404:
      return `No such file or directory${at}`;
    case 405:
      return `Confluence does not support this operation${at} (405)`;
    case 409:
      return `Conflict${at} (409): the page changed on the server since it was cached`;
    case 413:
      return `Too large${at} (413)`;
    case 429:
      return `Rate limited by Confluence${at} (429)`;
    case 507:
      return `Confluence reports insufficient storage${at} (507)`;
    default:
      return `Confluence request failed${at} (${status})`;
  }
}

/**
 * Turn anything thrown by the REST client into a {@link VfsError}.
 *
 * An error that is already a `VfsError` passes through untouched, so nested
 * calls do not re-wrap and lose their original code.
 */
export function mapClientError(error: unknown, path?: string): VfsError {
  if (error instanceof VfsError) return error;
  const status = httpStatusOf(error);
  if (status === undefined) {
    const message = error instanceof Error ? error.message : String(error);
    return new VfsError("EINVAL", `Confluence request failed: ${message}`, { path, cause: error });
  }
  const code = STATUS_CODES[status] ?? (status >= 500 ? "EAGAIN" : "EINVAL");
  let message = describe(status, path);
  if (status === 429) {
    const waitMs = retryAfterMsOf(error);
    message +=
      waitMs === undefined
        ? ". Retries are exhausted; lower --concurrency and try again"
        : `. Retry after ${Math.ceil(waitMs / 1000)} s; lower --concurrency to stay under the burst limit`;
  }
  if (status >= 500) {
    message = `Confluence is unavailable${path ? ` for ${path}` : ""} (${status}); the request was retried and still failed`;
  }
  return new VfsError(code, message, { path, status, cause: error });
}

export interface RateLimitRetryOptions {
  /** Attempts *after* the first. Default 2. */
  retries?: number;
  /** Used when the server sent no `Retry-After`. Default 1000 ms, doubling. */
  baseDelayMs?: number;
  /** Injectable sleep so tests do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** Called once per wait, so a frontend can warn above five seconds. */
  onWait?: (waitMs: number, attempt: number) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `task`, retrying only on 429.
 *
 * The REST client already retries 429 three times internally; this is the outer
 * band that keeps a *batch* alive when the client gives up mid-prefetch, and it
 * is the only place that adds jitter. Every other status fails immediately —
 * retrying a 404 or a 409 just spends the rate-limit budget faster.
 */
export async function withRateLimitRetry<T>(
  task: () => Promise<T>,
  options: RateLimitRetryOptions = {},
): Promise<T> {
  const retries = options.retries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await task();
    } catch (error) {
      const status = httpStatusOf(error);
      if (status !== 429 || attempt >= retries) throw mapClientError(error);
      const waitMs =
        retryAfterMsOf(error) ??
        // Full jitter: a synchronized retry storm is what produced the 429.
        Math.round(baseDelayMs * 2 ** attempt * (0.5 + Math.random() * 0.5));
      options.onWait?.(waitMs, attempt + 1);
      await sleep(waitMs);
    }
  }
}
