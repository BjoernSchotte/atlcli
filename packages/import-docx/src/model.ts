/** DOCX-only extensions around the source-neutral `@atlcli/import-core` IR. */
import type { ImportBlock, ImportDocumentV2 } from "@atlcli/import-core";

export type DocxImportBlock =
  | (Extract<ImportBlock, { type: "heading" }> & { bookmarks?: string[] })
  | (Extract<ImportBlock, { type: "paragraph" }> & { bookmarks?: string[] })
  | Exclude<ImportBlock, { type: "heading" } | { type: "paragraph" }>;

/**
 * A Word comment or reply. Source attribution is visible content only; the
 * authenticated importer remains the Confluence comment actor.
 */
export interface ImportComment {
  id: string;
  author: string;
  date?: string;
  text: string;
  resolved: boolean;
  replies: ImportComment[];
  anchorText?: string;
}

export interface ImportedDocument extends Omit<ImportDocumentV2, "blocks"> {
  sourceKind: "docx";
  blocks: DocxImportBlock[];
  comments: ImportComment[];
  commentOwners: Map<string, DocxImportBlock>;
}
