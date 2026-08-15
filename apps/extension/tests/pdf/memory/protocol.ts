export type MemoryWorkerPhase =
  | "booting"
  | "warm"
  | "bundle-received"
  | "vfs-ready"
  | "compiled-held"
  | "complete"
  | "error";

export type MemoryWorkerRequest =
  | { kind: "warm" }
  | { kind: "compile"; jobId: string }
  | { kind: "continue" }
  | { kind: "shutdown" };

export type MemoryWorkerResponse =
  | { kind: "phase"; phase: Exclude<MemoryWorkerPhase, "error">; detail?: Record<string, number> }
  | { kind: "error"; message: string };

export interface MemoryFixtureSummary {
  chapters: number;
  images: number;
  assetBytes: number;
  bundleBytes: number;
}

export interface MemoryCorpusFixtureSummary extends MemoryFixtureSummary {
  scale: number;
  manifestSha256: string;
  minAggregateBytes: number;
  /** Prepare-time export notes; the benchmark requires zero embed failures. */
  notes: number;
}

export interface MemoryProbeApi {
  prepareFixture(): Promise<MemoryFixtureSummary>;
  prepareCorpusFixture(profile?: "original" | "standard"): Promise<MemoryCorpusFixtureSummary>;
  storePreparedJob(): Promise<{ jobId: string }>;
  readMetaInventory(): Promise<{ jobs: number; inputBytes: number }>;
  releaseMetaInventory(): void;
  startWorker(): Promise<void>;
  startCompile(): Promise<void>;
  continueWorker(): void;
  phase(): MemoryWorkerPhase;
  workerDetail(phase: Exclude<MemoryWorkerPhase, "error">): Record<string, number> | null;
  readCompiledResult(): Promise<{ byteLength: number }>;
  /** Test-only: seed a synthetic held result so delivery probes run standalone. */
  seedResult(byteLength: number): { byteLength: number };
  /** Old productive delivery shape: concatenated array + anchor Blob copy. */
  deliverArrayShape(): Promise<{ byteLength: number }>;
  /** New productive delivery shape: chunk-granular Blob-backed handle. */
  deliverHandleShape(): Promise<{ byteLength: number }>;
  /** Byte sizes currently HELD by a delivery probe (also defeats DCE). */
  deliveredState(): { arrayBytes: number; blobBytes: number };
  /** Drop whichever delivery variant is currently held. */
  releaseDelivery(): void;
  validateResult(): ReturnType<typeof import("@atlcli/pdf/browser").validatePdfOutput>;
  createDownloadBlob(): { byteLength: number; blobSize: number };
  releaseDownloadBlob(): void;
  probePdfjsBlobLoading(): Promise<{
    directRangeStatus: number;
    directRangeBytes: number;
    directContentRange: string | null;
    pdfjsFetches: Array<{ range: string | null; status: number; bytes: number }>;
  }>;
  seedIdbPayload(kind: "array" | "blob", bytes: number): Promise<void>;
  readIdbPayload(kind: "array" | "blob"): Promise<{ storedType: string; byteLength: number }>;
  releaseIdbPayload(): void;
  cleanup(): Promise<void>;
}

declare global {
  interface Window {
    atlcliMemoryProbe: MemoryProbeApi;
  }
}
