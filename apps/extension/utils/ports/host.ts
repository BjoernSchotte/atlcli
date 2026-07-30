/**
 * Host description port (spec 010 Phase 0).
 *
 * The app must never ask "am I in Chrome?" — it asks "can this host do X?".
 * That is what lets the same screens be mounted by the Chrome side panel and by
 * a Forge Custom UI iframe whose PDF-WASM support is (per
 * `forge-export-app/SPIKE.md`'s conditional GO) not guaranteed: a host that can
 * only produce DOCX simply omits `pdf-export`, and the screen registry hides or
 * disables what depends on it — with a reason — instead of rendering a button
 * that throws.
 *
 * `name`/`version` are the injected replacement for the module-scope
 * `chrome.runtime.getManifest()` call that used to make `App.tsx` unimportable
 * outside an extension.
 */

/** Everything a screen may require of its host. */
export type HostCapability =
  /** Can compile PDFs (Typst WASM available and permitted). */
  | "pdf-export"
  /** Can render DOCX from a template. */
  | "docx-export"
  /** Can persist uploaded DOCX template bytes. */
  | "docx-template-store"
  /** Multi-slot, scoped template library (spec 010 T5.2). */
  | "template-library"
  /** Exports survive the surface closing (spec 010 T5.6). */
  | "durable-jobs"
  /** Can render a PDF preview of the bytes an export would produce (T5.3). */
  | "pdf-preview"
  /** Can run the private read-only research spike. */
  | "research"
  /** Preferences survive a reload. */
  | "settings-persistence";

export interface HostInfo {
  /**
   * Stable host identifier, for copy and for "this is not available here"
   * explanations. Not a feature switch — use {@link HostCapability} for that.
   */
  kind: "chrome-extension" | "forge" | "test";
  /** Product name for the header (extension: `chrome.runtime.getManifest().name`). */
  name: string;
  /** Version for the header (extension: the manifest version). */
  version: string;
  capabilities: readonly HostCapability[];
}

export function hasCapability(host: HostInfo, capability: HostCapability): boolean {
  return host.capabilities.includes(capability);
}
