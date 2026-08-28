import type { ExportBlock } from "@atlcli/confluence/browser";
import {
  normalizeRasterAssetV1,
  planRasterNormalizationV1,
  sha256Hex,
  type RasterNormalizeRequestV1,
  type RasterNormalizeResultV1,
} from "@atlcli/export-media";
import type { PdfRasterNormalizerLeaseV1 } from "@atlcli/export-wiring/jobs";
import type { PdfExportJobRequestV1 } from "@atlcli/export-jobs";
import {
  pdfBytesFromUint8Array,
  preparePdfDocument,
  validatePdfOutput,
  type PdfSourceBundle,
} from "@atlcli/pdf/browser";
import { serializePdfDocument } from "@atlcli/pdf/internal";
import {
  deletePdfJob,
  getPdfJob,
  listPdfJobMeta,
  putPdfJob,
  type StoredPdfJobMeta,
} from "../../../utils/pdf/job-store.js";
import { collectArtifactHandleV1 } from "../../../utils/export-jobs/artifact-delivery.js";
import { openPdfViewer } from "../../../utils/pdf/viewer.js";
import {
  createImageBitmapRasterNormalizerLeaseFactoryV1,
  createPureTsRasterNormalizerLeaseFactoryV1,
  type ProductiveRasterNormalizerReceiptV1 as HostRasterNormalizerReceiptV1,
} from "../../../utils/pdf/raster-normalizer-worker-host.js";
import type {
  MemoryCorpusFixtureSummary,
  MemoryFixtureSummary,
  MemoryProbeApi,
  MemoryWorkerPhase,
  MemoryWorkerRequest,
  MemoryWorkerResponse,
  ProductiveRasterNormalizerReceiptV1,
  RasterNormalizerCorpusSummary,
  RasterNormalizerInputSummary,
  RasterNormalizerState,
  RasterNormalizerVariant,
} from "./protocol.js";

const CHAPTERS = 6;
const IMAGE_WIDTH = 1_200;
const IMAGE_HEIGHT = 1_200;
const PROBE_DB = "atlcli-chrome-memory-probe";
const PRODUCTIVE_NORMALIZER_JOB_ID = "memory-productive-pure-worker";
const PRODUCTIVE_NORMALIZER_REQUEST = {
  schema: "atlcli.export-job-request/1",
  id: PRODUCTIVE_NORMALIZER_JOB_ID,
  idempotencyKey: "memory:productive-pure-worker",
  format: "pdf",
  renderer: "pdf-typst",
  source: {
    kind: "confluence",
    siteOrigin: "https://memory.invalid",
    locator: { kind: "page-id", id: "neutral-memory-fixture", version: 1 },
    scope: { kind: "page" },
  },
  authRef: "session:https://memory.invalid",
  displayName: "Neutral memory fixture",
  requestedFilename: "neutral-memory-fixture.pdf",
  createdAt: 0,
  priority: "interactive",
  output: { policy: "collect" },
  template: {
    kind: "builtin",
    id: "builtin.editorial-indigo",
    manifestVersion: "1.0.0",
  },
  settings: {},
  options: {
    resolveMacros: false,
    exportedAt: 0,
    imageProfile: "standard",
  },
} satisfies PdfExportJobRequestV1;

let bundle: PdfSourceBundle | undefined;
let jobId: string | undefined;
let metaInventory: StoredPdfJobMeta[] | undefined;
let pdf: Uint8Array | undefined;
let downloadBlob: Blob | undefined;
let downloadUrl: string | undefined;
let pdfjsViewer: Awaited<ReturnType<typeof openPdfViewer>> | undefined;
let idbPayload: unknown;
let worker: Worker | undefined;
let workerPhase: MemoryWorkerPhase = "booting";
let workerError: Error | undefined;
const workerDetails = new Map<string, Record<string, number>>();

interface LoadedRasterNormalizerCorpus {
  manifest: CorpusManifest;
  blocks: ExportBlock[];
  mediaTypes: Map<string, string>;
  assets: Map<string, Uint8Array>;
}

type NormalizerDetail = Record<string, number | string | boolean>;

type NormalizerWorkerResponse =
  | { kind: "ready"; variant: RasterNormalizerVariant; detail: NormalizerDetail }
  | {
      kind: "phase";
      id: number;
      phase: "source-held" | "decoded-held" | "target-held" | "encoded-held";
      detail: NormalizerDetail;
    }
  | {
      kind: "result";
      id: number;
      result: RasterNormalizeResultV1;
      elapsedMs: number;
      detail: NormalizerDetail;
    }
  | { kind: "error"; id?: number; message: string };

let normalizerInput: LoadedRasterNormalizerCorpus | undefined;
let normalizerWorker: Worker | undefined;
let productiveNormalizerLease: PdfRasterNormalizerLeaseV1 | undefined;
let productiveNormalizerAbort: AbortController | undefined;
let productiveNormalizerReceipt: HostRasterNormalizerReceiptV1 | null = null;
let normalizerPreparePromise: Promise<RasterNormalizerCorpusSummary> | undefined;
let normalizerReadyResolve: ((state: RasterNormalizerState) => void) | undefined;
let normalizerReadyReject: ((error: Error) => void) | undefined;
let normalizerRequestId = 0;
let normalizerQueue: Promise<void> = Promise.resolve();
const normalizerPending = new Map<
  number,
  {
    resolve: (result: RasterNormalizeResultV1) => void;
    reject: (error: Error) => void;
  }
>();
const probedFormats = new Set<"png" | "jpeg">();
let normalizerState: RasterNormalizerState = {
  variant: null,
  phase: "idle",
  sequence: 0,
  completedCalls: 0,
  normalizedCalls: 0,
  keptCalls: 0,
  done: false,
  detail: null,
  error: null,
};

function output(message: string): void {
  const state = document.querySelector<HTMLOutputElement>('[data-testid="memory-state"]');
  if (state) state.textContent = message;
}

function seededNoise(seed: number): Uint8ClampedArray<ArrayBuffer> {
  const bytes = new Uint8ClampedArray(
    new ArrayBuffer(IMAGE_WIDTH * IMAGE_HEIGHT * 4)
  );
  let value = seed >>> 0;
  for (let i = 0; i < bytes.length; i += 4) {
    value = (Math.imul(value, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[i] = value & 0xff;
    bytes[i + 1] = (value >>> 8) & 0xff;
    bytes[i + 2] = (value >>> 16) & 0xff;
    bytes[i + 3] = 0xff;
  }
  return bytes;
}

async function noisePng(seed: number): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = IMAGE_WIDTH;
  canvas.height = IMAGE_HEIGHT;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas 2D is unavailable in the memory harness.");
  context.putImageData(new ImageData(seededNoise(seed), IMAGE_WIDTH, IMAGE_HEIGHT), 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (value) => (value ? resolve(value) : reject(new Error("PNG encoding returned no Blob."))),
      "image/png"
    )
  );
  return new Uint8Array(await blob.arrayBuffer());
}

function fixtureBlocks(): ExportBlock[] {
  const blocks: ExportBlock[] = [];
  for (let chapter = 0; chapter < CHAPTERS; chapter += 1) {
    blocks.push(
      {
        type: "heading",
        level: 1,
        content: [{ type: "text", text: `DOCSY memory chapter ${chapter + 1}` }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Deterministic image-heavy tree fixture for the Chrome/V8 extension benchmark.",
          },
        ],
      },
      {
        type: "image",
        source: { kind: "attachment", filename: `noise-${chapter % 2}.png` },
        alt: `Noise fixture ${chapter % 2}`,
      }
    );
    if (chapter < CHAPTERS - 1) blocks.push({ type: "pageBreak" });
  }
  return blocks;
}

function sourceBundleBytes(value: PdfSourceBundle): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(value.main).byteLength +
    encoder.encode(value.template).byteLength +
    value.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0)
  );
}

async function prepareFixture(): Promise<MemoryFixtureSummary> {
  const images = new Map<string, Uint8Array>([
    ["noise-0.png", await noisePng(0x1234_5678)],
    ["noise-1.png", await noisePng(0x9abc_def0)],
  ]);
  const prepared = await preparePdfDocument(fixtureBlocks(), {
    async resolve(ref) {
      const name = ref.filename ?? "";
      const bytes = images.get(name);
      if (!bytes) throw new Error(`Missing memory fixture asset ${name}.`);
      return { bytes, mediaType: "image/png", filename: name };
    },
  });
  bundle = serializePdfDocument(prepared, {
    metadata: {
      title: "DOCSY Chrome memory fixture",
      space: "DOCSY",
      version: 1,
      exporter: "atlcli Chrome/V8 memory harness",
      exportedAt: new Date("2026-07-22T00:00:00.000Z"),
    },
    settings: { cover: false, outline: true },
  });
  const assetBytes = bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
  const summary = {
    chapters: CHAPTERS,
    images: bundle.assets.length,
    assetBytes,
    bundleBytes: sourceBundleBytes(bundle),
  };
  output(`prepared:${summary.bundleBytes}`);
  return summary;
}

interface CorpusManifest {
  schema: string;
  seed: number;
  scale: number;
  manifestSha256: string;
  minAggregateBytes: number;
  counts: {
    uniqueAssets: number;
    uniqueAssetBytes: number;
    chapters: number;
    placements?: number;
  };
  manifest: Array<{
    filename: string;
    mediaType: string;
    byteLength: number;
    width?: number;
    height?: number;
    role?: string;
  }>;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Corpus fetch failed (${response.status}): ${path}`);
  return (await response.json()) as T;
}

async function prepareCorpusFixture(
  profile: "original" | "standard" = "original",
): Promise<MemoryCorpusFixtureSummary> {
  // The ≥100 MiB image-heavy corpus exceeds the product budgets BY DESIGN
  // (issue #118 Phase 0). Both benchmark-only Symbol.for seams are installed
  // here, in the harness, so release configuration is provably untouched.
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  host[Symbol.for("atlcli.pdf.benchmark-asset-budget")] = {
    maxAssetBytes: 32 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
  };
  host[Symbol.for("atlcli.extension.benchmark-pdf-job-limits")] = {
    jobMaxBytes: 512 * 1024 * 1024,
    storeMaxBytes: 1024 * 1024 * 1024,
  };

  const manifest = await fetchJson<CorpusManifest>("image-heavy/manifest.json");
  const blocks = await fetchJson<ExportBlock[]>("image-heavy/blocks.json");
  const mediaTypes = new Map(manifest.manifest.map((entry) => [entry.filename, entry.mediaType]));
  const assets = new Map<string, Uint8Array>();
  for (const entry of manifest.manifest) {
    const response = await fetch(`image-heavy/${entry.filename}`);
    if (!response.ok) {
      throw new Error(`Corpus asset fetch failed (${response.status}): ${entry.filename}`);
    }
    assets.set(entry.filename, new Uint8Array(await response.arrayBuffer()));
  }

  const prepared = await preparePdfDocument(
    blocks,
    {
      async resolve(ref) {
        const name = ref.filename ?? "";
        const bytes = assets.get(name);
        if (!bytes) throw new Error(`Missing corpus asset ${name}.`);
        return { bytes, mediaType: mediaTypes.get(name) ?? "application/octet-stream", filename: name };
      },
    },
    profile === "standard" ? { imageQuality: { imageProfile: "standard" } } : {},
  );
  bundle = serializePdfDocument(prepared, {
    metadata: {
      title: "Image-heavy corpus attribution fixture",
      space: "DOCSY",
      version: 1,
      exporter: "atlcli Chrome/V8 memory harness",
      exportedAt: new Date("2026-07-27T00:00:00.000Z"),
    },
    settings: { cover: false, outline: true },
  });
  // The bundle references the fetched buffers; clearing the map drops the
  // only extra references so samples measure the bundle, not the fetch cache.
  assets.clear();
  const summary: MemoryCorpusFixtureSummary = {
    chapters: manifest.counts.chapters,
    images: bundle.assets.length,
    assetBytes: bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0),
    bundleBytes: sourceBundleBytes(bundle),
    scale: manifest.scale,
    manifestSha256: manifest.manifestSha256,
    minAggregateBytes: manifest.minAggregateBytes,
    notes: prepared.notes.length,
  };
  output(`corpus-prepared:${summary.bundleBytes}`);
  return summary;
}

function installImageHeavyBenchmarkBudgets(): void {
  const host = globalThis as typeof globalThis & Record<symbol, unknown>;
  host[Symbol.for("atlcli.pdf.benchmark-asset-budget")] = {
    maxAssetBytes: 32 * 1024 * 1024,
    maxTotalBytes: 512 * 1024 * 1024,
  };
  host[Symbol.for("atlcli.extension.benchmark-pdf-job-limits")] = {
    jobMaxBytes: 512 * 1024 * 1024,
    storeMaxBytes: 1024 * 1024 * 1024,
  };
}

async function loadRasterNormalizerCorpus(): Promise<RasterNormalizerInputSummary> {
  installImageHeavyBenchmarkBudgets();
  const manifest = await fetchJson<CorpusManifest>("image-heavy/manifest.json");
  const blocks = await fetchJson<ExportBlock[]>("image-heavy/blocks.json");
  const mediaTypes = new Map(manifest.manifest.map((entry) => [entry.filename, entry.mediaType]));
  const assets = new Map<string, Uint8Array>();
  for (const entry of manifest.manifest) {
    const response = await fetch(`image-heavy/${entry.filename}`);
    if (!response.ok) {
      throw new Error(`Corpus asset fetch failed (${response.status}): ${entry.filename}`);
    }
    assets.set(entry.filename, new Uint8Array(await response.arrayBuffer()));
  }
  normalizerInput = { manifest, blocks, mediaTypes, assets };
  const summary: RasterNormalizerInputSummary = {
    scale: manifest.scale,
    manifestSha256: manifest.manifestSha256,
    sourceAssets: manifest.counts.uniqueAssets,
    sourceAssetBytes: manifest.counts.uniqueAssetBytes,
    placements: manifest.counts.placements ?? 0,
  };
  output(`normalizer-corpus-loaded:${summary.sourceAssetBytes}`);
  return summary;
}

function snapshotNormalizerState(): RasterNormalizerState {
  return {
    ...normalizerState,
    detail: normalizerState.detail ? { ...normalizerState.detail } : null,
  };
}

function failNormalizer(error: Error, id?: number): void {
  normalizerState = {
    ...normalizerState,
    phase: "error",
    sequence: normalizerState.sequence + 1,
    done: true,
    error: error.message,
  };
  if (id !== undefined) {
    const pending = normalizerPending.get(id);
    normalizerPending.delete(id);
    pending?.reject(error);
  } else {
    for (const pending of normalizerPending.values()) pending.reject(error);
    normalizerPending.clear();
  }
  normalizerReadyReject?.(error);
  normalizerReadyResolve = undefined;
  normalizerReadyReject = undefined;
  output(`normalizer-error:${error.message}`);
}

function handleNormalizerMessage(event: MessageEvent<NormalizerWorkerResponse>): void {
  const message = event.data;
  if (message.kind === "error") {
    failNormalizer(new Error(message.message), message.id);
    return;
  }
  if (message.kind === "ready") {
    normalizerState = {
      ...normalizerState,
      phase: "ready",
      sequence: normalizerState.sequence + 1,
      detail: message.detail,
    };
    normalizerReadyResolve?.(snapshotNormalizerState());
    normalizerReadyResolve = undefined;
    normalizerReadyReject = undefined;
    output(`normalizer-ready:${message.variant}`);
    return;
  }
  if (message.kind === "phase") {
    normalizerState = {
      ...normalizerState,
      phase: message.phase,
      sequence: normalizerState.sequence + 1,
      detail: { requestId: message.id, ...message.detail },
    };
    output(`normalizer:${normalizerState.variant}:${message.phase}`);
    return;
  }
  const pending = normalizerPending.get(message.id);
  normalizerPending.delete(message.id);
  normalizerState = {
    ...normalizerState,
    phase: "running",
    sequence: normalizerState.sequence + 1,
    completedCalls: normalizerState.completedCalls + 1,
    normalizedCalls:
      normalizerState.normalizedCalls + (message.result.kind === "normalized" ? 1 : 0),
    keptCalls: normalizerState.keptCalls + (message.result.kind === "kept" ? 1 : 0),
    detail: {
      requestId: message.id,
      elapsedMs: message.elapsedMs,
      ...message.detail,
    },
  };
  pending?.resolve(message.result);
}

async function startRasterNormalizerWorker(
  value: RasterNormalizerVariant,
): Promise<RasterNormalizerState> {
  if (!normalizerInput) throw new Error("Load the normalizer corpus before starting its worker.");
  await terminateRasterNormalizer();
  normalizerRequestId = 0;
  normalizerQueue = Promise.resolve();
  normalizerPending.clear();
  probedFormats.clear();
  normalizerPreparePromise = undefined;
  normalizerState = {
    variant: value,
    phase: "booting",
    sequence: 0,
    completedCalls: 0,
    normalizedCalls: 0,
    keptCalls: 0,
    done: false,
    detail: null,
    error: null,
  };
  if (value === "pure-ts") {
    // Lane 1 is the actual current product shape: the pinned pure-TS codec on
    // the extension panel thread. It is intentionally not granted disposable
    // worker lifetime semantics that the three candidate lanes must earn.
    normalizerState = {
      ...normalizerState,
      phase: "ready",
      sequence: 1,
      detail: { executionContext: "panel-main-current" },
    };
    output("normalizer-ready:pure-ts");
    return snapshotNormalizerState();
  }
  if (value === "pure-worker" || value === "image-bitmap-worker") {
    productiveNormalizerReceipt = null;
    productiveNormalizerAbort = new AbortController();
    const factoryOptions = {
      createWorker: () =>
        new Worker(new URL("../../../workers/raster-normalizer.ts", import.meta.url), {
          type: "module",
          name: `atlcli-memory-productive-raster-normalizer-${value}`,
        }),
      memoizeImmutableSourceViews: true,
      onReceipt: (receipt: HostRasterNormalizerReceiptV1) => {
        productiveNormalizerReceipt = receipt;
      },
    };
    const factory = value === "pure-worker"
      ? createPureTsRasterNormalizerLeaseFactoryV1(factoryOptions)
      : createImageBitmapRasterNormalizerLeaseFactoryV1(factoryOptions);
    productiveNormalizerLease = await factory.acquire({
      jobId: PRODUCTIVE_NORMALIZER_JOB_ID,
      leaseEpoch: 1,
      request: PRODUCTIVE_NORMALIZER_REQUEST,
      signal: productiveNormalizerAbort.signal,
    });
    normalizerState = {
      ...normalizerState,
      phase: "ready",
      sequence: 1,
      detail: {
        executionContext: "disposable-worker",
        backend: productiveNormalizerLease.evidence.backend,
        revision: productiveNormalizerLease.evidence.revision,
      },
    };
    output(`normalizer-ready:${value}`);
    return snapshotNormalizerState();
  }
  normalizerWorker = new Worker(new URL("./normalizer-worker.ts", import.meta.url), {
    type: "module",
    name: `atlcli-memory-normalizer-${value}`,
  });
  normalizerWorker.addEventListener("message", handleNormalizerMessage);
  normalizerWorker.addEventListener("error", (event) => {
    failNormalizer(new Error(event.message || "Raster normalizer worker failed."));
  });
  const ready = new Promise<RasterNormalizerState>((resolve, reject) => {
    normalizerReadyResolve = resolve;
    normalizerReadyReject = reject;
  });
  normalizerWorker.postMessage({ kind: "init", variant: value });
  return ready;
}

function postRasterNormalize(
  request: RasterNormalizeRequestV1,
): Promise<RasterNormalizeResultV1> {
  if (!normalizerWorker) throw new Error("The raster normalizer worker is not running.");
  const id = ++normalizerRequestId;
  const planned = planRasterNormalizationV1(request);
  const probe = planned.kind === "normalize" && !probedFormats.has(planned.plan.sourceFormat);
  if (planned.kind === "normalize" && probe) probedFormats.add(planned.plan.sourceFormat);
  const bytes = request.bytes.slice();
  const response = new Promise<RasterNormalizeResultV1>((resolve, reject) => {
    normalizerPending.set(id, { resolve, reject });
  });
  normalizerWorker.postMessage(
    { kind: "normalize", id, request: { ...request, bytes }, probe },
    [bytes.buffer],
  );
  return response;
}

function normalizeRasterInWorker(
  request: RasterNormalizeRequestV1,
): Promise<RasterNormalizeResultV1> {
  const result = normalizerQueue.then(() => postRasterNormalize(request));
  normalizerQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function normalizeRasterInPanel(request: RasterNormalizeRequestV1): RasterNormalizeResultV1 {
  const result = normalizeRasterAssetV1(request);
  normalizerState = {
    ...normalizerState,
    completedCalls: normalizerState.completedCalls + 1,
    normalizedCalls: normalizerState.normalizedCalls + (result.kind === "normalized" ? 1 : 0),
    keptCalls: normalizerState.keptCalls + (result.kind === "kept" ? 1 : 0),
  };
  return result;
}

async function normalizeRasterInProductiveWorker(
  request: RasterNormalizeRequestV1,
): Promise<RasterNormalizeResultV1> {
  if (!productiveNormalizerLease) {
    throw new Error("The productive raster normalizer lease is unavailable.");
  }
  const result = await productiveNormalizerLease.rasterNormalizer.normalize(request);
  normalizerState = {
    ...normalizerState,
    phase: "running",
    sequence: normalizerState.sequence + 1,
    completedCalls: normalizerState.completedCalls + 1,
    normalizedCalls: normalizerState.normalizedCalls + (result.kind === "normalized" ? 1 : 0),
    keptCalls: normalizerState.keptCalls + (result.kind === "kept" ? 1 : 0),
  };
  return result;
}

function startRasterNormalizerPrepare(): void {
  if (
    !normalizerInput ||
    !normalizerState.variant ||
    (normalizerState.variant === "pure-worker" || normalizerState.variant === "image-bitmap-worker"
      ? !productiveNormalizerLease
      : normalizerState.variant !== "pure-ts" && !normalizerWorker)
  ) {
    throw new Error("Load the corpus and start its normalizer worker before preparing.");
  }
  if (normalizerPreparePromise) throw new Error("Raster normalizer preparation already started.");
  const input = normalizerInput;
  const value = normalizerState.variant;
  const startedAt = performance.now();
  normalizerState = {
    ...normalizerState,
    phase: "running",
    sequence: normalizerState.sequence + 1,
    detail: null,
  };
  normalizerPreparePromise = (async () => {
    const prepared = await preparePdfDocument(
      input.blocks,
      {
        async resolve(ref) {
          const name = ref.filename ?? "";
          const bytes = input.assets.get(name);
          if (!bytes) throw new Error(`Missing corpus asset ${name}.`);
          return {
            bytes,
            mediaType: input.mediaTypes.get(name) ?? "application/octet-stream",
            filename: name,
          };
        },
      },
      {
        imageQuality: { imageProfile: "standard" },
        rasterNormalizer: {
          normalize:
            value === "pure-ts"
              ? normalizeRasterInPanel
              : value === "pure-worker" || value === "image-bitmap-worker"
                ? normalizeRasterInProductiveWorker
                : normalizeRasterInWorker,
        },
      },
    );
    bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Image-heavy normalizer fixture",
        space: "DOCSY",
        version: 1,
        exporter: "atlcli Chrome/V8 raster normalizer ratchet",
        exportedAt: new Date("2026-08-28T00:00:00.000Z"),
      },
      settings: { cover: false, outline: true },
    });
    const assetBytes = bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0);
    const digestRecipe = bundle.assets
      .map((asset) => `${asset.path}:${asset.mediaType}:${sha256Hex(asset.bytes)}`)
      .join("\n");
    const prepareMs = performance.now() - startedAt;
    const summary: RasterNormalizerCorpusSummary = {
      variant: value,
      chapters: input.manifest.counts.chapters,
      images: bundle.assets.length,
      assetBytes,
      bundleBytes: sourceBundleBytes(bundle),
      scale: input.manifest.scale,
      manifestSha256: input.manifest.manifestSha256,
      minAggregateBytes: input.manifest.minAggregateBytes,
      notes: prepared.notes.length,
      normalizedCalls: normalizerState.normalizedCalls,
      keptCalls: normalizerState.keptCalls,
      prepareMs,
      outputAssetSha256: sha256Hex(new TextEncoder().encode(digestRecipe)),
    };
    // At this point the prepared bundle owns all output buffers. Release the
    // 100 MiB source corpus before the worker-termination and compiler gates.
    input.assets.clear();
    normalizerInput = undefined;
    normalizerState = {
      ...normalizerState,
      phase: "complete",
      sequence: normalizerState.sequence + 1,
      done: true,
      detail: {
        prepareMs,
        bundleBytes: summary.bundleBytes,
        assetBytes: summary.assetBytes,
      },
    };
    output(`normalizer-complete:${value}:${summary.bundleBytes}`);
    return summary;
  })().catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    failNormalizer(normalized);
    throw normalized;
  });
}

function continueRasterNormalizer(): void {
  if (normalizerState.error) throw new Error(normalizerState.error);
  normalizerWorker?.postMessage({ kind: "continue" });
}

async function readRasterNormalizerResult(): Promise<RasterNormalizerCorpusSummary> {
  if (!normalizerPreparePromise) throw new Error("Raster normalizer preparation has not started.");
  return normalizerPreparePromise;
}

async function terminateRasterNormalizer(): Promise<
  ProductiveRasterNormalizerReceiptV1 | null
> {
  normalizerWorker?.terminate();
  normalizerWorker = undefined;
  const lease = productiveNormalizerLease;
  productiveNormalizerLease = undefined;
  if (lease) await lease.release();
  productiveNormalizerAbort = undefined;
  normalizerState = {
    ...normalizerState,
    phase: "terminated",
    sequence: normalizerState.sequence + 1,
  };
  output(`normalizer-terminated:${normalizerState.variant ?? "none"}`);
  return productiveNormalizerReceipt === null
    ? null
    : structuredClone(productiveNormalizerReceipt);
}

async function storePreparedJob(): Promise<{ jobId: string }> {
  if (!bundle) throw new Error("Prepare the memory fixture before storing it.");
  jobId = crypto.randomUUID();
  await putPdfJob({
    id: jobId,
    sourceIdentity: "memory:DOCSY:tree",
    bundle,
    kind: "export",
    siteOrigin: "https://memory.invalid",
    title: "DOCSY Chrome memory fixture",
    filename: "docsy-chrome-memory-fixture.pdf",
    scopeLabel: "Page + children (6 chapters)",
  });
  bundle = undefined;
  output(`stored:${jobId}`);
  return { jobId };
}

async function readMetaInventory(): Promise<{ jobs: number; inputBytes: number }> {
  metaInventory = await listPdfJobMeta();
  return {
    jobs: metaInventory.length,
    inputBytes: metaInventory.reduce((total, meta) => total + meta.inputBytes, 0),
  };
}

function startWorker(): Promise<void> {
  if (worker) return Promise.resolve();
  worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "atlcli-memory-offscreen",
  });
  worker.addEventListener("message", (event: MessageEvent<MemoryWorkerResponse>) => {
    if (event.data.kind === "error") {
      workerPhase = "error";
      workerError = new Error(event.data.message);
      output(`error:${event.data.message}`);
      return;
    }
    workerPhase = event.data.phase;
    workerDetails.set(event.data.phase, event.data.detail ?? {});
    output(`worker:${workerPhase}`);
  });
  worker.postMessage({ kind: "warm" } satisfies MemoryWorkerRequest);
  return Promise.resolve();
}

async function startCompile(): Promise<void> {
  if (!worker || !jobId) throw new Error("Start the worker and store a job before compiling.");
  worker.postMessage({ kind: "compile", jobId } satisfies MemoryWorkerRequest);
}

async function readCompiledResult(): Promise<{ byteLength: number; sha256: string }> {
  if (!jobId) throw new Error("No memory fixture job exists.");
  const stored = await getPdfJob(jobId, undefined, { bundle: false, pdf: true });
  if (!stored?.pdf) throw new Error("The memory fixture produced no stored PDF.");
  pdf = stored.pdf;
  return { byteLength: pdf.byteLength, sha256: sha256Hex(pdf) };
}

const DELIVERY_CHUNK_BYTES = 1024 * 1024;

/** Test-only: seed a synthetic held result so delivery probes run standalone. */
function seedResult(byteLength: number): { byteLength: number } {
  pdf = new Uint8Array(byteLength);
  return { byteLength: pdf.byteLength };
}

/** Owned 1 MiB slices of the held result — the chunk-store read shape. */
async function* resultChunks(): AsyncIterable<Uint8Array> {
  if (!pdf) throw new Error("Read the compiled result before delivering it.");
  for (let offset = 0; offset < pdf.byteLength; offset += DELIVERY_CHUNK_BYTES) {
    yield pdf.slice(offset, Math.min(offset + DELIVERY_CHUNK_BYTES, pdf.byteLength));
  }
}

// Held delivery state lives behind a READ probe method (`deliveredState`):
// write-only module variables are legally dead-code-eliminated by the
// bundler, which silently un-retains the measured allocation.
const delivery: { array?: Uint8Array; blob?: Blob; url?: string } = {};

function deliveredState(): { arrayBytes: number; blobBytes: number } {
  return {
    arrayBytes: delivery.array?.byteLength ?? 0,
    blobBytes: delivery.blob?.size ?? 0,
  };
}

/**
 * The delivery shape `pdf-run.ts` used BEFORE issue #118 Phase 0.5: collect
 * all chunks into one preallocated panel-heap array, then hand the array to
 * the download path, which builds an anchor `Blob` copy. Kept as the measured
 * A-leg so the report proves the before/after delta forever. The artifacts
 * stay HELD (like a pending anchor click) until `releaseDelivery()` so the
 * forced-GC heap sample sees the retention the old flow really had.
 */
async function deliverArrayShape(): Promise<{ byteLength: number }> {
  if (!pdf) throw new Error("Read the compiled result before delivering it.");
  const result = new Uint8Array(pdf.byteLength);
  let offset = 0;
  for await (const chunk of resultChunks()) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  delivery.array = result;
  delivery.blob = new Blob([result as BlobPart], { type: "application/pdf" });
  delivery.url = URL.createObjectURL(delivery.blob);
  return { byteLength: result.byteLength };
}

/** The productive post-change shape: `collectArtifactHandleV1` end to end. */
async function deliverHandleShape(): Promise<{ byteLength: number }> {
  if (!pdf) throw new Error("Read the compiled result before delivering it.");
  const handle = await collectArtifactHandleV1(resultChunks(), {
    mediaType: "application/pdf",
    expectedByteLength: pdf.byteLength,
  });
  delivery.blob = await handle.asBlob();
  delivery.url = URL.createObjectURL(delivery.blob);
  return { byteLength: delivery.blob.size };
}

function releaseDelivery(): void {
  if (delivery.url) URL.revokeObjectURL(delivery.url);
  delete delivery.url;
  delete delivery.blob;
  delete delivery.array;
}

function validateResult(): ReturnType<typeof validatePdfOutput> {
  if (!pdf) throw new Error("Read the compiled result before validating it.");
  return validatePdfOutput(pdf);
}

function createDownloadBlob(): { byteLength: number; blobSize: number } {
  if (!pdf) throw new Error("Read the compiled result before creating the download Blob.");
  downloadBlob = new Blob([pdf as BlobPart], { type: "application/pdf" });
  downloadUrl = URL.createObjectURL(downloadBlob);
  return { byteLength: pdf.byteLength, blobSize: downloadBlob.size };
}

function releaseDownloadBlob(): void {
  if (downloadUrl) URL.revokeObjectURL(downloadUrl);
  downloadUrl = undefined;
  downloadBlob = undefined;
}

async function probePdfjsBlobLoading(): Promise<{
  directRangeStatus: number;
  directRangeBytes: number;
  directContentRange: string | null;
  pdfjsFetches: Array<{ range: string | null; status: number; bytes: number }>;
}> {
  if (!pdf) throw new Error("Read the compiled result before probing PDF.js.");
  const directUrl = URL.createObjectURL(new Blob([pdf as BlobPart], { type: "application/pdf" }));
  try {
    const direct = await fetch(directUrl, { headers: { Range: "bytes=0-65535" } });
    const directRangeBytes = (await direct.arrayBuffer()).byteLength;
    const originalFetch = globalThis.fetch;
    const pdfjsFetches: Array<{ range: string | null; status: number; bytes: number }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const response = await originalFetch(input, init);
      if (request.url.startsWith("blob:")) {
        pdfjsFetches.push({
          range: request.headers.get("range"),
          status: response.status,
          bytes: (await response.clone().arrayBuffer()).byteLength,
        });
      }
      return response;
    }) as typeof fetch;
    try {
      // Keep the document resident until the final cleanup: this sample is
      // meant to capture the real preview-held peak, not a post-destroy heap.
      pdfjsViewer = await openPdfViewer(pdfBytesFromUint8Array(pdf));
    } finally {
      globalThis.fetch = originalFetch;
    }
    return {
      directRangeStatus: direct.status,
      directRangeBytes,
      directContentRange: direct.headers.get("content-range"),
      pdfjsFetches,
    };
  } finally {
    URL.revokeObjectURL(directUrl);
  }
}

function openProbeDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PROBE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore("payloads");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function seedIdbPayload(kind: "array" | "blob", bytes: number): Promise<void> {
  const source = new Uint8Array(bytes);
  for (let offset = 0; offset < source.length; offset += 4096) source[offset] = offset & 0xff;
  const value = kind === "blob" ? new Blob([source as BlobPart]) : source;
  const db = await openProbeDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("payloads", "readwrite");
    tx.objectStore("payloads").put(value, kind);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function readIdbPayload(
  kind: "array" | "blob"
): Promise<{ storedType: string; byteLength: number }> {
  const db = await openProbeDb();
  idbPayload = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction("payloads", "readonly");
    const request = tx.objectStore("payloads").get(kind);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  db.close();
  if (idbPayload instanceof Blob) {
    return { storedType: "Blob", byteLength: idbPayload.size };
  }
  if (idbPayload instanceof Uint8Array) {
    return { storedType: "Uint8Array", byteLength: idbPayload.byteLength };
  }
  throw new Error(`Unexpected IndexedDB payload type: ${typeof idbPayload}.`);
}

async function cleanup(): Promise<void> {
  await terminateRasterNormalizer();
  normalizerInput?.assets.clear();
  normalizerInput = undefined;
  normalizerPreparePromise = undefined;
  normalizerPending.clear();
  releaseDelivery();
  releaseDownloadBlob();
  await pdfjsViewer?.destroy().catch(() => undefined);
  pdfjsViewer = undefined;
  metaInventory = undefined;
  pdf = undefined;
  bundle = undefined;
  idbPayload = undefined;
  if (jobId) await deletePdfJob(jobId).catch(() => undefined);
  jobId = undefined;
  worker?.postMessage({ kind: "shutdown" } satisfies MemoryWorkerRequest);
  worker = undefined;
  workerDetails.clear();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(PROBE_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

window.atlcliMemoryProbe = {
  prepareFixture,
  prepareCorpusFixture,
  loadRasterNormalizerCorpus,
  startRasterNormalizerWorker,
  startRasterNormalizerPrepare,
  rasterNormalizerState: snapshotNormalizerState,
  continueRasterNormalizer,
  readRasterNormalizerResult,
  terminateRasterNormalizer,
  storePreparedJob,
  readMetaInventory,
  releaseMetaInventory() {
    metaInventory = undefined;
  },
  startWorker,
  startCompile,
  continueWorker() {
    if (workerError) throw workerError;
    worker?.postMessage({ kind: "continue" } satisfies MemoryWorkerRequest);
  },
  phase() {
    if (workerError) throw workerError;
    return workerPhase;
  },
  workerDetail(phase) {
    return workerDetails.get(phase) ?? null;
  },
  readCompiledResult,
  seedResult,
  deliverArrayShape,
  deliverHandleShape,
  deliveredState,
  releaseDelivery,
  validateResult,
  createDownloadBlob,
  releaseDownloadBlob,
  probePdfjsBlobLoading,
  seedIdbPayload,
  readIdbPayload,
  releaseIdbPayload() {
    idbPayload = undefined;
  },
  cleanup,
} satisfies MemoryProbeApi;

output("ready");
