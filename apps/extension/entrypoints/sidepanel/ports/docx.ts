/**
 * Chrome adapters for the DOCX seams (spec 010 Phase 0).
 *
 * This file is the whole of what used to be `TemplateSection.tsx`'s effect
 * half: the IndexedDB template library, the session-authenticated dependency
 * round-trips, the engine's env adapters, and the lazy chunk loading. None of
 * it is new logic — it moved out of the component so the component could
 * become a port consumer.
 *
 * **Single-slot on purpose.** W1-C's store underneath is the multi-slot library
 * (T5.2), but Phase 0 keeps exactly today's behaviour: one template, replaced
 * in place. `put()` therefore reuses the current entry's *logical* `templateId`
 * so `buildRecordKey` produces the same row and the upload overwrites it —
 * rather than deleting rows (destructive) or minting a new one every upload
 * (accumulating a library the panel has no UI for). The library UI is wave-2
 * work and replaces this adapter's `get`/`put`/`remove`, not the port.
 */
import { ConfluenceClient } from "@atlcli/confluence/browser";
import { getConfluenceBaseUrl } from "@atlcli/core";
import type { ScanResult } from "@atlcli/docx/scan";
import { profileFromTabUrl } from "../../../utils/profile.js";
import { sessionCache } from "../../../utils/docx/session-cache.js";
import {
  prepareExportDeps,
  resolveDocxExportScope,
} from "../../../utils/docx/export-deps.js";
import { buildSessionMacroResolutionOptions } from "../../../utils/macros/session-ports.js";
import { idbTemplateLibrary, type IdbTemplateLibrary, type StoredTemplateEntry } from "../../../utils/templates/library.js";
import { rasterizerTimingNote } from "../../../components/export/docx-template.js";
import type { DocxExportPort, DocxTemplateStore } from "../../../utils/ports/export.js";
import type { SiteContext } from "./site-context.js";

// PizZip + docxtemplater (+ the OOXML serializer and, transitively, lazy Shiki)
// are heavy and only needed once the user opts into template upload/export.
// The scan import stays a deep path so uploading a template fetches only the
// light scan chunk, not the whole engine.
const loadScan = () => import("@atlcli/docx/scan");
const loadExport = () => import("@atlcli/docx/browser");
const loadEnv = () => import("../../../utils/docx/env.js");

/**
 * Panel-lifetime TTL cache for the space + icon round-trip, keyed by site +
 * space so multi-site tabs never bleed into each other. Exporting three pages
 * of one space previously paid the ~100 ms call three times. Current user,
 * homepage storage, details and owner are deliberately NOT cached: they can
 * change under the same key with no safe invalidation signal.
 */
const DEPS_CACHE_TTL_MS = 5 * 60_000;
const spaceInfoCache =
  sessionCache<Awaited<ReturnType<ConfluenceClient["getSpaceWithIcon"]>>>(DEPS_CACHE_TTL_MS);

function siteOriginOf(site: SiteContext): string | undefined {
  const profile = site.url ? profileFromTabUrl(site.url) : null;
  return profile ? profile.baseUrl : undefined;
}

/** The entry the single-slot panel considers "the" template. */
async function currentEntry(library: IdbTemplateLibrary): Promise<StoredTemplateEntry | null> {
  const entries = await library.listAll("docx");
  if (entries.length === 0) return null;
  const activeId = await library.getActiveTemplateId("docx");
  const active = activeId ? entries.find((entry) => entry.id === activeId) : undefined;
  // Mirrors `idbTemplateSource`'s continuity rule: the active selection, or —
  // when nothing was ever selected (the state right after the v1 → v2
  // migration) — the sole entry.
  return active ?? (entries.length === 1 ? entries[0]! : null);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

export function chromeDocxTemplateStore(site: SiteContext): DocxTemplateStore {
  const library = (): IdbTemplateLibrary =>
    idbTemplateLibrary({ siteOrigin: siteOriginOf(site) });

  return {
    async get() {
      const lib = library();
      const entry = await currentEntry(lib);
      if (!entry) return null;
      return {
        name: entry.fileName,
        uploadedAt: Date.parse(entry.uploadedAt),
        bytes: toArrayBuffer(await lib.getBytes(entry)),
        recordKey: entry.recordKey,
        sha256: entry.sha256,
      };
    },

    async put({ name, bytes }) {
      const lib = library();
      const previous = await currentEntry(lib);
      const entry = await lib.add({
        name,
        bytes,
        // Reusing the logical id makes this an in-place replace (same
        // `recordKey`), which is what "upload / replace" meant before the
        // library existed.
        ...(previous ? { templateId: previous.id } : {}),
      });
      await lib.setActiveTemplateId("docx", undefined, entry.id);
      return {
        name: entry.fileName,
        uploadedAt: Date.parse(entry.uploadedAt),
        bytes,
        recordKey: entry.recordKey,
        sha256: entry.sha256,
      };
    },

    async remove() {
      const lib = library();
      const entry = await currentEntry(lib);
      if (entry) await lib.remove(entry.recordKey);
      await lib.setActiveTemplateId("docx", undefined, undefined);
    },
  };
}

export function chromeDocxExportPort(): DocxExportPort {
  return {
    async scan(bytes): Promise<ScanResult> {
      const { scanTemplate } = await loadScan();
      return scanTemplate(bytes);
    },

    warm() {
      void Promise.all([loadExport(), loadEnv()]).catch(() => {
        // Pure warm-up: the export path retries its own imports.
      });
    },

    async run({ page, pageUrl, template, signal, scope, labels, resolveMacros, onProgress }) {
      const profile = profileFromTabUrl(pageUrl);
      const client = profile ? new ConfluenceClient(profile) : null;
      const site = profile ? getConfluenceBaseUrl(profile) : "";

      // Scope resolution FIRST (spec 010 T5.1): the shared
      // `fetchExportTree` → `composeChapters` orchestration, through the SAME
      // module the PDF host uses, so a tree export renders the same chapters in
      // both formats. `undefined` means single page, and the engine then walks
      // `details.storage` exactly as before. The signal reaches the WALK, so a
      // Cancel mid-tree stops fetching rather than only skipping the compile.
      const composed = await resolveDocxExportScope({
        root: {
          id: page.details.id,
          title: page.details.title,
          ...(page.details.version !== undefined ? { version: page.details.version } : {}),
          ...(page.details.spaceKey !== undefined ? { spaceKey: page.details.spaceKey } : {}),
        },
        pageUrl,
        ...(scope ? { scope } : {}),
        ...(labels ? { labels } : {}),
        ...(signal ? { signal } : {}),
        ...(onProgress
          ? {
              onProgress: (progress) =>
                onProgress({
                  fetched: progress.fetched,
                  total: progress.total ?? 0,
                  ...(progress.currentTitle ? { currentTitle: progress.currentTitle } : {}),
                }),
            }
          : {}),
      });

      // Start exactly the round-trips the already-derived scan names, BEFORE
      // host chunks/template setup. Rejections have a consumed branch, while
      // the original promises still reach the engine's report notes.
      const deps = client
        ? prepareExportDeps(await this.scan(new Uint8Array(template.bytes)), page.details, {
            getSpaceWithIcon: (key) =>
              spaceInfoCache.get(`${site}|${key}`, () => client.getSpaceWithIcon(key)),
            getCurrentUser: () => client.getCurrentUser(),
            getPageOwner: (id) => client.getPageOwner(id),
            getSpaceHomepageStorage: (key) => client.getSpaceHomepageStorage(key),
            // Cross-page include (spec 005 D1): lazy — the include pass calls it
            // per occurrence, so `buildGetIncludedPage` is imported on first
            // use. Title lookups use the DIRECT content endpoint, NOT CQL —
            // same as the CLI — so a just-created target resolves without the
            // search-index lag.
            getIncludedPage: async (ref) => {
              const { buildGetIncludedPage } = await import("@atlcli/docx/internal");
              return buildGetIncludedPage({
                getPage: (id) => client.getPage(id),
                findPagesByTitle: (title, spaceKey) =>
                  client.findPagesByTitle(title, { spaceKey }),
                defaultSpaceKey: page.details.spaceKey,
              })(ref);
            },
          })
        : {};

      // Live macro resolution (spec 010 T5.4). `contextFor` is handed to the
      // engine UNCHANGED — the engine calls
      // `contextFor(block.sourcePage ?? rootPage)`, so a macro on a CHILD page
      // of a tree export resolves against THAT page. `chapterAnchorById` lets a
      // renderer that lists other Confluence pages link into this document for
      // the ones that are chapters of it, using composition's own answer.
      const macros = profile
        ? buildSessionMacroResolutionOptions({
            pageUrl,
            targetEngine: "docx",
            ...(resolveMacros === false ? { live: false } : {}),
            ...(signal ? { signal } : {}),
            ...(composed?.chapterAnchorById
              ? { chapterAnchorById: composed.chapterAnchorById }
              : {}),
          })
        : undefined;

      const [{ runExport }, env] = await Promise.all([loadExport(), loadEnv()]);
      env.resetRasterizerStats();
      const report = await runExport(
        {
          // BASELINE-DESIGN A1: `details` stays the ROOT page even for a tree
          // export, so template placeholders (title/author/space) keep
          // resolving against it; the body comes from `blocks`.
          details: page.details,
          template: { name: template.name, modificationDate: new Date(template.uploadedAt) },
          deps,
          ...(signal ? { signal } : {}),
          ...(composed
            ? {
                blocks: composed.blocks,
                sourceNotes: composed.sourceNotes,
                complete: composed.complete,
              }
            : {}),
        },
        {
          // The panel already owns these exact bytes; avoid rereading the same
          // template from IndexedDB on every export.
          templates: env.memoryTemplateSource(template.bytes),
          // Attachment refs are wiki-base-relative (spec 005); resolve them
          // against the tab's Confluence root so the session cookies apply.
          //
          // `sessionDocxAssets`, never the bare `sessionAssetFetcher`: it
          // composes the spec-004 trust router, which is what keeps a URL
          // emitted by third-party `export_view` HTML off the session-
          // authenticated fetch path. Passing `macros` below to an env whose
          // assets are not policy-routed is an SSRF bypass — see
          // `assertPdfEnvMacroAssetRule` in `@atlcli/export-wiring/fixtures`
          // for the executable form of the rule.
          assets: env.sessionDocxAssets({
            pageUrl,
            ...(profile ? { baseUrl: getConfluenceBaseUrl(profile) } : {}),
          }),
          // Mermaid diagrams (spec 005a): the panel document supplies the
          // SVG → PNG raster fallback via a real <canvas>.
          rasterizer: env.canvasSvgRasterizer(),
          output: env.downloadOutputSink(),
          ...(macros ? { macros: macros.options } : {}),
        }
      );

      // Panel-side rasterizer sub-timings join the report so a slow diagram
      // pipeline names its slow sub-step.
      const timingNote = rasterizerTimingNote(env.getRasterizerStats());
      if (timingNote) report.notes.push(timingNote);
      // Session expiry is latched during the resolve pass, so its one distinct
      // note only exists once the engine has returned.
      for (const note of macros?.notes() ?? []) report.notes.push(note);
      return report;
    },
  };
}
