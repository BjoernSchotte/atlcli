/**
 * Host-versus-WASM memory attribution (functional core).
 *
 * Consumes per-phase compiler-worker heap samples (CDP `Runtime.getHeapUsage`)
 * plus the Typst WASM linear-memory byte length reported by the worker, and
 * produces the attribution record the Phase 0 gate of
 * `specs/issue-118-adaptive-browser-pdf-memory/PLAN.md` consumes: what share
 * of the worker peak is WASM-internal versus host-side.
 *
 * Pure and environment-free so it is unit-testable outside Chrome.
 */

export const PDF_HOST_WASM_ATTRIBUTION_SCHEMA = "atlcli.pdf-host-wasm-attribution/1";

export interface AttributionHeapSample {
  usedSize: number;
  totalSize: number;
  embedderHeapUsedSize: number;
  backingStorageSize: number;
}

export interface WorkerAttributionSample {
  phase: string;
  heap: AttributionHeapSample;
  /** Typst WASM linear-memory byteLength at this phase, when observable. */
  wasmMemoryBytes?: number;
}

/**
 * How WASM linear memory relates to CDP `backingStorageSize` in the measured
 * runtime. The relation is detected from the samples, never assumed: claiming
 * "backing includes WASM" when it does not would double-count host bytes.
 */
export type AttributionBasis =
  | "backing-includes-wasm"
  | "backing-excludes-wasm"
  | "wasm-unavailable";

export interface AttributedPhase {
  phase: string;
  wasmMiB: number;
  hostUsedMiB: number;
  hostEmbedderMiB: number;
  hostBackingOutsideWasmMiB: number;
  totalMiB: number;
  hostShare: number;
  wasmShare: number;
}

export interface WorkerMemoryAttributionV1 {
  schema: typeof PDF_HOST_WASM_ATTRIBUTION_SCHEMA;
  basis: AttributionBasis;
  wasmHighWaterMiB: number;
  /** Linear memory can only grow; false indicates a measurement defect. */
  wasmMonotonicGrowth: boolean;
  phases: AttributedPhase[];
  /** The phase with the largest total footprint. */
  peak: AttributedPhase;
}

const MIB = 1024 * 1024;

function mib(bytes: number): number {
  return Number((bytes / MIB).toFixed(2));
}

function share(part: number, total: number): number {
  if (total <= 0) return 0;
  return Number((part / total).toFixed(4));
}

function detectBasis(samples: readonly WorkerAttributionSample[]): AttributionBasis {
  const withWasm = samples.filter((sample) => typeof sample.wasmMemoryBytes === "number");
  if (withWasm.length === 0) return "wasm-unavailable";
  const excluded = withWasm.some(
    (sample) => (sample.wasmMemoryBytes ?? 0) > sample.heap.backingStorageSize
  );
  return excluded ? "backing-excludes-wasm" : "backing-includes-wasm";
}

function attributePhase(
  sample: WorkerAttributionSample,
  basis: AttributionBasis
): AttributedPhase {
  const wasmBytes = typeof sample.wasmMemoryBytes === "number" ? sample.wasmMemoryBytes : 0;
  const { usedSize, embedderHeapUsedSize, backingStorageSize } = sample.heap;
  const hostBackingOutsideWasm =
    basis === "backing-includes-wasm"
      ? Math.max(0, backingStorageSize - wasmBytes)
      : backingStorageSize;
  const totalBytes =
    basis === "backing-excludes-wasm"
      ? usedSize + embedderHeapUsedSize + backingStorageSize + wasmBytes
      : usedSize + embedderHeapUsedSize + backingStorageSize;
  return {
    phase: sample.phase,
    wasmMiB: mib(wasmBytes),
    hostUsedMiB: mib(usedSize),
    hostEmbedderMiB: mib(embedderHeapUsedSize),
    hostBackingOutsideWasmMiB: mib(hostBackingOutsideWasm),
    totalMiB: mib(totalBytes),
    hostShare: share(totalBytes - wasmBytes, totalBytes),
    wasmShare: share(wasmBytes, totalBytes),
  };
}

export function computeWorkerMemoryAttribution(
  samples: readonly WorkerAttributionSample[]
): WorkerMemoryAttributionV1 {
  if (samples.length === 0) {
    throw new Error("Attribution needs at least one worker heap sample.");
  }
  const basis = detectBasis(samples);
  const phases = samples.map((sample) => attributePhase(sample, basis));
  const wasmSeries = samples
    .map((sample) => sample.wasmMemoryBytes)
    .filter((bytes): bytes is number => typeof bytes === "number");
  const wasmMonotonicGrowth = wasmSeries.every(
    (bytes, index) => index === 0 || bytes >= (wasmSeries[index - 1] ?? 0)
  );
  const peak = phases.reduce((max, phase) => (phase.totalMiB > max.totalMiB ? phase : max));
  return {
    schema: PDF_HOST_WASM_ATTRIBUTION_SCHEMA,
    basis,
    wasmHighWaterMiB: mib(wasmSeries.length ? Math.max(...wasmSeries) : 0),
    wasmMonotonicGrowth,
    phases,
    peak,
  };
}
