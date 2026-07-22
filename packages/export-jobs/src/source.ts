/** Export formats supported by the version-1 job contract. */
export type ExportFormat = "docx" | "pdf";

/** Unresolved source scope; remote identifiers live exclusively in the locator. */
export type ExportScope =
  | { kind: "page" }
  | { kind: "tree"; includeRoot?: boolean; maxDepth?: number }
  | { kind: "space" };

/** Serializable label filter, structurally compatible with Confluence label filters. */
export interface LabelFilter {
  include?: string[];
  exclude?: string[];
  excludeMode?: "prune-subtree" | "page-only";
}

/** Whether incomplete source reads fail or produce a partial export. */
export type CompletenessMode = "strict" | "partial";

/** Version-1, replay-safe Confluence source descriptor. */
export interface ExportSourceV1 {
  kind: "confluence";
  siteOrigin: string;
  locator:
    | { kind: "page-id"; id: string; version?: number }
    | { kind: "content-key"; value: string }
    | { kind: "space-key"; spaceKey: string };
  scope: ExportScope;
  labels?: LabelFilter;
  completenessMode?: CompletenessMode;
  maxPages?: number;
}
