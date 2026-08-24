import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, TestInfo, chromium } from "@playwright/test";

export const PACKED_BROWSER_EVIDENCE_SUITES = [
  "worker",
  "jobs",
  "research",
  "rovo",
  "palette",
] as const;

export type PackedBrowserEvidenceSuite =
  (typeof PACKED_BROWSER_EVIDENCE_SUITES)[number];

type PersistentContextOptions = NonNullable<
  Parameters<typeof chromium.launchPersistentContext>[1]
>;
type RecordVideoOptions = NonNullable<PersistentContextOptions["recordVideo"]>;

type ContextState = {
  context: BrowserContext;
  index: number;
  chunkStarted: boolean;
};

type ActiveTest = {
  opaqueId: string;
  pendingTraces: string[];
};

const REPOSITORY_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

export function browserEvidenceRoot(): string {
  const configured = process.env.ATLCLI_BROWSER_EVIDENCE_ROOT?.trim();
  if (!configured) return join(REPOSITORY_ROOT, ".artifacts", "browser-evidence");
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

export function browserEvidenceSuiteDir(
  suite: PackedBrowserEvidenceSuite,
): string {
  return join(browserEvidenceRoot(), suite);
}

export function opaqueBrowserEvidenceId(testId: string): string {
  return createHash("sha256").update(testId).digest("hex").slice(0, 20);
}

/**
 * Captures evidence for persistent Chromium contexts created outside Playwright's
 * fixture lifecycle. One instance belongs to one packed MV3 suite process.
 */
export class PackedBrowserEvidence {
  readonly suiteDir: string;

  private readonly pendingDir: string;
  private readonly pendingVideoDir: string;
  private readonly contexts = new Map<BrowserContext, ContextState>();
  private activeTest: ActiveTest | undefined;
  private firstFailureId: string | undefined;
  private contextIndex = 0;
  private screenshotIndex = 0;

  constructor(readonly suite: PackedBrowserEvidenceSuite) {
    this.suiteDir = browserEvidenceSuiteDir(suite);
    this.pendingDir = join(this.suiteDir, ".pending");
    this.pendingVideoDir = join(this.pendingDir, "videos");
  }

  launchOptions(
    options: PersistentContextOptions,
  ): PersistentContextOptions & { recordVideo: RecordVideoOptions } {
    return {
      ...options,
      recordVideo: {
        ...options.recordVideo,
        dir: this.pendingVideoDir,
      },
    };
  }

  async attachContext(context: BrowserContext): Promise<void> {
    mkdirSync(this.pendingVideoDir, { recursive: true });
    const state: ContextState = {
      context,
      index: ++this.contextIndex,
      chunkStarted: false,
    };
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    this.contexts.set(context, state);
    if (this.activeTest) await this.startChunk(state, this.activeTest);
  }

  async startTest(testInfo: TestInfo): Promise<void> {
    if (this.activeTest) {
      throw new Error("Packed browser evidence already has an active test.");
    }
    const activeTest: ActiveTest = {
      opaqueId: opaqueBrowserEvidenceId(testInfo.testId),
      pendingTraces: [],
    };
    this.activeTest = activeTest;
    for (const state of this.contexts.values()) {
      await this.startChunk(state, activeTest);
    }
  }

  async finishTest(testInfo: TestInfo): Promise<void> {
    const activeTest = this.activeTest;
    if (!activeTest) {
      throw new Error("Packed browser evidence has no active test to finish.");
    }
    const failed = testInfo.status !== testInfo.expectedStatus;
    const finishErrors: unknown[] = [];
    if (failed) this.firstFailureId ??= activeTest.opaqueId;
    try {
      if (failed) {
        await this.captureFailureScreenshots(activeTest.opaqueId).catch((error) => {
          finishErrors.push(error);
        });
      }
      for (const state of this.contexts.values()) {
        await this.stopChunk(state, activeTest).catch((error) => {
          finishErrors.push(error);
        });
      }
      if (failed) {
        try {
          this.retainTraces(activeTest);
        } catch (error) {
          finishErrors.push(error);
        }
      } else {
        try {
          this.discardTraces(activeTest);
        } catch (error) {
          finishErrors.push(error);
        }
      }
    } finally {
      this.activeTest = undefined;
    }
    if (finishErrors.length > 0) {
      throw new AggregateError(
        finishErrors,
        `Failed to finalize ${this.suite} browser evidence.`,
      );
    }
  }

  async closeContext(context: BrowserContext): Promise<void> {
    const state = this.contexts.get(context);
    if (!state) {
      await context.close();
      return;
    }
    try {
      if (this.activeTest) await this.stopChunk(state, this.activeTest);
      await context.tracing.stop();
    } finally {
      this.contexts.delete(context);
      await context.close();
    }
  }

  /** Call only after every recorded context has closed so videos are complete. */
  finalize(): void {
    if (this.contexts.size > 0) {
      throw new Error(
        `Cannot finalize ${this.suite} browser evidence with open contexts.`,
      );
    }
    if (!this.firstFailureId) {
      rmSync(this.pendingDir, { recursive: true, force: true });
      return;
    }

    const failureDir = this.failureDir(this.firstFailureId);
    mkdirSync(failureDir, { recursive: true });
    const videos = existsSync(this.pendingVideoDir)
      ? readdirSync(this.pendingVideoDir)
          .filter((name) => name.endsWith(".webm"))
          .sort()
      : [];
    for (const [index, name] of videos.entries()) {
      renameSync(
        join(this.pendingVideoDir, name),
        join(failureDir, `video-${index + 1}.webm`),
      );
    }
    rmSync(this.pendingDir, { recursive: true, force: true });
  }

  private async startChunk(
    state: ContextState,
    activeTest: ActiveTest,
  ): Promise<void> {
    if (state.chunkStarted) return;
    await state.context.tracing.startChunk({
      title: `${this.suite}:${activeTest.opaqueId}:${state.index}`,
    });
    state.chunkStarted = true;
  }

  private async stopChunk(
    state: ContextState,
    activeTest: ActiveTest,
  ): Promise<void> {
    if (!state.chunkStarted) return;
    const traceDir = join(this.pendingDir, activeTest.opaqueId);
    mkdirSync(traceDir, { recursive: true });
    const tracePath = join(
      traceDir,
      `context-${state.index}-${activeTest.pendingTraces.length + 1}.zip`,
    );
    await state.context.tracing.stopChunk({ path: tracePath });
    state.chunkStarted = false;
    activeTest.pendingTraces.push(tracePath);
  }

  private async captureFailureScreenshots(opaqueId: string): Promise<void> {
    const failureDir = this.failureDir(opaqueId);
    mkdirSync(failureDir, { recursive: true });
    for (const state of this.contexts.values()) {
      for (const page of state.context.pages()) {
        if (page.isClosed()) continue;
        const path = join(failureDir, `screenshot-${++this.screenshotIndex}.png`);
        await page.screenshot({ path, fullPage: true });
      }
    }
  }

  private retainTraces(activeTest: ActiveTest): void {
    const failureDir = this.failureDir(activeTest.opaqueId);
    mkdirSync(failureDir, { recursive: true });
    for (const [index, tracePath] of activeTest.pendingTraces.entries()) {
      renameSync(tracePath, join(failureDir, `trace-${index + 1}.zip`));
    }
  }

  private discardTraces(activeTest: ActiveTest): void {
    for (const tracePath of activeTest.pendingTraces) {
      rmSync(tracePath, { force: true });
    }
  }

  private failureDir(opaqueId: string): string {
    return join(this.suiteDir, "failures", opaqueId);
  }
}

export function createPackedBrowserEvidence(
  suite: PackedBrowserEvidenceSuite,
): PackedBrowserEvidence {
  return new PackedBrowserEvidence(suite);
}
