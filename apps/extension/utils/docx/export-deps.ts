import type {
  ExportBlock,
  ExportNote,
  ExportScope,
  ExportTreeBodyStoreV1,
  LabelFilter,
  TreeFetchProgress,
} from "@atlcli/confluence/browser";
import {
  isTreeScope,
  resolveExportComposition,
  type ExportCompositionDeps,
} from "../confluence/export-composition.js";

// ---------------------------------------------------------------------------
// Scope (spec 010 T5.1)
// ---------------------------------------------------------------------------

export interface DocxScopeInput {
  root: { id: string; title: string; version?: number; spaceKey?: string };
  pageUrl: string;
  scope?: ExportScope;
  labels?: LabelFilter;
  /** Durable queued-export page/block spool; absent for direct panel work. */
  bodyStore?: ExportTreeBodyStoreV1;
  signal?: AbortSignal;
  onProgress?: (progress: TreeFetchProgress) => void;
}

/**
 * The `ExportInput` fields a tree/space scope contributes. Deliberately shaped
 * as a spread-in fragment: `undefined` means "single page", and the caller then
 * passes NOTHING extra, so the engine walks `details.storage` exactly as it did
 * before scope existed.
 */
export interface DocxScopeContribution {
  blocks: ExportBlock[];
  sourceNotes: ExportNote[];
  complete: boolean;
  /** For the macro builder — renderers that link to other in-scope pages. */
  chapterAnchorById: ReadonlyMap<string, string>;
  /** Pages that entered the document; the panel's progress denominator. */
  pageCount: number;
}

/**
 * Resolve a DOCX export's scope into pre-composed blocks (spec 010 T5.1,
 * BASELINE-DESIGN A1).
 *
 * Delegates to the SAME `resolveExportComposition` the PDF host uses, so a
 * `tree` export of one page produces the identical chapter structure, label
 * pruning, note set and completeness verdict in both formats. `ExportInput.details`
 * stays the ROOT page on purpose: template placeholders (title/author/space)
 * keep resolving against it, while the document body comes from {@link
 * DocxScopeContribution.blocks}.
 *
 * Returns `undefined` for a `page` scope (or no scope), which is what keeps the
 * single-page path byte-identical: the engine's own walk applies
 * `exportControls`, the caption locale and the template's dialect, none of
 * which a pre-composed block list would carry.
 */
export async function resolveDocxExportScope(
  input: DocxScopeInput,
  overrides: Partial<ExportCompositionDeps> = {}
): Promise<DocxScopeContribution | undefined> {
  if (!isTreeScope(input.scope)) return undefined;
  const composition = await resolveExportComposition(
    {
      root: input.root,
      pageUrl: input.pageUrl,
      exporter: "word",
      scope: input.scope,
      ...(input.labels ? { labels: input.labels } : {}),
      ...(input.bodyStore ? { bodyStore: input.bodyStore } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    },
    overrides
  );
  return {
    blocks: composition.blocks,
    sourceNotes: composition.notes,
    complete: composition.complete,
    chapterAnchorById: composition.chapterAnchorById ?? new Map(),
    pageCount: composition.pageCount,
  };
}
