import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { pdfBytesFromUint8Array } from "@atlcli/pdf/browser";
import { scanText } from "../../scripts/check-output-build.js";
import {
  MAX_CANVAS_PIXELS,
  MAX_DEVICE_PIXEL_RATIO,
  PDFJS_DOCUMENT_OPTIONS,
  __resetPdfjsModule,
  computeRenderScale,
  openPdfViewer,
  pdfjsSourceFor,
  safePdfPreviewAnnotations,
  safePdfPreviewExternalHref,
  type PdfjsDocument,
  type PdfjsModule,
  type PdfjsPage,
  type PdfPreviewViewer,
} from "../../utils/pdf/viewer.js";
import { EXTENSION_ROOT } from "../build-helper.js";

afterEach(() => __resetPdfjsModule());

// ---------------------------------------------------------------------------
// Fake PDF.js
// ---------------------------------------------------------------------------

interface Recorded {
  params: Record<string, unknown>[];
  rendered: { scale: number; canvas: unknown }[];
  annotationRenders: Array<{
    annotations: unknown[];
    renderForms: boolean;
    enableScripting: boolean;
    hasJSActions: boolean;
  }>;
}

function fakePdfjs(
  pages = 3,
  options: {
    annotations?: unknown[];
    annotationsByPage?: Record<number, unknown[]>;
    destinations?: Record<string, unknown[]>;
    pageWidth?: number;
    pageHeight?: number;
    getAnnotations?: (pageNumber: number) => Promise<unknown[]>;
    renderTask?: (pageNumber: number) => { promise: Promise<void>; cancel(): void };
  } = {}
): { module: PdfjsModule; recorded: Recorded } {
  const recorded: Recorded = { params: [], rendered: [], annotationRenders: [] };
  const pageWidth = options.pageWidth ?? 600;
  const pageHeight = options.pageHeight ?? 800;
  const pageFor = (pageNumber: number): PdfjsPage => ({
    getViewport: ({ scale }) => ({
      width: pageWidth * scale,
      height: pageHeight * scale,
    }),
    getAnnotations: () =>
      options.getAnnotations?.(pageNumber) ??
      Promise.resolve(options.annotationsByPage?.[pageNumber] ?? options.annotations ?? []),
    render: ({ viewport, canvas }) => {
      recorded.rendered.push({ scale: viewport.width / pageWidth, canvas });
      return options.renderTask?.(pageNumber) ?? {
        promise: Promise.resolve(),
        cancel: () => undefined,
      };
    },
  });
  const document: PdfjsDocument = {
    numPages: pages,
    getPage: async (pageNumber) => pageFor(pageNumber),
    getDestination: async (id) => options.destinations?.[id] ?? null,
    getPageIndex: async (ref) => {
      const pageIndex = (ref as { pageIndex?: unknown }).pageIndex;
      if (!Number.isInteger(pageIndex)) throw new Error("unknown page ref");
      return pageIndex as number;
    },
    destroy: async () => undefined,
  };
  const module: PdfjsModule = {
    GlobalWorkerOptions: { workerSrc: "" },
    AnnotationLayer: class FakeAnnotationLayer {
      private readonly div: HTMLDivElement;

      constructor(params: { div: HTMLDivElement }) {
        this.div = params.div;
      }

      async render(params: {
        annotations: unknown[];
        renderForms: false;
        enableScripting: false;
        hasJSActions: false;
        linkService: {
          addLinkAttributes(link: HTMLAnchorElement, url: string): void;
          getDestinationHash(destination: unknown): string;
          goToDestination(destination: unknown): Promise<void>;
        };
      }) {
        recorded.annotationRenders.push({
          annotations: params.annotations,
          renderForms: params.renderForms,
          enableScripting: params.enableScripting,
          hasJSActions: params.hasJSActions,
        });
        for (const candidate of params.annotations) {
          const annotation = candidate as { id?: string; subtype?: string; url?: string; dest?: unknown };
          if (annotation.subtype !== "Link") continue;
          const section = this.div.ownerDocument.createElement("section");
          section.className = "linkAnnotation";
          section.setAttribute("data-annotation-id", annotation.id ?? "link");
          const link = this.div.ownerDocument.createElement("a");
          if (annotation.url) {
            params.linkService.addLinkAttributes(link, annotation.url);
          } else if (annotation.dest != null) {
            section.setAttribute("data-internal-link", "");
            link.href = params.linkService.getDestinationHash(annotation.dest);
            link.onclick = () => {
              void params.linkService.goToDestination(annotation.dest);
              return false;
            };
          }
          section.append(link);
          this.div.append(section);
        }
      }

      destroy() {
        /* fake owns no resources */
      }
    } as unknown as PdfjsModule["AnnotationLayer"],
    getDocument: (params) => {
      recorded.params.push(params);
      return { promise: Promise.resolve(document), destroy: async () => undefined };
    },
  };
  return { module, recorded };
}

function fakeAnnotationHost(): HTMLDivElement {
  const window = new Window();
  return window.document.createElement("div") as unknown as HTMLDivElement;
}

type RenderOptions = Parameters<PdfPreviewViewer["renderPage"]>[2];

function renderOptions(overrides: Partial<RenderOptions> = {}): RenderOptions {
  return {
    containerWidth: 300,
    containerHeight: 700,
    annotationLayer: fakeAnnotationHost(),
    onNavigate: () => undefined,
    ...overrides,
  };
}

function fakeCanvas(): HTMLCanvasElement {
  return {
    width: 0,
    height: 0,
    clientWidth: 400,
    style: {} as CSSStyleDeclaration,
    getContext: () => ({}),
  } as unknown as HTMLCanvasElement;
}

// ---------------------------------------------------------------------------

describe("PDF.js construction site", () => {
  it("sets isEvalSupported: false at the single construction site", () => {
    expect(PDFJS_DOCUMENT_OPTIONS.isEvalSupported).toBe(false);
  });

  it("disables XFA and system fonts, and configures no remote runtime URLs", () => {
    expect(PDFJS_DOCUMENT_OPTIONS.enableXfa).toBe(false);
    expect(PDFJS_DOCUMENT_OPTIONS.useSystemFonts).toBe(false);
    // No cMapUrl / standardFontDataUrl / wasmUrl: nothing is fetched from
    // anywhere at runtime. "Bundled locally, never a CDN" has to hold at run
    // time too, not only in the build output.
    expect(PDFJS_DOCUMENT_OPTIONS.cMapUrl).toBeUndefined();
    expect(PDFJS_DOCUMENT_OPTIONS.standardFontDataUrl).toBeUndefined();
    expect(PDFJS_DOCUMENT_OPTIONS.wasmUrl).toBeUndefined();
  });

  it("passes the options through to getDocument", async () => {
    const { module, recorded } = fakePdfjs();
    await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "worker.mjs",
    });
    expect(recorded.params).toHaveLength(1);
    expect(recorded.params[0]!.isEvalSupported).toBe(false);
  });

  it("points the worker at a bundled URL and assigns it once", async () => {
    const { module } = fakePdfjs();
    let loads = 0;
    const deps = {
      importModule: async () => {
        loads += 1;
        return module;
      },
      workerSrc: "/assets/pdf.worker.min-abc.mjs",
    };
    await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), deps);
    await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([2])), deps);
    expect(loads).toBe(1);
    expect(module.GlobalWorkerOptions.workerSrc).toBe("/assets/pdf.worker.min-abc.mjs");
  });

  /**
   * The runtime files must come from the vendored package, emitted verbatim —
   * that is what makes the sha256 pins in `check-output-build.ts` say anything.
   * Asserted at the source level because the `?url&no-inline` transform only
   * exists inside the Vite build.
   */
  it("sources both runtime files from the vendored package, emitted verbatim", () => {
    const source = readFileSync(join(EXTENSION_ROOT, "utils", "pdf", "pdfjs-assets.ts"), "utf8");
    const workerBootstrap = readFileSync(
      join(EXTENSION_ROOT, "utils", "pdf", "pdfjs-worker-bootstrap.ts"),
      "utf8"
    );
    expect(source).toContain('"pdfjs-dist/build/pdf.min.mjs?url&no-inline"');
    expect(source).toContain('"./pdfjs-worker-bootstrap.ts?worker&url"');
    expect(workerBootstrap).toContain(
      '"pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline"'
    );
    expect(workerBootstrap).toContain("await import(");
    expect(workerBootstrap).toContain("export const WorkerMessageHandler");
    expect(workerBootstrap).not.toContain("void import(");
    expect(source).not.toMatch(/https?:\/\//);
    expect(workerBootstrap).not.toMatch(/https?:\/\//);
  });
});

/**
 * The hazard `packages/pdf/src/bytes-handle.ts` documents: `asUint8Array()`
 * returns the handle's **borrowed** backing array, and `getDocument({ data })`
 * may transfer that buffer to the PDF.js worker — detaching it and leaving the
 * handle (and therefore Download) with a zero-length view.
 */
describe("asUint8Array() borrow hazard", () => {
  it("hands PDF.js a blob: URL, never the borrowed array", async () => {
    const bytes = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
    const source = await pdfjsSourceFor(bytes);
    expect(typeof source.url).toBe("string");
    expect(String(source.url)).toStartWith("blob:");
    expect(source.data).toBeUndefined();
  });

  it("falls back to a COPY — never the borrowed array — without createObjectURL", async () => {
    const original = globalThis.URL.createObjectURL;
    // @ts-expect-error deliberately removing the API to exercise the fallback
    delete globalThis.URL.createObjectURL;
    try {
      const bytes = pdfBytesFromUint8Array(new Uint8Array([1, 2, 3]));
      const borrowed = await bytes.asUint8Array();
      const source = await pdfjsSourceFor(bytes);
      expect(source.url).toBeUndefined();
      expect(source.data).toEqual(borrowed);
      // Same content, DIFFERENT object: detaching the copy cannot zero the handle.
      expect(source.data).not.toBe(borrowed);
      expect((source.data as Uint8Array).buffer).not.toBe(borrowed.buffer);
    } finally {
      globalThis.URL.createObjectURL = original;
    }
  });
});

describe("computeRenderScale", () => {
  it("fits the page to the container width", () => {
    const { cssScale } = computeRenderScale({
      containerWidth: 300,
      containerHeight: 700,
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: 1,
    });
    expect(cssScale).toBeCloseTo(0.5);
  });

  it("applies zoom on top of fit-width", () => {
    const { cssScale } = computeRenderScale({
      containerWidth: 300,
      containerHeight: 700,
      pageWidth: 600,
      pageHeight: 800,
      zoom: 2,
      devicePixelRatio: 1,
    });
    expect(cssScale).toBeCloseTo(1);
  });

  it("fits the page to the container height", () => {
    const result = computeRenderScale({
      containerWidth: 1200,
      containerHeight: 400,
      pageWidth: 600,
      pageHeight: 800,
      fit: "height",
      devicePixelRatio: 1,
    });
    expect(result.fit).toBe("height");
    expect(result.cssScale).toBeCloseTo(0.5);
  });

  it("auto-fits portrait pages by height and landscape pages by width", () => {
    const portrait = computeRenderScale({
      containerWidth: 1200,
      containerHeight: 400,
      pageWidth: 600,
      pageHeight: 800,
      fit: "auto",
      devicePixelRatio: 1,
    });
    const landscape = computeRenderScale({
      containerWidth: 400,
      containerHeight: 1200,
      pageWidth: 800,
      pageHeight: 600,
      fit: "auto",
      devicePixelRatio: 1,
    });
    expect(portrait.fit).toBe("height");
    expect(portrait.cssScale).toBeCloseTo(0.5);
    expect(landscape.fit).toBe("width");
    expect(landscape.cssScale).toBeCloseTo(0.5);
  });

  it("caps the device-pixel-ratio contribution", () => {
    const capped = computeRenderScale({
      containerWidth: 300,
      containerHeight: 700,
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: 4,
    });
    const atCap = computeRenderScale({
      containerWidth: 300,
      containerHeight: 700,
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: MAX_DEVICE_PIXEL_RATIO,
    });
    expect(capped.deviceScale).toBeCloseTo(atCap.deviceScale);
  });

  it("caps total canvas area for a poster-sized page", () => {
    const { deviceScale } = computeRenderScale({
      containerWidth: 4000,
      containerHeight: 4000,
      pageWidth: 3370,
      pageHeight: 4768,
      devicePixelRatio: 2,
    });
    const pixels = 3370 * deviceScale * 4768 * deviceScale;
    expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.001);
  });
});

describe("PDF preview annotation policy", () => {
  it("allows only absolute web and mail links", () => {
    expect(safePdfPreviewExternalHref("https://example.com/docs")).toBe(
      "https://example.com/docs"
    );
    expect(safePdfPreviewExternalHref("mailto:docs@example.com")).toBe(
      "mailto:docs@example.com"
    );
    for (const blocked of [
      "/relative",
      "javascript:alert(1)",
      "data:text/html,hello",
      "file:///tmp/report.pdf",
      "tel:+49123",
      "not a url",
    ]) {
      expect(safePdfPreviewExternalHref(blocked)).toBeNull();
    }
  });

  it("passes only links to AnnotationLayer and strips every action field", () => {
    expect(
      safePdfPreviewAnnotations([
        {
          id: "internal",
          subtype: "Link",
          dest: "chapter",
          url: "https://attacker.example",
          action: "Launch",
          actions: { U: "JavaScript" },
        },
        {
          id: "external",
          subtype: "Link",
          url: "https://example.com/docs",
          action: "NextPage",
          attachment: { filename: "payload" },
        },
        { id: "named", subtype: "Link", action: "NextPage" },
        { id: "unsafe", subtype: "Link", url: "javascript:alert(1)" },
        { id: "widget", subtype: "Widget", url: "https://example.com" },
      ])
    ).toEqual([
      {
        id: "internal",
        subtype: "Link",
        dest: "chapter",
        url: undefined,
        action: undefined,
        actions: undefined,
        attachment: undefined,
        resetForm: undefined,
        setOCGState: undefined,
      },
      {
        id: "external",
        subtype: "Link",
        url: "https://example.com/docs",
        dest: undefined,
        action: undefined,
        actions: undefined,
        attachment: undefined,
        resetForm: undefined,
        setOCGState: undefined,
      },
    ]);
  });
});

describe("openPdfViewer", () => {
  it("observes the canvas render rejection before annotations finish loading", async () => {
    let finishAnnotations!: (annotations: unknown[]) => void;
    const annotationsPending = new Promise<unknown[]>((resolve) => {
      finishAnnotations = resolve;
    });
    let finishRender!: () => void;
    const renderPending = new Promise<void>((resolve) => {
      finishRender = resolve;
    });
    let rejectionObserverAttached = false;
    const nativeThen = renderPending.then.bind(renderPending);
    renderPending.then = ((onFulfilled, onRejected) => {
      if (typeof onRejected === "function") rejectionObserverAttached = true;
      return nativeThen(onFulfilled, onRejected);
    }) as typeof renderPending.then;

    const { module } = fakePdfjs(1, {
      getAnnotations: async () => annotationsPending,
      renderTask: () => ({ promise: renderPending, cancel: () => undefined }),
    });
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });

    const rendering = viewer.renderPage(1, fakeCanvas(), renderOptions());
    await Promise.resolve();
    expect(rejectionObserverAttached).toBe(true);

    finishAnnotations([]);
    finishRender();
    await rendering;
    await viewer.destroy();
  });

  it("renders only the requested page and clamps out-of-range numbers", async () => {
    const { module, recorded } = fakePdfjs(3);
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });
    expect(viewer.pageCount).toBe(3);
    await viewer.renderPage(2, fakeCanvas(), renderOptions({ devicePixelRatio: 1 }));
    // One page rendered — never the whole document.
    expect(recorded.rendered).toHaveLength(1);
    await viewer.renderPage(99, fakeCanvas(), renderOptions({ devicePixelRatio: 1 }));
    expect(recorded.rendered).toHaveLength(2);
    await viewer.destroy();
    await expect(
      viewer.renderPage(1, fakeCanvas(), renderOptions())
    ).rejects.toThrow(/destroyed/);
  });

  it("delegates internal and external links to PDF.js AnnotationLayer", async () => {
    const { module, recorded } = fakePdfjs(5, {
      annotations: [
        {
          id: "internal",
          subtype: "Link",
          rect: [60, 700, 180, 740],
          dest: "chapter-three",
        },
        {
          id: "external",
          subtype: "Link",
          rect: [240, 600, 360, 640],
          url: "https://example.com/docs",
        },
        { id: "unsafe", subtype: "Link", rect: [0, 0, 10, 10], url: "javascript:alert(1)" },
        { id: "named-action", subtype: "Link", rect: [0, 0, 10, 10], action: "NextPage" },
        { id: "form", subtype: "Widget", rect: [0, 0, 10, 10] },
      ],
      destinations: { "chapter-three": [{ pageIndex: 2 }, { name: "XYZ" }] },
    });
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });

    const annotationLayer = fakeAnnotationHost();
    const navigated: number[] = [];
    const rendered = await viewer.renderPage(
      2,
      fakeCanvas(),
      renderOptions({
        annotationLayer,
        onNavigate: (page) => navigated.push(page),
        devicePixelRatio: 2,
      })
    );

    expect(recorded.annotationRenders).toHaveLength(1);
    expect(recorded.annotationRenders[0]).toMatchObject({
      renderForms: false,
      enableScripting: false,
      hasJSActions: false,
    });
    expect(recorded.annotationRenders[0]!.annotations).toHaveLength(2);

    const internal = annotationLayer.querySelector(
      'section[data-annotation-id="internal"] > a'
    ) as HTMLAnchorElement | null;
    const external = annotationLayer.querySelector(
      'section[data-annotation-id="external"] > a'
    ) as HTMLAnchorElement | null;
    expect(internal).not.toBeNull();
    expect(external?.href).toBe("https://example.com/docs");
    expect(external?.target).toBe("_blank");
    expect(external?.rel).toBe("noopener noreferrer");
    expect(external?.getAttribute("aria-label")).toBe("https://example.com/docs");
    expect(annotationLayer.querySelector('[data-annotation-id="unsafe"]')).toBeNull();
    expect(annotationLayer.querySelector('[data-annotation-id="named-action"]')).toBeNull();
    expect(annotationLayer.querySelector('[data-annotation-id="form"]')).toBeNull();

    internal!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(navigated).toEqual([3]);
    expect(rendered.fit).toBe("width");
  });

  it("replaces stale annotation DOM when another page renders and clears it on destroy", async () => {
    const { module } = fakePdfjs(2, {
      annotationsByPage: {
        1: [{ id: "page-one", subtype: "Link", url: "https://example.com/one" }],
        2: [{ id: "page-two", subtype: "Link", url: "https://example.com/two" }],
      },
    });
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });
    const annotationLayer = fakeAnnotationHost();

    await viewer.renderPage(1, fakeCanvas(), renderOptions({ annotationLayer }));
    expect(annotationLayer.querySelector('[data-annotation-id="page-one"]')).not.toBeNull();
    await viewer.renderPage(2, fakeCanvas(), renderOptions({ annotationLayer }));
    expect(annotationLayer.querySelector('[data-annotation-id="page-one"]')).toBeNull();
    expect(annotationLayer.querySelector('[data-annotation-id="page-two"]')).not.toBeNull();

    await viewer.destroy();
    expect(annotationLayer.childElementCount).toBe(0);
  });

  it("uses the real page orientation when auto-fit is requested", async () => {
    const portrait = fakePdfjs(1, { pageWidth: 600, pageHeight: 800 });
    const portraitViewer = await openPdfViewer(
      pdfBytesFromUint8Array(new Uint8Array([1])),
      { importModule: async () => portrait.module, workerSrc: "w.mjs", getContext: () => ({}) }
    );
    const portraitRender = await portraitViewer.renderPage(1, fakeCanvas(), renderOptions({
      containerWidth: 1200,
      containerHeight: 400,
      fit: "auto",
      devicePixelRatio: 1,
    }));
    expect(portraitRender.fit).toBe("height");
    expect(portrait.recorded.rendered[0]!.scale).toBeCloseTo(0.5);
    await portraitViewer.destroy();
    __resetPdfjsModule();

    const landscape = fakePdfjs(1, { pageWidth: 800, pageHeight: 600 });
    const landscapeViewer = await openPdfViewer(
      pdfBytesFromUint8Array(new Uint8Array([2])),
      { importModule: async () => landscape.module, workerSrc: "w.mjs", getContext: () => ({}) }
    );
    const landscapeRender = await landscapeViewer.renderPage(1, fakeCanvas(), renderOptions({
      containerWidth: 400,
      containerHeight: 1200,
      fit: "auto",
      devicePixelRatio: 1,
    }));
    expect(landscapeRender.fit).toBe("width");
    expect(landscape.recorded.rendered[0]!.scale).toBeCloseTo(0.5);
  });
});

/**
 * The build gate's premise, checked against the dependency itself.
 *
 * The plan expected PDF.js to force a `DYNAMIC_CODE_RES` exemption. Measured
 * against `pdfjs-dist@6.1.200` it does not: v6 replaced the `Function`-based
 * PostScript evaluator with a WebAssembly one. This test is what makes that a
 * *pinned* fact rather than a one-time observation — an upgrade that
 * reintroduces string-to-code turns the decision back into a deliberate one
 * instead of inheriting a pre-granted allowance.
 */
describe("vendored PDF.js — no dynamic-code exemption needed", () => {
  // Bun may hoist a workspace dependency to the repository root without
  // leaving a package-local symlink on a clean CI install. Resolve both legal
  // workspace layouts before inspecting the pinned runtime.
  const extensionBase = join(EXTENSION_ROOT, "node_modules", "pdfjs-dist", "build");
  const workspaceBase = join(EXTENSION_ROOT, "..", "..", "node_modules", "pdfjs-dist", "build");
  const base = existsSync(extensionBase) ? extensionBase : workspaceBase;

  it.each(["pdf.min.mjs", "pdf.worker.min.mjs"])("%s is clean under the unchanged gate", (file) => {
    expect(scanText(readFileSync(join(base, file), "utf8"))).toEqual([]);
  });

  it("does not implement isEvalSupported (the option was removed in v6)", () => {
    // Kept as a forward-compatible belt, and documented as inert. If this ever
    // fails, PDF.js has reintroduced the option and the viewer's flag became
    // load-bearing — re-read `PDFJS_DOCUMENT_OPTIONS` at that point.
    const source = readFileSync(join(base, "pdf.mjs"), "utf8");
    expect(source).not.toContain("isEvalSupported");
  });
});
