import wasmUrl from "@atlcli/pdf-compiler-browser/wasm?url";
import sansRegularUrl from "@atlcli/pdf/fonts/SourceSans3-Regular.ttf?url";
import sansItalicUrl from "@atlcli/pdf/fonts/SourceSans3-It.ttf?url";
import sansSemiBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Semibold.ttf?url";
import sansBoldUrl from "@atlcli/pdf/fonts/SourceSans3-Bold.ttf?url";
import serifRegularUrl from "@atlcli/pdf/fonts/SourceSerif4-Regular.ttf?url";
import serifItalicUrl from "@atlcli/pdf/fonts/SourceSerif4-It.ttf?url";
import serifSemiBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Semibold.ttf?url";
import serifBoldUrl from "@atlcli/pdf/fonts/SourceSerif4-Bold.ttf?url";
import codeRegularUrl from "@atlcli/pdf/fonts/SourceCodePro-Regular.ttf?url";
import codeBoldUrl from "@atlcli/pdf/fonts/SourceCodePro-Bold.ttf?url";
import symbolsRegularUrl from "@atlcli/pdf/fonts/NotoSansSymbols2-Regular.ttf?url";
import emojiRegularUrl from "@atlcli/pdf/fonts/NotoEmoji-wght.ttf?url";
import {
  composeChapters,
  type ExportPageNode,
} from "@atlcli/confluence/browser";
import type {
  AssetFetcher,
  ExportInput,
} from "@atlcli/docx/browser";
import {
  type DocxExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobRequestV1,
  type PdfExportJobRequestV1,
  type ResourceEstimateV1,
} from "@atlcli/export-jobs";
import {
  DOCX_TEMPLATE_BYTES,
  digestLargeExportCorpus,
  generateLargeExportCorpus,
  type LargeExportCorpus,
} from "@atlcli/export-fixtures";
import {
  checkpointDocxAssetsV1,
  checkpointPdfAssetsV1,
  createExportTreeBodySpoolV1,
} from "@atlcli/export-wiring/jobs";
import {
  PDF_RUNTIME_ASSETS,
  type PdfAssetResolver,
} from "@atlcli/pdf/browser";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import {
  EXTENSION_EXPORT_BYTE_OBJECTS_STORE,
  extensionExportRequestResult,
  IndexedDbExportJobCatalog,
  openExtensionExportDb,
} from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  createProductiveExtensionDocxExecutor,
  EXTENSION_DOCX_SPOOL_LIMITS_V1,
} from "../../utils/export-jobs/docx-executor.js";
import {
  createProductiveExtensionPdfExecutor,
  EXTENSION_PDF_SPOOL_LIMITS_V1,
} from "../../utils/export-jobs/pdf-executor.js";
import { BrowserRenderReservationPoolV1 } from "../../utils/export-jobs/render-reservation.js";
import { runClaimedExtensionExportJob } from "../../utils/export-jobs/runtime.js";
import type { ChromeWorkerCompilerHost } from "../../utils/pdf/compiler-host.js";
import type {
  BrowserExportJobBaselineApi,
  BrowserJobBaselineExportResult,
  BrowserJobBaselineFormat,
  BrowserJobBaselinePrepareResult,
  BrowserJobSpoolBreakdown,
} from "./protocol.js";

const fontUrls = new Map<string, string>([
  ["SourceSans3-Regular.ttf", sansRegularUrl],
  ["SourceSans3-It.ttf", sansItalicUrl],
  ["SourceSans3-Semibold.ttf", sansSemiBoldUrl],
  ["SourceSans3-Bold.ttf", sansBoldUrl],
  ["SourceSerif4-Regular.ttf", serifRegularUrl],
  ["SourceSerif4-It.ttf", serifItalicUrl],
  ["SourceSerif4-Semibold.ttf", serifSemiBoldUrl],
  ["SourceSerif4-Bold.ttf", serifBoldUrl],
  ["SourceCodePro-Regular.ttf", codeRegularUrl],
  ["SourceCodePro-Bold.ttf", codeBoldUrl],
  ["NotoSansSymbols2-Regular.ttf", symbolsRegularUrl],
  ["NotoEmoji-wght.ttf", emojiRegularUrl],
]);

const EXPORT_DATE = new Date("2026-07-22T00:00:00.000Z");
const MIB = 1024 * 1024;
let corpus: LargeExportCorpus | undefined;
let composedBlocks = 0;
let compilerPromise: Promise<BrowserPdfCompiler> | undefined;

function output(message: string): void {
  const element = document.querySelector<HTMLOutputElement>(
    "[data-testid=baseline-state]",
  );
  if (element) element.textContent = message;
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : value;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes)),
  );
  return [...digest]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Job baseline runtime asset failed to load (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

function compiler(): Promise<BrowserPdfCompiler> {
  compilerPromise ??= Promise.all([
    fetchBytes(wasmUrl),
    ...PDF_RUNTIME_ASSETS.fonts.map((asset) =>
      fetchBytes(fontUrls.get(asset.fileName)!),
    ),
  ]).then(
    ([wasm, ...fonts]) =>
      new BrowserPdfCompiler({ wasm: wasm.buffer, fonts }),
  );
  return compilerPromise;
}

async function setup(
  format: BrowserJobBaselineFormat,
): Promise<{ setupMs: number }> {
  const started = performance.now();
  if (format === "pdf") await compiler();
  return { setupMs: performance.now() - started };
}

function logicalInputBytes(value: LargeExportCorpus): number {
  return (
    new TextEncoder().encode(JSON.stringify(value.nodes)).byteLength +
    value.assets.reduce((sum, asset) => sum + asset.bytes.byteLength, 0)
  );
}

async function prepare(options: {
  pages: 50 | 500;
  seed: number;
}): Promise<BrowserJobBaselinePrepareResult> {
  const corpusStarted = performance.now();
  corpus = generateLargeExportCorpus(options);
  const composed = composeChapters(corpus.nodes);
  composedBlocks = composed.blocks.length;
  const corpusAndComposeMs = performance.now() - corpusStarted;
  const fingerprintStarted = performance.now();
  const bytes = logicalInputBytes(corpus);
  const corpusDigest = await digestLargeExportCorpus(corpus);
  const corpusFingerprintMs = performance.now() - fingerprintStarted;
  output(`prepared:${options.pages}`);
  return {
    pages: options.pages,
    seed: options.seed,
    corpusDigest,
    counts: corpus.counts,
    composedBlocks,
    logicalInputBytes: bytes,
    corpusAndComposeMs,
    corpusFingerprintMs,
  };
}

function assetFor(
  pageId: string | undefined,
  filename: string,
): LargeExportCorpus["assets"][number] {
  if (!corpus) throw new Error("Prepare the corpus before resolving assets.");
  const exact = corpus.assets.find(
    (asset) => asset.pageId === pageId && asset.filename === filename,
  );
  const unique = corpus.assets.filter((asset) => asset.filename === filename);
  const result = exact ?? (unique.length === 1 ? unique[0] : undefined);
  if (!result) {
    throw new Error(`Browser job baseline asset not found: ${pageId ?? "?"}/${filename}`);
  }
  return result;
}

function docxAssets(): AssetFetcher {
  return {
    async fetch(ref) {
      if (!ref.filename) {
        throw new Error("DOCX job baseline received an asset without filename.");
      }
      return assetFor(ref.pageId, ref.filename).bytes.slice();
    },
  };
}

function pdfAssets(): PdfAssetResolver {
  return {
    async resolve(ref) {
      if (!ref.filename) {
        throw new Error("PDF job baseline received an asset without filename.");
      }
      const asset = assetFor(ref.pageId, ref.filename);
      return {
        bytes: asset.bytes.slice(),
        mediaType: asset.mediaType,
        filename: asset.filename,
      };
    },
  };
}

function requestBase(
  id: string,
  format: BrowserJobBaselineFormat,
): Pick<
  ExportJobRequestV1,
  | "schema"
  | "id"
  | "idempotencyKey"
  | "source"
  | "authRef"
  | "displayName"
  | "requestedFilename"
  | "createdAt"
  | "priority"
  | "output"
> {
  if (!corpus) throw new Error("Prepare the corpus before creating a job.");
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `chrome-post-queue:${format}:${corpus.pages}:${id}`,
    source: {
      kind: "confluence",
      siteOrigin: "https://example.invalid",
      locator: { kind: "page-id", id: "large-page-1", version: 1 },
      scope: { kind: "tree", includeRoot: true },
    },
    authRef: "benchmark:synthetic",
    displayName: `Large browser job benchmark (${corpus.pages} pages)`,
    requestedFilename: `large-export-${corpus.pages}.${format}`,
    createdAt: EXPORT_DATE.getTime(),
    priority: "interactive",
    output: { policy: "collect" },
  };
}

async function request(
  format: BrowserJobBaselineFormat,
): Promise<PdfExportJobRequestV1 | DocxExportJobRequestV1> {
  if (!corpus) throw new Error("Prepare the corpus before creating a job.");
  const id = `chrome-${format}-${corpus.pages}-${corpus.seed.toString(16)}`;
  const base = requestBase(id, format);
  if (format === "pdf") {
    return {
      ...base,
      format,
      renderer: "pdf-typst",
      template: {
        kind: "builtin",
        id: "builtin.editorial-indigo",
        manifestVersion: "1.0.0",
      },
      settings: {},
      options: {
        resolveMacros: false,
        profile: "tagged",
        exportedAt: EXPORT_DATE.getTime(),
      },
    };
  }
  return {
    ...base,
    format,
    renderer: "docx-typescript",
    template: {
      recordKey: "benchmark:default-template",
      sha256: await sha256(DOCX_TEMPLATE_BYTES),
      name: "post-queue-baseline.docx",
      uploadedAt: EXPORT_DATE.getTime(),
    },
    options: {
      embedImages: true,
      resolveMacros: false,
      updateFields: "auto",
    },
  };
}

function manifestEntries(value: LargeExportCorpus) {
  return value.nodes.map((node, ordinal) => ({
    ordinal,
    key: `${node.pageId}:v${node.meta.version}`,
    pageId: node.pageId,
    title: node.title,
  }));
}

async function durableBlocks(
  context: ExportJobExecutionContext,
  requestKey: string,
): Promise<ReturnType<typeof composeChapters>["blocks"]> {
  if (!corpus) throw new Error("Prepare the corpus before durable composition.");
  const store = createExportTreeBodySpoolV1(context, requestKey);
  const entries = manifestEntries(corpus);
  await store.prepare(entries, { signal: context.signal });
  const nodes: ExportPageNode[] = [];
  for (const [ordinal, node] of corpus.nodes.entries()) {
    const entry = entries[ordinal]!;
    const existing = await store.load(entry, { signal: context.signal });
    const result = existing ?? {
      ok: true as const,
      pageId: node.pageId,
      title: node.title,
      source: { representation: "storage" as const, degraded: false },
      blocks: structuredClone(node.blocks),
      notes: structuredClone(node.notes),
      meta: structuredClone(node.meta),
    };
    if (!existing) {
      await store.commit(entry, result, { signal: context.signal });
    }
    if (!result.ok) {
      throw new Error(`Synthetic browser page ${result.pageId} was not durable.`);
    }
    nodes.push({
      ...structuredClone(node),
      blocks: result.blocks,
      notes: result.notes,
      meta: result.meta,
    });
  }
  return composeChapters(nodes).blocks;
}

function estimate(format: BrowserJobBaselineFormat): ResourceEstimateV1 {
  if (!corpus) throw new Error("Prepare the corpus before estimating.");
  const logicalBytes = logicalInputBytes(corpus);
  return {
    heapBytes: Math.max(64 * MIB, logicalBytes * 8),
    spoolBytes: Math.max(16 * MIB, logicalBytes * 4),
    outputBytes: format === "pdf" ? 64 * MIB : 32 * MIB,
    rasterPixels: 32 * MIB,
    confidence: "estimated",
  };
}

interface ByteObjectProjection {
  kind: "spool" | "artifact";
  state: string;
  jobId: string;
  namespace?: string;
  byteLength: number;
}

async function persistedBreakdown(jobId: string): Promise<{
  spool: BrowserJobSpoolBreakdown;
  artifactBytes: number;
  totalPayloadBytes: number;
}> {
  const db = await openExtensionExportDb();
  try {
    const tx = db.transaction([EXTENSION_EXPORT_BYTE_OBJECTS_STORE], "readonly");
    const rows = await extensionExportRequestResult(
      tx.objectStore(EXTENSION_EXPORT_BYTE_OBJECTS_STORE).getAll(),
    ) as ByteObjectProjection[];
    const owned = rows.filter(
      (row) => row.jobId === jobId && row.state === "committed",
    );
    const namespaces: Record<string, number> = {};
    let artifactBytes = 0;
    for (const row of owned) {
      if (row.kind === "artifact") {
        artifactBytes += row.byteLength;
      } else if (row.namespace) {
        namespaces[row.namespace] =
          (namespaces[row.namespace] ?? 0) + row.byteLength;
      }
    }
    const sourceBytes =
      (namespaces["source-manifest"] ?? 0) +
      (namespaces["source-pages"] ?? 0);
    const assetBytes =
      (namespaces.assets ?? 0) +
      (namespaces["asset-checkpoints"] ?? 0);
    const preparedBytes = Object.entries(namespaces)
      .filter(([namespace]) => namespace.startsWith("ready-"))
      .reduce((sum, [, bytes]) => sum + bytes, 0);
    const totalBytes = Object.values(namespaces).reduce(
      (sum, bytes) => sum + bytes,
      0,
    );
    return {
      spool: {
        totalBytes,
        sourceBytes,
        assetBytes,
        preparedBytes,
        otherBytes: totalBytes - sourceBytes - assetBytes - preparedBytes,
        objectCount: owned.filter((row) => row.kind === "spool").length,
        namespaces,
      },
      artifactBytes,
      totalPayloadBytes: totalBytes + artifactBytes,
    };
  } finally {
    db.close();
  }
}

async function storageEstimate(): Promise<{
  usage: number | null;
  quota: number | null;
}> {
  if (!navigator.storage?.estimate) return { usage: null, quota: null };
  const value = await navigator.storage.estimate();
  return {
    usage: Number.isFinite(value.usage) ? value.usage! : null,
    quota: Number.isFinite(value.quota) ? value.quota! : null,
  };
}

const unusedCompilerHost: Pick<ChromeWorkerCompilerHost, "compile" | "cancel"> = {
  async compile(): Promise<never> {
    throw new Error("Injected benchmark compiler bypassed its private host.");
  },
  async cancel(): Promise<boolean> {
    return false;
  },
};

async function run(
  format: BrowserJobBaselineFormat,
): Promise<BrowserJobBaselineExportResult> {
  if (!corpus) throw new Error("Prepare the corpus before exporting.");
  const preparedCorpus = corpus;
  const before = await storageEstimate();
  const catalog = new IndexedDbExportJobCatalog();
  const bytes = new IndexedDbExportByteStore();
  const renderPool = new BrowserRenderReservationPoolV1();
  const durableRequest = await request(format);
  const docxTemplate =
    durableRequest.format === "docx" ? durableRequest.template : undefined;
  const queued = await catalog.create({ request: durableRequest });
  const claimed = await catalog.claimNext({
    ownerId: "benchmark:extension-page",
    now: Date.now(),
    leaseDurationMs: 10 * 60_000,
    ids: [queued.id],
  });
  if (!claimed) throw new Error("Browser benchmark job was not claimable.");

  const browserCompiler = format === "pdf" ? await compiler() : undefined;
  const executor =
    format === "pdf"
      ? createProductiveExtensionPdfExecutor({
          catalog,
          bytes,
          compilerHost: unusedCompilerHost,
          renderPool,
          async resolveInput(pdfRequest, context) {
            return {
              input: {
                blocks: await durableBlocks(
                  context,
                  pdfRequest.idempotencyKey,
                ),
                metadata: {
                  title: durableRequest.displayName,
                  space: "BENCH",
                  version: 1,
                  exporter: "atlcli POST-QUEUE Chrome benchmark",
                  exportedAt: EXPORT_DATE,
                },
                profile: "tagged",
                filename: durableRequest.requestedFilename!,
              },
              env: {
                assets: checkpointPdfAssetsV1(
                  context,
                  pdfRequest.idempotencyKey,
                  pdfAssets(),
                ),
              },
              telemetry: { sourcePageCount: preparedCorpus.pages },
            };
          },
          estimateRender: () => estimate("pdf"),
          createCompiler: () => browserCompiler!,
        })
      : createProductiveExtensionDocxExecutor({
          bytes,
          renderPool,
          async resolveInput(docxRequest, context): Promise<
            Omit<ExportInput, "templateBytes" | "signal" | "onProgress"> & {
              jobTelemetry: { sourcePageCount: number };
            }
          > {
            return {
              details: {
                id: "large-page-1",
                title: durableRequest.displayName,
                url:
                  "https://example.invalid/wiki/spaces/BENCH/pages/" +
                  "large-page-1",
                version: 1,
                spaceKey: "BENCH",
                storage: "",
                created: EXPORT_DATE.toISOString(),
                modified: EXPORT_DATE.toISOString(),
                createdBy: { displayName: "Benchmark" },
                modifiedBy: { displayName: "Benchmark" },
                labels: [],
              },
              blocks: await durableBlocks(
                context,
                docxRequest.idempotencyKey,
              ),
              template: {
                name: "post-queue-baseline.docx",
                modificationDate: new Date(EXPORT_DATE),
              },
              exportDate: new Date(EXPORT_DATE),
              embedImages: true,
              updateFields: "auto",
              assets: checkpointDocxAssetsV1(
                context,
                docxRequest.idempotencyKey,
                docxAssets(),
              ),
              jobTelemetry: { sourcePageCount: preparedCorpus.pages },
            };
          },
          estimateRender: () => estimate("docx"),
          templates: {
            async resolve(input) {
              if (
                !docxTemplate ||
                input.recordKey !== docxTemplate.recordKey ||
                input.expectedSha256 !== docxTemplate.sha256
              ) {
                throw new Error("Browser benchmark template identity changed.");
              }
              return {
                recordKey: input.recordKey,
                bytes: DOCX_TEMPLATE_BYTES.slice(),
              };
            },
          },
        });

  const started = performance.now();
  const snapshot = await runClaimedExtensionExportJob({
    claimed,
    catalog,
    bytes,
    executor,
    spoolLimits:
      format === "pdf"
        ? EXTENSION_PDF_SPOOL_LIMITS_V1
        : EXTENSION_DOCX_SPOOL_LIMITS_V1,
    leaseDurationMs: 10 * 60_000,
    heartbeatIntervalMs: 5_000,
    cancelPollMs: 250,
  });
  const jobExecutionMs = performance.now() - started;
  if (snapshot.state !== "succeeded" || !snapshot.artifact) {
    throw new Error(
      `Browser benchmark job failed: ${snapshot.error?.message ?? snapshot.state}`,
    );
  }
  const persisted = await persistedBreakdown(snapshot.id);
  if (
    persisted.artifactBytes !== snapshot.artifact.byteLength ||
    persisted.spool.sourceBytes <= 0 ||
    persisted.spool.assetBytes <= 0 ||
    persisted.spool.preparedBytes <= 0
  ) {
    throw new Error("Browser benchmark did not retain its complete durable payload.");
  }
  const after = await storageEstimate();
  const reportSummary = snapshot.reportSummary ?? {};
  const result: BrowserJobBaselineExportResult = {
    format,
    jobExecutionMs,
    durableRequestBytes: new TextEncoder().encode(
      JSON.stringify(durableRequest),
    ).byteLength,
    artifactBytes: snapshot.artifact.byteLength,
    artifactSha256: snapshot.artifact.sha256,
    persistedArtifactBytes: persisted.artifactBytes,
    indexedDbPayloadBytes: persisted.totalPayloadBytes,
    spool: persisted.spool,
    originUsageBeforeBytes: before.usage,
    originUsageAfterBytes: after.usage,
    originQuotaBytes: after.quota,
    compilerVersion: browserCompiler?.version ?? null,
    reportSummary,
    reportSha256: await sha256(JSON.stringify(reportSummary)),
    state: "succeeded",
  };
  output(`complete:${format}:${result.artifactBytes}`);
  return result;
}

async function cleanup(): Promise<void> {
  corpus = undefined;
  composedBlocks = 0;
}

window.atlcliExportJobBaseline = {
  setup,
  prepare,
  run,
  cleanup,
} satisfies BrowserExportJobBaselineApi;
output("ready");
