/**
 * Injected dependency signatures (spec 004). These functions live in
 * `@atlcli/confluence` (next to the XML tokenizer they share) and are passed in
 * by host-wiring code so `@atlcli/export-macros` keeps zero runtime imports from
 * any `@atlcli/*` package.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";
import type { ChartDiagnosticV1, ChartModelV1, ChartSourceKindV1, MacroParameter } from "@atlcli/export-blocks";

/** The `storageToBlocks` walker, injected. */
export type StorageToBlocksDep = (
  storage: string,
  opts?: {
    exporter?: "pdf" | "word" | "web";
    pageContext?: { id: string; version?: number; spaceKey?: string };
  }
) => { blocks: ExportBlock[]; notes: ExportNote[] };

/** The `htmlToExportBlocks` converter, injected. */
export type HtmlToExportBlocksDep = (html: string) => {
  blocks: ExportBlock[];
  notes: ExportNote[];
};

/**
 * The `parsePageProperties` reader, injected (lives in `@atlcli/confluence`
 * next to the tokenizer). Returns each `details` macro's label→value rows in
 * document order.
 */
export type ParsePagePropertiesDep = (
  storage: string
) => { id?: string; macroId?: string; rows: Map<string, string> }[];

/**
 * The `extractMacroBody` helper, injected (lives in `@atlcli/confluence` next
 * to the tokenizer): finds the named definition macro in a page's storage and
 * returns its rich-text body as a storage fragment for `storageToBlocks`.
 * Storage-based because the walker renders definition macros transparently.
 */
export type ExtractMacroBodyDep = (
  storage: string,
  macroNames: readonly string[],
  name: string
) => string | undefined;

/** Pure source adapter used when an ADF/DC macro reaches the resolver pass. */
export type NormalizeChartMacroDep = (
  params: readonly MacroParameter[],
  body: readonly ExportBlock[],
  source: ChartSourceKindV1,
) => { model?: ChartModelV1; diagnostics: readonly ChartDiagnosticV1[] };
