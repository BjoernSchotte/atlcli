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
import type { PdfPreviewFit, PdfPreviewViewer } from "../utils/pdf/viewer.js";
import type { ScreenProps } from "../utils/screens/registry.js";
import type { PanelState } from "../utils/panel-state.js";
import type { AppPorts } from "../utils/ports/index.js";
import type { LoadedPage } from "../utils/read-path.js";
import {
  PublishingDraftProvider,
  usePublishingDraft,
} from "../components/app/publishing-draft.js";

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
  "ResizeObserver",
] as const;

/**
 * The width the preview FRAME reports.
 *
 * happy-dom has no layout engine, so every `clientWidth` is 0 — and the screen
 * (correctly) refuses to fit a page to a zero-width frame. Stubbing the
 * property is the smallest thing that makes these tests run in a world where
 * elements have a size, and it keeps the production code free of test hooks.
 */
const FRAME_WIDTH = 412;
const FRAME_HEIGHT = 688;

/**
 * The width the CANVAS reports — deliberately different from {@link FRAME_WIDTH}.
 *
 * If both were the same number, "fits to the measured frame" could not tell the
 * two apart, and reverting to the old `canvas.clientWidth` basis would leave the
 * suite green. Different values are what make that assertion discriminating.
 */
const CANVAS_WIDTH = 987;

let saved: { key: string; descriptor: PropertyDescriptor | undefined }[] = [];
let win: Window | null = null;
let container: HTMLElement | null = null;
let root: { render: (node: React.ReactNode) => void; unmount: () => void } | null = null;
let savedChrome: PropertyDescriptor | undefined;

/**
 * Give elements a size. A `<canvas>` always reports {@link CANVAS_WIDTH}, so a
 * regression to the old canvas-relative fit basis produces a *different* number
 * rather than the same one by luck.
 */
function stubLayout(frameWidth: number, frameHeight = FRAME_HEIGHT): void {
  const prototype = (win as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  Object.defineProperty(prototype, "clientWidth", {
    configurable: true,
    get(this: { tagName?: string }) {
      return this.tagName === "CANVAS" ? CANVAS_WIDTH : frameWidth;
    },
  });
  Object.defineProperty(prototype, "clientHeight", {
    configurable: true,
    get(this: { tagName?: string }) {
      return this.tagName === "CANVAS" ? 1234 : frameHeight;
    },
  });
}

function installFullscreenMock(): void {
  const doc = win!.document as unknown as {
    fullscreenEnabled: boolean;
    fullscreenElement: Element | null;
    exitFullscreen(): Promise<void>;
    dispatchEvent(event: Event): boolean;
  };
  let fullscreenElement: Element | null = null;
  Object.defineProperty(doc, "fullscreenEnabled", { configurable: true, value: true });
  Object.defineProperty(doc, "fullscreenElement", {
    configurable: true,
    get: () => fullscreenElement,
  });
  Object.defineProperty(doc, "exitFullscreen", {
    configurable: true,
    value: async () => {
      fullscreenElement = null;
      doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("fullscreenchange"));
    },
  });
  const prototype = (win as unknown as { HTMLElement: { prototype: object } }).HTMLElement.prototype;
  Object.defineProperty(prototype, "requestFullscreen", {
    configurable: true,
    value: async function requestFullscreen(this: Element) {
      fullscreenElement = this;
      doc.dispatchEvent(new (win as unknown as { Event: typeof Event }).Event("fullscreenchange"));
    },
  });
}

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
  stubLayout(FRAME_WIDTH);
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
  await clickElement(find(testId));
}

async function clickElement(element: Element): Promise<void> {
  const { act } = await import("react");
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

/** One recorded `renderPage` call — the WHOLE call, not just the page number. */
interface RecordedRender {
  page: number;
  zoom: number | undefined;
  containerWidth: number;
  containerHeight: number;
  fit: PdfPreviewFit | undefined;
}

/**
 * The fake used to be `async renderPage(pageNumber) { renders.push(pageNumber) }`
 * — it dropped the options argument entirely. That is why no test could see
 * that the screen never passed `containerWidth`, and why the zoom test could
 * only assert *that* a re-render happened, never *at what scale*. It records
 * the full call now, and the assertions below read the recorded scale.
 */
function fakeViewer(pageCount = 4): PdfPreviewViewer & {
  renders: number[];
  calls: RecordedRender[];
} {
  const calls: RecordedRender[] = [];
  return {
    get renders() {
      return calls.map((c) => c.page);
    },
    calls,
    pageCount,
    async renderPage(pageNumber, _canvas, options) {
      calls.push({
        page: pageNumber,
        zoom: options.zoom,
        containerWidth: options.containerWidth,
        containerHeight: options.containerHeight,
        fit: options.fit,
      });
      options.annotationLayer.replaceChildren();
      if (pageNumber === 1) {
        const internalSection = options.annotationLayer.ownerDocument.createElement("section");
        internalSection.className = "linkAnnotation";
        internalSection.setAttribute("data-internal-link", "");
        const internal = options.annotationLayer.ownerDocument.createElement("a");
        internal.href = "#chapter-three";
        internal.onclick = () => {
          options.onNavigate(3);
          return false;
        };
        internalSection.append(internal);

        const externalSection = options.annotationLayer.ownerDocument.createElement("section");
        externalSection.className = "linkAnnotation";
        const external = options.annotationLayer.ownerDocument.createElement("a");
        external.href = "https://example.com/docs";
        external.target = "_blank";
        external.rel = "noopener noreferrer";
        externalSection.append(external);
        options.annotationLayer.append(internalSection, externalSection);
      }
      return {
        fit: options.fit === "auto" ? "height" : options.fit ?? "width",
      };
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
  openLargePreview: (() => void) | null = () => undefined,
  closePreview: (() => void) | null = null
): Promise<void> {
  await render(
    <PreviewShellContext.Provider value={{ layout, openLargePreview, closePreview }}>
      <PreviewRuntimeContext.Provider value={runtime}>
        <PreviewScreen {...screenProps(page)} />
      </PreviewRuntimeContext.Provider>
    </PreviewShellContext.Provider>
  );
}

function EmbeddedDraftPreview({
  props,
}: {
  props: ScreenProps;
}): React.JSX.Element {
  const draft = usePublishingDraft();
  return (
    <>
      <button
        type="button"
        data-testid="change-preview-setting"
        onClick={() => draft.onSettingChange("orientation", "landscape")}
      >
        Change setting
      </button>
      <button
        type="button"
        data-testid="change-preview-scope-tree"
        onClick={() => draft.dispatchScope({ type: "set-kind", kind: "tree" })}
      >
        Include children
      </button>
      <PreviewScreen {...props} embedded />
    </>
  );
}

async function mountEmbeddedDraft(page: PanelState, runtime: PreviewRuntime): Promise<void> {
  const props = screenProps(page);
  await render(
    <PreviewShellContext.Provider
      value={{ layout: "compact", openLargePreview: () => undefined, closePreview: null }}
    >
      <PreviewRuntimeContext.Provider value={runtime}>
        <PublishingDraftProvider ports={props.ports} page={page}>
          <EmbeddedDraftPreview props={props} />
        </PublishingDraftProvider>
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

  it("keeps the embedded preview in Review and marks it stale after design changes", async () => {
    const runtime = runtimeFor(ready(), fakeViewer(4));
    await mountEmbeddedDraft(loadedState(), runtime);

    expect(find("preview-status").getAttribute("data-status")).toBe("empty");
    expect(find("preview-metadata").textContent).toContain("v7");
    expect(maybeFind("preview-auto")).not.toBeNull();

    await click("preview-generate");
    expect(find("preview-status").getAttribute("data-status")).toBe("current");
    expect(find("preview-metadata").textContent).toBe("v7 · 4 pages");
    expect(find("preview-open-large").textContent).toContain("Large preview");
    expect(find("preview-open-large").className).toContain("h-7");
    expect(find("preview-generate").getAttribute("aria-label")).toContain("Refresh");
    expect(maybeFind("preview-document")).not.toBeNull();

    await click("change-preview-setting");
    expect(find("preview-status").getAttribute("data-status")).toBe("stale");
    // The old preview remains reviewable until the user deliberately refreshes it.
    expect(maybeFind("preview-document")).not.toBeNull();
  });

  it("threads Page + children into the preview request instead of falling back to the root", async () => {
    const requests: Parameters<PreviewRuntime["compile"]>[0][] = [];
    const runtime: PreviewRuntime = {
      async compile(request) {
        requests.push(request);
        return ready({ includedChapters: 3, totalChapters: 3 });
      },
      async readCached() {
        return null;
      },
      async openViewer() {
        return fakeViewer();
      },
    };
    await mountEmbeddedDraft(loadedState(), runtime);
    await click("change-preview-scope-tree");
    await click("preview-generate");

    expect(requests).toHaveLength(1);
    expect(requests[0]?.scope).toEqual({
      kind: "tree",
      rootPageId: "42",
      includeRoot: true,
      maxDepth: 5,
    });
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

  it("consumes PDF.js AnnotationLayer links without re-compiling or retaining stale DOM", async () => {
    const viewer = fakeViewer(4);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");

    const annotationLayer = find("preview-annotation-layer");
    const internal = annotationLayer.querySelector(
      "section.linkAnnotation[data-internal-link] > a"
    );
    const external = annotationLayer.querySelector(
      "section.linkAnnotation:not([data-internal-link]) > a"
    ) as HTMLAnchorElement | null;
    expect(internal).not.toBeNull();
    expect(external?.href).toBe("https://example.com/docs");
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener noreferrer");
    // The screen consumes PDF.js' own annotation DOM; there is no custom
    // geometry/button layer to keep in sync with canvas scale.
    expect(maybeFind("preview-internal-link-0")).toBeNull();
    await clickElement(internal!);

    expect(viewer.renders).toEqual([1, 3]);
    expect(find("preview-page-label").textContent).toContain("3");
    expect(runtime.compiles).toBe(1);
    // Page three has no annotations in this fake. The page-one links must not
    // linger over the newly rendered canvas.
    expect(find("preview-annotation-layer").childElementCount).toBe(0);
  });

  it("re-renders the same page at a new zoom without re-compiling", async () => {
    const viewer = fakeViewer(2);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");
    await click("preview-zoom-in");
    expect(viewer.renders).toEqual([1, 1]);
    expect(runtime.compiles).toBe(1);
    // The zoom must actually REACH the viewer. Asserting only that a second
    // render happened is what let the fit-width defect through: the old fake
    // discarded the options argument, so a zoom that changed nothing looked
    // identical to one that worked.
    expect(viewer.calls.map((c) => c.zoom)).toEqual([1, 1.25]);
  });

  /**
   * The regression for the reported bug: "Breite anpassen" did nothing.
   *
   * `renderPage` sets `canvas.style.width`, so the old code's
   * `canvas.clientWidth` fallback fed the previous render's output back in as
   * the fit basis. The scale was relative to itself, which made `zoom: 1` a
   * multiplication by one at every zoom level.
   */
  it("fits to the MEASURED frame, never to the canvas it just resized", async () => {
    const viewer = fakeViewer(2);
    await mount(loadedState(), runtimeFor(ready(), viewer));
    await click("preview-generate");
    for (const call of viewer.calls) {
      expect(call.containerWidth).toBe(FRAME_WIDTH);
    }
    expect(viewer.calls.length).toBeGreaterThan(0);
  });

  it("returns to fit-width after zooming, at the same scale as the first render", async () => {
    const viewer = fakeViewer(2);
    await mount(loadedState(), runtimeFor(ready(), viewer));
    await click("preview-generate");
    const first = viewer.calls.at(-1)!;

    await click("preview-zoom-in");
    await click("preview-zoom-in");
    const zoomed = viewer.calls.at(-1)!;
    expect(zoomed.zoom).toBeGreaterThan(1);

    await click("preview-fit-width");
    const fitted = viewer.calls.at(-1)!;
    // Same page, same basis, back to 1 — i.e. genuinely the first render again,
    // not "the current size times one".
    expect(fitted.zoom).toBe(1);
    expect(fitted.containerWidth).toBe(first.containerWidth);
    expect(fitted.fit).toBe("width");
    expect(fitted.page).toBe(first.page);
  });

  it("fits to the measured frame height when requested", async () => {
    const viewer = fakeViewer(2);
    await mount(loadedState(), runtimeFor(ready(), viewer));
    await click("preview-generate");
    await click("preview-fit-height");

    const fitted = viewer.calls.at(-1)!;
    expect(fitted.fit).toBe("height");
    expect(fitted.containerHeight).toBe(FRAME_HEIGHT);
    expect(fitted.zoom).toBe(1);
    expect(find("preview-fit-height").hasAttribute("disabled")).toBe(true);
    expect(find("preview-fit-width").hasAttribute("disabled")).toBe(false);
  });

  it("disables fit-width when the preview is already fitted", async () => {
    // A control that is a no-op in its default state and gives no feedback
    // reads as broken — which is exactly how this was reported.
    const viewer = fakeViewer(2);
    await mount(loadedState(), runtimeFor(ready(), viewer));
    await click("preview-generate");
    expect(find("preview-fit-width").hasAttribute("disabled")).toBe(true);
    await click("preview-zoom-in");
    expect(find("preview-fit-width").hasAttribute("disabled")).toBe(false);
  });

  /**
   * The other half of the measurement contract, and the one a fake CAN show.
   *
   * A frame with no layout must produce no render at all. Fitting a page to a
   * zero-width frame is how you get a 1-pixel-wide canvas, and the previous
   * code reached for `canvas.clientWidth` precisely to paper over this moment —
   * which is what made the fit basis self-referential ever after.
   *
   * The *resize* path (ResizeObserver → re-measure → re-render) is deliberately
   * NOT tested here: happy-dom has no layout engine, so its ResizeObserver
   * never fires and any assertion would pass whether the observer were wired up
   * or deleted. Do not "add coverage" for it against this fake — that trades a
   * real check for a green light. It belongs in the manual release protocol
   * (resize the panel and the large-preview tab with a preview on screen).
   */
  it("renders nothing while the frame has no width", async () => {
    stubLayout(0);
    const viewer = fakeViewer(2);
    const runtime = runtimeFor(ready(), viewer);
    await mount(loadedState(), runtime);
    await click("preview-generate");
    expect(runtime.compiles).toBe(1);
    expect(viewer.calls).toEqual([]);
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

  it("the large tab reads the exact latest slot instead of rebuilding the sidebar scope", async () => {
    let requestReads = 0;
    let latestReads = 0;
    const runtime: PreviewRuntime = {
      async compile() {
        throw new Error("must not compile");
      },
      async readCached() {
        requestReads += 1;
        return null;
      },
      async readLatest() {
        latestReads += 1;
        return ready({ truncated: true, includedChapters: 3, totalChapters: 8 });
      },
      async openViewer() {
        return fakeViewer();
      },
    };
    await mount(loadedState(), runtime, "full", null);

    expect(latestReads).toBe(1);
    expect(requestReads).toBe(0);
    expect(find("preview-scope").textContent).toContain("3");
    expect(find("preview-scope").textContent).toContain("8");
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

  it("turns the full shell into a focused, viewport-filling document view", async () => {
    let closed = 0;
    const viewer = fakeViewer(5);
    const runtime: PreviewRuntime = {
      compile: async () => ready(),
      readCached: async () => ready({ filename: "cached.pdf" }),
      openViewer: async () => viewer,
    };
    await mount(loadedState(), runtime, "full", null, () => {
      closed += 1;
    });

    expect(find("preview-full-header").textContent).toContain("whole document");
    expect(maybeFind("preview-generate")).toBeNull();
    expect(maybeFind("preview-auto")).toBeNull();
    expect(find("preview-screen").className).toContain("h-full");
    expect(find("preview-viewer").className).toContain("flex-1");
    expect(find("preview-viewer").className).toContain("min-h-0");
    expect(find("preview-frame").className).toContain("h-full");
    expect(viewer.calls.at(-1)?.fit).toBe("auto");
    expect(viewer.calls.at(-1)?.containerHeight).toBe(FRAME_HEIGHT);
    expect(find("preview-fit-height").hasAttribute("disabled")).toBe(true);

    const close = find("preview-close");
    expect(close.getAttribute("aria-label")).toContain("Close");
    expect(close.className).toContain("size-8");
    await click("preview-close");
    expect(closed).toBe(1);
  });

  it("promotes the large preview into native fullscreen and back", async () => {
    installFullscreenMock();
    const runtime: PreviewRuntime = {
      compile: async () => ready(),
      readCached: async () => ready({ filename: "cached.pdf" }),
      openViewer: async () => fakeViewer(5),
    };
    await mount(loadedState(), runtime, "full", null, () => undefined);

    const enter = find("preview-fullscreen");
    expect(enter.getAttribute("aria-label")).toContain("Enter fullscreen");
    await click("preview-fullscreen");
    expect(find("preview-screen").getAttribute("data-fullscreen")).toBe("true");
    expect(find("preview-fullscreen").getAttribute("aria-label")).toContain("Exit fullscreen");

    await click("preview-fullscreen");
    expect(find("preview-screen").getAttribute("data-fullscreen")).toBe("false");
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
