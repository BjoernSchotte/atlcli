/**
 * Engine ports (spec 010 Phase 0).
 *
 * PDF and DOCX are two independent ports, never one "export" port with a
 * `format` discriminator. `forge-export-app/SPIKE.md` records a conditional GO
 * in which PDF-WASM fails in a Forge iframe while DOCX works ("Browserbasis nur
 * DOCX"); a shared path would make that outcome a rewrite instead of a
 * capability flag. `AppPorts.pdf === null` and `AppPorts.docx === null` are
 * therefore both legal, independently.
 *
 * Both ports are host-implemented and lazily loaded: in the extension `run`
 * dynamically imports the heavy engine chunk on first use, so a panel that
 * never exports never pays for Typst WASM or PizZip.
 */
import type { ExportScope, LabelFilter } from "@atlcli/confluence/browser";
import type { TemplateLibraryEntry } from "@atlcli/core";
import type { ExportReport } from "@atlcli/docx/browser";
import type { ScanResult } from "@atlcli/docx/scan";
import type { PdfExportReport, PdfTemplateSettings } from "@atlcli/pdf/browser";
import type { LoadedPage } from "../read-path.js";

/**
 * User-visible export phases.
 *
 * Declared here rather than imported from `utils/pdf/run-export.ts` so the
 * portable layer does not name an extension module. The extension adapter
 * assigns that module's `PdfExportPhase` values straight into this union, so a
 * divergence between the two is a compile error at the adapter — which is the
 * point.
 */
export type ExportPhase =
  | "preparing"
  | "fetching"
  | "queued"
  | "compiling"
  | "validating"
  | "downloading";

/**
 * Detail channel for the multi-page walk (spec 010 T5.1).
 *
 * Separate from {@link ExportPhase} on purpose: a phase is a coarse state the
 * button label renders, whereas this is a *counter* that ticks many times
 * inside the single `fetching` phase. Merging them would make every tick a
 * phase transition.
 */
export interface ExportProgress {
  /** Pages walked so far. */
  fetched: number;
  /** Pages the walk expects in total; `0` while still unknown. */
  total: number;
  /** Title of the page currently being fetched, when known. */
  currentTitle?: string;
}

/**
 * What the shared scope form contributes to an export (spec 010 T5.1,
 * Architecture point 7).
 *
 * One shape for both engines — the panel renders **one** `ScopeSection` above
 * both engine panels, so the DOCX and PDF buttons cannot disagree about what
 * "the export" covers. Every field is optional: a host that predates the scope
 * work (and today's Chrome adapters) keeps compiling and keeps behaving exactly
 * like `scope: { kind: "page" }`, which is the 90 % case.
 */
export interface ExportScopeRequest {
  /** Absent means "the single loaded page" — today's behaviour. */
  scope?: ExportScope;
  /** Absent means "no label filtering". */
  labels?: LabelFilter;
  /**
   * `false` turns off dynamic macro resolution (spec 010 T5.4), which makes an
   * export deterministic at the price of placeholders for Jira/`export_view`
   * macros. Absent/`true` is the default.
   */
  resolveMacros?: boolean;
  /** Per-page ticks during the tree walk. */
  onProgress?: (progress: ExportProgress) => void;
}

export interface PdfExportRequest extends ExportScopeRequest {
  page: LoadedPage;
  /** Page URL — hosts that need an origin for asset fetches key on it. */
  pageUrl: string;
  signal?: AbortSignal;
  onPhase?: (phase: ExportPhase) => void;
  /**
   * Level-A template settings (spec 007), collected by `SettingsForm` and
   * persisted per template in `template-prefs`.
   *
   * **PDF only, deliberately.** `packages/pdf` threads `settings` through
   * `RunPdfExportInput`; `packages/docx`'s `ExportInput` has no equivalent
   * field and no folder currently adds one, so {@link DocxExportRequest}
   * intentionally does **not** mirror this. Adding it there would be an
   * `as any`-shaped promise the engine cannot keep.
   */
  settings?: PdfTemplateSettings;
}

export interface PdfExportPort {
  run(request: PdfExportRequest): Promise<PdfExportReport>;
}

/** One stored DOCX template. Phase 0 keeps today's single-slot model. */
export interface DocxTemplateRecord {
  name: string;
  uploadedAt: number;
  bytes: ArrayBuffer;
}

/**
 * Persistence for template bytes.
 *
 * Single-slot in Phase 0, matching `utils/docx/template-store.ts`'s `"current"`
 * record. T5.2 replaces the implementation with the multi-slot library; this
 * interface then grows list/select methods rather than the screens growing
 * storage knowledge.
 */
export interface DocxTemplateStore {
  get(): Promise<DocxTemplateRecord | null>;
  put(record: { name: string; bytes: ArrayBuffer }): Promise<DocxTemplateRecord>;
  remove(): Promise<void>;
}

/**
 * Note the absence of a `settings` field, and keep it absent: `ExportInput`
 * (`packages/docx/src/export.ts`) has none, so anything the panel put here
 * would be dropped on the floor while looking like a feature. DOCX manifest
 * settings stay informational-only in the panel until a DOCX-side settings seam
 * lands. `tests/settings-form.test.tsx` pins this.
 */
export interface DocxExportRequest extends ExportScopeRequest {
  page: LoadedPage;
  pageUrl: string;
  template: DocxTemplateRecord;
  signal?: AbortSignal;
}

/**
 * One row in the template library, as the panel sees it (spec 010 T5.2).
 *
 * `TemplateLibraryEntry` is the shared, host-neutral catalog entry from
 * `@atlcli/core` — the exact value `resolveTemplate` arbitrates over. The two
 * added fields are what a *list UI* needs on top of that: the physical row to
 * act on, and the filename to show. Deliberately structural rather than an
 * import of `utils/templates/library.ts`'s `StoredTemplateEntry`: the portable
 * layer must not name an extension module, and the extension adapter assigning
 * its value into this port is where a divergence becomes a compile error.
 */
export interface TemplateLibraryItem extends TemplateLibraryEntry {
  /** Storage key of the physical upload; what delete/assign act on. */
  recordKey: string;
  /** Original uploaded filename. */
  fileName: string;
}

/** Values a template-manifest settings form may persist. */
export type TemplateSettingValue = string | number | boolean | null;

/**
 * The multi-slot, scoped template library (spec 010 T5.2, Architecture point 4).
 *
 * A host advertising `template-library` must supply this. Precedence is **not**
 * part of the port: `resolve` delegates to the shared, pure `resolveTemplate`
 * from `@atlcli/core`, so "space beats global" means the same thing here as in
 * the CLI and the panel grows no rules of its own.
 *
 * **Scope: DOCX template bytes.** PDF renders with the built-in document design
 * and carries *settings*, not uploaded template bytes — 007's Level-B custom
 * Typst render path does not exist yet, so there is deliberately no PDF
 * template upload anywhere in this port.
 */
export interface TemplateLibraryPort {
  /** Every row for `engine` on this site, unfiltered by space (library view). */
  listAll(engine: TemplateLibraryEntry["engine"]): Promise<TemplateLibraryItem[]>;
  /**
   * Bytes for one entry, integrity-checked.
   *
   * @throws a `TemplateIntegrityError`-shaped error ("template was modified,
   * re-upload") when the stored bytes no longer match the entry's `sha256` or
   * `size`. There is no silent fallback to another entry.
   */
  getBytes(entry: TemplateLibraryEntry): Promise<Uint8Array>;
  /** Add a physical upload; the host computes its sha256. */
  add(input: {
    name: string;
    displayName?: string;
    bytes: ArrayBuffer;
    engine?: TemplateLibraryEntry["engine"];
    scope?: TemplateLibraryEntry["scope"];
    spaceKey?: string;
  }): Promise<TemplateLibraryItem>;
  /**
   * "Assign to current space": mints a **new** row carrying the source entry's
   * logical `id` with `scope: "space"`. The global row is never mutated, so
   * deleting the override falls back to it.
   */
  assignToSpace(entry: TemplateLibraryEntry, spaceKey: string): Promise<TemplateLibraryItem>;
  /** Delete one physical row. */
  remove(recordKey: string): Promise<void>;
  /** The active selection's logical template id for this engine + space. */
  getActiveTemplateId(
    engine: TemplateLibraryEntry["engine"],
    spaceKey?: string
  ): Promise<string | undefined>;
  /** Persist the active selection (`undefined` clears it). */
  setActiveTemplateId(
    engine: TemplateLibraryEntry["engine"],
    spaceKey: string | undefined,
    templateId: string | undefined
  ): Promise<void>;
  /** Settings-form values for one logical template (`{}` when unset). */
  readSettings(
    engine: TemplateLibraryEntry["engine"],
    spaceKey: string | undefined,
    templateId: string
  ): Promise<Record<string, TemplateSettingValue>>;
  /** Persist settings-form values for one logical template. */
  writeSettings(
    engine: TemplateLibraryEntry["engine"],
    spaceKey: string | undefined,
    templateId: string,
    values: Record<string, TemplateSettingValue>
  ): Promise<void>;
}

export interface DocxExportPort {
  /**
   * Validate and classify template bytes.
   *
   * Throws the engine's own rejection error (a `DocxError`-shaped value with a
   * `kind`) so the UI can map the known kinds to translated copy and quote the
   * engine's message verbatim for everything else.
   */
  scan(bytes: Uint8Array): Promise<ScanResult>;

  run(request: DocxExportRequest): Promise<ExportReport>;

  /**
   * Optional: pre-fetch the heavy engine chunks because an export is likely
   * (a template already exists). Pure warm-up — failures must be swallowed.
   */
  warm?(): void;
}
