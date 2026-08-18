/** Source-neutral semantic import model shared by format-specific analyzers. */

export const IMPORT_DOCUMENT_SCHEMA_V2 = "atlcli.import-document/2" as const;

export type ImportSourceKind = "docx" | "pdf";
export type ImportOutcome = "native" | "approximated" | "attached" | "reported" | "rejected";
export type ImportIssueSeverity = "info" | "warning" | "error";

export interface ImportNodeIdentity {
  /** Stable within one canonical import plan. */
  id: string;
  /** Source-specific evidence ids. Evidence itself remains outside this model. */
  sourceRefs?: string[];
  /** Split hint only; target encoders deliberately ignore it. */
  pageBoundaryBefore?: boolean;
}

export interface ImportReferenceLink {
  /** Opaque namespace owned by the source package, for example `docx-bookmark`. */
  namespace: string;
  target: string;
  fragment?: string;
}

export function importReferenceKey(reference: ImportReferenceLink): string {
  return JSON.stringify([reference.namespace, reference.target, reference.fragment ?? null]);
}

export function resolveImportReference(
  reference: ImportReferenceLink,
  references?: ReadonlyMap<string, string>,
): string | undefined {
  return references?.get(importReferenceKey(reference))
    ?? (reference.fragment
      ? references?.get(importReferenceKey({ namespace: reference.namespace, target: reference.target }))
      : undefined);
}

export interface ImportRunMarks {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  link?: { href: string };
  /** Source-owned reference resolved by the host before target projection. */
  reference?: ImportReferenceLink;
}

export type ImportRun =
  | { kind: "text"; text: string; marks?: ImportRunMarks }
  | { kind: "hard-break" };

export interface ImportListItem {
  blocks: ImportBlock[];
  child?: ImportListBlock;
}

export interface ImportListBlock extends ImportNodeIdentity {
  type: "list";
  ordered: boolean;
  items: ImportListItem[];
}

export interface ImportTableCell {
  id: string;
  sourceRefs?: string[];
  header: boolean;
  rowspan?: number;
  colspan?: number;
  blocks: ImportBlock[];
}

export interface ImportTableRow {
  cells: ImportTableCell[];
}

export interface ImportImageBlock extends ImportNodeIdentity {
  type: "image";
  assetId: string;
  alt?: string;
  width?: number;
  height?: number;
  presentation?: "figure" | "page-fallback" | "region-fallback";
  captionBlockId?: string;
}

export type ImportBlock =
  | (ImportNodeIdentity & {
      type: "heading";
      level: 1 | 2 | 3 | 4 | 5 | 6;
      runs: ImportRun[];
      label?: string;
    })
  | (ImportNodeIdentity & { type: "paragraph"; runs: ImportRun[] })
  | ImportListBlock
  | (ImportNodeIdentity & { type: "table"; rows: ImportTableRow[] })
  | ImportImageBlock
  | (ImportNodeIdentity & { type: "blockquote"; blocks: ImportBlock[] })
  | (ImportNodeIdentity & { type: "code"; text: string })
  | (ImportNodeIdentity & { type: "page-break"; sourcePageIndex?: number });

export interface ImportAsset {
  id: string;
  sourceRefs?: string[];
  fileName: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface ImportIssue {
  code: string;
  severity: ImportIssueSeverity;
  outcome: ImportOutcome;
  message: string;
  sourceRefs?: string[];
  /** Sanitized counts/enums/dimensions only; never document body text. */
  context?: Record<string, string | number>;
  action?: string;
}

export interface ImportDocumentV2 {
  schema: typeof IMPORT_DOCUMENT_SCHEMA_V2;
  sourceKind: ImportSourceKind;
  titleCandidate?: string;
  blocks: ImportBlock[];
  assets: ImportAsset[];
  issues: ImportIssue[];
}

export type ImportProjectionInput = Pick<ImportDocumentV2, "blocks" | "assets" | "issues">;
