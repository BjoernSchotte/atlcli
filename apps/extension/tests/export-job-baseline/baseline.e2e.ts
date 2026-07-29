import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
} from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserJobBaselineCorpus,
  BrowserJobBaselineDocxMode,
  BrowserJobBaselineFormat,
  BrowserJobBaselinePages,
} from "./protocol.js";

const OUTPUT_DIR = fileURLToPath(
  new URL("../../.output/chrome-export-job-baseline-mv3", import.meta.url),
);
const DEFAULT_REPORT = fileURLToPath(
  new URL(
    "../../../../specs/export-expansion/013-isomorphic-export-jobs/baselines/chrome-post-queue.json",
    import.meta.url,
  ),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const RAW_RESULTS_EXCLUDE =
  ":(exclude)specs/export-expansion/013-isomorphic-export-jobs/baselines/*.json";
const HARNESS_FILES = [
  "apps/extension/package.json",
  "apps/extension/tests/export-job-baseline/app.ts",
  "apps/extension/tests/export-job-baseline/baseline.e2e.ts",
  "apps/extension/tests/export-job-baseline/index.html",
  "apps/extension/tests/export-job-baseline/playwright.config.ts",
  "apps/extension/tests/export-job-baseline/protocol.ts",
  "apps/extension/tests/export-job-baseline/vite.config.ts",
  "apps/extension/tests/export-baseline/public/background.js",
  "apps/extension/tests/export-baseline/public/manifest.json",
  "packages/export-fixtures/src/large-export-corpus.ts",
  "scripts/bench/export-baseline-contract.ts",
  "scripts/bench/run-chrome-export-job-baseline.ts",
] as const;

interface ChromeHeapBuckets {
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  embedderHeapUsedBytes: number;
  backingStorageBytes: number;
  rssBytes: null;
  rssPeakBytes: null;
}

function pages(): BrowserJobBaselinePages[] {
  const values = (
    process.env.ATLCLI_EXPORT_JOB_BASELINE_PAGES ?? "50,500"
  ).split(",");
  if (values.some((value) => value !== "50" && value !== "500")) {
    throw new Error(
      "ATLCLI_EXPORT_JOB_BASELINE_PAGES must contain only 50 and 500.",
    );
  }
  return values.map(Number) as BrowserJobBaselinePages[];
}

function formats(): BrowserJobBaselineFormat[] {
  const values = (
    process.env.ATLCLI_EXPORT_JOB_BASELINE_FORMATS ?? "docx,pdf"
  ).split(",");
  if (values.some((value) => value !== "docx" && value !== "pdf")) {
    throw new Error(
      "ATLCLI_EXPORT_JOB_BASELINE_FORMATS must contain only docx and pdf.",
    );
  }
  return values as BrowserJobBaselineFormat[];
}

function corpusKind(): BrowserJobBaselineCorpus {
  const value = process.env.ATLCLI_EXPORT_JOB_BASELINE_CORPUS ?? "text";
  if (value !== "text" && value !== "mixed" && value !== "image-heavy") {
    throw new Error(
      "ATLCLI_EXPORT_JOB_BASELINE_CORPUS must be text, mixed, or image-heavy.",
    );
  }
  return value;
}

function imageScale(): number | undefined {
  const raw = process.env.ATLCLI_EXPORT_JOB_BASELINE_IMAGE_SCALE;
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error("ATLCLI_EXPORT_JOB_BASELINE_IMAGE_SCALE must be in (0, 1].");
  }
  return value;
}

function docxMode(): BrowserJobBaselineDocxMode {
  const value = process.env.ATLCLI_EXPORT_JOB_BASELINE_DOCX_MODE ?? "adaptive";
  if (value !== "adaptive" && value !== "memory") {
    throw new Error("ATLCLI_EXPORT_JOB_BASELINE_DOCX_MODE must be adaptive or memory.");
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be positive.`);
  }
  return value;
}

async function currentHeap(session: CDPSession): Promise<ChromeHeapBuckets> {
  const value = (await session.send("Runtime.getHeapUsage")) as {
    usedSize: number;
    totalSize: number;
    embedderHeapUsedSize: number;
    backingStorageSize: number;
  };
  return {
    jsHeapUsedBytes: value.usedSize,
    jsHeapTotalBytes: value.totalSize,
    embedderHeapUsedBytes: value.embedderHeapUsedSize,
    backingStorageBytes: value.backingStorageSize,
    rssBytes: null,
    rssPeakBytes: null,
  };
}

async function heap(session: CDPSession): Promise<ChromeHeapBuckets> {
  await session.send("HeapProfiler.collectGarbage");
  return currentHeap(session);
}

function peakHeap(samples: ChromeHeapBuckets[]): ChromeHeapBuckets {
  const maximum = (key: keyof ChromeHeapBuckets): number =>
    Math.max(...samples.map((sample) => sample[key] ?? 0));
  return {
    jsHeapUsedBytes: maximum("jsHeapUsedBytes"),
    jsHeapTotalBytes: maximum("jsHeapTotalBytes"),
    embedderHeapUsedBytes: maximum("embedderHeapUsedBytes"),
    backingStorageBytes: maximum("backingStorageBytes"),
    rssBytes: null,
    rssPeakBytes: null,
  };
}

function commit(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function sourceTreeState(): {
  workingTreeDirty: boolean | null;
  treeFingerprint: string | null;
} {
  try {
    const status = execFileSync(
      "git",
      [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
        "--",
        ".",
        RAW_RESULTS_EXCLUDE,
      ],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    const diff = execFileSync(
      "git",
      ["diff", "--binary", "HEAD", "--", ".", RAW_RESULTS_EXCLUDE],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "buffer",
        maxBuffer: 64 * 1024 * 1024,
      },
    );
    const untracked = execFileSync(
      "git",
      [
        "ls-files",
        "--others",
        "--exclude-standard",
        "-z",
        "--",
        ".",
        RAW_RESULTS_EXCLUDE,
      ],
      {
        cwd: REPOSITORY_ROOT,
        encoding: "buffer",
        maxBuffer: 16 * 1024 * 1024,
      },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256")
      .update("tracked-diff\0")
      .update(diff);
    for (const relativePath of untracked) {
      hash.update("\0untracked\0").update(relativePath).update("\0");
      hash.update(readFileSync(join(REPOSITORY_ROOT, relativePath)));
    }
    return {
      workingTreeDirty: status.length > 0,
      treeFingerprint: hash.digest("hex"),
    };
  } catch {
    return { workingTreeDirty: null, treeFingerprint: null };
  }
}

function harnessDigest(): string {
  const hash = createHash("sha256");
  for (const relativePath of HARNESS_FILES) {
    hash.update(relativePath).update("\0");
    hash.update(readFileSync(join(REPOSITORY_ROOT, relativePath))).update("\0");
  }
  return hash.digest("hex");
}

async function browserVersion(): Promise<Record<string, string>> {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    return (await session.send("Browser.getVersion")) as Record<string, string>;
  } finally {
    await browser.close();
  }
}

test("records productive POST-QUEUE DOCX and PDF jobs in real Chromium", async () => {
  const requestedPages = pages();
  const requestedFormats = formats();
  const requestedCorpus = corpusKind();
  const requestedImageScale = imageScale();
  const requestedDocxMode = docxMode();
  const repeat = positiveInt("ATLCLI_EXPORT_JOB_BASELINE_REPEAT", 3);
  const seed =
    positiveInt("ATLCLI_EXPORT_JOB_BASELINE_SEED", 0x9e37_79b9) >>> 0;
  const out = resolve(
    process.env.ATLCLI_EXPORT_JOB_BASELINE_OUT ?? DEFAULT_REPORT,
  );
  const browser = await browserVersion();
  const tree = sourceTreeState();
  const configuration = {
    pages: requestedPages,
    formats: requestedFormats,
    repeat,
    seed,
    corpus: requestedCorpus,
    imageScale: requestedImageScale ?? null,
    docxMode: requestedDocxMode,
  };
  const provenance = {
    schema: "atlcli.post-queue-export-provenance/1",
    gitCommit: commit(),
    ...tree,
    harnessDigest: harnessDigest(),
    browser,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    configuration,
  };
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(provenance))
    .digest("hex");
  const results: Array<Record<string, unknown>> = [];

  const write = (): void => {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(
      out,
      `${JSON.stringify({
        schema: "atlcli.post-queue-export-baseline/1",
        measuredAt: new Date().toISOString(),
        shape: "browser-extension-job-harness",
        state: "post-queue",
        provenance: { ...provenance, fingerprint },
        environment: {
          gitCommit: provenance.gitCommit,
          workingTreeDirty: provenance.workingTreeDirty,
          treeFingerprint: provenance.treeFingerprint,
          harnessDigest: provenance.harnessDigest,
          browser,
          playwright: "1.55.0",
          platform: platform(),
          release: release(),
          architecture: process.arch,
          hostname: hostname(),
          cpu: cpus()[0]?.model ?? null,
          logicalCpuCount: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        configuration,
        observability: {
          heapBuckets:
            "extension-page CDP Runtime.getHeapUsage checkpoints after forced V8 GC",
          rssBytes: null,
          rssPeakBytes: null,
          rssReason: "CDP Runtime.getHeapUsage does not expose process RSS",
          indexedDbPayloadBytes:
            "exact committed spool and artifact payload byteLength from productive IndexedDB rows",
          originUsageBytes:
            "navigator.storage.estimate origin usage; browser estimate, not a per-job exact value",
          dedicatedWorkerHeap: null,
          offscreenDocumentHeap: null,
          workerHeapReason:
            "the deterministic benchmark rehosts the productive executor/runtime in one extension page; packed MV3 lifecycle tests separately prove the offscreen owner",
          wasmLinearMemoryBytes: null,
          wasmReason:
            "CDP Runtime.getHeapUsage does not expose compiler WASM linear memory separately",
          sourceTransport:
            "deterministic synthetic corpus; every normalized page is committed to productive IndexedDB before composition",
        },
        results,
      }, null, 2)}\n`,
    );
  };

  for (const pageCount of requestedPages) {
    for (const format of requestedFormats) {
      for (let repetition = 1; repetition <= repeat; repetition += 1) {
        let context: BrowserContext | undefined;
        try {
          context = await chromium.launchPersistentContext("", {
            channel: "chromium",
            headless: true,
            args: [
              `--disable-extensions-except=${OUTPUT_DIR}`,
              `--load-extension=${OUTPUT_DIR}`,
              "--enable-precise-memory-info",
            ],
          });
          let serviceWorker = context.serviceWorkers()[0];
          serviceWorker ??= await context.waitForEvent("serviceworker", {
            timeout: 30_000,
          });
          const extensionId = new URL(serviceWorker.url()).host;
          const page = await context.newPage();
          const loadStarted = performance.now();
          await page.goto(`chrome-extension://${extensionId}/index.html`);
          await expect(page.getByTestId("baseline-state")).toHaveText("ready");
          const pageLoadMs = performance.now() - loadStarted;
          const cdp = await context.newCDPSession(page);
          const ready = await heap(cdp);

          const setup = await page.evaluate(
            (value) => window.atlcliExportJobBaseline.setup(value),
            format,
          );
          const engineReady = await heap(cdp);
          const prepared = await page.evaluate(
            (options) => window.atlcliExportJobBaseline.prepare(options),
            {
              pages: pageCount,
              seed,
              corpusKind: requestedCorpus,
              docxMode: requestedDocxMode,
              ...(requestedImageScale === undefined
                ? {}
                : { imageScale: requestedImageScale }),
            },
          );
          const corpusPrepared = await heap(cdp);
          let exportSettled = false;
          const exportPromise = page.evaluate(
            (value) => window.atlcliExportJobBaseline.run(value),
            format,
          ).finally(() => {
            exportSettled = true;
          });
          const duringJobSamples: ChromeHeapBuckets[] = [];
          while (!exportSettled) {
            duringJobSamples.push(await currentHeap(cdp));
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
          }
          const exported = await exportPromise;
          duringJobSamples.push(await currentHeap(cdp));
          const jobCompleted = await heap(cdp);

          expect(exported.state).toBe("succeeded");
          expect(exported.artifactBytes).toBeGreaterThan(0);
          expect(exported.persistedArtifactBytes).toBe(exported.artifactBytes);
          expect(exported.spool.sourceBytes).toBeGreaterThan(0);
          expect(exported.spool.assetBytes).toBeGreaterThan(0);
          expect(exported.spool.preparedBytes).toBeGreaterThan(0);
          expect(exported.indexedDbPayloadBytes).toBe(
            exported.spool.totalBytes + exported.artifactBytes,
          );

          results.push({
            repetition,
            provenanceFingerprint: fingerprint,
            ...prepared,
            ...exported,
            ...setup,
            pageLoadMs,
            heap: {
              surface: "extension-page",
              checkpoints: {
                ready,
                engineReady,
                corpusPrepared,
                jobCompleted,
              },
              observedDuringJobPeak: peakHeap(duringJobSamples),
              observedDuringJobSamples: duringJobSamples.length,
              dedicatedWorker: null,
              offscreenDocument: null,
              wasmLinearMemoryBytes: null,
            },
          });
          write();
          await page.evaluate(() => window.atlcliExportJobBaseline.cleanup());
          await cdp.detach();
        } finally {
          await context?.close();
        }
      }
    }
  }
  write();
  console.log(`ATLCLI_EXPORT_JOB_BASELINE_REPORT=${out}`);
});
