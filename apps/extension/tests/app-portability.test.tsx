/**
 * **The Phase 0 gate** (spec 010, = SPIKE.md hypothesis H4 operationalized).
 *
 * The whole app renders and drives an export to completion under happy-dom with
 * `globalThis.chrome` **deleted**, using nothing but fake ports. If this is
 * green the Forge port is mechanical; if it is not, no amount of abstraction
 * helps.
 *
 * It is also the standing regression against re-coupling: any `chrome.*` that
 * creeps back into `components/**`, `utils/i18n/**`, `utils/ports/**`,
 * `utils/screens/**` or their transitive imports fails here with a
 * `ReferenceError` rather than in a Forge spike six months from now. The
 * deletion is asserted again after the export, so a test that accidentally
 * restores a global cannot pass silently.
 *
 * Deliberately NOT mocked: React, the reducer in `utils/panel-state.ts`, the
 * screen registry, the i18n catalogues, the report components. Only the ports
 * are fake — that is the seam under test.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { PdfExportReport } from "@atlcli/pdf/browser";
import { ExportApp } from "../components/app/ExportApp.js";
import type { LoadedPage } from "../utils/read-path.js";
import { memorySettingsStore } from "../utils/ports/settings.js";
import type {
  AppPorts,
  DocxExportPort,
  DocxTemplateRecord,
  DocxTemplateStore,
  ExportPhase,
  HostCapability,
  PageContext,
  PdfExportPort,
} from "../utils/ports/index.js";

// ---------------------------------------------------------------------------
// DOM harness
// ---------------------------------------------------------------------------

/**
 * The globals react-dom needs to render into a happy-dom document — and nothing
 * more.
 *
 * Kept deliberately short. Bun has real `URL`, `Blob` and `DOMException`
 * implementations that other suites (`packages/diagram`'s SVG pipeline, the
 * rasterizers) rely on; swapping those for happy-dom's would be gratuitous
 * blast radius for a test that never constructs one. Add a key only when a
 * render actually fails without it.
 */
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

interface Harness {
  window: Window;
  container: HTMLElement;
  /** Close the window and restore every global exactly as it was found. */
  cleanup: () => Promise<void>;
}

let harness: Harness | null = null;
let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;

/**
 * Install a global, remembering its ORIGINAL property descriptor.
 *
 * Descriptors rather than values, and captured exactly once per key before any
 * mutation: an earlier version of this harness re-read `globalThis.window`
 * *after* the install loop had already overwritten it, so it "restored" the
 * happy-dom window permanently and every later suite in the same bun process
 * rendered against a torn-down DOM.
 */
function installGlobal(
  saved: { key: string; descriptor: PropertyDescriptor | undefined }[],
  key: string,
  value: unknown
): void {
  saved.push({ key, descriptor: Object.getOwnPropertyDescriptor(globalThis, key) });
  try {
    Object.defineProperty(globalThis, key, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    // Non-configurable host global: fall back to assignment.
    (globalThis as unknown as Record<string, unknown>)[key] = value;
  }
}

function restoreGlobals(
  saved: readonly { key: string; descriptor: PropertyDescriptor | undefined }[]
): void {
  // Reverse order so a key installed twice ends on its true original.
  for (const { key, descriptor } of [...saved].reverse()) {
    try {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as unknown as Record<string, unknown>)[key];
    } catch {
      if (!descriptor) (globalThis as unknown as Record<string, unknown>)[key] = undefined;
    }
  }
}

function installDom(): Harness {
  const window = new Window({ url: "https://example.atlassian.net/wiki" });
  const saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];

  for (const key of DOM_GLOBALS) {
    // `window` maps to the Window itself; everything else is read off it.
    const value =
      key === "window" ? window : (window as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    installGlobal(saved, key, value);
  }
  installGlobal(saved, "IS_REACT_ACT_ENVIRONMENT", true);

  const container = window.document.createElement("div") as unknown as HTMLElement;
  window.document.body.appendChild(container as unknown as never);

  return {
    window,
    container,
    async cleanup() {
      // Abort happy-dom's pending timers/async tasks BEFORE the globals go
      // away — a live window whose `document` global has been deleted is what
      // made one unrelated test hit the 5 s timeout.
      try {
        await window.happyDOM?.close();
      } catch {
        // Already closed; teardown must never fail the suite.
      }
      restoreGlobals(saved);
    },
  };
}

/** Render (or re-render) and flush every effect + microtask React scheduled. */
async function render(node: React.ReactNode): Promise<void> {
  const { act } = await import("react");
  const { createRoot } = await import("react-dom/client");
  if (!root) root = createRoot(harness!.container);
  await act(async () => {
    root!.render(node);
  });
  await flush();
}

/** Let queued promises settle and let React commit whatever they produced. */
async function flush(times = 4): Promise<void> {
  const { act } = await import("react");
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function html(): string {
  return harness!.container.innerHTML;
}

function find(testId: string): HTMLElement {
  const element = harness!.container.querySelector(`[data-testid="${testId}"]`);
  if (!element) throw new Error(`no element with data-testid="${testId}" in:\n${html()}`);
  return element as unknown as HTMLElement;
}

function maybeFind(testId: string): HTMLElement | null {
  return harness!.container.querySelector(`[data-testid="${testId}"]`) as unknown as HTMLElement | null;
}

async function click(testId: string): Promise<void> {
  const { act } = await import("react");
  const element = find(testId);
  await act(async () => {
    element.dispatchEvent(
      new (harness!.window as unknown as { MouseEvent: typeof MouseEvent }).MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      })
    );
  });
  await flush();
}

async function selectValue(testId: string, value: string): Promise<void> {
  const { act } = await import("react");
  const element = find(testId) as unknown as HTMLSelectElement;
  await act(async () => {
    element.value = value;
    element.dispatchEvent(
      new (harness!.window as unknown as { Event: typeof Event }).Event("change", { bubbles: true })
    );
  });
  await flush();
}

// ---------------------------------------------------------------------------
// Fakes — the only mocked layer
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.atlassian.net/wiki/spaces/DOCSY/pages/42/Handbook";

function loadedPage(): LoadedPage {
  return {
    details: {
      id: "42",
      title: "Deployment Handbook",
      spaceKey: "DOCSY",
      version: 7,
      storage: "<p>Ship it.</p>",
      modified: "2026-07-01T10:00:00.000Z",
      modifiedBy: { displayName: "Björn Schotte" },
    },
    markdown: "Ship it.",
    wordCount: 2,
    attachments: [
      { name: "diagram.png", mediaType: "image/png", size: 2048, link: "/download/diagram.png" },
    ],
  };
}

/** A host that answers once, immediately — the Forge-shaped case. */
function fakePageContext(context: PageContext): AppPorts["watchPageContext"] {
  return (onChange) => {
    onChange(context);
    return () => undefined;
  };
}

const EMPTY_SCAN: ScanResult = {
  supported: [{ base: "$scroll.title", status: "supported", count: 1, raw: ["$scroll.title"] }],
  unsupported: [],
  never: [],
  parts: ["word/document.xml"],
  hasContentPlaceholder: true,
  stylerefStyleNames: [],
};

function pdfReport(): PdfExportReport {
  return {
    filename: "Deployment Handbook.pdf",
    profile: "tagged",
    compilerVersion: "test",
    embeddedImages: 2,
    renderedDiagrams: 1,
    skippedAssets: 0,
    notes: [],
    complete: true,
    timings: { prepareMs: 10, compileMs: 20, emitMs: 5, totalMs: 35 },
  };
}

function docxReport(): ExportReport {
  return {
    resolvedCount: 4,
    unsupportedNames: [],
    skippedImages: 0,
    embeddedImages: 1,
    renderedDiagrams: 0,
    durationMs: 88,
    filename: "Deployment Handbook.docx",
    notes: [],
    complete: true,
    scan: EMPTY_SCAN,
    timings: {
      resolveMs: 0,
      bodyMs: 0,
      logoFetchMs: 0,
      includeFetchMs: 0,
      renderMs: 0,
      imageFetchMs: 0,
      imageFetches: 0,
      diagramRenderMs: 0,
      diagramRasterMs: 0,
    },
  };
}

interface Recorder {
  pdfPhases: ExportPhase[];
  pdfRuns: number;
  docxRuns: number;
}

function fakePdfPort(recorder: Recorder): PdfExportPort {
  return {
    async run(request) {
      recorder.pdfRuns += 1;
      for (const phase of ["preparing", "fetching", "queued", "compiling"] as const) {
        recorder.pdfPhases.push(phase);
        request.onPhase?.(phase);
      }
      return pdfReport();
    },
  };
}

function fakeDocxPort(recorder: Recorder): DocxExportPort {
  return {
    scan: async () => EMPTY_SCAN,
    async run() {
      recorder.docxRuns += 1;
      return docxReport();
    },
  };
}

function fakeTemplateStore(initial: DocxTemplateRecord | null): DocxTemplateStore {
  let current = initial;
  return {
    get: async () => current,
    put: async ({ name, bytes }) => {
      current = { name, uploadedAt: 1_700_000_000_000, bytes };
      return current;
    },
    remove: async () => {
      current = null;
    },
  };
}

function makePorts(
  recorder: Recorder,
  overrides: Partial<AppPorts> = {},
  capabilities: readonly HostCapability[] = [
    "pdf-export",
    "docx-export",
    "docx-template-store",
    "settings-persistence",
  ]
): AppPorts {
  const page = loadedPage();
  return {
    host: { kind: "test", name: "atlcli", version: "9.9.9", capabilities },
    watchPageContext: fakePageContext({
      url: PAGE_URL,
      entity: { product: "confluence", type: "page", pageId: "42", spaceKey: "DOCSY" },
      seq: 1,
    }),
    loadPage: async () => page,
    pdf: fakePdfPort(recorder),
    docx: fakeDocxPort(recorder),
    docxTemplates: fakeTemplateStore({
      name: "mayflower.docx",
      uploadedAt: 1_700_000_000_000,
      bytes: new ArrayBuffer(8),
    }),
    settings: memorySettingsStore(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------

/**
 * The original `chrome` descriptor — `undefined` when there was no such global,
 * which is the normal case under bun and must be restored by DELETING the key
 * again, never by assigning `undefined` (that would leave an own property whose
 * mere existence changes `"chrome" in globalThis`).
 */
let savedChromeDescriptor: PropertyDescriptor | undefined;
let hadChrome = false;

beforeEach(() => {
  hadChrome = Object.prototype.hasOwnProperty.call(globalThis, "chrome");
  savedChromeDescriptor = Object.getOwnPropertyDescriptor(globalThis, "chrome");
  delete (globalThis as unknown as Record<string, unknown>).chrome;
  harness = installDom();
  root = null;
});

afterEach(async () => {
  if (root) {
    const { act } = await import("react");
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  await harness?.cleanup();
  harness = null;

  if (hadChrome && savedChromeDescriptor) {
    Object.defineProperty(globalThis, "chrome", savedChromeDescriptor);
  } else {
    delete (globalThis as unknown as Record<string, unknown>).chrome;
  }
  savedChromeDescriptor = undefined;
  hadChrome = false;
});

function newRecorder(): Recorder {
  return { pdfPhases: [], pdfRuns: 0, docxRuns: 0 };
}

/**
 * Every global this file may touch, snapshotted at module load — i.e. before
 * any `beforeEach` has run.
 *
 * This file installs a DOM and deletes `chrome` for the whole process, so a
 * teardown bug here does not fail this file, it fails somebody else's: a
 * previous version leaked a torn-down happy-dom `window`, and the damage showed
 * up as 30 unrelated failures in `packages/diagram`'s mermaid/SVG rendering and
 * its downstream rasterizer consumers. Scoped runs stayed green the whole time,
 * which is exactly why the check has to be an assertion rather than a habit.
 */
const PRISTINE_GLOBALS = new Map<string, PropertyDescriptor | undefined>(
  [...DOM_GLOBALS, "chrome", "IS_REACT_ACT_ENVIRONMENT"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ])
);

afterAll(() => {
  const leaked = [...PRISTINE_GLOBALS]
    .filter(([key, before]) => {
      const after = Object.getOwnPropertyDescriptor(globalThis, key);
      if ((before === undefined) !== (after === undefined)) return true;
      if (!before || !after) return false;
      return before.value !== after.value || before.get !== after.get;
    })
    .map(([key]) => key);

  expect(leaked).toEqual([]);
});

describe("ExportApp without chrome (Phase 0 acceptance criterion)", () => {
  it("renders the whole app with globalThis.chrome deleted", async () => {
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);

    expect(html()).toContain("atlcli");
    expect(find("app-version").textContent).toBe("v9.9.9");
    expect(find("loaded-title").textContent).toBe("Deployment Handbook");
    expect(find("loaded-space").textContent).toBe("DOCSY");
    expect(find("loaded-version").textContent).toBe("v7");
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
  });

  it("drives a PDF export to completion and shows the report", async () => {
    const recorder = newRecorder();
    await render(<ExportApp ports={makePorts(recorder)} localeCandidates={["en"]} />);

    expect(maybeFind("pdf-report")).toBeNull();
    await click("pdf-export");

    expect(recorder.pdfRuns).toBe(1);
    // Every phase the port reported reached the panel's progress channel.
    expect(recorder.pdfPhases).toEqual(["preparing", "fetching", "queued", "compiling"]);

    const report = find("pdf-report");
    expect(report.textContent).toContain("Deployment Handbook.pdf");
    expect(report.textContent).toContain("2 image(s)");
    expect(report.textContent).toContain("1 diagram(s)");
    expect(maybeFind("pdf-error")).toBeNull();
    // The export completed without a single chrome API existing.
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
  });

  it("drives a DOCX export to completion over the stored template", async () => {
    const recorder = newRecorder();
    await render(<ExportApp ports={makePorts(recorder)} localeCandidates={["en"]} />);

    // The stored template was read through the port and re-scanned on load.
    expect(find("template-name").textContent).toBe("mayflower.docx");
    expect(find("template-scan").textContent).toContain("$scroll.title");

    await click("template-export");

    expect(recorder.docxRuns).toBe(1);
    const report = find("export-report");
    expect(report.textContent).toContain("Deployment Handbook.docx");
    expect(report.textContent).toContain("4 placeholder(s) resolved");
    expect((globalThis as Record<string, unknown>).chrome).toBeUndefined();
  });

  it("keeps the two engines independently swappable", async () => {
    // SPIKE.md's conditional GO: PDF-WASM fails in a host where DOCX works.
    const recorder = newRecorder();
    await render(
      <ExportApp
        ports={makePorts(recorder, { pdf: null }, ["docx-export", "docx-template-store"])}
        localeCandidates={["en"]}
      />
    );

    expect(maybeFind("pdf-section")).toBeNull();
    expect(maybeFind("template-section")).not.toBeNull();

    await click("template-export");
    expect(recorder.docxRuns).toBe(1);
  });

  it("hides the Word panel for a host with no template storage", async () => {
    await render(
      <ExportApp
        ports={makePorts(newRecorder(), { docx: null, docxTemplates: null }, ["pdf-export"])}
        localeCandidates={["en"]}
      />
    );
    expect(maybeFind("template-section")).toBeNull();
    expect(maybeFind("pdf-section")).not.toBeNull();
  });
});

describe("the shell renders from the registry", () => {
  it("renders one nav entry per visible screen and opens the requested one", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);

    for (const id of ["export", "templates", "activity", "settings", "about"]) {
      expect(maybeFind(`nav-${id}`)).not.toBeNull();
    }
    expect(maybeFind("screen-export")).not.toBeNull();

    await click("nav-about");
    expect(maybeFind("screen-about")).not.toBeNull();
    expect(find("about-version").textContent).toBe("v9.9.9");
    expect(find("about-host-kind").textContent).toBe("test");
  });

  it("disables a screen whose capability is missing and states the reason", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);

    const activity = find("nav-activity") as unknown as HTMLButtonElement;
    expect(activity.disabled).toBe(true);
    expect(activity.getAttribute("title")).toBe(
      "Background jobs are not available in this app yet."
    );
  });

  it("enables that same screen when the host advertises the capability", async () => {
    await render(
      <ExportApp
        ports={makePorts(newRecorder(), {}, [
          "pdf-export",
          "docx-export",
          "docx-template-store",
          "durable-jobs",
        ])}
        localeCandidates={["en"]}
      />
    );

    const activity = find("nav-activity") as unknown as HTMLButtonElement;
    expect(activity.disabled).toBe(false);
    await click("nav-activity");
    expect(maybeFind("activity-screen")).not.toBeNull();
  });

  it("mounts only the screens a host registers", async () => {
    const { defaultScreens } = await import("../components/screens/index.js");
    // A Forge content-action modal mounts Export alone, with no nav to speak of.
    await render(
      <ExportApp
        ports={makePorts(newRecorder())}
        screens={defaultScreens.filter((screen) => screen.id === "export")}
        localeCandidates={["en"]}
      />
    );
    expect(maybeFind("nav-export")).not.toBeNull();
    expect(maybeFind("nav-settings")).toBeNull();
    expect(maybeFind("pdf-section")).not.toBeNull();
  });

  it("keeps the Publishing draft when moving through the product shell", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);

    await click("scope-kind-tree");
    expect((find("scope-kind-tree") as unknown as HTMLInputElement).checked).toBe(true);

    await click("nav-settings");
    expect(maybeFind("screen-settings")).not.toBeNull();
    await click("nav-export");

    expect((find("scope-kind-tree") as unknown as HTMLInputElement).checked).toBe(true);
  });

  it("integrates Preview into Studio instead of adding a fourth local tab", async () => {
    await render(
      <ExportApp
        ports={makePorts(newRecorder(), {}, [
          "pdf-export",
          "docx-export",
          "docx-template-store",
          "pdf-preview",
        ])}
        localeCandidates={["en"]}
      />
    );

    expect(maybeFind("studio-preview")).not.toBeNull();
    expect(find("studio-step-04").textContent).toContain("Review");
    expect(find("studio-step-05").textContent).toContain("Export");
    expect(find("pdf-settings-summary").textContent).toContain("A4 · Portrait");
    expect(maybeFind("nav-preview")).toBeNull();
  });

  it("uses the compact editorial density of the sidebar mockup", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);

    const header = find("app-shell").querySelector("header");
    expect(header?.className).toContain("min-h-12");
    expect(find("nav-export").className).toContain("min-h-8");
    expect(find("format-pdf").className).toContain("min-h-16");
    expect(html()).not.toContain(">Publishing Studio</h1>");
  });
});

describe("i18n reaches the rendered app", () => {
  it("renders German when the host language is German", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["de-AT"]} />);
    expect(find("nav-export").textContent).toContain("Studio");
    expect(find("nav-settings").textContent).toContain("Einstellungen");
    expect(find("nav-activity").getAttribute("title")).toBe(
      "Hintergrund-Jobs gibt es in dieser App noch nicht."
    );
  });

  it("switching the language preference re-renders the whole app", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);
    await click("nav-settings");
    expect(find("nav-settings").textContent).toContain("Settings");

    await selectValue("settings-language", "de");

    expect(find("nav-settings").textContent).toContain("Einstellungen");
    expect(find("nav-export").textContent).toContain("Studio");
  });

  it("persists the language through the settings port", async () => {
    const settings = memorySettingsStore();
    await render(
      <ExportApp ports={makePorts(newRecorder(), { settings })} localeCandidates={["en"]} />
    );
    await click("nav-settings");
    await selectValue("settings-language", "de");

    expect(await settings.load()).toEqual({ locale: "de" });
  });
});

describe("page states render without a page", () => {
  it("shows the idle state and still offers the Export screen", async () => {
    await render(
      <ExportApp
        ports={makePorts(newRecorder(), {
          watchPageContext: fakePageContext({ url: null, entity: null, seq: 1 }),
        })}
        localeCandidates={["en"]}
      />
    );

    expect(maybeFind("state-idle")).not.toBeNull();
    expect((find("pdf-export") as unknown as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a classified error with a retry affordance", async () => {
    const { ReadError } = await import("../utils/read-path.js");
    await render(
      <ExportApp
        ports={makePorts(newRecorder(), {
          loadPage: async () => {
            throw new ReadError("not-logged-in", "session gone");
          },
        })}
        localeCandidates={["en"]}
      />
    );

    expect(maybeFind("error-not-logged-in")).not.toBeNull();
    expect(find("state-error").textContent).toContain("example.atlassian.net");
    expect(maybeFind("retry")).not.toBeNull();
  });
});

describe("the debug surface is gone", () => {
  it("renders no Ping / WASM-smoke buttons and no markdown dump", async () => {
    await render(<ExportApp ports={makePorts(newRecorder())} localeCandidates={["en"]} />);
    const markup = html();
    expect(maybeFind("ping-result")).toBeNull();
    expect(maybeFind("wasm-result")).toBeNull();
    expect(maybeFind("markdown-preview")).toBeNull();
    // The converted body must not be dumped into a 400 px panel.
    expect(markup).not.toContain("Ship it.");
  });
});
