/**
 * Neutral import IR for the DOCX → Confluence vertical slice
 * (specs/import-docx-mvp/PLAN.md §7.1, reduced per DRIFT.md §2).
 *
 * The IR is target-neutral and parser-neutral: nothing in here may reference
 * OOXML part names, saxes types, ADF, or Storage XHTML. Every construct the
 * parser cannot represent must surface as an {@link ImportIssue} — "parser
 * ignored it" is never a valid outcome (§2.4).
 */

/** Inline formatting carried by a text run. */
export interface ImportRunMarks {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  /** External hyperlink target (http/https/mailto only; enforced by the parser). */
  link?: { href: string };
}

export type ImportRun =
  | { kind: "text"; text: string; marks?: ImportRunMarks }
  | { kind: "hard-break" };

export interface ImportListItem {
  /** Block content of the item (first block is the item paragraph). */
  blocks: ImportBlock[];
  /** Nested list (deeper `ilvl` in the source), if any. */
  child?: ImportListBlock;
}

export interface ImportListBlock {
  type: "list";
  ordered: boolean;
  items: ImportListItem[];
}

export interface ImportTableCell {
  header: boolean;
  blocks: ImportBlock[];
}

export interface ImportTableRow {
  cells: ImportTableCell[];
}

export type ImportBlock =
  | {
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      runs: ImportRun[];
      /**
       * Resolved visible numbering label (e.g. `1.2`, `A`, `IV`) when the
       * source heading is numbered via OOXML numbering. Word generates these
       * at render time; losing them breaks the section identifiers people
       * cite, so the import resolves and preserves them explicitly
       * (specs/import-docx/002-heading-numbering).
       */
      label?: string;
    }
  | { type: "paragraph"; runs: ImportRun[] }
  | ImportListBlock
  | { type: "table"; rows: ImportTableRow[] }
  | ImportImageBlock
  /** Consecutive Quote/Intense Quote paragraphs, grouped. */
  | { type: "blockquote"; blocks: ImportBlock[] }
  /** Consecutive code-styled paragraphs, merged into one block. */
  | { type: "code"; text: string };

export interface ImportImageBlock {
  type: "image";
  /** References an {@link ImportAsset} by its stable id. */
  assetId: string;
  alt?: string;
  /** Display size in CSS px (converted from source EMU), when declared. */
  width?: number;
  height?: number;
}

/**
 * An embedded binary carried alongside the document (today: images). Bytes
 * stay in memory only; publication uploads them as page attachments.
 */
export interface ImportAsset {
  /** Stable id derived from the source package part name. */
  id: string;
  /** Attachment file name used at upload (basename of the source part). */
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export type ImportIssueSeverity = "info" | "warning";

/**
 * §2.4 outcome for the construct the issue describes. The slice only produces
 * `approximated` and `reported`; `rejected` is thrown as an error instead.
 */
export type ImportIssueOutcome = "approximated" | "reported";

export interface ImportIssue {
  /** Stable machine code, e.g. `docx-import/image-not-supported`. */
  code: string;
  severity: ImportIssueSeverity;
  outcome: ImportIssueOutcome;
  message: string;
  /** Sanitized context (element names, counts) — never document body text. */
  context?: Record<string, string | number>;
}

export interface ImportedDocument {
  /** Title candidate derived from the first level-1 heading, if present. */
  titleCandidate?: string;
  blocks: ImportBlock[];
  /** Embedded binaries referenced by `image` blocks, in source order. */
  assets: ImportAsset[];
  issues: ImportIssue[];
}
