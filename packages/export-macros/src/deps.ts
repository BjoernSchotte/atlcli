/**
 * Injected dependency signatures (spec 004). These functions live in
 * `@atlcli/confluence` (next to the XML tokenizer they share) and are passed in
 * by host-wiring code so `@atlcli/export-macros` keeps zero runtime imports from
 * any `@atlcli/*` package.
 */
import type { ExportBlock, ExportNote } from "@atlcli/confluence";

/** The `storageToBlocks` walker, injected. */
export type StorageToBlocksDep = (
  storage: string,
  opts?: {
    exporter?: "pdf" | "word";
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
