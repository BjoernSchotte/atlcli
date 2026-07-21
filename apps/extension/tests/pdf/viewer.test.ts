import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  type PdfjsDocument,
  type PdfjsModule,
  type PdfjsPage,
} from "../../utils/pdf/viewer.js";
import { EXTENSION_ROOT } from "../build-helper.js";

afterEach(() => __resetPdfjsModule());

// ---------------------------------------------------------------------------
// Fake PDF.js
// ---------------------------------------------------------------------------

interface Recorded {
  params: Record<string, unknown>[];
  rendered: { scale: number; canvas: unknown }[];
}

function fakePdfjs(
  pages = 3,
  options: {
    annotations?: unknown[];
    destinations?: Record<string, unknown[]>;
  } = {}
): { module: PdfjsModule; recorded: Recorded } {
  const recorded: Recorded = { params: [], rendered: [] };
  const page: PdfjsPage = {
    getViewport: ({ scale }) => ({
      width: 600 * scale,
      height: 800 * scale,
      // PDF coordinates start at the bottom-left; viewport coordinates start
      // at the top-left. Keeping that flip in the fake makes the link geometry
      // assertion discriminate between PDF points and CSS pixels.
      convertToViewportPoint: (x, y) => [x * scale, (800 - y) * scale],
    }),
    getAnnotations: async () => options.annotations ?? [],
    render: ({ viewport, canvas }) => {
      recorded.rendered.push({ scale: viewport.width / 600, canvas });
      return { promise: Promise.resolve(), cancel: () => undefined };
    },
  };
  const document: PdfjsDocument = {
    numPages: pages,
    getPage: async () => page,
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
    getDocument: (params) => {
      recorded.params.push(params);
      return { promise: Promise.resolve(document), destroy: async () => undefined };
    },
  };
  return { module, recorded };
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
    expect(source).toContain('"pdfjs-dist/build/pdf.min.mjs?url&no-inline"');
    expect(source).toContain('"pdfjs-dist/build/pdf.worker.min.mjs?url&no-inline"');
    expect(source).not.toMatch(/https?:\/\//);
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
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: 1,
    });
    expect(cssScale).toBeCloseTo(0.5);
  });

  it("applies zoom on top of fit-width", () => {
    const { cssScale } = computeRenderScale({
      containerWidth: 300,
      pageWidth: 600,
      pageHeight: 800,
      zoom: 2,
      devicePixelRatio: 1,
    });
    expect(cssScale).toBeCloseTo(1);
  });

  it("caps the device-pixel-ratio contribution", () => {
    const capped = computeRenderScale({
      containerWidth: 300,
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: 4,
    });
    const atCap = computeRenderScale({
      containerWidth: 300,
      pageWidth: 600,
      pageHeight: 800,
      devicePixelRatio: MAX_DEVICE_PIXEL_RATIO,
    });
    expect(capped.deviceScale).toBeCloseTo(atCap.deviceScale);
  });

  it("caps total canvas area for a poster-sized page", () => {
    const { deviceScale } = computeRenderScale({
      containerWidth: 4000,
      pageWidth: 3370,
      pageHeight: 4768,
      devicePixelRatio: 2,
    });
    const pixels = 3370 * deviceScale * 4768 * deviceScale;
    expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS * 1.001);
  });
});

describe("openPdfViewer", () => {
  it("renders only the requested page and clamps out-of-range numbers", async () => {
    const { module, recorded } = fakePdfjs(3);
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });
    expect(viewer.pageCount).toBe(3);
    await viewer.renderPage(2, fakeCanvas(), { containerWidth: 300, devicePixelRatio: 1 });
    // One page rendered — never the whole document.
    expect(recorded.rendered).toHaveLength(1);
    await viewer.renderPage(99, fakeCanvas(), { containerWidth: 300, devicePixelRatio: 1 });
    expect(recorded.rendered).toHaveLength(2);
    await viewer.destroy();
    await expect(viewer.renderPage(1, fakeCanvas(), { containerWidth: 300 })).rejects.toThrow(
      /destroyed/
    );
  });

  it("projects internal PDF links into CSS pixels and resolves their target pages", async () => {
    const { module } = fakePdfjs(5, {
      annotations: [
        {
          subtype: "Link",
          rect: [60, 700, 180, 740],
          dest: "chapter-three",
        },
        {
          subtype: "Link",
          rect: [240, 600, 360, 640],
          dest: [1, { name: "XYZ" }],
        },
        // External links and malformed internal destinations are deliberately
        // inert in the reduced preview surface.
        { subtype: "Link", rect: [0, 0, 10, 10], url: "https://example.com" },
        { subtype: "Link", rect: [0, 0, 10, 10], dest: "missing" },
        { subtype: "Link", rect: [0, 0, 10, 10], dest: [99, { name: "XYZ" }] },
        { subtype: "Link", rect: [0, 0, 0, 10], dest: [1, { name: "XYZ" }] },
      ],
      destinations: { "chapter-three": [{ pageIndex: 2 }, { name: "XYZ" }] },
    });
    const viewer = await openPdfViewer(pdfBytesFromUint8Array(new Uint8Array([1])), {
      importModule: async () => module,
      workerSrc: "w.mjs",
      getContext: () => ({}),
    });

    const rendered = await viewer.renderPage(2, fakeCanvas(), {
      containerWidth: 300,
      devicePixelRatio: 2,
    });

    // Fit width is 0.5 CSS px per PDF point. The backing canvas renders at
    // deviceScale 1 here, but the hotspots MUST stay in CSS pixels.
    expect(rendered.internalLinks).toEqual([
      { pageNumber: 3, left: 30, top: 30, width: 60, height: 20 },
      { pageNumber: 2, left: 120, top: 80, width: 60, height: 20 },
    ]);
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
  const base = join(EXTENSION_ROOT, "node_modules", "pdfjs-dist", "build");

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
