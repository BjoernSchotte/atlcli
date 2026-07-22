import { expect, test, chromium, type BrowserContext, type CDPSession } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, hostname, platform, release, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserBaselineFormat, BrowserBaselinePages } from "./protocol.js";
import {
  createChromeBaselineProvenance,
  selectResumableResults,
  type ChromeBaselineConfiguration,
} from "./resume-provenance.js";

const OUTPUT_DIR = fileURLToPath(
  new URL("../../.output/chrome-export-baseline-mv3", import.meta.url),
);
const DEFAULT_REPORT = fileURLToPath(
  new URL(
    "../../../../specs/export-expansion/013-isomorphic-export-jobs/baselines/chrome-pre-queue.json",
    import.meta.url,
  ),
);
const REPOSITORY_ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
const RAW_RESULTS_EXCLUDE =
  ":(exclude)specs/export-expansion/013-isomorphic-export-jobs/baselines/*.json";
const HARNESS_FIXTURE_FILES = [
  "apps/extension/package.json",
  "apps/extension/tests/export-baseline/app.ts",
  "apps/extension/tests/export-baseline/baseline.e2e.ts",
  "apps/extension/tests/export-baseline/playwright.config.ts",
  "apps/extension/tests/export-baseline/protocol.ts",
  "apps/extension/tests/export-baseline/public/background.js",
  "apps/extension/tests/export-baseline/public/manifest.json",
  "apps/extension/tests/export-baseline/resume-provenance.ts",
  "apps/extension/tests/export-baseline/vite.config.ts",
  "packages/export-fixtures/src/large-export-corpus.ts",
  "scripts/bench/export-baseline-contract.ts",
  "scripts/bench/run-chrome-export-baseline.ts",
] as const;

interface ChromeHeapBuckets {
  jsHeapUsedBytes: number;
  jsHeapTotalBytes: number;
  embedderHeapUsedBytes: number;
  backingStorageBytes: number;
  /** Runtime.getHeapUsage does not expose process RSS. */
  rssBytes: null;
  rssPeakBytes: null;
}

function pages(): BrowserBaselinePages[] {
  const values = (process.env.ATLCLI_EXPORT_BASELINE_PAGES ?? "50,500").split(",");
  if (values.some((value) => value !== "50" && value !== "500")) {
    throw new Error("ATLCLI_EXPORT_BASELINE_PAGES must contain only 50 and 500.");
  }
  return values.map(Number) as BrowserBaselinePages[];
}

function formats(): BrowserBaselineFormat[] {
  const values = (process.env.ATLCLI_EXPORT_BASELINE_FORMATS ?? "docx,pdf").split(",");
  if (values.some((value) => value !== "docx" && value !== "pdf")) {
    throw new Error("ATLCLI_EXPORT_BASELINE_FORMATS must contain only docx and pdf.");
  }
  return values as BrowserBaselineFormat[];
}

function positiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
  return value;
}

async function heap(session: CDPSession): Promise<ChromeHeapBuckets> {
  await session.send("HeapProfiler.collectGarbage");
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

function sourceTreeState(): { workingTreeDirty: boolean | null; treeFingerprint: string | null } {
  try {
    const status = execFileSync(
      "git",
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ".", RAW_RESULTS_EXCLUDE],
      { cwd: REPOSITORY_ROOT, encoding: "utf8" },
    );
    const diff = execFileSync(
      "git",
      ["diff", "--binary", "HEAD", "--", ".", RAW_RESULTS_EXCLUDE],
      { cwd: REPOSITORY_ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
    );
    const untracked = execFileSync(
      "git",
      ["ls-files", "--others", "--exclude-standard", "-z", "--", ".", RAW_RESULTS_EXCLUDE],
      { cwd: REPOSITORY_ROOT, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256").update("tracked-diff\0").update(diff);
    for (const relativePath of untracked) {
      hash.update("\0untracked\0").update(relativePath).update("\0");
      hash.update(readFileSync(join(REPOSITORY_ROOT, relativePath)));
    }
    return { workingTreeDirty: status.length > 0, treeFingerprint: hash.digest("hex") };
  } catch {
    return { workingTreeDirty: null, treeFingerprint: null };
  }
}

function harnessFixtureDigest(): string {
  const hash = createHash("sha256");
  for (const relativePath of HARNESS_FIXTURE_FILES) {
    hash.update(relativePath).update("\0");
    hash.update(readFileSync(join(REPOSITORY_ROOT, relativePath))).update("\0");
  }
  return hash.digest("hex");
}

async function detectBrowserVersion(): Promise<Record<string, string>> {
  const browser = await chromium.launch({ channel: "chromium", headless: true });
  try {
    const page = await browser.newPage();
    const session = await page.context().newCDPSession(page);
    return (await session.send("Browser.getVersion")) as Record<string, string>;
  } finally {
    await browser.close();
  }
}

test("records the PRE-QUEUE DOCX and Typst/PDF paths in real headless Chrome", async () => {
  const requestedPages = pages();
  const requestedFormats = formats();
  const repeat = positiveInt("ATLCLI_EXPORT_BASELINE_REPEAT", 3);
  const seed = positiveInt("ATLCLI_EXPORT_BASELINE_SEED", 0x9e37_79b9) >>> 0;
  const out = resolve(process.env.ATLCLI_EXPORT_BASELINE_OUT ?? DEFAULT_REPORT);
  const configuration: ChromeBaselineConfiguration = {
    pages: requestedPages,
    formats: requestedFormats,
    repeat,
    seed,
  };
  const browserVersion = await detectBrowserVersion();
  const tree = sourceTreeState();
  const provenance = createChromeBaselineProvenance({
    gitCommit: commit(),
    ...tree,
    harnessFixtureDigest: harnessFixtureDigest(),
    browser: browserVersion,
    platform: platform(),
    release: release(),
    architecture: process.arch,
    configuration,
  });
  const results: Array<Record<string, unknown>> = [];
  if (process.env.ATLCLI_EXPORT_BASELINE_RESUME === "1" && existsSync(out)) {
    const previous = JSON.parse(readFileSync(out, "utf8")) as {
      schema?: string;
      state?: string;
      shape?: string;
      provenance?: Parameters<typeof selectResumableResults>[0]["provenance"];
      results?: Array<Record<string, unknown>>;
    };
    results.push(
      ...selectResumableResults(previous, provenance).filter(
        (result) =>
          requestedPages.includes(result.pages as BrowserBaselinePages) &&
          requestedFormats.includes(result.format as BrowserBaselineFormat) &&
          Number(result.repetition) <= repeat,
      ),
    );
  }

  const write = (): void => {
    const report = {
      schema: "atlcli.pre-queue-export-baseline/1",
      measuredAt: new Date().toISOString(),
      shape: "browser-extension-harness",
      state: "pre-queue",
      provenance,
      environment: {
        gitCommit: provenance.gitCommit,
        workingTreeDirty: provenance.workingTreeDirty,
        treeFingerprint: provenance.treeFingerprint,
        harnessFixtureDigest: provenance.harnessFixtureDigest,
        browser: browserVersion,
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
        heapBuckets: "extension-page CDP Runtime.getHeapUsage checkpoints after forced V8 GC",
        rssBytes: null,
        rssPeakBytes: null,
        rssReason: "CDP Runtime.getHeapUsage does not expose process RSS",
        persistedInputBytes: null,
        persistedArtifactBytes: null,
        persistenceReason: "the measured direct PRE-QUEUE calls keep input/output in page memory and create no durable queue record",
        dedicatedWorkerHeap: null,
        offscreenWorkerHeap: null,
        workerHeapReason: "this harness measures the direct extension-page engine surface; no worker is used",
        wasmLinearMemoryBytes: null,
        wasmReason: "CDP Runtime.getHeapUsage does not expose the compiler WASM linear-memory bucket separately",
        artifactBytes: "exact emitted Uint8Array byteLength",
      },
      results,
    };
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  };

  for (const pageCount of requestedPages) {
    for (const format of requestedFormats) {
      for (let repetition = 1; repetition <= repeat; repetition += 1) {
        if (
          results.some(
            (result) =>
              result.pages === pageCount &&
              result.format === format &&
              result.repetition === repetition,
          )
        ) {
          continue;
        }
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
          serviceWorker ??= await context.waitForEvent("serviceworker", { timeout: 30_000 });
          const extensionId = new URL(serviceWorker.url()).host;
          const page = await context.newPage();
          const loadStarted = performance.now();
          await page.goto(`chrome-extension://${extensionId}/index.html`);
          await expect(page.getByTestId("baseline-state")).toHaveText("ready");
          const pageLoadMs = performance.now() - loadStarted;
          const cdp = await context.newCDPSession(page);
          const scenarioBrowserVersion = (await cdp.send("Browser.getVersion")) as Record<string, string>;
          expect(scenarioBrowserVersion).toEqual(browserVersion);
          const ready = await heap(cdp);

          const setup = await page.evaluate((value) => window.atlcliExportBaseline.setup(value), format);
          const engineReady = await heap(cdp);

          const prepared = await page.evaluate(
            (options) => window.atlcliExportBaseline.prepare(options),
            { pages: pageCount, seed },
          );
          const corpusPrepared = await heap(cdp);

          const exported = await page.evaluate((value) => window.atlcliExportBaseline.run(value), format);
          const artifactHeld = await heap(cdp);
          expect(exported.artifactBytes).toBeGreaterThan(0);
          expect(exported.persistedArtifactBytes).toBeNull();
          expect(prepared.persistedInputBytes).toBeNull();
          expect(await page.evaluate(() => window.atlcliExportBaseline.heldArtifactBytes())).toBe(
            exported.artifactBytes,
          );

          results.push({
            repetition,
            provenanceFingerprint: provenance.fingerprint,
            ...prepared,
            ...exported,
            ...setup,
            pageLoadMs,
            heap: {
              surface: "extension-page",
              checkpoints: { ready, engineReady, corpusPrepared, artifactHeld },
              dedicatedWorker: null,
              offscreenWorker: null,
              wasmLinearMemoryBytes: null,
            },
          });
          write();
          await page.evaluate(() => window.atlcliExportBaseline.cleanup());
          await cdp.detach();
        } finally {
          await context?.close();
        }
      }
    }
  }
  write();
  console.log(`ATLCLI_EXPORT_BASELINE_REPORT=${out}`);
});
