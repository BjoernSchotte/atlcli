import {
  RESEARCH_REPORT_SCHEMA_V1,
  RESEARCH_REPORT_SCHEMA_V2,
  ResearchContractError,
  type ResearchReportClaimV2,
  type ResearchReportReconciliationV2,
  type ResearchReportSourceAuthorityV2,
  type ResearchReportSectionV2,
  type ResearchReportV1,
  type ResearchReportV2,
  type ResearchRequestV1,
  type ResearchRunSummaryV1,
  type ResearchSourceReferenceV1,
} from "./contracts.js";
import type { ResearchClaimLedgerV1, ResearchClaimV1 } from "./claim-ledger.js";
import type { ResearchEvidenceRecordV1, ResearchEvidenceStoreV1 } from "./evidence-store.js";
import type { ResearchOutlineV1 } from "./outline.js";
import type {
  ResearchReconciliationDefectV1,
  ResearchReconciliationDispositionV1,
} from "./workflow-contracts.js";
import { finalizeResearchReportV1, renderResearchReportWithFindingSectionsMarkdown } from "./report.js";
import {
  localizeResearchLimitationV1,
  researchReportCopyV1,
} from "./report-locale.js";

const CLAIM_ID = /^claim:[a-f0-9]{48}$/;
const MAXIMUM_REPORT_CLAIMS = 96;
const MAXIMUM_REPORT_SECTIONS = 24;
const MAXIMUM_RECONCILIATION_OUTCOMES = 16;

function invalid(message: string): never {
  throw new ResearchContractError("invalid-report", message);
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum || value.includes("\u0000")) {
    invalid(`${label} is invalid.`);
  }
  return value;
}

function distinctClaimIds(value: readonly string[], label: string): string[] {
  if (!Array.isArray(value) || value.length > MAXIMUM_REPORT_CLAIMS || value.some((id) => !CLAIM_ID.test(id))) {
    invalid(`${label} is invalid.`);
  }
  if (new Set(value).size !== value.length) invalid(`${label} contains duplicates.`);
  return [...value];
}

function sameSource(left: ResearchSourceReferenceV1, right: ResearchSourceReferenceV1): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sourceIdsForClaim(
  claim: ResearchClaimV1,
  records: ReadonlyMap<string, ResearchEvidenceRecordV1>,
): string[] {
  const sourceIds = claim.evidenceIds.map((evidenceId) => {
    const record = records.get(evidenceId);
    if (!record) invalid("A current claim references evidence that is not retained.");
    return record.source.id;
  });
  return [...new Set(sourceIds)].sort();
}

function sectionsFor(
  outline: ResearchOutlineV1 | undefined,
  claimIds: readonly string[],
): ResearchReportSectionV2[] {
  if (!outline) {
    return [{
      id: "report-section:validated-findings",
      title: "Evidence-backed findings",
      question: "What do the currently validated claims establish?",
      claimIds: [...claimIds],
      coverageTargetIds: [],
    }];
  }
  const selected = new Set(claimIds);
  const sections = outline.sections.map((section): ResearchReportSectionV2 => ({
    id: section.id,
    title: section.title,
    question: section.question,
    claimIds: section.claimIds.filter((id) => selected.has(id)),
    coverageTargetIds: [...section.coverageTargetIds],
  }));
  const assigned = new Set(sections.flatMap((section) => section.claimIds));
  const unassigned = claimIds.filter((id) => !assigned.has(id));
  if (unassigned.length > 0) {
    sections.push({
      id: "report-section:unassigned-validated-claims",
      title: "Additional validated findings",
      question: "Which validated claims were not assigned to an outline section?",
      claimIds: unassigned,
      coverageTargetIds: [],
    });
  }
  if (sections.length > MAXIMUM_REPORT_SECTIONS) invalid("Report contains too many sections.");
  return sections;
}

function coverageMarkdown(report: ResearchReportV2, language: ResearchRequestV1["reportLanguage"]): string[] {
  if (report.coverage.length === 0) return [];
  const copy = researchReportCopyV1(language);
  return [
    `## ${copy.evidenceCoverage}`,
    "",
    ...report.coverage.map((entry) =>
      `- \`${entry.targetId}\`: ${entry.status}; ${entry.distinctSourceCount} distinct retained ${entry.distinctSourceCount === 1 ? "source" : "sources"}.`,
    ),
    "",
  ];
}

function incompleteCoverageLimitations(
  coverage: readonly Pick<ResearchReportV2["coverage"][number], "targetId" | "status" | "distinctSourceCount">[],
  language: ResearchRequestV1["reportLanguage"],
): string[] {
  return coverage
    .filter((entry) => entry.status !== "covered")
    .map((entry) => language === "de"
      ? `Die Evidenzabdeckung für ${entry.targetId} ist ${entry.status} (${entry.distinctSourceCount} unterschiedliche erhaltene ${entry.distinctSourceCount === 1 ? "Quelle" : "Quellen"}); der Bericht ist für dieses Ziel nicht erschöpfend.`
      : `Evidence coverage for ${entry.targetId} is ${entry.status} (${entry.distinctSourceCount} distinct retained ${entry.distinctSourceCount === 1 ? "source" : "sources"}); the report is not exhaustive for this target.`);
}

function markdownText(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/([`*_[\]<>])/g, "\\$1")
    .replace(/\s+/g, " ")
    .trim();
}

function reconciliationMarkdown(report: ResearchReportV2, language: ResearchRequestV1["reportLanguage"]): string[] {
  const outcomes = report.reconciliation ?? [];
  if (outcomes.length === 0) return [];
  const copy = researchReportCopyV1(language);
  return [
    `## ${copy.reconciliationDecisions}`,
    "",
    ...outcomes.map((entry) =>
      `- ${markdownText(entry.target.kind)} ${markdownText(entry.target.id)}: ${entry.decision} (${entry.reasonCode}).`,
    ),
    "",
  ];
}

function sourceAuthorityMarkdown(report: ResearchReportV2, language: ResearchRequestV1["reportLanguage"]): string[] {
  if (!report.sourceAuthorities || report.sourceAuthorities.length === 0) return [];
  const copy = researchReportCopyV1(language);
  return [
    `## ${copy.sourceAccessAuthority}`,
    "",
    ...report.sourceAuthorities.map((entry) =>
      `- \`${markdownText(entry.sourceId)}\`: ${entry.authorityClasses
        .map((authority) => authority === "exact_entity" ? copy.exactEntity : copy.wholeScope)
        .join(", ")}.`,
    ),
    "",
  ];
}

function renderMarkdown(
  report: Omit<ResearchReportV2, "markdown">,
  language: ResearchRequestV1["reportLanguage"],
): string {
  const claimsById = new Map(report.claims.map((claim) => [claim.id, claim]));
  const sections = report.sections.map((section) => ({
    title: section.title,
    question: section.question,
    findings: section.claimIds.map((id, index) => {
      const claim = claimsById.get(id);
      if (!claim) invalid("V2 report section references an unavailable claim.");
      return {
        id: `${section.id}:finding:${index + 1}`,
        classification: claim.classification,
        summary: claim.statement,
        sourceIds: claim.sourceIds,
      };
    }),
  }));
  const executiveSummary = report.executiveSummaryClaimIds.length === 0
    ? "No current, evidence-backed claim was available for publication."
    : report.executiveSummaryClaimIds
      .map((id) => claimsById.get(id)?.statement)
      .filter((statement): statement is string => statement !== undefined)
      .join(" ");
  const legacy: Omit<ResearchReportV1, "markdown"> = {
    schema: RESEARCH_REPORT_SCHEMA_V1,
    title: report.title,
    question: report.question,
    scope: report.scope,
    executiveSummary,
    findings: [],
    relationships: [],
    limitations: report.limitations,
    sources: report.sources,
    run: report.run,
  };
  // Reuse the legacy contract validator for source URLs and run metadata, then
  // project the host-approved outline through the same safe Markdown helpers.
  finalizeResearchReportV1(legacy);
  return [
    ...renderResearchReportWithFindingSectionsMarkdown({
      ...legacy,
      sections,
      language,
    }).trimEnd().split("\n"),
    ...coverageMarkdown({ ...report, markdown: "" }, language),
    ...reconciliationMarkdown({ ...report, markdown: "" }, language),
    ...sourceAuthorityMarkdown({ ...report, markdown: "" }, language),
  ].join("\n");
}

function reconciliationOutcome(value: unknown): ResearchReportReconciliationV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("V2 report reconciliation outcome is invalid.");
  const outcome = value as Partial<ResearchReportReconciliationV2>;
  const target = outcome.target;
  if (typeof outcome.defectId !== "string" || outcome.defectId.length === 0 || outcome.defectId.length > 160 ||
      !target || typeof target !== "object" ||
      !["finding", "relationship", "claim", "section", "node", "coverage"].includes(target.kind ?? "") ||
      typeof target.id !== "string" || target.id.length === 0 || target.id.length > 160 ||
      !["reject_defect", "revise", "downgrade", "add_follow_up", "abstain", "no_change"].includes(outcome.decision ?? "") ||
      !["invalid_reference", "already_resolved", "supported_by_evidence", "material_defect", "insufficient_budget", "outside_approval_envelope"].includes(outcome.reasonCode ?? "")) {
    invalid("V2 report reconciliation outcome is invalid.");
  }
  return {
    defectId: outcome.defectId,
    target: { kind: target.kind, id: target.id },
    decision: outcome.decision,
    reasonCode: outcome.reasonCode,
  } as ResearchReportReconciliationV2;
}

function sourceAuthorityEntries(value: unknown, sourceIds: ReadonlySet<string>): ResearchReportSourceAuthorityV2[] {
  if (!Array.isArray(value) || value.length !== sourceIds.size || value.length > MAXIMUM_REPORT_CLAIMS) {
    invalid("V2 report source authority projection is invalid.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      invalid("V2 report source authority projection is invalid.");
    }
    const candidate = entry as Partial<ResearchReportSourceAuthorityV2>;
    if (typeof candidate.sourceId !== "string" || !sourceIds.has(candidate.sourceId) ||
        seen.has(candidate.sourceId) || !Array.isArray(candidate.authorityClasses) ||
        candidate.authorityClasses.length === 0 || candidate.authorityClasses.length > 2 ||
        candidate.authorityClasses.some((authority) => authority !== "whole_scope" && authority !== "exact_entity") ||
        new Set(candidate.authorityClasses).size !== candidate.authorityClasses.length) {
      invalid("V2 report source authority projection is invalid.");
    }
    seen.add(candidate.sourceId);
    return {
      sourceId: candidate.sourceId,
      authorityClasses: [...candidate.authorityClasses].sort(),
    } as ResearchReportSourceAuthorityV2;
  }).sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

/**
 * Reject malformed V2 reports before they reach a renderer or future exporter.
 * This intentionally validates structure and provenance, not model prose: V2
 * factual statements are copied from the host claim ledger by the finalizer.
 */
export function assertResearchReportV2(value: unknown): asserts value is ResearchReportV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("V2 report is invalid.");
  const report = value as Partial<ResearchReportV2>;
  if (report.schema !== RESEARCH_REPORT_SCHEMA_V2 || !Array.isArray(report.claims) || !Array.isArray(report.sections) ||
      !Array.isArray(report.coverage) || !Array.isArray(report.limitations) || !Array.isArray(report.sources) || !Array.isArray(report.executiveSummaryClaimIds)) {
    invalid("V2 report schema is invalid.");
  }
  if (report.reconciliation !== undefined &&
      (!Array.isArray(report.reconciliation) || report.reconciliation.length > MAXIMUM_RECONCILIATION_OUTCOMES)) {
    invalid("V2 report reconciliation is invalid.");
  }
  boundedText(report.title, "V2 report title", 300);
  boundedText(report.question, "V2 report question", 4_000);
  if (report.claims.length > MAXIMUM_REPORT_CLAIMS || report.sections.length === 0 || report.sections.length > MAXIMUM_REPORT_SECTIONS) {
    invalid("V2 report claim or section count is invalid.");
  }
  const claims = new Map<string, ResearchReportClaimV2>();
  for (const claim of report.claims) {
    if (!claim || typeof claim !== "object" || !CLAIM_ID.test(claim.id) ||
        (claim.classification !== "fact" && claim.classification !== "inference") || claim.freshness !== "current" ||
        !Array.isArray(claim.evidenceIds) || claim.evidenceIds.length === 0 || !Array.isArray(claim.sourceIds) || claim.sourceIds.length === 0) {
      invalid("V2 report claim is invalid.");
    }
    boundedText(claim.statement, "V2 report claim statement", 2_000);
    if (claims.has(claim.id)) invalid("V2 report contains duplicate claim IDs.");
    claims.set(claim.id, claim);
  }
  const sourceIds = new Set(report.sources.map((source) => source.id));
  for (const claim of claims.values()) {
    if (claim.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) invalid("V2 report claim source is missing.");
  }
  if (report.sourceAuthorities !== undefined) {
    sourceAuthorityEntries(report.sourceAuthorities, sourceIds);
  }
  const summaries = distinctClaimIds(report.executiveSummaryClaimIds, "V2 report executive summary claims");
  if (summaries.some((id) => !claims.has(id))) invalid("V2 report executive summary references an unknown claim.");
  const sectionIds = new Set<string>();
  for (const section of report.sections) {
    if (!section || typeof section !== "object" || typeof section.id !== "string" || sectionIds.has(section.id) ||
        !Array.isArray(section.claimIds) || !Array.isArray(section.coverageTargetIds)) {
      invalid("V2 report section is invalid.");
    }
    sectionIds.add(section.id);
    boundedText(section.title, "V2 report section title", 240);
    boundedText(section.question, "V2 report section question", 1_200);
    const ids = distinctClaimIds(section.claimIds, "V2 report section claim IDs");
    if (ids.some((id) => !claims.has(id))) invalid("V2 report section references an unknown claim.");
  }
  const evidenceIds = new Set(report.claims.flatMap((claim) => claim.evidenceIds));
  for (const coverage of report.coverage) {
    if (!coverage || typeof coverage !== "object" ||
        !["covered", "partial", "uncovered"].includes(coverage.status) ||
        !Array.isArray(coverage.claimIds) || !Array.isArray(coverage.evidenceIds) ||
        !Number.isSafeInteger(coverage.distinctSourceCount) || coverage.distinctSourceCount < 0) {
      invalid("V2 report coverage is invalid.");
    }
    const coverageClaimIds = distinctClaimIds(coverage.claimIds, "V2 report coverage claim IDs");
    if (coverageClaimIds.some((id) => !claims.has(id)) || coverage.evidenceIds.some((id) => !evidenceIds.has(id))) {
      invalid("V2 report coverage references unavailable support.");
    }
  }
  const reconciliationDefectIds = new Set<string>();
  for (const outcome of report.reconciliation ?? []) {
    const validated = reconciliationOutcome(outcome);
    if (reconciliationDefectIds.has(validated.defectId)) invalid("V2 report reconciliation defect is duplicated.");
    reconciliationDefectIds.add(validated.defectId);
  }
  if (!report.run || typeof report.run !== "object" || typeof report.markdown !== "string") invalid("V2 report run or Markdown is invalid.");
}

export interface FinalizeResearchReportV2Input {
  request: ResearchRequestV1;
  claimLedger: ResearchClaimLedgerV1;
  evidenceStore: ResearchEvidenceStoreV1;
  /** Explicit host-selected claims; omitted means the authoritative outline set. */
  claimIds?: readonly string[];
  /** Must have passed `ResearchOutlineStoreV1.validateCurrent()` before use. */
  outline?: ResearchOutlineV1;
  title?: string;
  /** Host-authored, evidence-state limitations only; model prose is not accepted here. */
  limitations?: readonly string[];
  /**
   * Optional source focus selected by the schema-bound synthesizer. Each ID is
   * checked against the current claim/evidence set before it can affect which
   * host-validated claims are published; the synthesizer never supplies the
   * factual report prose.
   */
  selectedSourceIds?: readonly string[];
  /** Host-recorded reconciliation results; never critic prose or source support. */
  reconciliation?: readonly ResearchReportReconciliationV2[];
  run: ResearchRunSummaryV1;
  checkedAt: string;
}

function selectedSourceSet(value: readonly string[] | undefined): Set<string> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAXIMUM_REPORT_CLAIMS) {
    invalid("V2 report selected source IDs are invalid.");
  }
  return new Set(value.map((sourceId) =>
    boundedText(sourceId, "V2 report selected source ID", 320)
  ));
}

function normalizedReconciliation(
  value: readonly ResearchReportReconciliationV2[] | undefined,
): ResearchReportReconciliationV2[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAXIMUM_RECONCILIATION_OUTCOMES) {
    invalid("V2 report reconciliation is invalid.");
  }
  const outcomes = value.map(reconciliationOutcome);
  if (new Set(outcomes.map((outcome) => outcome.defectId)).size !== outcomes.length) {
    invalid("V2 report reconciliation defect is duplicated.");
  }
  return outcomes.map((outcome) => structuredClone(outcome));
}

/**
 * Project host-accepted reconciliation outcomes for operator visibility. The
 * critic's explanation and support references deliberately do not cross this
 * boundary: neither is report evidence nor report prose.
 */
export function projectResearchReportReconciliationV2(
  defects: readonly ResearchReconciliationDefectV1[],
  dispositions: readonly ResearchReconciliationDispositionV1[],
): ResearchReportReconciliationV2[] {
  const dispositionsByDefectId = new Map(
    dispositions.map((disposition) => [disposition.defectId, disposition]),
  );
  if (defects.length !== dispositionsByDefectId.size) {
    invalid("Every reconciliation defect requires one host-recorded disposition.");
  }
  return normalizedReconciliation(defects.map((defect) => {
    const disposition = dispositionsByDefectId.get(defect.id);
    if (!disposition) invalid("A reconciliation disposition is missing its defect.");
    return {
      defectId: defect.id,
      target: structuredClone(defect.target),
      decision: disposition.decision,
      reasonCode: disposition.reasonCode,
    };
  }));
}

/**
 * Finalize a V2 report from private host ledgers. Every published statement is
 * copied from a `current` claim after its exact evidence spans were refreshed.
 * The function deliberately accepts no model-authored Markdown or findings.
 */
export async function finalizeResearchReportV2(
  input: FinalizeResearchReportV2Input,
): Promise<ResearchReportV2> {
  if (!Number.isFinite(Date.parse(input.checkedAt))) invalid("V2 report freshness check time is invalid.");
  const selectedSources = selectedSourceSet(input.selectedSourceIds);
  const requestedIds = input.claimIds === undefined
    ? input.outline
      ? [...new Set([
          ...input.outline.sections.flatMap((section) => section.claimIds),
          ...input.outline.coverage.flatMap((entry) => entry.claimIds),
        ])]
      : []
    : distinctClaimIds(input.claimIds, "V2 report claim IDs");
  if (requestedIds.length > MAXIMUM_REPORT_CLAIMS) invalid("V2 report contains too many requested claims.");
  const claims: ResearchClaimV1[] = [];
  const staleLimitations: string[] = [];
  const records = new Map<string, ResearchEvidenceRecordV1>();
  const sources = new Map<string, ResearchSourceReferenceV1>();
  for (const claimId of requestedIds) {
    const claim = await input.claimLedger.refresh(claimId, input.checkedAt);
    if (!claim) invalid("V2 report references a claim that is not retained.");
    if (claim.freshness !== "current") {
      staleLimitations.push("A selected claim was excluded because its evidence is no longer current.");
      continue;
    }
    for (const evidenceId of claim.evidenceIds) {
      const record = await input.evidenceStore.get(evidenceId);
      if (!record || record.identity.tenantOrigin !== input.request.scope.siteOrigin) {
        invalid("V2 report claim evidence is unavailable or outside the approved tenant.");
      }
      records.set(evidenceId, record);
      const existing = sources.get(record.source.id);
      if (existing && !sameSource(existing, record.source)) {
        invalid("V2 report has inconsistent source metadata for one source ID.");
      }
      sources.set(record.source.id, structuredClone(record.source));
    }
    claims.push(claim);
  }
  if (selectedSources && [...selectedSources].some((sourceId) => !sources.has(sourceId))) {
    invalid("V2 report selects a source outside its current evidence.");
  }
  const selectedClaims = selectedSources === undefined
    ? claims
    : claims.filter((claim) => sourceIdsForClaim(claim, records)
      .some((sourceId) => selectedSources.has(sourceId)));
  const reportClaims: ResearchReportClaimV2[] = selectedClaims.map((claim) => ({
    id: claim.id,
    classification: claim.classification,
    statement: claim.statement,
    freshness: "current",
    evidenceIds: [...claim.evidenceIds],
    sourceIds: sourceIdsForClaim(claim, records),
  }));
  const currentClaimIds = new Set(reportClaims.map((claim) => claim.id));
  const currentEvidenceIds = new Set(reportClaims.flatMap((claim) => claim.evidenceIds));
  const reportSourceIds = new Set(reportClaims.flatMap((claim) => claim.sourceIds));
  const authorityClassesBySourceId = new Map<string, Set<"whole_scope" | "exact_entity">>();
  for (const evidenceId of currentEvidenceIds) {
    const record = records.get(evidenceId);
    if (!record || !reportSourceIds.has(record.source.id)) continue;
    const authorities = authorityClassesBySourceId.get(record.source.id) ?? new Set();
    authorities.add(record.authority.authorityClass);
    authorityClassesBySourceId.set(record.source.id, authorities);
  }
  const coverage = (input.outline?.coverage ?? []).map((entry) => {
    const claimIds = entry.claimIds.filter((id) => currentClaimIds.has(id));
    const evidenceIds = entry.evidenceIds.filter((id) => currentEvidenceIds.has(id));
    const distinctSourceCount = new Set(evidenceIds.map((id) => records.get(id)?.identity.canonicalId)).size;
    return {
      targetId: entry.targetId,
      status: claimIds.length === entry.claimIds.length && evidenceIds.length === entry.evidenceIds.length
        ? entry.status
        : evidenceIds.length === 0 ? "uncovered" as const : "partial" as const,
      claimIds,
      evidenceIds,
      distinctSourceCount,
    };
  });
  const report = {
    schema: RESEARCH_REPORT_SCHEMA_V2,
    title: input.title === undefined ? "Evidence-backed research" : boundedText(input.title, "V2 report title", 300),
    question: input.request.question,
    scope: structuredClone(input.request.scope),
    executiveSummaryClaimIds: reportClaims.slice(0, 4).map((claim) => claim.id),
    claims: reportClaims,
    sections: sectionsFor(input.outline, reportClaims.map((claim) => claim.id)),
    coverage,
    reconciliation: normalizedReconciliation(input.reconciliation),
    sourceAuthorities: [...reportSourceIds]
      .map((sourceId) => ({
        sourceId,
        authorityClasses: [...(authorityClassesBySourceId.get(sourceId) ?? new Set())].sort(),
      }))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId)),
    limitations: [...new Set([
      ...(input.limitations ?? []).map((value) => localizeResearchLimitationV1(
        input.request.reportLanguage,
        boundedText(value, "V2 report limitation", 700),
      )),
      ...input.run.warnings.map((value) => boundedText(value, "V2 report run warning", 700)),
      ...staleLimitations.map((value) => localizeResearchLimitationV1(input.request.reportLanguage, value)),
      ...incompleteCoverageLimitations(coverage, input.request.reportLanguage),
    ])].slice(0, 12),
    sources: [...new Set(reportClaims.flatMap((claim) => claim.sourceIds))]
      .map((sourceId) => sources.get(sourceId)!)
      .sort((left, right) => left.id.localeCompare(right.id)),
    run: structuredClone(input.run),
  } satisfies Omit<ResearchReportV2, "markdown">;
  const finalized: ResearchReportV2 = { ...report, markdown: renderMarkdown(report, input.request.reportLanguage) };
  assertResearchReportV2(finalized);
  return finalized;
}
