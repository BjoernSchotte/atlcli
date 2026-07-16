/**
 * Browser implementations of the `@atlcli/docx` export-env interfaces
 * (spec 006 Task 3). The engine is isomorphic; these thin adapters are the
 * extension's imperative shell: template bytes come from the IndexedDB store,
 * asset bytes ride the user's Atlassian session cookies, and the finished
 * document leaves through a browser download. No engine code touches
 * `chrome.*` / DOM — it all lives here, next to the host that owns it.
 */
import type {
  AssetFetcher,
  AssetRef,
  OutputSink,
  SvgRasterizer,
  TemplateSource,
} from "@atlcli/docx/browser";
import { getTemplate } from "./template-store.js";

/**
 * {@link TemplateSource} over the panel's IndexedDB template store. The id is
 * the store slot (the panel uses the single `"current"` slot). Rejects when
 * nothing is stored — the caller (panel) gates Export on a loaded template,
 * so this firing means the template was deleted underneath the panel.
 */
export function idbTemplateSource(factory?: IDBFactory): TemplateSource {
  return {
    async getBytes(id: string): Promise<Uint8Array> {
      const stored = await getTemplate(id, factory);
      if (!stored) throw new Error(`No template stored under id "${id}". Upload a template first.`);
      return new Uint8Array(stored.bytes);
    },
  };
}

/**
 * {@link AssetFetcher} over the page's own session: attachment downloads are
 * plain GETs that succeed because the browser attaches the Atlassian cookies
 * (`credentials: "include"`). Drives image embedding (spec 005).
 *
 * The engine hands attachment refs as WIKI-BASE-RELATIVE download paths
 * (`/download/attachments/…`); the panel runs on the extension origin, so a
 * relative fetch would resolve against `chrome-extension://` — `baseUrl`
 * (the site's Confluence root, e.g. `https://x.atlassian.net/wiki`) is
 * prefixed to make them absolute. External image URLs pass through as-is.
 */
export function sessionAssetFetcher(baseUrl?: string, fetchFn: typeof fetch = fetch): AssetFetcher {
  return {
    async fetch(ref: AssetRef): Promise<Uint8Array> {
      const url = /^https?:\/\//i.test(ref.url) ? ref.url : `${baseUrl ?? ""}${ref.url}`;
      const res = await fetchFn(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Asset fetch failed (${res.status}) for ${ref.filename ?? ref.url}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * {@link SvgRasterizer} over the panel's real document (spec 005a §2.4,
 * option 1): the rendered diagram SVG becomes an `<img src="blob:…">`, is
 * drawn onto a `<canvas>` at the requested target size (the engine asks for
 * 2× the intrinsic size), and encoded to PNG via `canvas.toBlob`. The SVG is
 * self-contained (beautiful-mermaid output, external font import stripped by
 * the engine), so the blob image decodes without network and the canvas
 * stays untainted. Any failure throws — the engine then routes the diagram
 * to the readable code-block fallback; a decode that never settles is cut off
 * by `decodeTimeoutMs` so one broken diagram can't freeze the whole export.
 */
export function canvasSvgRasterizer(doc: Document = document, decodeTimeoutMs = 10_000): SvgRasterizer {
  return {
    async rasterize(svg, { widthPx, heightPx }): Promise<Uint8Array> {
      // Image/Blob/URL come from the document's own window so the rasterizer
      // works against any real DOM handed in (panel window, happy-dom tests).
      const view = (doc.defaultView ?? globalThis) as Window & typeof globalThis;
      const url = view.URL.createObjectURL(new view.Blob([svg], { type: "image/svg+xml" }));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
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
        const canvas = doc.createElement("canvas");
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d canvas context available");
        ctx.drawImage(img, 0, 0, widthPx, heightPx);
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))),
            "image/png"
          )
        );
        return new Uint8Array(await blob.arrayBuffer());
      } finally {
        clearTimeout(timer);
        view.URL.revokeObjectURL(url);
      }
    },
  };
}

/**
 * {@link OutputSink} that hands the bytes to the browser as a `.docx`
 * download via a temporary object URL on an invisible anchor.
 */
export function downloadOutputSink(doc: Document = document): OutputSink {
  return {
    async emit(name: string, bytes: Uint8Array): Promise<void> {
      const blob = new Blob([bytes as BlobPart], {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement("a");
      a.href = url;
      a.download = name;
      doc.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };
}
