import type { ExportBlock } from "@atlcli/confluence/browser";
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
import { openPdfViewer } from "../../../utils/pdf/viewer.js";
import type {
  MemoryCorpusFixtureSummary,
  MemoryFixtureSummary,
  MemoryProbeApi,
  MemoryWorkerPhase,
  MemoryWorkerRequest,
  MemoryWorkerResponse,
} from "./protocol.js";

const CHAPTERS = 6;
const IMAGE_WIDTH = 1_200;
const IMAGE_HEIGHT = 1_200;
const PROBE_DB = "atlcli-chrome-memory-probe";

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
  counts: { uniqueAssets: number; uniqueAssetBytes: number; chapters: number };
  manifest: Array<{ filename: string; mediaType: string; byteLength: number }>;
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Corpus fetch failed (${response.status}): ${path}`);
  return (await response.json()) as T;
}

async function prepareCorpusFixture(): Promise<MemoryCorpusFixtureSummary> {
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

  const prepared = await preparePdfDocument(blocks, {
    async resolve(ref) {
      const name = ref.filename ?? "";
      const bytes = assets.get(name);
      if (!bytes) throw new Error(`Missing corpus asset ${name}.`);
      return { bytes, mediaType: mediaTypes.get(name) ?? "application/octet-stream", filename: name };
    },
  });
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

async function readCompiledResult(): Promise<{ byteLength: number }> {
  if (!jobId) throw new Error("No memory fixture job exists.");
  const stored = await getPdfJob(jobId, undefined, { bundle: false, pdf: true });
  if (!stored?.pdf) throw new Error("The memory fixture produced no stored PDF.");
  pdf = stored.pdf;
  return { byteLength: pdf.byteLength };
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
