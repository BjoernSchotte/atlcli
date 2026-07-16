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

/** Template source over bytes the panel already has in memory. */
export function memoryTemplateSource(bytes: ArrayBuffer): TemplateSource {
  return {
    async getBytes(): Promise<Uint8Array> {
      return new Uint8Array(bytes);
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
/**
 * Panel-lifetime cache for IMMUTABLE asset bytes: version-stamped
 * `/download/attachments/…` URLs (the space logo's icon path carries
 * `version=…&modificationDate=…`) never change under their key — a replaced
 * logo gets a new stamp — so repeat exports skip those round-trips entirely.
 * Bounded so a long panel session can't hoard megabytes.
 */
const versionedAssetCache = new Map<string, Uint8Array>();
const VERSIONED_CACHE_MAX_ENTRIES = 32;

function isVersionedAssetUrl(refUrl: string): boolean {
  return refUrl.startsWith("/download/") && /[?&](version|modificationDate)=/.test(refUrl);
}

function canonicalAssetBaseUrl(baseUrl?: string): string {
  if (!baseUrl) return "";
  try {
    const url = new URL(baseUrl);
    return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
  } catch {
    return baseUrl.replace(/\/+$/, "");
  }
}

export function sessionAssetFetcher(baseUrl?: string, fetchFn: typeof fetch = fetch): AssetFetcher {
  const canonicalBaseUrl = canonicalAssetBaseUrl(baseUrl);
  return {
    async fetch(ref: AssetRef): Promise<Uint8Array> {
      const cacheable = isVersionedAssetUrl(ref.url);
      const cacheKey = `${canonicalBaseUrl}\n${ref.url}`;
      const cached = cacheable ? versionedAssetCache.get(cacheKey) : undefined;
      if (cached) return cached;
      const url = /^https?:\/\//i.test(ref.url) ? ref.url : `${canonicalBaseUrl}${ref.url}`;
      const res = await fetchFn(url, { credentials: "include" });
      if (!res.ok) {
        throw new Error(`Asset fetch failed (${res.status}) for ${ref.filename ?? ref.url}`);
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (cacheable && bytes.byteLength > 0) {
        if (versionedAssetCache.size >= VERSIONED_CACHE_MAX_ENTRIES) {
          // Map iterates in insertion order — drop the oldest entry.
          const oldest = versionedAssetCache.keys().next().value;
          if (oldest !== undefined) versionedAssetCache.delete(oldest);
        }
        versionedAssetCache.set(cacheKey, bytes);
      }
      return bytes;
    },
  };
}

/**
 * {@link SvgRasterizer} over the panel's real document (spec 005a §2.4,
 * option 1): the rendered diagram SVG becomes an `<img src="blob:…">`, is
 * drawn onto a `<canvas>` at the requested target size (the engine asks for
 * 2× the intrinsic size), and encoded to PNG via `canvas.toDataURL`. In real
 * side-panel E2E runs, the asynchronous `toBlob` callback path incurred
 * repeated ~1-second scheduling delays; synchronous encoding avoids that task
 * runner while preparation remains strictly serial.
 * The SVG is
 * self-contained (beautiful-mermaid output, external font import stripped by
 * the engine), so the blob image decodes without network and the canvas
 * stays untainted. Any failure throws — the engine then routes the diagram
 * to the readable code-block fallback; a decode that never settles is cut off
 * by `decodeTimeoutMs` so one broken diagram can't freeze the whole export.
 */
/**
 * Sub-phase timing sums of every {@link canvasSvgRasterizer} call since the
 * last {@link resetRasterizerStats} — the panel appends them to the export
 * report so a slow rasterizer names its slow sub-step (decode vs draw vs
 * encode) without devtools.
 */
export interface RasterizerStats {
  calls: number;
  decodeMs: number;
  drawMs: number;
  encodeMs: number;
  encodeCallsMs: number[];
}

const rasterizerStats: RasterizerStats = {
  calls: 0,
  decodeMs: 0,
  drawMs: 0,
  encodeMs: 0,
  encodeCallsMs: [],
};

export function resetRasterizerStats(): void {
  rasterizerStats.calls = 0;
  rasterizerStats.decodeMs = 0;
  rasterizerStats.drawMs = 0;
  rasterizerStats.encodeMs = 0;
  rasterizerStats.encodeCallsMs.length = 0;
}

export function getRasterizerStats(): RasterizerStats {
  return { ...rasterizerStats, encodeCallsMs: [...rasterizerStats.encodeCallsMs] };
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

export function canvasSvgRasterizer(doc: Document = document, decodeTimeoutMs = 10_000): SvgRasterizer {
  return {
    async rasterize(svg, { widthPx, heightPx }): Promise<Uint8Array> {
      // Image/Blob/URL come from the document's own window so the rasterizer
      // works against any real DOM handed in (panel window, happy-dom tests).
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
        rasterizerStats.decodeMs += Date.now() - decodeStart;
        const drawStart = Date.now();
        const canvas = doc.createElement("canvas");
        canvas.width = widthPx;
        canvas.height = heightPx;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("no 2d canvas context available");
        ctx.drawImage(img, 0, 0, widthPx, heightPx);
        rasterizerStats.drawMs += Date.now() - drawStart;
        const encodeStart = Date.now();
        const bytes = pngDataUrlBytes(canvas.toDataURL("image/png"), view);
        const encodeMs = Date.now() - encodeStart;
        rasterizerStats.encodeMs += encodeMs;
        rasterizerStats.encodeCallsMs.push(encodeMs);
        rasterizerStats.calls += 1;
        return bytes;
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
