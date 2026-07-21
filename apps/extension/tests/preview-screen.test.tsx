/**
 * The preview screen, rendered by BOTH shells (spec 010 T5.3).
 *
 * The property under test is the one the Phase 0 screen model exists to make
 * true: the compact side-panel mount and the full-size tab mount are the *same
 * component*, differing only in a layout value passed through context. If this
 * ever needs a second component, the screen model is wrong.
 *
 * Rendered under happy-dom with `globalThis.chrome` deleted — the preview
 * screen must not re-couple the portable layer to Chrome.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import React from "react";
import { Window } from "happy-dom";
import { pdfBytesFromUint8Array, type PdfExportReport } from "@atlcli/pdf/browser";
import {
  PreviewRuntimeContext,
  PreviewScreen,
  PreviewShellContext,
  previewScreenDefinition,
  type PreviewRuntime,
} from "../components/screens/PreviewScreen.js";
import type { PdfPreviewResult } from "../utils/pdf/preview.js";
import type { PdfPreviewViewer } from "../utils/pdf/viewer.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import type { PanelState } from "../utils/panel-state.js";
import type { AppPorts } from "../utils/ports/index.js";
import type { LoadedPage } from "../utils/read-path.js";

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

/**
 * Let every queued promise settle and let React commit what they produced.
 *
 * A macrotask boundary rather than `Promise.resolve()`: the compile path is
 * `compile → openViewer → setState → render effect`, several awaits deep, and a
 * microtask-only flush returns while later links are still pending — which
 * shows up as React's "not wrapped in act" warning rather than as a failure.
 */
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

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

const PAGE_URL = "https://example.atlassian.net/wiki/spaces/DOCSY/pages/42/Handbook";

function loadedPage(): LoadedPage {
  return {
    details: {
      id: "42",
      title: "Handbook",
      spaceKey: "DOCSY",
      version: 7,
      storage: "<p>Ship it.</p>",
    },
    markdown: "Ship it.",
    wordCount: 2,
    attachments: [],
  } as unknown as LoadedPage;
}

function loadedState(): PanelState {
  return {
    status: "loaded",
    token: 1,
    lastSeq: 1,
    ref: { url: PAGE_URL, entity: { kind: "confluence-content", contentId: "42" } },
    contentId: "42",
    page: loadedPage(),
  } as unknown as PanelState;
}

function idleState(): PanelState {
  return { status: "idle", token: 0, lastSeq: 0 } as PanelState;
}

const report = { filename: "Handbook.pdf" } as unknown as PdfExportReport;

function fakeViewer(pageCount = 4): PdfPreviewViewer & { renders: number[] } {
  const renders: number[] = [];
  return {
    renders,
    pageCount,
    async renderPage(pageNumber) {
      renders.push(pageNumber);
    },
    async destroy() {
      /* nothing */
    },
  };
}

function runtimeFor(
  result: PdfPreviewResult,
  viewer: PdfPreviewViewer
): PreviewRuntime & { compiles: number } {
  const state = { compiles: 0 };
  return {
    get compiles() {
      return state.compiles;
    },
    async compile() {
      state.compiles += 1;
      return result;
    },
    async readCached() {
      return null;
    },
    async openViewer() {
      return viewer;
    },
  };
}

function ready(overrides: Partial<PdfPreviewResult> = {}): PdfPreviewResult {
  return {
    status: "ready",
    bytes: pdfBytesFromUint8Array(new Uint8Array([0x25, 0x50, 0x44, 0x46])),
    report,
    filename: "Handbook.pdf",
    truncated: false,
    includedChapters: 1,
    totalChapters: 1,
    reason: "none",
    ...overrides,
  };
}

function screenProps(page: PanelState): ScreenProps {
  return {
    ports: { host: { kind: "test", name: "t", version: "0", capabilities: [] } } as unknown as AppPorts,
    page,
    retry: () => undefined,
    navigate: () => undefined,
  };
}

async function mount(
  page: PanelState,
  runtime: PreviewRuntime,
  layout: "compact" | "full" = "compact",
  openLargePreview: (() => void) | null = () => undefined
): Promise<void> {
  await render(
    <PreviewShellContext.Provider value={{ layout, openLargePreview }}>
      <PreviewRuntimeContext.Provider value={runtime}>
        <PreviewScreen {...screenProps(page)} />
      </PreviewRuntimeContext.Provider>
    </PreviewShellContext.Provider>
  );
}

// ---------------------------------------------------------------------------

describe("PreviewScreen", () => {
  it("renders with chrome undefined", async () => {
    expect((globalThis as { chrome?: unknown }).chrome).toBeUndefined();
    await mount(loadedState(), runtimeFor(ready(), fakeViewer()));
    expect(find("preview-screen")).toBeDefined();
  });

  it("compiles nothing until the user asks — the export click never pays for a preview", async () => {
    const runtime = runtimeFor(ready(), fakeViewer());
    await mount(loadedState(), runtime);
    expect(runtime.compiles).toBe(0);
    expect(maybeFind("preview-empty")).not.toBeNull();
    expect(maybeFind("preview-canvas")).toBeNull();
    // The auto-update toggle is off by default, for the same reason.
    expect((find("preview-auto") as unknown as HTMLInputElement).checked).toBe(false);
  });

  it("compiles and shows a page on demand", async () => {
    const viewer = fakeViewer(4);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");
    expect(runtime.compiles).toBe(1);
    expect(find("preview-canvas")).toBeDefined();
    expect(find("preview-page-label").textContent).toContain("1");
    expect(find("preview-page-label").textContent).toContain("4");
    // Only the visible page is rasterized.
    expect(viewer.renders).toEqual([1]);
  });

  it("navigates page by page without re-compiling", async () => {
    const viewer = fakeViewer(3);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");
    await click("preview-next");
    expect(viewer.renders).toEqual([1, 2]);
    expect(runtime.compiles).toBe(1);
    await click("preview-prev");
    expect(viewer.renders).toEqual([1, 2, 1]);
  });

  it("re-renders the same page at a new zoom without re-compiling", async () => {
    const viewer = fakeViewer(2);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");
    await click("preview-zoom-in");
    expect(viewer.renders).toEqual([1, 1]);
    expect(runtime.compiles).toBe(1);
  });

  /** The label must never say "pages" for a truncated tree/space preview. */
  it("labels a truncated preview in CHAPTERS and warns that Download will not reuse it", async () => {
    const runtime = runtimeFor(
      ready({ truncated: true, includedChapters: 5, totalChapters: 42, reason: "chapters" }),
      fakeViewer()
    );
    await mount(loadedState(), runtime);
    await click("preview-generate");
    const label = find("preview-scope").textContent ?? "";
    expect(label).toContain("chapters");
    expect(label).not.toContain("pages");
    expect(label).toContain("5");
    expect(label).toContain("42");
    expect(find("preview-truncated-hint")).toBeDefined();
  });

  it("labels a full preview as the whole document", async () => {
    await mount(loadedState(), runtimeFor(ready(), fakeViewer()));
    await click("preview-generate");
    expect(find("preview-scope").textContent).toContain("whole document");
    expect(maybeFind("preview-truncated-hint")).toBeNull();
  });

  it("says the preview reflects the published version, not the editor draft", async () => {
    await mount(loadedState(), runtimeFor(ready(), fakeViewer()));
    expect(container!.textContent).toContain("published");
  });

  it("treats a superseded result as 'nothing new', not an error", async () => {
    const runtime: PreviewRuntime = {
      compile: async () => ({
        status: "superseded",
        truncated: false,
        includedChapters: 1,
        totalChapters: 1,
        reason: "none",
      }),
      readCached: async () => null,
      openViewer: async () => fakeViewer(),
    };
    await mount(loadedState(), runtime);
    await click("preview-generate");
    expect(maybeFind("preview-error")).toBeNull();
    expect(maybeFind("preview-canvas")).toBeNull();
  });

  it("surfaces a real compile failure", async () => {
    const runtime: PreviewRuntime = {
      compile: async () => {
        throw new Error("Typst exploded");
      },
      readCached: async () => null,
      openViewer: async () => fakeViewer(),
    };
    await mount(loadedState(), runtime);
    await click("preview-generate");
    expect(find("preview-error").textContent).toContain("Typst exploded");
  });

  it("asks for a page when none is loaded", async () => {
    await mount(idleState(), runtimeFor(ready(), fakeViewer()));
    expect(find("preview-needs-page")).toBeDefined();
    expect(maybeFind("preview-generate")).toBeNull();
  });
});

describe("PreviewScreen — cached bytes", () => {
  /**
   * The claim "the large preview opens over the *same* bytes" is only true if
   * the second shell reads the cache instead of compiling again.
   */
  it("opens the cached preview without compiling", async () => {
    let compiles = 0;
    const viewer = fakeViewer(2);
    const runtime: PreviewRuntime = {
      compile: async () => {
        compiles += 1;
        return ready();
      },
      readCached: async () => ready({ filename: "cached.pdf" }),
      openViewer: async () => viewer,
    };
    await mount(loadedState(), runtime, "full", null);
    expect(compiles).toBe(0);
    expect(find("preview-canvas")).toBeDefined();
    expect(viewer.renders).toEqual([1]);
  });

  it("keeps the truncation label of a cached entry", async () => {
    const runtime: PreviewRuntime = {
      compile: async () => ready(),
      readCached: async () =>
        ready({ truncated: true, includedChapters: 3, totalChapters: 19, reason: "chapters" }),
      openViewer: async () => fakeViewer(),
    };
    await mount(loadedState(), runtime, "full", null);
    expect(find("preview-scope").textContent).toContain("chapters");
    expect(find("preview-truncated-hint")).toBeDefined();
  });

  it("falls back to the idle state when nothing is cached", async () => {
    const runtime = runtimeFor(ready(), fakeViewer());
    await mount(loadedState(), runtime);
    expect(maybeFind("preview-empty")).not.toBeNull();
    expect(runtime.compiles).toBe(0);
  });

  it("a failing cache read never blocks a manual compile", async () => {
    let compiles = 0;
    const runtime: PreviewRuntime = {
      compile: async () => {
        compiles += 1;
        return ready();
      },
      readCached: async () => {
        throw new Error("IndexedDB unavailable");
      },
      openViewer: async () => fakeViewer(),
    };
    await mount(loadedState(), runtime);
    expect(maybeFind("preview-error")).toBeNull();
    await click("preview-generate");
    expect(compiles).toBe(1);
    expect(find("preview-canvas")).toBeDefined();
  });
});

describe("PreviewScreen — one screen, two shells", () => {
  it("offers 'open large preview' in the compact shell", async () => {
    let opened = 0;
    await mount(loadedState(), runtimeFor(ready(), fakeViewer()), "compact", () => {
      opened += 1;
    });
    expect(find("preview-screen").getAttribute("data-layout")).toBe("compact");
    await click("preview-open-large");
    expect(opened).toBe(1);
  });

  it("hides it in the full shell — that shell IS the large preview", async () => {
    await mount(loadedState(), runtimeFor(ready(), fakeViewer()), "full", null);
    expect(find("preview-screen").getAttribute("data-layout")).toBe("full");
    expect(maybeFind("preview-open-large")).toBeNull();
  });

  it("both shells mount the very same component", () => {
    expect(previewScreenDefinition.component).toBe(PreviewScreen);
  });
});

describe("previewScreenDefinition", () => {
  it("declares the requirements the registry needs to disable it honestly", () => {
    expect(previewScreenDefinition.id).toBe("preview");
    expect(previewScreenDefinition.labelKey).toBe("screen.preview.label");
    expect(previewScreenDefinition.requirements).toEqual([
      { kind: "loaded-page" },
      { kind: "capability", capability: "pdf-preview" },
    ]);
  });
});
