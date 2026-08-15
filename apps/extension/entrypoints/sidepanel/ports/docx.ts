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
import type { ScanResult } from "@atlcli/docx/browser-entry";
import { profileFromTabUrl } from "../../../utils/profile.js";
import { idbTemplateLibrary, type IdbTemplateLibrary, type StoredTemplateEntry } from "../../../utils/templates/library.js";
import type { DocxExportPort, DocxTemplateStore } from "../../../utils/ports/export.js";
import type { SiteContext } from "./site-context.js";

// The scan stays panel-local and light. Export itself is a durable observer
// adapter; PizZip/docxtemplater and canvas load only in the offscreen executor.
const loadScan = () => import("@atlcli/docx/browser-entry");
const loadRun = () => import("../../../utils/export-jobs/docx-run.js");

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

    async warm(options) {
      const responsePromise = chrome.runtime.sendMessage({
        kind: "docx:prepare-runtime",
        ...(options?.codeTheme ? { codeTheme: options.codeTheme } : {}),
      }) as Promise<
        | { kind: "docx:prepare-runtime-result"; ok: true }
        | { kind: "docx:prepare-runtime-result"; ok: false; error: string }
        | undefined
      >;
      const [, response] = await Promise.all([loadRun(), responsePromise]);
      if (!response || response.kind !== "docx:prepare-runtime-result") {
        throw new Error("DOCX runtime preparation returned no result.");
      }
      if (!response.ok) throw new Error(response.error);
    },

    async run(request) {
      const { chromeExtensionDocxRunDeps, runSubmittedExtensionDocxExport } =
        await loadRun();
      return runSubmittedExtensionDocxExport(
        request,
        chromeExtensionDocxRunDeps(),
      );
    },
  };
}
