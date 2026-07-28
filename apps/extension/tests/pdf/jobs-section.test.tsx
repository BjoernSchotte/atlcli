/**
 * The re-attach UI (spec 010 T5.6).
 *
 * Rendered under happy-dom with `globalThis.chrome` deleted — the Jobs screen is
 * a portable screen like every other, so it must reach the durable records
 * through its port and never through `chrome.*`.
 *
 * The records themselves are real: a real `fake-indexeddb` store driven through
 * the real `putPdfJob`/`claimPdfJob`/`completePdfJob`, so "the panel re-attaches
 * on mount" is tested as an actual read of an actual record rather than against
 * a hand-written list. Only the two genuine host effects are stubbed — sending
 * the cancel message and handing bytes to a download.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import type { PdfSourceBundle } from "@atlcli/pdf/browser";
import {
  FULL_REPORT_RETENTION_MS_V1,
  type DocxExportJobRequestV1,
  type PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import {
  cancelPdfJob,
  claimPdfJob,
  completePdfJob,
  deletePdfJob,
  getPdfJob,
  getPdfJobMeta,
  listPdfJobMeta,
  markPdfJobConsumed,
  putPdfJob,
  updatePdfJobProgress,
} from "../../utils/pdf/job-store.js";
import { createDurableJobsStore, createExtensionDurableJobsStore, type DurableJobsPort } from "../../utils/jobs/store.js";
import { IndexedDbExportJobCatalog } from "../../utils/export-jobs/catalog.js";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import {
  EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
  extensionDocxTemplateSpoolRef,
} from "../../utils/export-jobs/docx-template.js";
import { DurableJobsProvider } from "../../utils/jobs/context.js";
import { JobsScreen, jobsScreenDefinition, siteOriginOf } from "../../components/screens/JobsScreen.js";
import type { ScreenProps } from "../../utils/screens/registry.js";
import type { PanelState } from "../../utils/panel-state.js";
import type { AppPorts } from "../../utils/ports/index.js";

globalThis.IDBKeyRange = IDBKeyRange;

const DOM_GLOBALS = [
  "window",
  "document",
  "navigator",
  "location",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "getComputedStyle",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "MutationObserver",
] as const;

const SITE = "https://example.atlassian.net";
const OTHER_SITE = "https://staging.atlassian.net";
const JOB_HERE = "123e4567-e89b-42d3-a456-426614174000";
const JOB_ELSEWHERE = "223e4567-e89b-42d3-a456-426614174000";
const COMMON_JOB = "common-docx-1";
const COMMON_PDF = "common-pdf-1";
const SHA_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

let saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];
let win: Window | null = null;
let container: HTMLElement | null = null;
let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;
let savedChrome: PropertyDescriptor | undefined;
let factory: IDBFactory;
let emitted: { filename: string; bytes: number }[] = [];
let cancelRequests: string[] = [];

function installGlobal(key: string, value: unknown): void {
  saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
  Object.defineProperty(globalThis, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

beforeEach(() => {
  savedChrome = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  delete (globalThis as unknown as Record<string, unknown>).chrome;
  win = new Window({ url: `${SITE}/wiki` });
  saved = [];
  for (const key of DOM_GLOBALS) {
    const value = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    installGlobal(key, value);
  }
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as never);
  factory = new IDBFactory();
  emitted = [];
  cancelRequests = [];
});

afterEach(async () => {
  if (root) {
    const { act } = await import("react");
    const current = root;
    await act(async () => {
      current.unmount();
    });
  }
  root = null;
  try {
    await win?.happyDOM?.close();
  } catch {
    /* already closed */
  }
  for (const { key, descriptor } of [...saved].reverse()) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete (globalThis as unknown as Record<string, unknown>)[key];
  }
  if (savedChrome) Object.defineProperty(globalThis, "chrome", savedChrome);
  win = null;
  container = null;
});

async function render(node: React.ReactNode): Promise<void> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  if (!root) root = createRoot(container!);
  await act(async () => {
    root!.render(node);
  });
  await flush();
}

async function flush(times = 4): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function find(testId: string): HTMLElement {
  const element = container!.querySelector(`[data-testid="${testId}"]`);
  if (!element) {
    throw new Error(`no element with data-testid="${testId}" in:\n${container!.innerHTML}`);
  }
  return element as unknown as HTMLElement;
}

function maybeFind(testId: string): HTMLElement | null {
  return container!.querySelector(`[data-testid="${testId}"]`) as unknown as HTMLElement | null;
}

async function click(testId: string): Promise<void> {
  const { act } = await import("react");
  const element = find(testId);
  await act(async () => {
    element.dispatchEvent(
      new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await flush();
}

async function clickElement(element: Element): Promise<void> {
  const { act } = await import("react");
  await act(async () => {
    element.dispatchEvent(
      new (win as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await flush();
}

async function select(testId: string, value: string): Promise<void> {
  const { act } = await import("react");
  const element = find(testId) as HTMLSelectElement;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

async function toggle(testId: string, checked: boolean): Promise<void> {
  const { act } = await import("react");
  const element = find(testId) as HTMLInputElement;
  if (element.checked === checked) return;
  await act(async () => {
    element.click();
  });
  await flush();
}

function rows(): HTMLElement[] {
  return [...container!.querySelectorAll('[data-testid="job-row"]')] as unknown as HTMLElement[];
}

function row(route: string): HTMLElement {
  const found = container!.querySelector(`[data-job-id="${route}"]`);
  if (!found) throw new Error(`no row ${route} in:\n${container!.innerHTML}`);
  return found as unknown as HTMLElement;
}

function bundle(size = 512): PdfSourceBundle {
  return {
    main: "= Job",
    template: "template",
    assets: [{ path: "assets/a.png", mediaType: "image/png", bytes: new Uint8Array(size) }],
    sourceMap: [],
    notes: [],
  };
}

function port(): DurableJobsPort {
  return createDurableJobsStore({
    list: () => listPdfJobMeta(factory),
    read: (id, _factory, options) => getPdfJob(id, factory, options),
    cancelJob: (id) => cancelPdfJob(id, factory),
    deleteJob: (id) => deletePdfJob(id, factory),
    consume: (id) => markPdfJobConsumed(id, factory),
    requestCancel: async (jobId) => {
      cancelRequests.push(jobId);
    },
    emit: async (filename, bytes) => {
      emitted.push({ filename, bytes: bytes.byteLength });
    },
  });
}

function commonRequest(
  id = COMMON_JOB,
  siteOrigin = SITE,
): DocxExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "docx",
    renderer: "docx-typescript",
    source: {
      kind: "confluence",
      siteOrigin,
      locator: { kind: "space-key", spaceKey: "DOCSY" },
      scope: { kind: "space" },
    },
    authRef: "profile:default",
    displayName: `Common DOCX ${id}`,
    createdAt: 20,
    priority: "interactive",
    output: { policy: "collect" },
    template: { recordKey: "default", sha256: SHA_ABC, name: "Default" },
    options: { embedImages: true, resolveMacros: true },
  };
}

function commonPdfRequest(
  id = COMMON_PDF,
  siteOrigin = SITE,
): PdfExportJobRequestV1 {
  return {
    schema: "atlcli.export-job-request/1",
    id,
    idempotencyKey: `idem:${id}`,
    format: "pdf",
    renderer: "pdf-typst",
    source: {
      kind: "confluence",
      siteOrigin,
      locator: { kind: "page-id", id: "42" },
      scope: { kind: "page" },
    },
    authRef: `session:${siteOrigin}`,
    displayName: `Common PDF ${id}`,
    createdAt: 21,
    priority: "interactive",
    output: { policy: "collect" },
    template: { kind: "builtin", id: "default", manifestVersion: "1" },
    settings: {},
    options: { resolveMacros: true, exportedAt: 21 },
  };
}

function unifiedPort(
  catalog: IndexedDbExportJobCatalog,
  options: {
    bytes?: IndexedDbExportByteStore;
    readReport?: (format: "pdf" | "docx", ref: string) => Promise<unknown | undefined>;
    now?: () => number;
    randomUUID?: () => string;
    wake?: (
      jobIds: string[],
      options?: { resumeWaiting?: boolean },
    ) => Promise<{ claimedJobId?: string; error?: string }>;
    getPulseEnabled?: () => Promise<boolean>;
    setPulseEnabled?: (enabled: boolean) => Promise<void>;
  } = {},
): DurableJobsPort {
  return createExtensionDurableJobsStore({
    catalog,
    bytes: options.bytes ?? new IndexedDbExportByteStore({ factory }),
    legacy: port(),
    listLegacyPdf: () => listPdfJobMeta(factory),
    ...(options.readReport ? { readReport: options.readReport } : {}),
    ...(options.randomUUID ? { randomUUID: options.randomUUID } : {}),
    ...(options.wake ? { wake: options.wake } : {}),
    ...(options.getPulseEnabled
      ? { getPulseEnabled: options.getPulseEnabled }
      : {}),
    ...(options.setPulseEnabled
      ? { setPulseEnabled: options.setPulseEnabled }
      : {}),
    emit: async (filename, bytes) => {
      emitted.push({ filename, bytes: bytes.byteLength });
    },
    now: options.now ?? (() => 30),
  });
}

function loadedState(): PanelState {
  return {
    status: "loaded",
    token: 1,
    lastSeq: 1,
    ref: { url: `${SITE}/wiki/spaces/DOCSY/pages/42`, entity: { kind: "confluence-content", contentId: "42" } },
    contentId: "42",
    page: {} as never,
  } as unknown as PanelState;
}

function screenProps(): ScreenProps {
  return {
    ports: {} as unknown as AppPorts,
    page: loadedState(),
    retry: () => undefined,
    navigate: () => undefined,
  };
}

async function renderScreen(): Promise<void> {
  await render(
    <DurableJobsProvider port={port()}>
      <JobsScreen {...screenProps()} />
    </DurableJobsProvider>
  );
}

describe("the Jobs screen", () => {
  it("renders no list at all when there are no jobs", async () => {
    await renderScreen();
    // The 90 % single-page case must not grow a permanently empty section.
    expect(maybeFind("jobs-list")).toBeNull();
    expect(find("jobs-empty")).toBeDefined();
  });

  it("re-attaches on mount to a job that is still compiling, with its progress", async () => {
    await putPdfJob(
      {
        id: JOB_HERE,
        sourceIdentity: `${SITE}/wiki/spaces/DOCSY/pages/42|42|7`,
        bundle: bundle(),
        title: "Handbook",
        scopeLabel: "Tree",
      },
      factory
    );
    await claimPdfJob(JOB_HERE, factory);
    await updatePdfJobProgress(JOB_HERE, { done: 37, total: 210 }, factory);

    await renderScreen();

    expect(find("jobs-list")).toBeDefined();
    expect(find("job-status").textContent).toBe("Page 37/210");
    expect(find("job-scope").textContent).toBe("Tree");
    expect(find("job-cancel")).toBeDefined();
    expect(maybeFind("job-download")).toBeNull();
  });

  it("renders and routes actions for a common DOCX job through the productive Activity port", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 30 });
    await catalog.create({ request: commonRequest() });
    await render(
      <DurableJobsProvider port={unifiedPort(catalog)}>
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>
    );

    expect(find("job-row").getAttribute("data-job-id")).toBe(`common:${COMMON_JOB}`);
    expect(find("job-status").textContent).toBe("Queued");
    expect(find("job-scope").textContent).toBe("space");
    expect(find("job-queue-position").textContent).toBe(
      "Estimated queue position 1",
    );

    await click("job-cancel");
    expect((await catalog.get(COMMON_JOB))?.state).toBe("cancelled");
  });

  it("offers the download for a finished job, and consumes it when taken", async () => {
    await putPdfJob(
      {
        id: JOB_HERE,
        sourceIdentity: `${SITE}/wiki/spaces/DOCSY/pages/42|42|7`,
        bundle: bundle(),
        title: "Handbook",
        filename: "Handbook.pdf",
      },
      factory
    );
    await claimPdfJob(JOB_HERE, factory);
    await completePdfJob(
      JOB_HERE,
      { pdf: new Uint8Array([1, 2, 3, 4]), diagnostics: [], compilerVersion: "test" },
      factory
    );

    await renderScreen();
    expect(find("job-status").textContent).toBe("Ready");

    await click("job-download");
    expect(emitted).toEqual([{ filename: "Handbook.pdf", bytes: 4 }]);
    // Consuming it is what removes it from the list and from the badge count.
    expect(await getPdfJobMeta(JOB_HERE, factory)).toBeUndefined();
    expect(maybeFind("job-download")).toBeNull();
  });

  it("cancels a running job through the compiler, not only in the record", async () => {
    await putPdfJob(
      { id: JOB_HERE, sourceIdentity: `${SITE}/x|42|7`, bundle: bundle(), title: "Handbook" },
      factory
    );
    await claimPdfJob(JOB_HERE, factory);

    await renderScreen();
    await click("job-cancel");

    expect(cancelRequests).toEqual([JOB_HERE]);
    const meta = await getPdfJobMeta(JOB_HERE, factory);
    expect(meta?.status).toBe("cancelled");
    expect(meta?.inputBytes).toBe(0);
  });

  it("does not list a job from another site", async () => {
    await putPdfJob(
      { id: JOB_ELSEWHERE, sourceIdentity: `${OTHER_SITE}/x|9|1`, bundle: bundle(), title: "Staging" },
      factory
    );
    await claimPdfJob(JOB_ELSEWHERE, factory);

    await renderScreen();
    expect(maybeFind("jobs-list")).toBeNull();
    expect(container!.innerHTML).not.toContain("Staging");
  });

  it("never lists a preview job", async () => {
    await putPdfJob(
      {
        id: JOB_HERE,
        sourceIdentity: `${SITE}/x|42|7`,
        bundle: bundle(),
        kind: "preview",
        title: "Preview",
      },
      factory
    );
    await claimPdfJob(JOB_HERE, factory);

    await renderScreen();
    expect(maybeFind("jobs-list")).toBeNull();
  });

  it("says exactly what background means, and promises nothing server-side", async () => {
    await putPdfJob(
      { id: JOB_HERE, sourceIdentity: `${SITE}/x|42|7`, bundle: bundle(), title: "Handbook" },
      factory
    );
    await renderScreen();
    const copy = find("jobs-durability").textContent ?? "";
    expect(copy).toContain("closing the browser");
    expect(copy.toLowerCase()).not.toContain("server");
    expect(copy.toLowerCase()).not.toContain("cloud");
  });

  it("loads and persists the toolbar pulse preference through the host port", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 30 });
    const writes: boolean[] = [];
    await render(
      <DurableJobsProvider
        port={unifiedPort(catalog, {
          getPulseEnabled: async () => false,
          setPulseEnabled: async (enabled) => {
            writes.push(enabled);
          },
        })}
      >
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>,
    );

    const checkbox = find("jobs-pulse-enabled") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
    await toggle("jobs-pulse-enabled", true);
    expect(checkbox.checked).toBe(true);
    expect(writes).toEqual([true]);
  });

  it("filters common PDF and DOCX history by current/all sites, format, status, and time", async () => {
    const catalog = new IndexedDbExportJobCatalog({ factory, now: () => 30 });
    await catalog.create({ request: commonRequest() });
    await catalog.create({
      request: commonPdfRequest(COMMON_PDF, OTHER_SITE),
    });
    await render(
      <DurableJobsProvider port={unifiedPort(catalog)}>
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>,
    );

    expect(rows().map((item) => item.getAttribute("data-job-id"))).toEqual([
      `common:${COMMON_JOB}`,
    ]);
    await select("jobs-filter-site", "all");
    expect(rows()).toHaveLength(2);
    await select("jobs-filter-format", "pdf");
    expect(rows().map((item) => item.getAttribute("data-job-id"))).toEqual([
      `common:${COMMON_PDF}`,
    ]);
    await select("jobs-filter-status", "succeeded");
    expect(rows()).toHaveLength(0);
    await select("jobs-filter-status", "all");
    await select("jobs-filter-time", "day");
    expect(rows()).toHaveLength(0);
  });

  it("shows acknowledged detail with timeline and truthful expired report/metrics", async () => {
    let now = 30;
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
      randomUUID: () => "activity-artifact",
    });
    await catalog.create({ request: commonPdfRequest() });
    const claimed = (await catalog.claimNext({
      ids: [COMMON_PDF],
      ownerId: "runner",
      now,
      leaseDurationMs: 100,
    }))!;
    await catalog.appendEvent(COMMON_PDF, {
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      event: {
        kind: "state",
        seq: 1,
        at: 30,
        from: "queued",
        to: "running",
      },
    });
    const staged = await bytes.stage(COMMON_PDF, claimed.leaseEpoch, {
      mediaType: "application/pdf",
      filename: "activity.pdf",
      byteLength: 3,
      sha256: SHA_ABC,
      bytes: (async function* () {
        yield Uint8Array.from([97, 98, 99]);
      })(),
    });
    now = 40;
    await catalog.finalizeArtifact({
      id: COMMON_PDF,
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      stagedArtifact: staged,
      reportRef: "report:expired",
      reportSummary: {
        issues: { info: 0, warning: 1, error: 0 },
        topCodes: [{ code: "image-skipped", count: 1 }],
        completeness: "partial",
      },
      finishedAt: now,
    });

    await render(
      <DurableJobsProvider
        port={unifiedPort(catalog, {
          bytes,
          readReport: async () => undefined,
          now: () => now,
        })}
      >
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>,
    );
    await clickElement(
      row(`common:${COMMON_PDF}`).querySelector(
        '[data-testid="job-detail-open"]',
      )!,
    );

    expect(find("job-detail")).toBeDefined();
    expect(find("job-report-expired").textContent).toContain("expired");
    expect(find("job-metric-spool").textContent).toBe("Unavailable");
    expect(find("job-metric-heap").textContent).toBe("Unavailable");
    expect(find("job-detail").textContent).toContain("queued → running");
    expect((await catalog.get(COMMON_PDF))?.acknowledgedAt).toBe(40);
  });

  it("renders a released full report as expired while retaining its compact summary", async () => {
    let now = 30;
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
      randomUUID: () => "released-report-artifact",
    });
    await catalog.create({ request: commonPdfRequest() });
    const claimed = (await catalog.claimNext({
      ids: [COMMON_PDF],
      ownerId: "runner",
      now,
      leaseDurationMs: FULL_REPORT_RETENTION_MS_V1 + 1_000,
    }))!;
    const staged = await bytes.stage(COMMON_PDF, claimed.leaseEpoch, {
      mediaType: "application/pdf",
      filename: "activity.pdf",
      byteLength: 3,
      sha256: SHA_ABC,
      bytes: (async function* () {
        yield Uint8Array.from([97, 98, 99]);
      })(),
    });
    now = 40;
    const succeeded = await catalog.finalizeArtifact({
      id: COMMON_PDF,
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      stagedArtifact: staged,
      reportRef: "report:released",
      reportSummary: {
        issues: { info: 0, warning: 1, error: 0 },
        topCodes: [{ code: "image-skipped", count: 1 }],
        completeness: "partial",
      },
      finishedAt: now,
    });
    now += FULL_REPORT_RETENTION_MS_V1;
    await catalog.compareAndSet({
      kind: "retention",
      id: COMMON_PDF,
      expectedRevision: succeeded.revision,
      at: now,
      releaseArtifact: false,
      releaseReport: true,
    });

    await render(
      <DurableJobsProvider port={unifiedPort(catalog, { bytes, now: () => now })}>
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>,
    );
    await clickElement(
      row(`common:${COMMON_PDF}`).querySelector(
        '[data-testid="job-detail-open"]',
      )!,
    );
    expect(find("job-report-expired")).toBeDefined();
    expect(find("job-detail").textContent).toContain("partial");
    expect(find("job-detail").textContent).toContain("1 warning");
  });

  it("routes Retry, Run again, Resume, Acknowledge, and Dismiss from their rows", async () => {
    let now = 30;
    let serial = 0;
    const waitingId = "common-auth-1";
    const wakes: Array<{
      ids: string[];
      resumeWaiting?: boolean;
    }> = [];
    const catalog = new IndexedDbExportJobCatalog({
      factory,
      now: () => now,
    });
    const bytes = new IndexedDbExportByteStore({
      factory,
      now: () => now,
      randomUUID: () => `artifact-${++serial}`,
    });

    await bytes.put(
      extensionDocxTemplateSpoolRef(COMMON_JOB),
      (async function* () {
        yield Uint8Array.from([97, 98, 99]);
      })(),
      EXTENSION_DOCX_TEMPLATE_LIMITS_V1,
    );
    await catalog.create({ request: commonRequest() });
    const failedClaim = (await catalog.claimNext({
      ids: [COMMON_JOB],
      ownerId: "failed-runner",
      now,
      leaseDurationMs: 100,
    }))!;
    await catalog.compareAndSet({
      id: COMMON_JOB,
      kind: "transition",
      expectedRevision: failedClaim.revision,
      leaseEpoch: failedClaim.leaseEpoch,
      to: "failed",
      at: 31,
      error: {
        code: "fixture-failure",
        message: "Retry me.",
        category: "network",
        retryable: true,
        occurredAt: 31,
      },
    });

    await catalog.create({ request: commonPdfRequest() });
    const successClaim = (await catalog.claimNext({
      ids: [COMMON_PDF],
      ownerId: "success-runner",
      now,
      leaseDurationMs: 100,
    }))!;
    const staged = await bytes.stage(COMMON_PDF, successClaim.leaseEpoch, {
      mediaType: "application/pdf",
      filename: "success.pdf",
      byteLength: 3,
      sha256: SHA_ABC,
      bytes: (async function* () {
        yield Uint8Array.from([97, 98, 99]);
      })(),
    });
    now = 32;
    await catalog.finalizeArtifact({
      id: COMMON_PDF,
      expectedRevision: successClaim.revision,
      leaseEpoch: successClaim.leaseEpoch,
      stagedArtifact: staged,
      finishedAt: now,
    });

    await catalog.create({ request: commonRequest(waitingId) });
    const waitingClaim = (await catalog.claimNext({
      ids: [waitingId],
      ownerId: "auth-runner",
      now,
      leaseDurationMs: 100,
    }))!;
    await catalog.compareAndSet({
      id: waitingId,
      kind: "transition",
      expectedRevision: waitingClaim.revision,
      leaseEpoch: waitingClaim.leaseEpoch,
      to: "waiting",
      waiting: { reason: "auth" },
      checkpointRef: "checkpoint:auth-ui",
      at: 33,
    });
    now = 40;

    await render(
      <DurableJobsProvider
        port={unifiedPort(catalog, {
          bytes,
          now: () => ++now,
          randomUUID: () => `ui-derived-${++serial}`,
          wake: async (ids, options) => {
            wakes.push({
              ids,
              ...(options?.resumeWaiting ? { resumeWaiting: true } : {}),
            });
            return {};
          },
        })}
      >
        <JobsScreen {...screenProps()} />
      </DurableJobsProvider>,
    );

    await clickElement(
      row(`common:${COMMON_JOB}`).querySelector('[data-testid="job-retry"]')!,
    );
    await clickElement(
      row(`common:${COMMON_PDF}`).querySelector('[data-testid="job-rerun"]')!,
    );
    await clickElement(
      row(`common:${waitingId}`).querySelector('[data-testid="job-resume"]')!,
    );
    await clickElement(
      row(`common:${COMMON_JOB}`).querySelector(
        '[data-testid="job-acknowledge"]',
      )!,
    );
    await clickElement(
      row(`common:${COMMON_JOB}`).querySelector('[data-testid="job-dismiss"]')!,
    );

    let derived = (await catalog.list({ includeDismissed: true }))
      .filter((snapshot) => snapshot.derivedFrom !== undefined);
    for (let attempt = 0; derived.length < 2 && attempt < 20; attempt += 1) {
      await flush(1);
      derived = (await catalog.list({ includeDismissed: true }))
        .filter((snapshot) => snapshot.derivedFrom !== undefined);
    }
    expect(derived.map((snapshot) => snapshot.derivedFrom?.relation).sort())
      .toEqual(["rerun", "retry"]);
    expect(wakes.some((entry) =>
      entry.ids[0] === waitingId && entry.resumeWaiting === true
    )).toBe(true);
    expect(await catalog.get(COMMON_JOB)).toMatchObject({
      acknowledgedAt: expect.any(Number),
      dismissedAt: expect.any(Number),
    });
    expect(container!.innerHTML).not.toContain(`data-job-id="common:${COMMON_JOB}"`);
  });
});

describe("the screen definition the shell wires up", () => {
  it("declares the durable-jobs capability and the Activity slot", () => {
    expect(jobsScreenDefinition.id).toBe("activity");
    expect(jobsScreenDefinition.requirements).toEqual([
      { kind: "capability", capability: "durable-jobs" },
    ]);
    expect(jobsScreenDefinition.component).toBe(JobsScreen);
  });

  it("reads the site origin out of every panel state that has one", () => {
    expect(siteOriginOf(loadedState())).toBe(SITE);
    expect(siteOriginOf({ status: "idle", token: 0, lastSeq: 0 } as PanelState)).toBeNull();
  });
});
