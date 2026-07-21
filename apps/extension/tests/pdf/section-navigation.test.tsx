/**
 * Navigating away must not kill a running export (spec 010 T5.6, defect (a)).
 *
 * `ExportRunsProvider` held `identity = pageUrl|id|version` and aborted the
 * active export whenever it changed. That is CONFCLOUD-83694 reproduced in our
 * own panel, by design: open another Confluence page and your export dies. It
 * was invisible while every export was a single page that finished in seconds;
 * tree and space exports make it the normal case. The Chrome side panel survives
 * tab navigation on its own, so this was our decision, not a platform limit.
 *
 * The property asserted here is exact: on an identity change the panel **stops
 * watching** — the `AbortController` is not signalled, the port keeps running,
 * and the job record stays `compiling`. Only the explicit Cancel button aborts.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import {
  ExportRunsProvider,
  useExportRuns,
  type ExportRuns,
} from "../../components/app/export-runs.js";
import type { PdfExportPort, PdfExportRequest } from "../../utils/ports/index.js";
import type { LoadedPage } from "../../utils/read-path.js";

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

let saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];
let win: Window | null = null;
let container: HTMLElement | null = null;
let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;
let savedChrome: PropertyDescriptor | undefined;

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
  win = new Window({ url: "https://example.atlassian.net/wiki" });
  saved = [];
  for (const key of DOM_GLOBALS) {
    const value = key === "window" ? win : (win as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    installGlobal(key, value);
  }
  installGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = win.document.createElement("div") as unknown as HTMLElement;
  win.document.body.appendChild(container as unknown as never);
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

async function flush(times = 3): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

// ---------------------------------------------------------------------------
// A port that stands in for a long tree export: it records the signal it was
// handed and does not finish until the test says so.
// ---------------------------------------------------------------------------

interface Harness {
  port: PdfExportPort;
  /** The signal the running export is bound to. */
  signal(): AbortSignal | undefined;
  finish(): void;
  started: number;
}

function longRunningPort(): Harness {
  let signal: AbortSignal | undefined;
  let finish: (() => void) | undefined;
  const harness: Harness = {
    port: {
      run(request: PdfExportRequest): Promise<PdfExportReport> {
        harness.started += 1;
        signal = request.signal;
        return new Promise<PdfExportReport>((resolve) => {
          finish = () => resolve({ notes: [] } as unknown as PdfExportReport);
        });
      },
    },
    signal: () => signal,
    finish: () => finish?.(),
    started: 0,
  };
  return harness;
}

let runs: ExportRuns | null = null;

function Probe(): null {
  runs = useExportRuns();
  return null;
}

function page(): LoadedPage {
  return { details: { id: "42", title: "Handbook", version: 7 } } as unknown as LoadedPage;
}

async function renderWithIdentity(identity: string): Promise<void> {
  await render(
    <ExportRunsProvider identity={identity}>
      <Probe />
    </ExportRunsProvider>
  );
}

describe("a page change while an export runs", () => {
  it("stops watching without aborting — the export and its record survive", async () => {
    const harness = longRunningPort();
    await renderWithIdentity("https://site/a|1|1");

    const { act } = await import("react");
    await act(async () => {
      runs!.startPdf(harness.port, { page: page(), pageUrl: "https://site/a" });
    });
    await flush();
    expect(harness.started).toBe(1);
    expect(runs!.pdf.phase).toBe("preparing");

    // Navigate to another Confluence page.
    await renderWithIdentity("https://site/b|2|1");
    await flush();

    // The panel stopped showing it…
    expect(runs!.pdf.phase).toBeNull();
    // …but the export was NOT aborted. This is the assertion the defect fails:
    // the controller behind this signal used to be aborted here, which is what
    // killed the compile and left the record `compiling` with nobody watching.
    expect(harness.signal()?.aborted).toBe(false);

    // And it still runs to completion.
    await act(async () => {
      harness.finish();
    });
    await flush();
  });

  it("still aborts on the explicit Cancel button", async () => {
    const harness = longRunningPort();
    await renderWithIdentity("https://site/a|1|1");

    const { act } = await import("react");
    await act(async () => {
      runs!.startPdf(harness.port, { page: page(), pageUrl: "https://site/a" });
    });
    await flush();
    expect(harness.signal()?.aborted).toBe(false);

    await act(async () => {
      runs!.cancelPdf();
    });
    await flush();
    expect(harness.signal()?.aborted).toBe(true);
  });

  it("does not abort when the panel itself goes away", async () => {
    const harness = longRunningPort();
    await renderWithIdentity("https://site/a|1|1");

    const { act } = await import("react");
    await act(async () => {
      runs!.startPdf(harness.port, { page: page(), pageUrl: "https://site/a" });
    });
    await flush();

    const current = root!;
    await act(async () => {
      current.unmount();
    });
    root = null;
    // Closing the panel is the case durable jobs exist for: the offscreen
    // compile keeps going and `completePdfJob` still writes the result, so the
    // next panel finds it on the Jobs screen.
    expect(harness.signal()?.aborted).toBe(false);
  });

  it("starts a fresh export on the new page rather than reusing the detached one", async () => {
    const first = longRunningPort();
    const second = longRunningPort();
    await renderWithIdentity("https://site/a|1|1");

    const { act } = await import("react");
    await act(async () => {
      runs!.startPdf(first.port, { page: page(), pageUrl: "https://site/a" });
    });
    await flush();

    await renderWithIdentity("https://site/b|2|1");
    await flush();

    await act(async () => {
      runs!.startPdf(second.port, { page: page(), pageUrl: "https://site/b" });
    });
    await flush();
    expect(second.started).toBe(1);
    expect(first.signal()?.aborted).toBe(false);
  });
});
