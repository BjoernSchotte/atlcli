import { describe, expect, it } from "bun:test";
import {
  computeWorkerMemoryAttribution,
  PDF_HOST_WASM_ATTRIBUTION_SCHEMA,
  type WorkerAttributionSample,
} from "./attribution.js";

const MIB = 1024 * 1024;

function sample(
  phase: string,
  heap: { used: number; embedder: number; backing: number },
  wasmMemoryBytes?: number
): WorkerAttributionSample {
  return {
    phase,
    heap: {
      usedSize: heap.used,
      totalSize: heap.used,
      embedderHeapUsedSize: heap.embedder,
      backingStorageSize: heap.backing,
    },
    ...(wasmMemoryBytes === undefined ? {} : { wasmMemoryBytes }),
  };
}

describe("host-versus-WASM memory attribution", () => {
  it("attributes phases when backing storage includes the WASM linear memory", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 10 * MIB, embedder: 1 * MIB, backing: 120 * MIB }, 100 * MIB),
      sample("vfs-ready", { used: 12 * MIB, embedder: 1 * MIB, backing: 160 * MIB }, 130 * MIB),
      sample("compiled-held", { used: 14 * MIB, embedder: 1 * MIB, backing: 200 * MIB }, 150 * MIB),
    ]);
    expect(attribution.schema).toBe(PDF_HOST_WASM_ATTRIBUTION_SCHEMA);
    expect(attribution.basis).toBe("backing-includes-wasm");
    expect(attribution.wasmHighWaterMiB).toBe(150);
    expect(attribution.wasmMonotonicGrowth).toBe(true);
    expect(attribution.peak.phase).toBe("compiled-held");
    expect(attribution.peak.totalMiB).toBe(215);
    expect(attribution.peak.wasmMiB).toBe(150);
    expect(attribution.peak.hostBackingOutsideWasmMiB).toBe(50);
    expect(attribution.peak.hostShare + attribution.peak.wasmShare).toBeCloseTo(1, 3);
  });

  it("does not subtract WASM bytes when backing storage excludes them", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 10 * MIB, embedder: 0, backing: 20 * MIB }, 100 * MIB),
      sample("compiled-held", { used: 12 * MIB, embedder: 0, backing: 30 * MIB }, 140 * MIB),
    ]);
    expect(attribution.basis).toBe("backing-excludes-wasm");
    // Total must then count host backing AND the separate WASM memory.
    expect(attribution.peak.totalMiB).toBe(12 + 30 + 140);
    expect(attribution.peak.hostBackingOutsideWasmMiB).toBe(30);
    expect(attribution.peak.wasmShare).toBeCloseTo(140 / 182, 3);
  });

  it("classifies a mixed series as backing-excludes-wasm rather than double-counting", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 1 * MIB, embedder: 0, backing: 200 * MIB }, 100 * MIB),
      sample("compiled-held", { used: 1 * MIB, embedder: 0, backing: 90 * MIB }, 100 * MIB),
    ]);
    expect(attribution.basis).toBe("backing-excludes-wasm");
  });

  it("reports wasm-unavailable honestly when no sample carries WASM bytes", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 10 * MIB, embedder: 1 * MIB, backing: 40 * MIB }),
      sample("compiled-held", { used: 11 * MIB, embedder: 1 * MIB, backing: 60 * MIB }),
    ]);
    expect(attribution.basis).toBe("wasm-unavailable");
    expect(attribution.wasmHighWaterMiB).toBe(0);
    expect(attribution.peak.wasmShare).toBe(0);
    expect(attribution.peak.hostShare).toBe(1);
  });

  it("clamps host backing outside WASM to zero instead of going negative", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 1 * MIB, embedder: 0, backing: 100 * MIB }, 100 * MIB),
    ]);
    expect(attribution.basis).toBe("backing-includes-wasm");
    expect(attribution.peak.hostBackingOutsideWasmMiB).toBe(0);
  });

  it("flags a shrinking WASM series as non-monotonic (measurement defect)", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("warm", { used: 1 * MIB, embedder: 0, backing: 150 * MIB }, 120 * MIB),
      sample("compiled-held", { used: 1 * MIB, embedder: 0, backing: 150 * MIB }, 110 * MIB),
    ]);
    expect(attribution.wasmMonotonicGrowth).toBe(false);
    expect(attribution.wasmHighWaterMiB).toBe(120);
  });

  it("selects the peak phase by total footprint, not by WASM size", () => {
    const attribution = computeWorkerMemoryAttribution([
      sample("vfs-ready", { used: 50 * MIB, embedder: 0, backing: 300 * MIB }, 100 * MIB),
      sample("compiled-held", { used: 10 * MIB, embedder: 0, backing: 200 * MIB }, 150 * MIB),
    ]);
    expect(attribution.peak.phase).toBe("vfs-ready");
  });

  it("rejects an empty sample list", () => {
    expect(() => computeWorkerMemoryAttribution([])).toThrow(
      "Attribution needs at least one worker heap sample."
    );
  });
});
