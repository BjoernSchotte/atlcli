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
import type { ExportScope, LabelFilter } from "@atlcli/confluence/browser";
import type { EntityDetection } from "../messages.js";
import type { LoadedPage } from "../read-path.js";
import type { HostInfo } from "./host.js";
import type {
  DocxExportPort,
  DocxTemplateStore,
  PdfExportPort,
  TemplateLibraryPort,
} from "./export.js";
import type { SettingsStore } from "./settings.js";
import type { ResearchPort } from "../research/contracts.js";
import type { ChatAgentPortV1 } from "@atlcli/research";
import type { BrowserLocalModelPortV1 } from "../local-model/storage.js";

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

  /**
   * Navigate the host's current content surface to a validated source URL.
   * Portable presenters may omit this port and fall back to a normal link;
   * the side panel uses it for same-page section citations so it does not open
   * a duplicate Confluence tab.
   */
  navigateToSource?(input: { url: string }): Promise<void>;

  /** `null` when this host cannot produce PDFs. */
  pdf: PdfExportPort | null;
  /** `null` when this host cannot produce Word documents. */
  docx: DocxExportPort | null;
  /** `null` when this host cannot persist template bytes. */
  docxTemplates: DocxTemplateStore | null;
  settings: SettingsStore;
  /** Single-shot, bounded Jira + Confluence research. */
  research?: ResearchPort | null;
  /** Ordinary Chat controls and streams, independent from Deep Research. */
  chat?: ChatAgentPortV1 | null;
  /** Browser-owned local model installation and readiness, when supported. */
  localModel?: BrowserLocalModelPortV1 | null;

  /**
   * The multi-slot template library (spec 010 T5.2).
   *
   * Optional so a host that predates it still satisfies `AppPorts`; the screen
   * that renders it declares the `template-library` capability, so a host
   * without the port gets "not available here, because…" rather than a screen
   * that throws. Never feature-detect on this field in a screen — ask the
   * registry.
   */
  templates?: TemplateLibraryPort | null;

  /**
   * Pre-flight page count for a tree/space scope, for the "212 pages,
   * continue?" confirmation (spec 010 T5.1, baseline A2).
   *
   * Optional because it is a *nicety*, not a gate: the confirmation is shown
   * for every space export either way, and a host that cannot count cheaply
   * gets the count-free wording instead. Rejections (including abort) are
   * treated as "count unknown" — a failed estimate must never block an export
   * the user is entitled to run.
   */
  countScopePages?(request: {
    scope: ExportScope;
    labels?: LabelFilter;
    signal?: AbortSignal;
  }): Promise<number>;
}

export * from "./host.js";
export * from "./export.js";
export * from "./settings.js";
