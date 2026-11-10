/** Package-private helpers shared by the job modules. Not exported from any index. */
import type {
  ExportJobExecutionContext,
  ExportJobProgressV1,
  ExportJobResultTelemetryV1,
  ExportReportSummaryV1,
  ResourceEstimateV1,
} from "@atlcli/export-jobs";

const KEY_ORDER = new Intl.Collator("en");

/**
 * Order of canonical JSON keys and of every other string that feeds a digest
 * or a stored comparison. It is pinned to English collation, which is what
 * the former default-locale `localeCompare` produced on English hosts, so
 * stored digests stay valid while lt/cs/... hosts now agree.
 */
export function compareCanonicalKeys(left: string, right: string): number {
  return KEY_ORDER.compare(left, right);
}

/**
 * Canonical JSON. With `strictLabel` the value must be finite, acyclic plain
 * data and failures name that payload.
 */
export function canonicalJson(
  value: unknown,
  strictLabel?: string,
  ancestors = new Set<object>(),
): string {
  if (value === null || typeof value !== "object") {
    if (strictLabel && typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${strictLabel} contains a non-finite number.`);
    }
    return JSON.stringify(value);
  }
  if (strictLabel && ancestors.has(value)) throw new Error(`${strictLabel} contains a cycle.`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => canonicalJson(entry, strictLabel, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (strictLabel && prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${strictLabel} must contain only plain data objects.`);
    }
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => compareCanonicalKeys(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, strictLabel, ancestors)}`)
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Export job was cancelled.", "AbortError");
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortReason(signal);
}

export async function sha256Hex(bytes: Uint8Array, signal?: AbortSignal): Promise<string> {
  if (signal) throwIfAborted(signal);
  // WebCrypto snapshots its input synchronously and digesting a typed-array
  // VIEW hashes exactly the view's range, so no copy is needed. Only a
  // SharedArrayBuffer-backed view (which WebCrypto rejects) still copies.
  const source: Uint8Array<ArrayBuffer> =
    bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", source));
  if (signal) throwIfAborted(signal);
  return [...digest].map((value) => value.toString(16).padStart(2, "0")).join("");
}

/**
 * Serialises async progress writes fired from a synchronous engine callback.
 * The chain itself never rejects: a rejected chain nobody awaits until the
 * engine finishes would surface as an unhandled rejection. The first failure
 * stops later writes and is rethrown by `settled()`.
 */
export function serialProgressChannel<Event>(
  publish: (event: Event) => void | Promise<void>,
): { callback: (event: Event) => void; settled(): Promise<void> } {
  let pending: Promise<void> = Promise.resolve();
  let failure: { error: unknown } | undefined;
  return {
    callback(event) {
      pending = pending
        .then(async () => {
          if (!failure) await publish(event);
        })
        .catch((error: unknown) => {
          failure ??= { error };
        });
    },
    async settled() {
      await pending;
      if (failure) throw failure.error;
    },
  };
}

// --- Shared by the DOCX and PDF job executors ---

export function nonNegativeSafeInteger(value: number, path: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative safe integer.`);
  }
}

export function nonNegativeFinite(value: number, path: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${path} must be a non-negative finite number.`);
  }
}

export function validateEstimate(estimate: ResourceEstimateV1): void {
  nonNegativeSafeInteger(estimate.heapBytes, "estimate.heapBytes");
  nonNegativeSafeInteger(estimate.spoolBytes, "estimate.spoolBytes");
  nonNegativeSafeInteger(estimate.outputBytes, "estimate.outputBytes");
  nonNegativeSafeInteger(estimate.rasterPixels, "estimate.rasterPixels");
  if (!(["measured", "estimated", "unknown"] as const).includes(estimate.confidence)) {
    throw new RangeError("estimate.confidence is invalid.");
  }
}

export function sameEstimate(left: ResourceEstimateV1, right: ResourceEstimateV1): boolean {
  return (
    left.heapBytes === right.heapBytes &&
    left.spoolBytes === right.spoolBytes &&
    left.outputBytes === right.outputBytes &&
    left.rasterPixels === right.rasterPixels &&
    left.confidence === right.confidence
  );
}

export function sameReportSummary(
  left: ExportReportSummaryV1 | undefined,
  right: ExportReportSummaryV1,
): boolean {
  return (
    left !== undefined &&
    canonicalJson(left, "Export report summary") === canonicalJson(right, "Export report summary")
  );
}

/** The twenty most frequent issue codes, ties in locale-independent code order. */
export function topReportCodes(codes: ReadonlyMap<string, number>): ExportReportSummaryV1["topCodes"] {
  return [...codes]
    .map(([code, count]) => ({ code, count }))
    .sort((left, right) => right.count - left.count || compareCanonicalKeys(left.code, right.code))
    .slice(0, 20);
}

export async function publishTelemetry(
  context: ExportJobExecutionContext,
  telemetry: ExportJobResultTelemetryV1,
): Promise<void> {
  await context.updateStats(telemetry.stats);
  for (const issue of telemetry.issues) await context.appendEvent(issue);
}

export function progress(
  context: ExportJobExecutionContext,
  now: () => number,
  stage: ExportJobProgressV1["stage"],
  done: number,
  total: number | null,
  detail: string,
): Promise<void> {
  return context.updateProgress({ stage, done, total, detail, updatedAt: now() });
}
