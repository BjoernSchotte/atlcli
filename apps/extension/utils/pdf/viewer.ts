/**
 * PDF.js viewer adapter (spec 010 T5.3, Architecture points 5 and 8).
 *
 * Renders the *compiled* bytes — the same document Download emits — into a
 * `<canvas>`. Canvas rendering runs under `script-src 'self'`, which this
 * extension's CSP already allows, so the viewer raises no `object-src`
 * question at all. What it buys over the browser's built-in PDF surface is a
 * reduced, controllable surface plus page navigation, zoom and fit-width, and
 * identical behaviour across Chrome and Firefox.
 *
 * ## How PDF.js is vendored, and why it is not bundled
 *
 * Both `pdf.min.mjs` and `pdf.worker.min.mjs` are imported with Vite's
 * `?url&no-inline` and loaded at runtime through a dynamic `import()`. They are
 * therefore emitted **verbatim**, byte-identical to the npm package, instead of
 * being merged into a rolldown chunk. Three consequences, all deliberate:
 *
 *   - the emitted paths are stable and contain *only* upstream code, so the
 *     sha256 pin in `scripts/check-output-build.ts` is meaningful and cannot be
 *     invalidated by an unrelated edit to our own sources;
 *   - a chunk-level path rule could never make that guarantee — rolldown is
 *     free to merge our modules into any chunk, so a path-scoped build-gate
 *     rule written against a chunk name could silently start covering our code;
 *   - nothing of PDF.js is parsed until the user actually opens a preview.
 *
 * ## The `asUint8Array()` borrow hazard
 *
 * `PdfBytesHandle.asUint8Array()` returns the handle's **borrowed** backing
 * array, and `pdfjs.getDocument({ data })` may transfer that buffer to its
 * worker — detaching it and leaving every other holder (including the handle,
 * and therefore Download) with a zero-length view. The viewer therefore hands
 * PDF.js a `blob:` URL, which PDF.js fetches and never detaches. Only when the
 * runtime has no `URL.createObjectURL` (a non-browser test host) does it fall
 * back to `data`, and then with an explicit **copy**. The borrowed array is
 * never passed through as-is. Pinned by `tests/pdf/viewer.test.ts`.
 */
import type { PdfBytesHandle } from "@atlcli/pdf/browser";

// ---------------------------------------------------------------------------
// Structural PDF.js surface — only what this module uses
// ---------------------------------------------------------------------------

export interface PdfjsViewport {
  width: number;
  height: number;
}

export interface PdfjsRenderTask {
  promise: Promise<void>;
  cancel(): void;
}

export interface PdfjsPage {
  getViewport(params: { scale: number }): PdfjsViewport;
  render(params: {
    canvasContext: unknown;
    viewport: PdfjsViewport;
    canvas?: unknown;
  }): PdfjsRenderTask;
  cleanup?(): void;
}

export interface PdfjsDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfjsPage>;
  destroy(): Promise<void>;
}

export interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(params: Record<string, unknown>): PdfjsLoadingTask;
}

// ---------------------------------------------------------------------------
// Construction options — the single site
// ---------------------------------------------------------------------------

/**
 * The **only** place `getDocument` options are built.
 *
 * `isEvalSupported: false` is set deliberately and is, in `pdfjs-dist@6`,
 * **inert**: the option was removed upstream together with the `Function`-based
 * PostScript function evaluator, which v6 replaced with a WebAssembly one
 * (`buildPostScriptWasmFunction`). It is kept because it costs one property and
 * means the day a future release reintroduces a string-to-code path behind that
 * flag, this viewer is already opted out. It is **not** a compensating control
 * for anything today — see `scripts/check-output-build.ts` for the actual,
 * mechanical statement about dynamic code in the vendored bundle.
 *
 * The options that *are* load-bearing today:
 *   - `enableXfa: false` — no XFA form engine.
 *   - `useSystemFonts: false` — never reach outside the bundle for a font.
 *   - no `wasmUrl` / `cMapUrl` / `standardFontDataUrl`: nothing is fetched from
 *     anywhere, which is what "bundled locally, never a CDN" means at runtime.
 *     Our documents come from our own Typst compiler with fonts embedded, so
 *     none of those optional runtimes apply.
 */
export const PDFJS_DOCUMENT_OPTIONS: Readonly<Record<string, unknown>> = Object.freeze({
  isEvalSupported: false,
  enableXfa: false,
  useSystemFonts: false,
});

/** Highest device-pixel-ratio the canvas is allowed to honour. */
export const MAX_DEVICE_PIXEL_RATIO = 2;
/** Ceiling on canvas pixels (≈ 4096²), so a poster-sized page cannot exhaust memory. */
export const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;

export interface RenderScaleInput {
  /** CSS pixels available for the page. */
  containerWidth: number;
  /** Page width in PDF units at scale 1. */
  pageWidth: number;
  /** Page height in PDF units at scale 1. */
  pageHeight: number;
  /** User zoom multiplier (1 = fit width). */
  zoom?: number;
  devicePixelRatio?: number;
}

export interface RenderScale {
  /** Scale for the CSS box. */
  cssScale: number;
  /** Scale for the backing store (`cssScale × capped DPR`, further capped by area). */
  deviceScale: number;
}

/**
 * Fit-width scale plus a resolution cap.
 *
 * Two independent ceilings, because they fail differently: an uncapped
 * device-pixel-ratio quadruples memory on a 3× display for no visible gain past
 * 2×, while an uncapped *area* lets a single A0 diagram page allocate hundreds
 * of megabytes regardless of DPR. Pure — no DOM, so both are unit-testable.
 */
export function computeRenderScale(input: RenderScaleInput): RenderScale {
  const zoom = input.zoom && input.zoom > 0 ? input.zoom : 1;
  const width = input.pageWidth > 0 ? input.pageWidth : 1;
  const cssScale = Math.max(0.05, (input.containerWidth / width) * zoom);
  const dpr = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, input.devicePixelRatio && input.devicePixelRatio > 0 ? input.devicePixelRatio : 1)
  );
  let deviceScale = cssScale * dpr;
  const pixels = width * deviceScale * Math.max(1, input.pageHeight) * deviceScale;
  if (pixels > MAX_CANVAS_PIXELS) {
    deviceScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  }
  return { cssScale, deviceScale };
}

// ---------------------------------------------------------------------------
// Module loading
// ---------------------------------------------------------------------------

export interface PdfjsLoaderDeps {
  /** Loads the vendored library. Injected in tests; never a network URL. */
  importModule: () => Promise<PdfjsModule>;
  workerSrc: string;
}

/**
 * Resolve the two emitted asset URLs.
 *
 * Behind a dynamic `import()` because `?url&no-inline` is a build-time
 * transform: importing `./pdfjs-assets.js` statically would make this module
 * unloadable in a plain module runner, and with it every unit test of the
 * scaling and borrow-contract logic below.
 */
async function loadVendoredPdfjs(): Promise<PdfjsModule> {
  const { PDFJS_MODULE_URL, PDFJS_WORKER_URL } = await import("./pdfjs-assets.js");
  // `@vite-ignore`: the specifier is an emitted asset URL resolved at runtime,
  // which is the whole point — see the module comment.
  const mod = (await import(/* @vite-ignore */ PDFJS_MODULE_URL)) as PdfjsModule;
  mod.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
  return mod;
}

let modulePromise: Promise<PdfjsModule> | null = null;

/** Test-only: forget the memoized module so a fresh loader can be injected. */
export function __resetPdfjsModule(): void {
  modulePromise = null;
}

/**
 * Load PDF.js once per document context and point it at the bundled worker.
 *
 * Memoized: `GlobalWorkerOptions.workerSrc` is global state, so assigning it
 * per call would be both wasteful and a race between two viewers.
 */
export function loadPdfjs(overrides: Partial<PdfjsLoaderDeps> = {}): Promise<PdfjsModule> {
  if (!modulePromise) {
    const load = overrides.importModule;
    modulePromise = (async () => {
      if (!load) return loadVendoredPdfjs();
      const mod = await load();
      mod.GlobalWorkerOptions.workerSrc = overrides.workerSrc ?? "";
      return mod;
    })().catch((error: unknown) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

// ---------------------------------------------------------------------------
// Viewer
// ---------------------------------------------------------------------------

/**
 * Turn a handle into something `getDocument` can consume **without** risking
 * the borrow hazard. See the module comment.
 */
export async function pdfjsSourceFor(bytes: PdfBytesHandle): Promise<Record<string, unknown>> {
  if (typeof globalThis.URL?.createObjectURL === "function") {
    return { url: await bytes.objectUrl() };
  }
  // No object-URL support (non-browser host): copy, never borrow. PDF.js may
  // transfer and detach `data`'s buffer, which would zero the handle itself.
  return { data: new Uint8Array(await bytes.asUint8Array()) };
}

export interface PdfPreviewViewer {
  readonly pageCount: number;
  /** Render one page into `canvas`. Cancels any render already in flight. */
  /**
   * Draw one page onto `canvas`.
   *
   * `containerWidth` is REQUIRED, and that is the whole point of this
   * signature. It used to be optional with a `canvas.clientWidth` fallback —
   * but this method *sets* `canvas.style.width` at the end, so falling back to
   * the canvas's own width measured the output of the previous render and fed
   * it back in as the fit basis. The scale became relative to itself, which
   * made `zoom: 1` ("fit width") a multiplication by one — a no-op at every
   * zoom level — and left the page pinned at whatever width the canvas
   * happened to have on its first layout.
   *
   * Requiring the caller to measure its own container makes that class of bug
   * a compile error rather than a button that silently does nothing.
   */
  renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    options: { containerWidth: number; zoom?: number; devicePixelRatio?: number }
  ): Promise<void>;
  destroy(): Promise<void>;
}

export interface OpenPdfViewerDeps extends Partial<PdfjsLoaderDeps> {
  /** Injected in tests so no real canvas is required. */
  getContext?: (canvas: HTMLCanvasElement) => unknown;
}

/**
 * Open a compiled PDF for on-screen rendering.
 *
 * Only the page the caller asks for is rendered — the compact panel shows one
 * page at a time and the large view scrolls page by page — so a 200-page
 * preview never rasterizes 200 canvases.
 */
export async function openPdfViewer(
  bytes: PdfBytesHandle,
  deps: OpenPdfViewerDeps = {}
): Promise<PdfPreviewViewer> {
  const pdfjs = await loadPdfjs(deps);
  const source = await pdfjsSourceFor(bytes);
  const task = pdfjs.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, ...source });
  const document = await task.promise;

  let inFlight: PdfjsRenderTask | null = null;
  let destroyed = false;

  return {
    get pageCount() {
      return document.numPages;
    },
    async renderPage(pageNumber, canvas, options) {
      if (destroyed) throw new Error("PDF preview viewer was destroyed.");
      const clamped = Math.min(Math.max(1, Math.floor(pageNumber)), document.numPages);
      const page = await document.getPage(clamped);
      const base = page.getViewport({ scale: 1 });
      const { cssScale, deviceScale } = computeRenderScale({
        // Never `canvas.clientWidth` — see the interface docstring.
        containerWidth: options.containerWidth,
        pageWidth: base.width,
        pageHeight: base.height,
        zoom: options.zoom,
        devicePixelRatio:
          options.devicePixelRatio ??
          (typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1),
      });
      const viewport = page.getViewport({ scale: deviceScale });
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = `${Math.max(1, Math.round(base.width * cssScale))}px`;
      canvas.style.height = `${Math.max(1, Math.round(base.height * cssScale))}px`;

      inFlight?.cancel();
      const context = deps.getContext
        ? deps.getContext(canvas)
        : canvas.getContext("2d");
      const render = page.render({ canvasContext: context, viewport, canvas });
      inFlight = render;
      try {
        await render.promise;
      } finally {
        if (inFlight === render) inFlight = null;
        page.cleanup?.();
      }
    },
    async destroy() {
      destroyed = true;
      inFlight?.cancel();
      inFlight = null;
      bytes.release();
      await document.destroy().catch(() => undefined);
    },
  };
}
