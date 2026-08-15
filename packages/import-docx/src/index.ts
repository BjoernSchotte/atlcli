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
export { parseDocx, type ParseDocxPolicy } from "./parse.js";
export {
  BATCH_MANIFEST_SCHEMA,
  BATCH_STATE_SCHEMA,
  parseBatchManifest,
  validateBatchState,
  type BatchManifestDocumentV1,
  type BatchStateItemV1,
  type DocxBatchManifestV1,
  type DocxBatchStateV1,
} from "./batch-manifest.js";
export {
  BASELINE_PROPERTY_KEY,
  BASELINE_SCHEMA,
  buildBaseline,
  canonicalJson,
  digestAdfValue,
  validateBaseline,
  type BaselineAssetBinding,
  type ImportedPageBaselineV1,
} from "./baseline.js";
export {
  diffAdfBlocks,
  renderSemanticDiffLines,
  type SemanticDiffEntry,
  type SemanticDiffV1,
} from "./diff.js";
export {
  RECIPE_SCHEMA,
  canonicalRecipeJson,
  parseRecipe,
  recipeApplicability,
  type DocxImportRecipeV1,
  type ParsedRecipe,
} from "./recipe.js";
export {
  STYLE_MAPPING_TARGETS,
  renderPolicySummary,
  resolveImportPolicy,
  type DocxImportOptionsV1,
  type DocxImportOverridesV1,
  type PolicyLayerInput,
  type PolicySource,
  type ResolvedImportPolicy,
  type StyleMappingTarget,
} from "./overrides.js";
export {
  documentToAdf,
  type AdfDocument,
  type AdfEncodeOptions,
  type AdfMediaResolution,
  type AdfNode,
} from "./adf.js";
export {
  buildGovernance,
  governanceHasEffects,
  parsePrincipal,
  principalId,
  renderGovernanceSummary,
  type DestinationGovernance,
  type DestinationPrincipal,
  type DestinationRestrictionPolicy,
  type GovernanceInput,
} from "./destination-governance.js";
export {
  EDITABILITY_BUDGETS,
  assessEditability,
  type EditabilityAssessment,
  type EditabilityLevel,
} from "./assess.js";
export {
  SplitTitleConflictError,
  collectAnchorRefs,
  countPages,
  splitDocument,
  type ImportPagePlan,
  type SplitOptions,
  type SplitResult,
} from "./split.js";
export {
  buildImportPreview,
  renderImportPreview,
  type ImportPreview,
  type ImportPreviewAsset,
  type ImportTarget,
} from "./preview.js";
