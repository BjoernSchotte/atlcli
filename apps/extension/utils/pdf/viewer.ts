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
 * Both `pdf.min.mjs` and `pdf.worker.min.mjs` are emitted with Vite's
 * `?url&no-inline`, so the upstream assets remain **verbatim** and
 * byte-identical to the npm package. The viewer imports the library asset
 * directly; a small local worker bootstrap installs required modern built-ins
 * before importing the separately emitted upstream worker. Consequences:
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
import { sanitizeLinkHref } from "@atlcli/confluence/browser";
import type { PdfBytesHandle } from "@atlcli/pdf/browser";
import { ensurePdfjsModernBuiltins } from "./pdfjs-modern-builtins.js";

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
  getAnnotations(params: { intent: "display" }): Promise<unknown[]>;
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
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: object): Promise<number>;
  destroy(): Promise<void>;
}

export interface PdfjsLoadingTask {
  promise: Promise<PdfjsDocument>;
  destroy(): Promise<void>;
}

export interface PdfjsModule {
  GlobalWorkerOptions: { workerSrc: string };
  AnnotationLayer: PdfjsAnnotationLayerConstructor;
  getDocument(params: Record<string, unknown>): PdfjsLoadingTask;
}

interface PdfjsAnnotationLayerRenderParams {
  viewport: PdfjsViewport;
  div: HTMLDivElement;
  annotations: unknown[];
  page: PdfjsPage;
  linkService: PdfjsAnnotationLinkService;
  renderForms: false;
  enableScripting: false;
  hasJSActions: false;
}

interface PdfjsAnnotationLayerInstance {
  render(params: PdfjsAnnotationLayerRenderParams): Promise<void>;
  destroy(): void;
}

interface PdfjsAnnotationLayerConstructor {
  new (params: {
    div: HTMLDivElement;
    page: PdfjsPage;
    viewport: PdfjsViewport;
    linkService: PdfjsAnnotationLinkService;
    accessibilityManager?: undefined;
    annotationCanvasMap?: undefined;
    annotationEditorUIManager?: undefined;
    annotationStorage?: undefined;
    commentManager?: undefined;
    structTreeLayer?: undefined;
  }): PdfjsAnnotationLayerInstance;
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

/** How the PDF page is fitted into the preview viewport before user zoom. */
export type PdfPreviewFit = "width" | "height" | "auto";
export type ResolvedPdfPreviewFit = Exclude<PdfPreviewFit, "auto">;

export interface RenderScaleInput {
  /** CSS pixels available for the page. */
  containerWidth: number;
  /** CSS pixels available for the page. */
  containerHeight: number;
  /** Page width in PDF units at scale 1. */
  pageWidth: number;
  /** Page height in PDF units at scale 1. */
  pageHeight: number;
  /** Fit basis. `auto` uses height for portrait pages and width otherwise. */
  fit?: PdfPreviewFit;
  /** User zoom multiplier (1 = the requested fit). */
  zoom?: number;
  devicePixelRatio?: number;
}

export interface RenderScale {
  /** Concrete fit selected after resolving `auto` against the page shape. */
  fit: ResolvedPdfPreviewFit;
  /** Scale for the CSS box. */
  cssScale: number;
  /** Scale for the backing store (`cssScale × capped DPR`, further capped by area). */
  deviceScale: number;
}

/**
 * Fit scale plus a resolution cap.
 *
 * Two independent ceilings, because they fail differently: an uncapped
 * device-pixel-ratio quadruples memory on a 3× display for no visible gain past
 * 2×, while an uncapped *area* lets a single A0 diagram page allocate hundreds
 * of megabytes regardless of DPR. Pure — no DOM, so both are unit-testable.
 */
export function computeRenderScale(input: RenderScaleInput): RenderScale {
  const zoom = input.zoom && input.zoom > 0 ? input.zoom : 1;
  const width = input.pageWidth > 0 ? input.pageWidth : 1;
  const height = input.pageHeight > 0 ? input.pageHeight : 1;
  const requestedFit = input.fit ?? "width";
  const fit: ResolvedPdfPreviewFit =
    requestedFit === "auto"
      ? height > width
        ? "height"
        : "width"
      : requestedFit;
  const available = fit === "height" ? input.containerHeight : input.containerWidth;
  const pageExtent = fit === "height" ? height : width;
  const cssScale = Math.max(0.05, (Math.max(1, available) / pageExtent) * zoom);
  const dpr = Math.min(
    MAX_DEVICE_PIXEL_RATIO,
    Math.max(1, input.devicePixelRatio && input.devicePixelRatio > 0 ? input.devicePixelRatio : 1)
  );
  let deviceScale = cssScale * dpr;
  const pixels = width * deviceScale * Math.max(1, input.pageHeight) * deviceScale;
  if (pixels > MAX_CANVAS_PIXELS) {
    deviceScale *= Math.sqrt(MAX_CANVAS_PIXELS / pixels);
  }
  return { fit, cssScale, deviceScale };
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
  ensurePdfjsModernBuiltins();
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

export interface PdfPreviewPageRender {
  /** Concrete fit used for this page; useful when the caller requested `auto`. */
  fit: ResolvedPdfPreviewFit;
}

interface PdfjsLinkAnnotation {
  subtype?: unknown;
  dest?: unknown;
  url?: unknown;
}

/**
 * Reduce a PDF URI annotation to an absolute URL the extension may open.
 * The shared policy removes controls and blocks active schemes first; the
 * standalone preview is deliberately narrower and refuses relative / native
 * protocol targets because it has no trustworthy document base URL.
 */
export function safePdfPreviewExternalHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const verdict = sanitizeLinkHref(value);
  if (!verdict.safe) return null;
  if (!/^(?:https?:\/\/|mailto:)/i.test(verdict.href)) return null;
  try {
    const url = new URL(verdict.href);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url.hostname ? url.href : null;
    }
    if (url.protocol === "mailto:") {
      return url.pathname ? url.href : null;
    }
    return null;
  } catch {
    return null;
  }
}

async function destinationPageNumber(
  document: PdfjsDocument,
  destination: unknown
): Promise<number | null> {
  let explicit: unknown;
  try {
    explicit =
      typeof destination === "string" ? await document.getDestination(destination) : destination;
  } catch {
    return null;
  }
  if (!Array.isArray(explicit) || explicit.length === 0) return null;

  const ref = explicit[0];
  let pageIndex: number;
  if (Number.isInteger(ref)) {
    pageIndex = ref as number;
  } else if (ref !== null && typeof ref === "object") {
    try {
      pageIndex = await document.getPageIndex(ref);
    } catch {
      return null;
    }
  } else {
    return null;
  }

  const pageNumber = pageIndex + 1;
  return pageNumber >= 1 && pageNumber <= document.numPages ? pageNumber : null;
}

/** Only link annotations cross into PDF.js' DOM renderer; every PDF action is discarded. */
export function safePdfPreviewAnnotations(annotations: readonly unknown[]): object[] {
  const safe: object[] = [];
  for (const candidate of annotations) {
    if (!candidate || typeof candidate !== "object") continue;
    const annotation = candidate as PdfjsLinkAnnotation;
    if (annotation.subtype !== "Link") continue;
    if (annotation.dest != null) {
      safe.push({
        ...candidate,
        url: undefined,
        action: undefined,
        actions: undefined,
        attachment: undefined,
        resetForm: undefined,
        setOCGState: undefined,
      });
      continue;
    }
    const href = safePdfPreviewExternalHref(annotation.url);
    if (!href) continue;
    safe.push({
      ...candidate,
      url: href,
      dest: undefined,
      action: undefined,
      actions: undefined,
      attachment: undefined,
      resetForm: undefined,
      setOCGState: undefined,
    });
  }
  return safe;
}

interface PdfjsAnnotationLinkService {
  eventBus?: undefined;
  addLinkAttributes(link: HTMLAnchorElement, url: string): void;
  getDestinationHash(destination: unknown): string;
  getAnchorUrl(anchor: string): string;
  goToDestination(destination: unknown): Promise<void>;
  executeNamedAction(action: string): void;
  executeSetOCGState(action: object): Promise<void>;
  getAttachmentContent(id: string): Promise<null>;
}

function annotationLinkService(
  document: PdfjsDocument,
  onNavigate: (pageNumber: number) => void
): PdfjsAnnotationLinkService {
  return {
    eventBus: undefined,
    addLinkAttributes(link, value) {
      const href = safePdfPreviewExternalHref(value);
      if (!href) return;
      link.href = href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = href;
      // URL-only keeps this infrastructure layer locale-neutral while still
      // giving the otherwise empty annotation anchor an accessible name.
      link.setAttribute("aria-label", href);
    },
    getDestinationHash() {
      return "#";
    },
    getAnchorUrl() {
      return "#";
    },
    async goToDestination(destination) {
      const pageNumber = await destinationPageNumber(document, destination);
      if (pageNumber !== null) onNavigate(pageNumber);
    },
    executeNamedAction() {
      // Named / Launch actions are filtered before AnnotationLayer sees them.
    },
    async executeSetOCGState() {
      // Optional-content actions are outside this reduced preview surface.
    },
    async getAttachmentContent() {
      return null;
    },
  };
}

function commitAnnotationLayer(target: HTMLDivElement, staging: HTMLDivElement): void {
  target.replaceChildren(...staging.childNodes);
  target.style.cssText = staging.style.cssText;
  const rotation = staging.getAttribute("data-main-rotation");
  if (rotation === null) target.removeAttribute("data-main-rotation");
  else target.setAttribute("data-main-rotation", rotation);
}

export interface PdfPreviewViewer {
  readonly pageCount: number;
  /** Render one page into `canvas`. Cancels any render already in flight. */
  /**
   * Draw one page onto `canvas`.
   *
   * `containerWidth` and `containerHeight` are REQUIRED, and that is the whole point of this
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
    options: {
      containerWidth: number;
      containerHeight: number;
      /** PDF.js-native annotation host; contains both internal and external links. */
      annotationLayer: HTMLDivElement;
      /** Receives resolved one-based internal destination pages. */
      onNavigate: (pageNumber: number) => void;
      fit?: PdfPreviewFit;
      zoom?: number;
      devicePixelRatio?: number;
    }
  ): Promise<PdfPreviewPageRender>;
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
  let activeAnnotationLayer: PdfjsAnnotationLayerInstance | null = null;
  let activeAnnotationHost: HTMLDivElement | null = null;
  let renderGeneration = 0;
  let destroyed = false;

  return {
    get pageCount() {
      return document.numPages;
    },
    async renderPage(pageNumber, canvas, options) {
      if (destroyed) throw new Error("PDF preview viewer was destroyed.");
      const generation = ++renderGeneration;
      activeAnnotationLayer?.destroy();
      activeAnnotationLayer = null;
      activeAnnotationHost?.replaceChildren();
      activeAnnotationHost = options.annotationLayer;
      options.annotationLayer.replaceChildren();
      const clamped = Math.min(Math.max(1, Math.floor(pageNumber)), document.numPages);
      const page = await document.getPage(clamped);
      const base = page.getViewport({ scale: 1 });
      const { fit, cssScale, deviceScale } = computeRenderScale({
        // Never `canvas.clientWidth` — see the interface docstring.
        containerWidth: options.containerWidth,
        containerHeight: options.containerHeight,
        pageWidth: base.width,
        pageHeight: base.height,
        fit: options.fit,
        zoom: options.zoom,
        devicePixelRatio:
          options.devicePixelRatio ??
          (typeof globalThis.devicePixelRatio === "number" ? globalThis.devicePixelRatio : 1),
      });
      // AnnotationLayer receives the CSS viewport; only the canvas backing
      // store uses deviceScale. PDF.js remains the sole geometry authority.
      const cssViewport = page.getViewport({ scale: cssScale });
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
      const annotations = await page.getAnnotations({ intent: "display" }).catch(() => []);
      const staging = options.annotationLayer.ownerDocument.createElement("div");
      staging.className = "pdf-annotation-layer";
      staging.style.setProperty("--total-scale-factor", String(cssScale));
      staging.style.setProperty("--scale-round-x", "1px");
      staging.style.setProperty("--scale-round-y", "1px");
      const linkService = annotationLinkService(document, options.onNavigate);
      const annotationLayer = new pdfjs.AnnotationLayer({
        div: staging,
        page,
        viewport: cssViewport,
        linkService,
        accessibilityManager: undefined,
        annotationCanvasMap: undefined,
        annotationEditorUIManager: undefined,
        annotationStorage: undefined,
        commentManager: undefined,
        structTreeLayer: undefined,
      });
      try {
        await Promise.all([
          render.promise,
          annotationLayer.render({
            viewport: cssViewport,
            div: staging,
            annotations: safePdfPreviewAnnotations(annotations),
            page,
            linkService,
            renderForms: false,
            enableScripting: false,
            hasJSActions: false,
          }),
        ]);
        if (!destroyed && generation === renderGeneration) {
          // `setLayerDimensions` uses viewer-wide CSS variables in upstream;
          // this reduced viewer owns one page, so pin the already-resolved CSS
          // viewport explicitly before moving PDF.js' DOM into the live host.
          staging.style.width = `${cssViewport.width}px`;
          staging.style.height = `${cssViewport.height}px`;
          commitAnnotationLayer(options.annotationLayer, staging);
          activeAnnotationLayer = annotationLayer;
        } else {
          annotationLayer.destroy();
        }
        return { fit };
      } catch (cause) {
        annotationLayer.destroy();
        throw cause;
      } finally {
        if (inFlight === render) inFlight = null;
        page.cleanup?.();
      }
    },
    async destroy() {
      destroyed = true;
      renderGeneration += 1;
      inFlight?.cancel();
      inFlight = null;
      activeAnnotationLayer?.destroy();
      activeAnnotationLayer = null;
      activeAnnotationHost?.replaceChildren();
      activeAnnotationHost = null;
      bytes.release();
      await document.destroy().catch(() => undefined);
    },
  };
}
