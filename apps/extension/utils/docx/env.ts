/**
 * Browser implementations of the `@atlcli/docx` export-env interfaces
 * (spec 006 Task 3). The engine is isomorphic; these thin adapters are the
 * extension's imperative shell: template bytes come from the IndexedDB store,
 * asset bytes ride the user's Atlassian session cookies, and the finished
 * document leaves through a browser download. Neutral memory/canvas support
 * comes from `@atlcli/docx/browser-runtime`; session, storage, cache, download,
 * and report policy remain here with the extension host.
 */
import type {
  AssetFetcher,
  AssetRef,
  OutputSink,
  SvgRasterizer,
  TemplateSource,
} from "@atlcli/docx/browser";
import {
  canvasSvgRasterizer as neutralCanvasSvgRasterizer,
  memoryTemplateSource,
} from "@atlcli/docx/browser-runtime";
import { LEGACY_CURRENT_KEY, type TemplateEngine } from "./template-store.js";
import { idbTemplateLibrary } from "../templates/library.js";
import { downloadBytes } from "../download.js";

export { memoryTemplateSource };

/** Optional context for {@link idbTemplateSource}. */
export interface IdbTemplateSourceOptions {
  /** Ambient Atlassian session origin — isolates two sites sharing a space key. */
  siteOrigin?: string;
  /** Current space; a space-scoped override beats the global entry of the same id. */
  spaceKey?: string;
  /** Defaults to `"docx"` (the only engine whose bytes this library swaps for v1). */
  engine?: TemplateEngine;
}

/**
 * {@link TemplateSource} over the panel's IndexedDB template **library**
 * (spec 010 T5.2). The `id` is the logical `templateId`; resolution runs through
 * the shared `resolveTemplate` (space-scoped entry beats global) and the bytes
 * are sha256-verified before they are handed to the engine — a modified
 * template is a hard error, never a silent fallback.
 *
 * For continuity with the pre-library single-slot panel, an empty id (or the
 * retired `"current"` slot name) means "whatever is active": the
 * `template-prefs` selection, or — when nothing was ever selected, which is the
 * state right after the v1 → v2 migration — the sole entry if there is exactly
 * one. Rejects when nothing is stored; the panel gates Export on a loaded
 * template, so this firing means it was deleted underneath the panel.
 */
export function idbTemplateSource(
  factory?: IDBFactory,
  options: IdbTemplateSourceOptions = {}
): TemplateSource {
  const engine = options.engine ?? "docx";
  const { siteOrigin, spaceKey } = options;
  return {
    async getBytes(id: string): Promise<Uint8Array> {
      const library = idbTemplateLibrary({ factory, siteOrigin });
      let templateId: string | undefined = id && id !== LEGACY_CURRENT_KEY ? id : undefined;
      if (!templateId) {
        templateId = await library.getActiveTemplateId(engine, spaceKey);
      }
      if (!templateId) {
        const available = await library.list(engine, spaceKey);
        if (available.length === 1) templateId = available[0].id;
      }
      if (!templateId) {
        throw new Error("No template selected. Upload a template first.");
      }
      const entry = await library.resolve(templateId, engine, spaceKey);
      if (!entry) {
        throw new Error(
          `No ${engine} template "${templateId}" in the library. Upload a template first.`
        );
      }
      return library.getBytes(entry);
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

export function canvasSvgRasterizer(doc: Document = document, decodeTimeoutMs = 10_000): SvgRasterizer {
  return neutralCanvasSvgRasterizer({
    document: doc,
    decodeTimeoutMs,
    onTiming(timing) {
      rasterizerStats.decodeMs += timing.decodeMs;
      rasterizerStats.drawMs += timing.drawMs;
      rasterizerStats.encodeMs += timing.encodeMs;
      rasterizerStats.encodeCallsMs.push(timing.encodeMs);
      rasterizerStats.calls += 1;
    },
  });
}

/**
 * {@link OutputSink} that hands the bytes to the browser as a `.docx`
 * download via a temporary object URL on an invisible anchor.
 */
export function downloadOutputSink(doc: Document = document): OutputSink {
  return {
    async emit(name: string, bytes: Uint8Array): Promise<void> {
      await downloadBytes({
        name,
        bytes,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        document: doc,
      });
    },
  };
}
