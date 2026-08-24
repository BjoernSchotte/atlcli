import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BrowserContext, TestInfo } from "@playwright/test";
import {
  PackedBrowserEvidence,
  browserEvidenceSuiteDir,
  opaqueBrowserEvidenceId,
} from "./packed-browser-evidence.js";

const originalRoot = process.env.ATLCLI_BROWSER_EVIDENCE_ROOT;

afterEach(() => {
  if (originalRoot === undefined) delete process.env.ATLCLI_BROWSER_EVIDENCE_ROOT;
  else process.env.ATLCLI_BROWSER_EVIDENCE_ROOT = originalRoot;
});

describe("packed browser evidence paths", () => {
  test("uses a fixed suite directory below an absolute configured root", () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-browser-evidence-test-"));
    try {
      process.env.ATLCLI_BROWSER_EVIDENCE_ROOT = root;
      expect(browserEvidenceSuiteDir("research")).toBe(join(root, "research"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resolves a relative configured root from the caller cwd", () => {
    process.env.ATLCLI_BROWSER_EVIDENCE_ROOT = ".artifacts/evidence-test";
    expect(browserEvidenceSuiteDir("jobs")).toBe(
      resolve(process.cwd(), ".artifacts/evidence-test", "jobs"),
    );
  });

  test("derives stable opaque identifiers without leaking the test title", () => {
    const testId = "tests/jobs/packed/job-recovery.e2e.ts::tenant-shaped title";
    const opaque = opaqueBrowserEvidenceId(testId);
    expect(opaque).toMatch(/^[a-f0-9]{20}$/u);
    expect(opaque).toBe(opaqueBrowserEvidenceId(testId));
    expect(opaque).not.toContain("tenant");
  });
});

function fakeTestInfo(
  testId: string,
  status: "passed" | "failed",
): TestInfo {
  return { testId, status, expectedStatus: "passed" } as TestInfo;
}

function fakeContext(videoDir: string, index: number): BrowserContext {
  let chunkStarted = false;
  const page = {
    isClosed: () => false,
    screenshot: async ({ path }: { path: string }) => {
      writeFileSync(path, "png");
    },
  };
  return {
    tracing: {
      start: async () => undefined,
      startChunk: async () => {
        chunkStarted = true;
      },
      stopChunk: async ({ path }: { path: string }) => {
        expect(chunkStarted).toBe(true);
        writeFileSync(path, "trace");
        chunkStarted = false;
      },
      stop: async () => undefined,
    },
    pages: () => [page],
    close: async () => {
      mkdirSync(videoDir, { recursive: true });
      writeFileSync(join(videoDir, `raw-${index}.webm`), "video");
    },
  } as unknown as BrowserContext;
}

describe("PackedBrowserEvidence", () => {
  test("discards traces and suite videos when the test passes", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-browser-evidence-pass-"));
    process.env.ATLCLI_BROWSER_EVIDENCE_ROOT = root;
    try {
      const evidence = new PackedBrowserEvidence("worker");
      const options = evidence.launchOptions({ headless: true });
      const context = fakeContext(options.recordVideo.dir, 1);
      await evidence.attachContext(context);
      await evidence.startTest(fakeTestInfo("worker passes", "passed"));
      await evidence.finishTest(fakeTestInfo("worker passes", "passed"));
      await evidence.closeContext(context);
      evidence.finalize();

      expect(existsSync(join(root, "worker", ".pending"))).toBe(false);
      expect(existsSync(join(root, "worker", "failures"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("retains opaque failure evidence across a context restart", async () => {
    const root = mkdtempSync(join(tmpdir(), "atlcli-browser-evidence-fail-"));
    process.env.ATLCLI_BROWSER_EVIDENCE_ROOT = root;
    try {
      const evidence = new PackedBrowserEvidence("jobs");
      const options = evidence.launchOptions({ headless: true });
      const firstContext = fakeContext(options.recordVideo.dir, 1);
      await evidence.attachContext(firstContext);
      const testInfo = fakeTestInfo("jobs restart failure", "failed");
      await evidence.startTest(testInfo);
      await evidence.closeContext(firstContext);
      const restartedContext = fakeContext(options.recordVideo.dir, 2);
      await evidence.attachContext(restartedContext);
      await evidence.finishTest(testInfo);
      await evidence.closeContext(restartedContext);
      evidence.finalize();

      const opaque = opaqueBrowserEvidenceId(testInfo.testId);
      const files = readdirSync(join(root, "jobs", "failures", opaque)).sort();
      expect(files).toEqual([
        "screenshot-1.png",
        "trace-1.zip",
        "trace-2.zip",
        "video-1.webm",
        "video-2.webm",
      ]);
      expect(JSON.stringify(files)).not.toContain("restart failure");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
