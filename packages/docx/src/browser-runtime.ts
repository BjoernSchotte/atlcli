/**
 * Browser-host support for the DOCX engine (spec 009).
 *
 * This deliberately lives behind its own package subpath: importing the
 * normal browser or Node barrel must not install globals or pull DOM policy
 * into hosts that do not need it.
 */
import type { SvgRasterizer, TemplateSource } from "./env.js";

export interface DocxByteHelpers {
  from(value: ArrayLike<number> | ArrayBuffer | string, encoding?: string): Uint8Array;
  alloc(size: number): Uint8Array;
  isBuffer(value: unknown): boolean;
}

const helpers: DocxByteHelpers = {
  from(value, _encoding) {
    // Preserve the extension shim's existing behavior: strings are UTF-8 and
    // byte-like values are copied through Uint8Array's native constructors.
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(value as ArrayLike<number>);
  },
  alloc(size) {
    return new Uint8Array(size);
  },
  isBuffer() {
    // Browser hosts never produce Node Buffers. This keeps PizZip and
    // docxtemplater on their Uint8Array branches.
    return false;
  },
};

type DocxBrowserGlobal = typeof globalThis & {
  __atlDocxByteHelpers?: DocxByteHelpers;
};

/** Install the namespaced byte helpers once without defining a fake Buffer. */
export function installDocxBrowserRuntime(): void {
  const scope = globalThis as DocxBrowserGlobal;
  scope.__atlDocxByteHelpers ??= helpers;
}

// Deliberate side effect: browser entries import this subpath before importing
// PizZip/docxtemplater through @atlcli/docx/browser.
installDocxBrowserRuntime();

/**
 * A template source that owns an immutable snapshot of the supplied view.
 * Each read returns another copy so neither caller nor consumer mutation can
 * change a later export.
 */
export function memoryTemplateSource(bytes: ArrayBuffer | Uint8Array): TemplateSource {
  const snapshot = bytes instanceof Uint8Array ? bytes.slice() : new Uint8Array(bytes).slice();
  return {
    async getBytes(): Promise<Uint8Array> {
      return snapshot.slice();
    },
  };
}

export interface CanvasRasterizerTiming {
  decodeMs: number;
  drawMs: number;
  encodeMs: number;
}

export interface CanvasSvgRasterizerOptions {
  document?: Document;
  decodeTimeoutMs?: number;
  onTiming?: (timing: CanvasRasterizerTiming) => void;
}

function pngDataUrlBytes(dataUrl: string, view: Window & typeof globalThis): Uint8Array {
  const marker = ";base64,";
  const offset = dataUrl.indexOf(marker);
  if (!dataUrl.startsWith("data:image/png") || offset === -1) {
    throw new Error("PNG encoding failed");
  }
  const binary = view.atob(dataUrl.slice(offset + marker.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Neutral DOM/canvas implementation of the DOCX SVG rasterizer port. */
export function canvasSvgRasterizer(options: CanvasSvgRasterizerOptions = {}): SvgRasterizer {
  return {
    async rasterize(svg, { widthPx, heightPx }): Promise<Uint8Array> {
      const doc = options.document ?? globalThis.document;
      if (!doc) throw new Error("canvas SVG rasterization requires a document");
      const decodeTimeoutMs = options.decodeTimeoutMs ?? 10_000;
      const view = (doc.defaultView ?? globalThis) as Window & typeof globalThis;
      const url = view.URL.createObjectURL(new view.Blob([svg], { type: "image/svg+xml" }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const decodeStart = Date.now();
        const img = new view.Image();
        await new Promise<void>((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`the diagram SVG did not decode within ${decodeTimeoutMs} ms`)),
            decodeTimeoutMs
          );
          img.onload = () => resolve();
          img.onerror = () => reject(new Error("the diagram SVG could not be decoded"));
          img.src = url;
        });
        const decodeMs = Date.now() - decodeStart;

        const drawStart = Date.now();
        const canvas = doc.createElement("canvas");
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d canvas context available");
        ctx.drawImage(img, 0, 0, widthPx, heightPx);
        const drawMs = Date.now() - drawStart;

        const encodeStart = Date.now();
        const bytes = pngDataUrlBytes(canvas.toDataURL("image/png"), view);
        const encodeMs = Date.now() - encodeStart;
        options.onTiming?.({ decodeMs, drawMs, encodeMs });
        return bytes;
      } finally {
        clearTimeout(timer);
        view.URL.revokeObjectURL(url);
      }
    },
  };
}
