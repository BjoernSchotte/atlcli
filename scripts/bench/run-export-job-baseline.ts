/**
 * Reproducible POST-QUEUE Node benchmark for the productive job boundary.
 *
 * Each matrix cell runs in an isolated Bun process and uses the real file
 * journal, source/asset spool, ready-to-render stores, heavy-render lock,
 * result store, artifact finalization, PDF executor, and TypeScript DOCX
 * executor. The Confluence transport is deterministic synthetic input so the
 * measurement is repeatable and directly comparable with the committed
 * PRE-QUEUE corpus.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { cpus, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  composeChapters,
  type ExportPageNode,
} from "@atlcli/confluence";
import {
  type AssetFetcher,
  type ExportInput,
} from "@atlcli/docx";
import {
  type DocxExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobRequestV1,
  type PdfExportJobRequestV1,
  type ResourceEstimateV1,
} from "@atlcli/export-jobs";
import {
  createFileExportJobPersistence,
  runClaimedFileExportJob,
} from "@atlcli/export-node";
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
  createPdfExportJobExecutor,
  createTypescriptDocxExportJobExecutor,
} from "@atlcli/export-wiring/jobs";
import {
  PDF_RUNTIME_ASSETS,
  type PdfAssetResolver,
  type PdfCompilePort,
} from "@atlcli/pdf";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import { ensurePdfFonts } from "../../packages/pdf/scripts/ensure-fonts.js";
import {
  logicalCorpusBytes,
  parseExportBaselineArgs,
  type ExportBaselineFormat,
  type ExportBaselinePages,
} from "./export-baseline-contract.js";

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_OUT = resolve(
  dirname(SELF),
  "../../specs/export-expansion/013-isomorphic-export-jobs/baselines/node-post-queue.json",
);
const CHILD_MARKER = "ATLCLI_EXPORT_JOB_BASELINE_CHILD=";
const EXPORT_DATE = new Date("2026-07-22T00:00:00.000Z");
const MIB = 1024 * 1024;

interface HeapBuckets {
  heapUsedBytes: number;
  heapTotalBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  rssBytes: number;
  rssPeakBytes: null;
}

interface SpoolBreakdown {
  totalBytes: number;
  sourceBytes: number;
  assetBytes: number;
  preparedBytes: number;
  otherBytes: number;
  objectCount: number;
  namespaces: Record<string, number>;
}

interface ChildResult {
  pages: ExportBaselinePages;
  format: ExportBaselineFormat;
  repetition: number;
  seed: number;
  corpusDigest: string;
  counts: LargeExportCorpus["counts"];
  logicalInputBytes: number;
  durableRequestBytes: number;
  artifactBytes: number;
  artifactSha256: string;
  reportSummary: Record<string, unknown>;
  reportSha256: string;
  setupMs: number;
  corpusAndComposeMs: number;
  corpusFingerprintMs: number;
  jobExecutionMs: number;
  totalMs: number;
  heap: {
    processStart: HeapBuckets;
    engineReady: HeapBuckets;
    corpusPrepared: HeapBuckets;
    jobCompleted: HeapBuckets;
  };
  spool: SpoolBreakdown;
  physicalStateBytes: number;
  compilerVersion: string | null;
  state: "succeeded";
}

function heap(): HeapBuckets {
  const value = process.memoryUsage();
  return {
    heapUsedBytes: value.heapUsed,
    heapTotalBytes: value.heapTotal,
    externalBytes: value.external,
    arrayBuffersBytes: value.arrayBuffers,
    rssBytes: value.rss,
    rssPeakBytes: null,
  };
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

async function packageBytes(specifier: string): Promise<Uint8Array> {
  const path = fileURLToPath(import.meta.resolve(specifier));
  return new Uint8Array(await Bun.file(path).arrayBuffer());
}

async function buildCompiler(): Promise<BrowserPdfCompiler> {
  await ensurePdfFonts({ logger: () => {} });
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`),
    ),
  ]);
  return new BrowserPdfCompiler({
    wasm: wasm.buffer.slice(
      wasm.byteOffset,
      wasm.byteOffset + wasm.byteLength,
    ) as ArrayBuffer,
    fonts,
  });
}

function assetFor(
  corpus: LargeExportCorpus,
  pageId: string | undefined,
  filename: string,
): LargeExportCorpus["assets"][number] {
  const exact = corpus.assets.find(
    (asset) => asset.pageId === pageId && asset.filename === filename,
  );
  const unique = corpus.assets.filter((asset) => asset.filename === filename);
  const result = exact ?? (unique.length === 1 ? unique[0] : undefined);
  if (!result) {
    throw new Error(`Job benchmark asset not found: ${pageId ?? "?"}/${filename}`);
  }
  return result;
}

function docxAssets(corpus: LargeExportCorpus): AssetFetcher {
  return {
    async fetch(ref) {
      if (!ref.filename) {
        throw new Error("DOCX job benchmark received an asset without filename.");
      }
      return assetFor(corpus, ref.pageId, ref.filename).bytes.slice();
    },
  };
}

function pdfAssets(corpus: LargeExportCorpus): PdfAssetResolver {
  return {
    async resolve(ref) {
      if (!ref.filename) {
        throw new Error("PDF job benchmark received an asset without filename.");
      }
      const asset = assetFor(corpus, ref.pageId, ref.filename);
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
  format: ExportBaselineFormat,
  pages: ExportBaselinePages,
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
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `node-post-queue:${format}:${pages}:${id}`,
    source: {
      kind: "confluence",
      siteOrigin: "https://example.invalid",
      locator: { kind: "page-id", id: "large-page-1", version: 1 },
      scope: {
        kind: "tree",
        includeRoot: true,
      },
    },
    authRef: "benchmark:synthetic",
    displayName: `Large export job benchmark (${pages} pages)`,
    requestedFilename: `large-export-${pages}.${format}`,
    createdAt: EXPORT_DATE.getTime(),
    priority: "interactive",
    output: { policy: "collect" },
  };
}

async function request(
  id: string,
  format: ExportBaselineFormat,
  pages: ExportBaselinePages,
): Promise<PdfExportJobRequestV1 | DocxExportJobRequestV1> {
  const base = requestBase(id, format, pages);
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

function manifestEntries(corpus: LargeExportCorpus) {
  return corpus.nodes.map((node, ordinal) => ({
    ordinal,
    key: `${node.pageId}:v${node.meta.version}`,
    pageId: node.pageId,
    title: node.title,
  }));
}

async function durableBlocks(
  corpus: LargeExportCorpus,
  context: ExportJobExecutionContext,
  requestKey: string,
): Promise<ReturnType<typeof composeChapters>["blocks"]> {
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
      throw new Error(`Synthetic benchmark page ${result.pageId} was not durable.`);
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

function estimate(
  corpus: LargeExportCorpus,
  format: ExportBaselineFormat,
): ResourceEstimateV1 {
  const logicalBytes = logicalCorpusBytes(corpus);
  return {
    heapBytes: Math.max(64 * MIB, logicalBytes * 8),
    spoolBytes: Math.max(16 * MIB, logicalBytes * 4),
    outputBytes: format === "pdf" ? 64 * MIB : 32 * MIB,
    rasterPixels: 32 * MIB,
    confidence: "estimated",
  };
}

function directoryBytes(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    total += entry.isDirectory() ? directoryBytes(child) : statSync(child).size;
  }
  return total;
}

async function spoolBreakdown(
  persistence: ReturnType<typeof createFileExportJobPersistence>,
  jobId: string,
  leaseEpoch: number,
): Promise<SpoolBreakdown> {
  const refs = await persistence.spool.listNamespaceRefs(jobId, leaseEpoch);
  const namespaces: Record<string, number> = {};
  let totalBytes = 0;
  for (const ref of refs) {
    const object = await persistence.spool.stat(ref);
    if (!object) throw new Error("Committed benchmark spool object disappeared.");
    totalBytes += object.byteLength;
    namespaces[ref.namespace] =
      (namespaces[ref.namespace] ?? 0) + object.byteLength;
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
  return {
    totalBytes,
    sourceBytes,
    assetBytes,
    preparedBytes,
    otherBytes: totalBytes - sourceBytes - assetBytes - preparedBytes,
    objectCount: refs.length,
    namespaces,
  };
}

async function runChild(
  pages: ExportBaselinePages,
  format: ExportBaselineFormat,
  repetition: number,
  seed: number,
): Promise<ChildResult> {
  const totalStarted = performance.now();
  const processStart = heap();
  const setupStarted = performance.now();
  const compiler = format === "pdf" ? await buildCompiler() : null;
  const setupMs = performance.now() - setupStarted;
  const engineReady = heap();

  const corpusStarted = performance.now();
  const corpus = generateLargeExportCorpus({ pages, seed });
  // Match the PRE-QUEUE phase boundary even though the productive resolver
  // composes again from its durable page spool during job execution.
  composeChapters(corpus.nodes);
  const corpusAndComposeMs = performance.now() - corpusStarted;
  const fingerprintStarted = performance.now();
  const logicalInputByteLength = logicalCorpusBytes(corpus);
  const corpusDigest = await digestLargeExportCorpus(corpus);
  const corpusFingerprintMs = performance.now() - fingerprintStarted;
  const corpusPrepared = heap();

  const root = mkdtempSync(join(tmpdir(), "atlcli-post-queue-node-"));
  try {
    const persistence = createFileExportJobPersistence({
      rootDir: join(root, "state"),
    });
    const id =
      `node-${format}-${pages}-${repetition}-` +
      `${seed.toString(16).padStart(8, "0")}`;
    const durableRequest = await request(id, format, pages);
    const docxTemplate =
      durableRequest.format === "docx" ? durableRequest.template : undefined;
    const queued = await persistence.jobs.create({ request: durableRequest });
    const claimed = await persistence.jobs.claimNext({
      ownerId: `benchmark:${process.pid}`,
      now: Date.now(),
      leaseDurationMs: 120_000,
      ids: [queued.id],
    });
    if (!claimed) throw new Error("Node benchmark job was not claimable.");

    const renderEstimate = estimate(corpus, format);
    const executor =
      format === "pdf"
        ? createPdfExportJobExecutor({
            async resolveInput(pdfRequest, context) {
              return {
                input: {
                  blocks: await durableBlocks(
                    corpus,
                    context,
                    pdfRequest.idempotencyKey,
                  ),
                  metadata: {
                    title: durableRequest.displayName,
                    space: "BENCH",
                    version: 1,
                    exporter: "atlcli POST-QUEUE Node benchmark",
                    exportedAt: EXPORT_DATE,
                  },
                  profile: "tagged",
                  filename: durableRequest.requestedFilename!,
                },
                env: {
                  assets: checkpointPdfAssetsV1(
                    context,
                    pdfRequest.idempotencyKey,
                    pdfAssets(corpus),
                  ),
                },
                telemetry: { sourcePageCount: pages },
              };
            },
            readyToRender: persistence.pdfReadyToRender,
            estimateRender: () => renderEstimate,
            compiler: compiler as PdfCompilePort,
            renderReservations: persistence.pdfRenderReservations,
            results: persistence.pdfResults,
          })
        : createTypescriptDocxExportJobExecutor({
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
                  corpus,
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
                  docxAssets(corpus),
                ),
                jobTelemetry: { sourcePageCount: pages },
              };
            },
            estimateRender: () => renderEstimate,
            templates: {
              async resolve(input) {
                if (
                  !docxTemplate ||
                  input.recordKey !== docxTemplate.recordKey ||
                  input.expectedSha256 !== docxTemplate.sha256
                ) {
                  throw new Error("Node benchmark template identity changed.");
                }
                return {
                  recordKey: input.recordKey,
                  bytes: DOCX_TEMPLATE_BYTES.slice(),
                };
              },
            },
            readyToRender: persistence.docxReadyToRender,
            renderReservations: persistence.docxRenderReservations,
            results: persistence.docxResults,
          });

    const executionStarted = performance.now();
    const snapshot = await runClaimedFileExportJob({
      claimed,
      jobs: persistence.jobs,
      spool: persistence.spool,
      artifacts: persistence.artifacts,
      spoolLimits: persistence.spoolLimits,
      executor,
      leaseDurationMs: 120_000,
      heartbeatIntervalMs: 5_000,
      cancelPollMs: 250,
    });
    const jobExecutionMs = performance.now() - executionStarted;
    if (snapshot.state !== "succeeded" || !snapshot.artifact) {
      throw new Error(
        `Node benchmark job failed: ${snapshot.error?.message ?? snapshot.state}`,
      );
    }
    const jobCompleted = heap();
    const spool = await spoolBreakdown(
      persistence,
      snapshot.id,
      snapshot.leaseEpoch,
    );
    const reportSummary = snapshot.reportSummary ?? {};
    return {
      pages,
      format,
      repetition,
      seed,
      corpusDigest,
      counts: corpus.counts,
      logicalInputBytes: logicalInputByteLength,
      durableRequestBytes: new TextEncoder().encode(
        JSON.stringify(durableRequest),
      ).byteLength,
      artifactBytes: snapshot.artifact.byteLength,
      artifactSha256: snapshot.artifact.sha256,
      reportSummary,
      reportSha256: await sha256(JSON.stringify(reportSummary)),
      setupMs,
      corpusAndComposeMs,
      corpusFingerprintMs,
      jobExecutionMs,
      totalMs: performance.now() - totalStarted,
      heap: {
        processStart,
        engineReady,
        corpusPrepared,
        jobCompleted,
      },
      spool,
      physicalStateBytes: directoryBytes(persistence.rootDir),
      compilerVersion:
        format === "pdf"
          ? (compiler as BrowserPdfCompiler).version
          : null,
      state: "succeeded",
    };
  } finally {
    await compiler?.reset();
    rmSync(root, { recursive: true, force: true });
  }
}

function gitCommit(): string | null {
  const result = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}

function workingTreeDirty(): boolean | null {
  const result = Bun.spawnSync(["git", "status", "--porcelain"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  return result.exitCode === 0 ? result.stdout.byteLength > 0 : null;
}

async function runParent(): Promise<void> {
  const options = parseExportBaselineArgs(process.argv.slice(2));
  const results: ChildResult[] = [];
  for (const pages of options.pages) {
    for (const format of options.formats) {
      for (let repetition = 1; repetition <= options.repeat; repetition += 1) {
        const child = Bun.spawn(
          [
            process.execPath,
            "--conditions=development",
            SELF,
            "--child",
            "--pages",
            String(pages),
            "--formats",
            format,
            "--repeat",
            String(repetition),
            "--seed",
            String(options.seed),
          ],
          { stdout: "pipe", stderr: "inherit" },
        );
        const stdout = await new Response(child.stdout).text();
        const exitCode = await child.exited;
        if (exitCode !== 0) {
          throw new Error(
            `Post-queue child failed (${pages}/${format}/${repetition}).`,
          );
        }
        const line = stdout
          .split("\n")
          .find((entry) => entry.startsWith(CHILD_MARKER));
        if (!line) {
          throw new Error(
            `Post-queue child emitted no result (${pages}/${format}/${repetition}).`,
          );
        }
        results.push(
          JSON.parse(line.slice(CHILD_MARKER.length)) as ChildResult,
        );
      }
    }
  }
  const report = {
    schema: "atlcli.post-queue-export-baseline/1",
    measuredAt: new Date().toISOString(),
    shape: "node-cli",
    state: "post-queue",
    environment: {
      gitCommit: gitCommit(),
      workingTreeDirty: workingTreeDirty(),
      runtime: `Bun ${Bun.version}`,
      platform: platform(),
      release: release(),
      architecture: process.arch,
      hostname: hostname(),
      cpu: cpus()[0]?.model ?? null,
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    configuration: options,
    observability: {
      heapBuckets:
        "process.memoryUsage checkpoints; synchronous in-stage peaks are not observable",
      rssPeakBytes: null,
      durableRequestBytes: "exact UTF-8 JSON request envelope bytes",
      spoolBytes:
        "sum of committed file-spool object payloads, grouped by namespace",
      physicalStateBytes:
        "recursive file bytes for journal, requests, spool, reports, and artifact",
      artifactBytes:
        "finalized artifact metadata byteLength; artifact bytes remain in the file store",
      sourceTransport:
        "deterministic synthetic corpus; every normalized page is committed to the productive source spool before composition",
    },
    results,
  };
  const out = resolve(options.out ?? DEFAULT_OUT);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Wrote ${out}`);
}

if (process.argv.includes("--child")) {
  const options = parseExportBaselineArgs(process.argv.slice(2));
  const repetition = Number(
    process.argv[process.argv.indexOf("--repeat") + 1],
  );
  const result = await runChild(
    options.pages[0]!,
    options.formats[0]!,
    repetition,
    options.seed,
  );
  console.log(`${CHILD_MARKER}${JSON.stringify(result)}`);
} else {
  await runParent();
}
