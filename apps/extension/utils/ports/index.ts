/**
 * What `<ExportApp ports={…} />` is written against (spec 010 Phase 0).
 *
 * The acceptance criterion for the whole phase (SPIKE.md hypothesis H4) is that
 * `ExportApp` renders and completes an export with `globalThis.chrome` deleted,
 * driven only by fakes of what is below — see `tests/app-portability.test.tsx`.
 *
 * **Two things this file deliberately does NOT declare**, after an audit of the
 * isomorphic base found both already covered:
 *
 * - *A Confluence reader interface.* `getSpace`/`getCurrentUser`/`getPageOwner`
 *   are already `ResolveDeps` (`packages/docx/src/resolver.ts`), implemented by
 *   both hosts (`apps/cli/src/commands/export.ts`,
 *   `utils/docx/export-deps.ts`). Attachment bytes are already `AssetFetcher`
 *   (`@atlcli/docx`) and `PdfAssetResolver` (`@atlcli/pdf`); attachment
 *   metadata is already `AttachmentLookupPort` (`@atlcli/export-macros`); tree
 *   reads are already `TreeSource` (`@atlcli/confluence`). The only uncovered
 *   slot is loading the root page for the panel, which is one function —
 *   {@link AppPorts.loadPage} — following the base's own idiom of a structural
 *   type next to the consumer (`utils/read-path.ts`'s
 *   `Pick<ConfluenceClient, "getPageDetails" | "listAttachments">`,
 *   `TreeSourceClient`), not a named interface.
 *
 * - *A page-context port.* URL → entity is already `extractEntityFromUrl`
 *   (`@atlcli/core`), URL → profile is already `profileFromTabUrl` (which its
 *   own header says belongs in the extension), and the detection payload is
 *   already `EntityDetection` (`utils/messages.ts`). All that is left is a
 *   subscription — {@link AppPorts.watchPageContext} — so the app can be handed
 *   the answer instead of discovering it through `chrome.*`.
 */
import type { EntityDetection } from "../messages.js";
import type { LoadedPage } from "../read-path.js";
import type { HostInfo } from "./host.js";
import type { DocxExportPort, DocxTemplateStore, PdfExportPort } from "./export.js";
import type { SettingsStore } from "./settings.js";

/**
 * What the host knows about the page it is showing.
 *
 * The existing detection payload minus `windowId`: a Chrome window is not a
 * concept the app has, and a Forge iframe has no equivalent to substitute.
 */
export type PageContext = Omit<EntityDetection, "windowId">;

export interface AppPorts {
  host: HostInfo;

  /**
   * Subscribe to "which page is the host showing?".
   *
   * The host calls back as soon as it has an answer and on every change after
   * that; `seq` carries the ordering guarantee the panel reducer's `lastSeq`
   * guard depends on. Re-resolving after the surface regains focus is the
   * host's business, not the app's.
   *
   * @returns an unsubscribe function; calling it twice must be safe.
   */
  watchPageContext(onChange: (context: PageContext) => void): () => void;

  /**
   * Load a Confluence page and everything the panel renders for it.
   *
   * The extension binds `loadConfluencePage` to a session `Profile` derived
   * from the active tab — the part SPIKE.md classifies as "nicht direkt
   * verwenden" for Forge, and therefore the part that is injected.
   *
   * @throws {ReadError} with a classified `kind` (`utils/read-path.ts`).
   */
  loadPage(contentId: string): Promise<LoadedPage>;

  /** `null` when this host cannot produce PDFs. */
  pdf: PdfExportPort | null;
  /** `null` when this host cannot produce Word documents. */
  docx: DocxExportPort | null;
  /** `null` when this host cannot persist template bytes. */
  docxTemplates: DocxTemplateStore | null;
  settings: SettingsStore;
}

export * from "./host.js";
export * from "./export.js";
export * from "./settings.js";
