/**
 * Browser implementations of the `@atlcli/docx` export-env interfaces
 * (spec 006 Task 3). The engine is isomorphic; these thin adapters are the
 * extension's imperative shell: template bytes come from the IndexedDB store,
 * asset bytes ride the user's Atlassian session cookies, and the finished
 * document leaves through a browser download. Neutral memory/canvas support
 * comes from `@atlcli/docx/browser-entry`; session, storage, cache, download,
 * and report policy remain here with the extension host.
 */
import type {
  AssetFetcher,
  AssetRef,
  OutputSink,
  SvgRasterizer,
  TemplateSource,
} from "@atlcli/docx/browser-entry";
import {
  canvasSvgRasterizer as neutralCanvasSvgRasterizer,
  memoryTemplateSource,
} from "@atlcli/docx/browser-entry";
import type { ExternalAssetFetcher, ExternalAssetPolicy } from "@atlcli/export-macros";
import { trustRoutingAssetFetcher } from "@atlcli/export-wiring";
import {
  createExternalAssetFetcher,
  extensionPageAssetFetcher,
  extensionAssetPolicyFromPageUrl,
} from "../macros/external-asset-policy.js";
import {
  SessionRedirectBlockedError,
  createAtlassianSessionRedirectPolicy,
  fetchSessionBinaryFollowingRedirects,
  type SessionRedirectPolicy,
} from "@atlcli/core/internal";
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
 *
 * Redirects are classified by DESTINATION through the shared session policy
 * (`@atlcli/core/internal`), the same one `ConfluenceClient.requestBinary` uses
 * (spec 010 wave 2). Before that, a plain `fetch(url, { credentials: "include" })`
 * followed anything: an expired session bounced to the login host, the HTML
 * login page came back `ok`, and its bytes were embedded into the export as
 * image data — and cached under a version-stamped key, so the poison persisted
 * for the rest of the panel session.
 */
/**
 * Panel-lifetime cache for IMMUTABLE asset bytes: version-stamped
 * `/download/attachments/…` URLs (the space logo's icon path carries
 * `version=…&modificationDate=…`) never change under their key — a replaced
 * logo gets a new stamp — so repeat exports skip those round-trips entirely.
 * Bounded so a long panel session can't hoard megabytes.
 *
 * Cache-poisoning invariant: the only write is AFTER the redirect follower has
 * returned an allowlisted, non-redirect, `ok` response. A login bounce or a
 * blocked destination throws out of {@link sessionAssetFetcher}'s `fetch`
 * before the write is reached, so login-page HTML can never take up residence
 * under an attachment's key and outlive the expired session.
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

/**
 * The one place this module spells the session-expiry message for an asset
 * download — the wording is load-bearing, not cosmetic.
 *
 * `apps/extension/utils/read-path.ts` (`classifyThrownError`) and
 * `apps/extension/utils/macros/session-ports.ts` both latch "the Atlassian
 * session is gone" by matching `authentication redirect` (among a few other
 * phrases) against a thrown message. Without that phrase a login bounce would
 * classify as a generic asset failure and the user would get a silently broken
 * image instead of "your session expired, sign in again". The phrasing is
 * deliberately the same one `ConfluenceClient` uses so both asset paths read
 * identically to the panel.
 */
function assetAuthRedirectError(status: number, ref: AssetRef): Error {
  return new Error(
    `Asset fetch failed (${status}) for ${ref.filename ?? ref.url}: ` +
      `authentication redirect to Atlassian login (session not logged in)`
  );
}

/**
 * Destination allowlist for one asset request.
 *
 * `siteOrigin` is the panel's Confluence root — `getConfluenceBaseUrl(profile)`
 * for the docx port, `<profile.baseUrl>/wiki` for the PDF port — i.e. the very
 * base the relative `/download/attachments/…` refs are resolved against, so the
 * origin that is allowed is by construction the origin the attachment came from.
 *
 * The request's OWN origin is vouched for as well: an absolute external image
 * URL (which passes through untouched, and never was a session-authenticated
 * fetch) must keep following its own host's internal redirects exactly as
 * before. For a site attachment this adds nothing — the two origins coincide.
 * Everything else is refused, and the Atlassian media CDN is allowed by the
 * shared policy because that is how Cloud actually delivers attachment bytes.
 */
function assetRedirectPolicy(canonicalBaseUrl: string, requestUrl: string): SessionRedirectPolicy {
  let ownOrigin = "";
  try {
    ownOrigin = new URL(requestUrl).origin;
  } catch {
    // Unparseable request URL: nothing extra to vouch for; the site origin and
    // the media CDN still apply.
  }
  return createAtlassianSessionRedirectPolicy({
    siteOrigin: canonicalBaseUrl,
    allowedOrigins: ownOrigin === "" ? [] : [ownOrigin],
  });
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
      // `redirect: "manual"` hands the 3xx back to the follower instead of
      // letting the runtime chase it blindly; the follower classifies the
      // DESTINATION and only then re-issues. This is what stops an expired
      // session's HTML login page from being embedded as image bytes.
      const res = await fetchSessionBinaryFollowingRedirects(
        url,
        { credentials: "include", redirect: "manual" },
        assetRedirectPolicy(canonicalBaseUrl, url),
        {
          fetchFn: (input, init) => fetchFn(input, init),
          loginRedirectError: (status) => assetAuthRedirectError(status, ref),
          // A refused third-party hop is NOT a session expiry: this message
          // deliberately avoids the phrases the panel latches expiry on.
          blockedRedirectError: (target, reason) =>
            new SessionRedirectBlockedError("Asset fetch", target, reason),
        }
      );
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

export interface SessionDocxAssetsOptions {
  /** The site's Confluence root (`https://x.atlassian.net/wiki`). */
  baseUrl?: string;
  /** The active tab's URL — the origin the external-asset policy is built on. */
  pageUrl: string;
  /** Replaces the session fetch; the manifest guard and trust router are composed around it. */
  inner?: AssetFetcher;
  /** Defaults to the extension's manifest-scoped origin allowlist. */
  policy?: ExternalAssetPolicy;
  /** Defaults to the shared enforced fetcher over {@link policy}. */
  external?: ExternalAssetFetcher;
  fetchFn?: typeof fetch;
}

/**
 * The fetcher the DOCX export env actually gets: {@link sessionAssetFetcher}
 * with the manifest-origin guard and spec-004 trust router composed around it.
 *
 * **Every `ExportEnv.assets` this host builds goes through here** — the exact
 * counterpart of `extensionPdfAssets` in `utils/pdf/run-export.ts`, and for the
 * exact same reason. Before spec 010 wave 3 this path fetched **any** absolute
 * URL with `credentials: "include"`, and the panel is about to start resolving
 * macros: an `<img>` pointing at the cloud metadata service, emitted by a
 * app's `export_view` HTML would otherwise have been fetched from inside the
 * user's authenticated browser session. The router sends exactly those
 * (`trust: "export-view"`) through the policy-checked, redirect-re-checked,
 * byte-capped, `credentials: "omit"` fetcher. Page-author refs keep the
 * session path when their origin is covered by the extension manifest; other
 * absolute origins are rejected before Chrome can emit a CORS request. PDF
 * applies the same host-specific guard, so both engines degrade identically.
 */
export function sessionDocxAssets(options: SessionDocxAssetsOptions): AssetFetcher {
  const policy = options.policy ?? extensionAssetPolicyFromPageUrl(options.pageUrl);
  const external = options.external ?? createExternalAssetFetcher(policy);
  const session =
    options.inner ?? sessionAssetFetcher(options.baseUrl, options.fetchFn ?? fetch);
  const inner = extensionPageAssetFetcher(session, policy);
  return trustRoutingAssetFetcher(inner, external);
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
