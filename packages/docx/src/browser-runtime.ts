/**
 * Browser-host support for the DOCX engine (spec 009).
 *
 * This deliberately lives behind its own package subpath: importing the
 * normal browser or Node barrel must not install globals or pull DOM policy
 * into hosts that do not need it.
 */
import { installJavaScriptHighlightEngine } from "@atlcli/code-highlight/engine/javascript";
import type { CodeThemeId } from "@atlcli/code-highlight/registry";
import type { ExportBlock } from "@atlcli/confluence";
import {
  installDocxBrowserByteRuntime,
  type DocxByteHelpers,
} from "./browser-runtime-bootstrap.js";
import type { SvgRasterizer, TemplateSource } from "./env.js";

export type { DocxByteHelpers } from "./browser-runtime-bootstrap.js";
export {
  prepareDocxExportRuntime,
  type DocxExportRuntimePreparation,
  type PrepareDocxExportRuntimeOptions,
} from "./runtime-preparation.js";

/** Install the namespaced byte helpers once without defining a fake Buffer. */
export function installDocxBrowserRuntime(): void {
  // Bun/Node unit tests import this adapter to exercise its neutral helpers in
  // the same process as Node entry tests. Only an actual browser document owns
  // the browser engine choice; production iframe/offscreen/harness realms all
  // expose `document`.
  if (typeof document !== "undefined") installJavaScriptHighlightEngine();
  installDocxBrowserByteRuntime();
}

// Deliberate side effect: browser entries import this subpath before importing
// PizZip/docxtemplater through @atlcli/docx/browser.
installDocxBrowserRuntime();

/**
 * Load only grammars used by the supplied DOCX blocks. The implementation is
 * dynamically imported so merely bootstrapping a browser realm does not load
 * the Shiki catalogue or engine chunk before explicit DOCX intent.
 */
export async function prepareDocxCodeHighlighting(
  blocks: readonly ExportBlock[],
  options: { codeTheme?: CodeThemeId } = {},
): Promise<void> {
  const highlighting = await import("./code-highlighting.js");
  await highlighting.prepareDocxCodeHighlighting(blocks, options);
}

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
