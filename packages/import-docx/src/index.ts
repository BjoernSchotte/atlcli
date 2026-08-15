/**
 * `@atlcli/import-docx` — semantic DOCX → Confluence import (vertical slice).
 *
 * Byte-oriented and host-neutral: callers hand in `Uint8Array` DOCX bytes;
 * file/stdin/network acquisition belongs to the imperative shell (CLI).
 */
export type {
  ImportAsset,
  ImportBlock,
  ImportImageBlock,
  ImportIssue,
  ImportIssueOutcome,
  ImportIssueSeverity,
  ImportListBlock,
  ImportListItem,
  ImportRun,
  ImportRunMarks,
  ImportTableCell,
  ImportTableRow,
  ImportedDocument,
} from "./model.js";
export { parseDocx } from "./parse.js";
export {
  documentToAdf,
  type AdfDocument,
  type AdfEncodeOptions,
  type AdfMediaResolution,
  type AdfNode,
} from "./adf.js";
export {
  EDITABILITY_BUDGETS,
  assessEditability,
  type EditabilityAssessment,
  type EditabilityLevel,
} from "./assess.js";
export {
  SplitTitleConflictError,
  countPages,
  splitDocument,
  type ImportPagePlan,
  type SplitOptions,
} from "./split.js";
export {
  buildImportPreview,
  renderImportPreview,
  type ImportPreview,
  type ImportPreviewAsset,
  type ImportTarget,
} from "./preview.js";
