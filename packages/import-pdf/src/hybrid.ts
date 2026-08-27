import {
  IMPORT_DOCUMENT_SCHEMA_V2,
  type ImportBlock,
  type ImportDocumentV2,
  type ImportIssue,
} from "@atlcli/import-core";
import {
  PDF_GEOMETRY_POLICY_REVISION_V2,
  PDF_HYBRID_POLICY_REVISION_V2,
  PDF_HYBRID_SEMANTICS_SCHEMA_V2,
  PDF_TAGGED_POLICY_REVISION_V2,
  type PdfCharacterOwnershipV2,
  type PdfDecisionEvidenceV2,
  type PdfFactsV2,
  type PdfHybridSemanticsV2,
  type PdfNormalizedRect,
  type PdfPageFactsV2,
  type PdfSourceLocatorV1,
} from "./contracts.js";
import {
  appendPdfTextAssemblyV2,
  pdfTextAssemblyConfidenceV2,
  pdfTextAssemblyIssuesV2,
  pdfTextBoundaryDecisionIdsV2,
} from "./assembly-evidence.js";
import { digestPdfCanonical, digestPdfFactsV2 } from "./canonical.js";
import { rectsTouch } from "./fallbacks.js";
import { mergePdfBlocksByEvidence } from "./figures.js";
import { PdfImportError } from "./issues.js";
import { taggedRunsV2 } from "./links.js";
import { normalizeTaggedPdfFactsV2 } from "./normalize.js";
import {
  analyzeGeometryReadingOrderV2,
  assembleGeometryFragmentsV2,
  type PdfGeometryFragmentV2,
} from "./reading-order.js";
import {
  PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
  type PdfTextBoundaryDecisionV2,
  type PdfTextTransformationV2,
} from "./text-assembly.js";
import { unionRects } from "./text.js";

export const PDF_HYBRID_POLICY_V2 = Object.freeze({
  localizedRegionJoinGap: 0.04,
  maximumLocalizedRegions: 2,
  maximumLocalizedRegionArea: 0.35,
} as const);

export interface PdfCharacterOwnershipAuditV2 {
  ownership: PdfCharacterOwnershipV2[];
  duplicateOwnershipAttemptCount: number;
  duplicateOwnershipAttemptsByPage: Array<{ pageIndex: number; count: number }>;
}

interface ResidualRegion {
  sourceId: string;
  fragments: PdfGeometryFragmentV2[];
  bbox: PdfNormalizedRect;
}

interface PageReconciliation {
  pageIndex: number;
  mode: "hybrid-native" | "hybrid-repaired" | "fallback-required";
  projectedNodeIds: string[];
  geometryRepairedCharacterIndexes: number[];
  geometryRepairRegionCount: number;
  duplicateOwnershipAttemptCount: number;
  fallbackScope: "none" | "region" | "page";
  fallbackReasonCodes: string[];
  fallbackRegionLocators: PdfSourceLocatorV1[];
  normalizedFallbackArea: number;
}

function isVisibleCharacter(value: string): boolean {
  return value !== "\r"
    && value !== "\n"
    && value.replace(/[\s\u00ad]/gu, "").length > 0;
}

function ownershipBasis(entry: PdfDecisionEvidenceV2): PdfCharacterOwnershipV2["basis"] {
  if (entry.decisionCode.includes("fallback")) return "fallback";
  if (entry.analyzerRevision === PDF_TAGGED_POLICY_REVISION_V2 || entry.basis.includes("structure-tree")) {
    return entry.targetNodeId ? "tagged" : "reported";
  }
  if (
    entry.analyzerRevision === PDF_GEOMETRY_POLICY_REVISION_V2
    || entry.analyzerRevision === PDF_HYBRID_POLICY_REVISION_V2
    || entry.basis.includes("text-geometry")
  ) return entry.targetNodeId ? "geometry" : "reported";
  return entry.targetNodeId ? "tagged" : "reported";
}

function isAggregateOwnershipEvidence(entry: PdfDecisionEvidenceV2): boolean {
  return [
    "pdf/tagged-list-native",
    "pdf/geometry-list-native",
    "pdf/table-tagged-native",
    "pdf/table-untagged-grid-native",
  ].includes(entry.decisionCode);
}

export function auditPdfCharacterOwnershipV2(
  facts: Pick<PdfFactsV2, "pages">,
  evidence: readonly PdfDecisionEvidenceV2[],
): PdfCharacterOwnershipAuditV2 {
  const visible = new Map<string, { pageIndex: number; characterIndex: number }>(facts.pages.flatMap((page) => page.characters
    .filter((character) => isVisibleCharacter(character.value))
    .map((character) => [`${page.index}:${character.index}`, { pageIndex: page.index, characterIndex: character.index }] as const)));
  const ownership = new Map<string, PdfCharacterOwnershipV2>();
  let duplicateOwnershipAttemptCount = 0;
  const duplicateOwnershipAttemptsByPage = new Map<number, number>();
  for (const entry of evidence) {
    if (isAggregateOwnershipEvidence(entry)) continue;
    for (const characterIndex of entry.locator.characterIndexes ?? []) {
      const key = `${entry.locator.pageIndex}:${characterIndex}`;
      const character = visible.get(key);
      if (!character) continue;
      const candidate: PdfCharacterOwnershipV2 = {
        ...character,
        ownerSourceId: entry.sourceId,
        ...(entry.targetNodeId ? { targetNodeId: entry.targetNodeId } : {}),
        basis: ownershipBasis(entry),
        outcome: entry.outcome,
      };
      const existing = ownership.get(key);
      if (!existing) ownership.set(key, candidate);
      else if (
        existing.ownerSourceId !== candidate.ownerSourceId
        || existing.targetNodeId !== candidate.targetNodeId
      ) {
        duplicateOwnershipAttemptCount += 1;
        duplicateOwnershipAttemptsByPage.set(
          character.pageIndex,
          (duplicateOwnershipAttemptsByPage.get(character.pageIndex) ?? 0) + 1,
        );
      }
    }
  }
  for (const [key, character] of visible) {
    if (!ownership.has(key)) {
      ownership.set(key, {
        ...character,
        ownerSourceId: `pdf:p${character.pageIndex}:unowned`,
        basis: "reported",
        outcome: "reported",
      });
    }
  }
  return {
    ownership: [...ownership.values()].sort((left, right) =>
      left.pageIndex - right.pageIndex || left.characterIndex - right.characterIndex
    ),
    duplicateOwnershipAttemptCount,
    duplicateOwnershipAttemptsByPage: [...duplicateOwnershipAttemptsByPage.entries()]
      .map(([pageIndex, count]) => ({ pageIndex, count }))
      .sort((left, right) => left.pageIndex - right.pageIndex),
  };
}

function residualPage(
  page: PdfPageFactsV2,
  residualIndexes: ReadonlySet<number>,
): PdfPageFactsV2 {
  const visible = page.characters.filter((character) => isVisibleCharacter(character.value));
  const previousVisible = new Map<number, number>();
  const nextVisible = new Map<number, number>();
  let previous = -1;
  for (const character of page.characters) {
    previousVisible.set(character.index, previous);
    if (isVisibleCharacter(character.value)) previous = character.index;
  }
  let next = -1;
  for (const character of [...page.characters].reverse()) {
    nextVisible.set(character.index, next);
    if (isVisibleCharacter(character.value)) next = character.index;
  }
  const supporting = new Set(page.characters.filter((character) => {
    if (isVisibleCharacter(character.value)) return false;
    const left = previousVisible.get(character.index) ?? -1;
    const right = nextVisible.get(character.index) ?? -1;
    return residualIndexes.has(left) && residualIndexes.has(right);
  }).map((character) => character.index));
  const characters = page.characters.filter((character) =>
    residualIndexes.has(character.index) || supporting.has(character.index)
  );
  const retained = new Set(characters.map((character) => character.index));
  if (visible.some((character) => residualIndexes.has(character.index) && !retained.has(character.index))) {
    throw new PdfImportError("pdf/incomplete", "Hybrid residual projection lost a visible source character.", {
      pageIndex: page.index,
    });
  }
  return {
    ...page,
    text: characters.map((character) => character.value).join(""),
    characters,
    structures: [],
    images: [],
    paths: [],
  };
}

function groupResidualRegions(fragments: readonly PdfGeometryFragmentV2[]): ResidualRegion[] {
  const remaining = [...fragments];
  const groups: PdfGeometryFragmentV2[][] = [];
  while (remaining.length > 0) {
    const group = [remaining.shift()!];
    for (let index = 0; index < remaining.length;) {
      if (group.some((fragment) =>
        rectsTouch(fragment.bbox, remaining[index]!.bbox, PDF_HYBRID_POLICY_V2.localizedRegionJoinGap)
      )) {
        group.push(remaining.splice(index, 1)[0]!);
        index = 0;
      } else index += 1;
    }
    groups.push(group);
  }
  return groups.map((fragments) => {
    const bbox = unionRects(fragments.map((fragment) => fragment.bbox))!;
    return {
      sourceId: `${fragments[0]!.id}:hybrid-region:${fragments.length}`,
      fragments: [...fragments].sort((left, right) =>
        left.column - right.column
        || left.physicalLineIndex - right.physicalLineIndex
        || left.bbox.x - right.bbox.x
        || left.sourceOrder - right.sourceOrder
      ),
      bbox,
    };
  }).sort((left, right) => left.bbox.y - right.bbox.y || left.bbox.x - right.bbox.x);
}

function overlaps(left: PdfNormalizedRect, right: PdfNormalizedRect): boolean {
  return Math.min(left.x + left.width, right.x + right.width) > Math.max(left.x, right.x)
    && Math.min(left.y + left.height, right.y + right.height) > Math.max(left.y, right.y);
}

function boundaryCounts(
  pageIndex: number,
  evidence: readonly PdfDecisionEvidenceV2[],
  boundaries: readonly PdfTextBoundaryDecisionV2[],
): { explicit: number; inferred: number; unresolved: number } {
  const ids = new Set(evidence.filter((entry) => entry.locator.pageIndex === pageIndex)
    .flatMap((entry) => entry.boundaryDecisionIds));
  const pageBoundaries = boundaries.filter((boundary) => ids.has(boundary.id));
  const explicit = pageBoundaries.filter((boundary) => boundary.action === "preserve-explicit-space").length;
  const unresolved = pageBoundaries.filter((boundary) => boundary.action === "unresolved").length;
  return { explicit, unresolved, inferred: pageBoundaries.length - explicit - unresolved };
}

export async function normalizeHybridPdfFactsV2(
  facts: PdfFactsV2,
  factsDigest: string,
): Promise<PdfHybridSemanticsV2> {
  if (await digestPdfFactsV2(facts) !== factsDigest) {
    throw new PdfImportError(
      "pdf/provenance-drift",
      "PDF V2 facts differ from the digest supplied to hybrid semantic normalization.",
    );
  }
  if (!facts.tagged) {
    throw new PdfImportError("pdf/incomplete", "Hybrid normalization requires a tagged PDF.");
  }
  const tagged = await normalizeTaggedPdfFactsV2(facts, factsDigest);
  const evidence = tagged.evidence.map((entry) => ({ ...entry }));
  const boundaries: PdfTextBoundaryDecisionV2[] = tagged.boundaries.map((entry) => ({ ...entry }));
  const transformations: PdfTextTransformationV2[] = tagged.transformations.map((entry) => ({ ...entry }));
  let issues: ImportIssue[] = tagged.document.issues.map((issue) => ({ ...issue }));
  const additions: Array<{ block: ImportBlock; pageIndex: number; y: number; x: number; height: number }> = [];
  const reconciliations: PageReconciliation[] = [];
  const pagesWithHybridResidual = new Set<number>();

  for (const page of facts.pages) {
    const initialAudit = auditPdfCharacterOwnershipV2(facts, evidence);
    const taggedOwned = new Set(initialAudit.ownership.filter((entry) =>
      entry.pageIndex === page.index && entry.basis === "tagged" && entry.targetNodeId
    ).map((entry) => entry.characterIndex));
    const visible = page.characters.filter((character) => isVisibleCharacter(character.value));
    const residualIndexes = new Set(visible
      .filter((character) => !taggedOwned.has(character.index))
      .map((character) => character.index));
    const projectedNodeIds = tagged.pageOutcomes.find((outcome) => outcome.pageIndex === page.index)
      ?.projectedNodeIds ?? [];
    const duplicateOwnershipAttemptCount = initialAudit.duplicateOwnershipAttemptsByPage
      .find((entry) => entry.pageIndex === page.index)?.count ?? 0;
    if (residualIndexes.size === 0 && duplicateOwnershipAttemptCount === 0) {
      reconciliations.push({
        pageIndex: page.index,
        mode: "hybrid-native",
        projectedNodeIds: [...projectedNodeIds],
        geometryRepairedCharacterIndexes: [],
        geometryRepairRegionCount: 0,
        duplicateOwnershipAttemptCount: 0,
        fallbackScope: "none",
        fallbackReasonCodes: [],
        fallbackRegionLocators: [],
        normalizedFallbackArea: 0,
      });
      continue;
    }
    pagesWithHybridResidual.add(page.index);

    const residual = residualPage(page, residualIndexes);
    const analysis = analyzeGeometryReadingOrderV2(residual);
    const fragments = analysis.fragments.filter((fragment) =>
      fragment.assembly.characterIndexes.some((index) => residualIndexes.has(index))
    );
    const accounted = new Set(fragments.flatMap((fragment) => fragment.assembly.characterIndexes)
      .filter((index) => residualIndexes.has(index)));
    const regions = groupResidualRegions(fragments);
    const acceptedTaggedBoxes = evidence.filter((entry) =>
      entry.locator.pageIndex === page.index
      && entry.targetNodeId
      && entry.locator.bbox
    ).map((entry) => entry.locator.bbox!);
    const pageReasons = new Set<string>();
    if ([...residualIndexes].some((index) => !accounted.has(index))) pageReasons.add("missing-geometry");
    if (duplicateOwnershipAttemptCount > 0) pageReasons.add("duplicate-character-ownership");
    if (regions.length > PDF_HYBRID_POLICY_V2.maximumLocalizedRegions) pageReasons.add("dispersed-residual-regions");
    if (regions.some((region) => region.bbox.width * region.bbox.height > PDF_HYBRID_POLICY_V2.maximumLocalizedRegionArea)) {
      pageReasons.add("oversized-residual-region");
    }
    if (regions.some((region) => acceptedTaggedBoxes.some((bbox) => overlaps(region.bbox, bbox)))) {
      pageReasons.add("overlapping-tagged-owner");
    }
    for (const reason of analysis.qualificationReasons) {
      if ([
        "missing-geometry",
        "conflicting-overlap",
        "non-horizontal-text",
        "unicode-map-error",
        "too-many-columns",
        "column-overlap",
      ].includes(reason)) pageReasons.add(reason);
    }

    const repairedIndexes: number[] = [];
    const fallbackLocators: PdfSourceLocatorV1[] = [];
    const fallbackReasonCodes = new Set<string>();
    if (pageReasons.size > 0 || regions.length === 0) {
      const sourceId = `pdf:p${page.index}:hybrid-page-fallback`;
      const regionAssemblies = regions.map((region) => region.fragments.length === 1
        ? region.fragments[0]!.assembly
        : assembleGeometryFragmentsV2(residual, region.sourceId, region.fragments));
      for (const assembly of regionAssemblies) {
        appendPdfTextAssemblyV2({ boundaries, transformations }, assembly);
        issues.push(...pdfTextAssemblyIssuesV2(assembly, page.index, sourceId));
      }
      evidence.push({
        sourceId,
        locator: { pageIndex: page.index, characterIndexes: [...residualIndexes].sort((a, b) => a - b) },
        basis: ["text-geometry", "text-boundary"],
        confidence: 0,
        decisionCode: "pdf/hybrid-page-fallback-required",
        outcome: "reported",
        analyzerRevision: PDF_HYBRID_POLICY_REVISION_V2,
        boundaryDecisionIds: regionAssemblies.flatMap(pdfTextBoundaryDecisionIdsV2),
      });
      if (pageReasons.size > 0) {
        for (const reason of [...pageReasons].sort()) fallbackReasonCodes.add(reason);
      } else fallbackReasonCodes.add("unlocalized-residual");
      issues.push({
        code: "pdf-import/hybrid-page-fallback-required",
        severity: "warning",
        outcome: "reported",
        message: "Residual visible characters cannot be repaired or localized without page-level ambiguity.",
        sourceRefs: [sourceId],
        context: { pageIndex: page.index, characters: residualIndexes.size },
      });
      reconciliations.push({
        pageIndex: page.index,
        mode: "fallback-required",
        projectedNodeIds: [...projectedNodeIds],
        geometryRepairedCharacterIndexes: [],
        geometryRepairRegionCount: 0,
        duplicateOwnershipAttemptCount,
        fallbackScope: "page",
        fallbackReasonCodes: [...fallbackReasonCodes],
        fallbackRegionLocators: [],
        normalizedFallbackArea: 1,
      });
      continue;
    }

    const regionFallbackRequired = analysis.qualificationReasons.length > 0;
    for (const region of regions) {
      const assembly = region.fragments.length === 1
        ? region.fragments[0]!.assembly
        : assembleGeometryFragmentsV2(residual, region.sourceId, region.fragments);
      appendPdfTextAssemblyV2({ boundaries, transformations }, assembly);
      issues.push(...pdfTextAssemblyIssuesV2(assembly, page.index, region.sourceId));
      const regionIndexes = assembly.characterIndexes.filter((index) => residualIndexes.has(index));
      const unresolved = assembly.unresolvedBoundaryCount > 0;
      if (regionFallbackRequired || unresolved) {
        const locator: PdfSourceLocatorV1 = {
          pageIndex: page.index,
          bbox: region.bbox,
          structurePath: region.sourceId,
          characterIndexes: regionIndexes,
        };
        fallbackLocators.push(locator);
        fallbackReasonCodes.add(unresolved ? "unresolved-text-boundary" : "under-evidenced-residual-layout");
        evidence.push({
          sourceId: region.sourceId,
          locator,
          basis: ["text-geometry", "text-boundary"],
          confidence: 0,
          decisionCode: "pdf/hybrid-region-fallback-required",
          outcome: "reported",
          analyzerRevision: PDF_HYBRID_POLICY_REVISION_V2,
          boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(assembly),
        });
        continue;
      }
      const blockId = `${region.sourceId}:paragraph`;
      const linked = taggedRunsV2(
        assembly,
        region.fragments.flatMap((fragment) => fragment.characters),
        page.annotations,
      );
      additions.push({
        block: {
          id: blockId,
          type: "paragraph",
          runs: linked.runs,
          sourceRefs: region.fragments.map((fragment) => fragment.id),
        },
        pageIndex: page.index,
        y: region.bbox.y,
        x: region.bbox.x,
        height: region.bbox.height,
      });
      repairedIndexes.push(...regionIndexes);
      evidence.push({
        sourceId: region.sourceId,
        targetNodeId: blockId,
        locator: {
          pageIndex: page.index,
          bbox: region.bbox,
          structurePath: region.sourceId,
          characterIndexes: regionIndexes,
          ...(linked.annotationIds[0] ? { annotationId: linked.annotationIds[0] } : {}),
        },
        basis: [
          "text-geometry",
          "text-boundary",
          ...(linked.annotationIds.length > 0 ? ["annotation" as const] : []),
        ],
        confidence: Math.min(0.9, pdfTextAssemblyConfidenceV2(assembly)),
        decisionCode: "pdf/hybrid-geometry-repair",
        outcome: "approximated",
        analyzerRevision: PDF_HYBRID_POLICY_REVISION_V2,
        boundaryDecisionIds: pdfTextBoundaryDecisionIdsV2(assembly),
      });
    }
    if (repairedIndexes.length > 0) {
      issues.push({
        code: "pdf-import/hybrid-geometry-repair",
        severity: "info",
        outcome: "approximated",
        message: "Localized residual text was recovered geometrically with unique source-character ownership.",
        sourceRefs: [`pdf:p${page.index}`],
        context: { pageIndex: page.index, characters: repairedIndexes.length, regions: regions.length },
      });
    }
    if (fallbackLocators.length > 0) {
      issues.push({
        code: "pdf-import/hybrid-region-fallback-required",
        severity: "warning",
        outcome: "reported",
        message: "Localized residual text requires bounded visual fallback coverage.",
        sourceRefs: fallbackLocators.flatMap((locator) => locator.structurePath ? [locator.structurePath] : []),
        context: { pageIndex: page.index, regions: fallbackLocators.length },
      });
    }
    reconciliations.push({
      pageIndex: page.index,
      mode: fallbackLocators.length > 0 ? "fallback-required" : "hybrid-repaired",
      projectedNodeIds: [
        ...projectedNodeIds,
        ...additions.filter((addition) => addition.pageIndex === page.index).map((addition) => addition.block.id),
      ],
      geometryRepairedCharacterIndexes: [...new Set(repairedIndexes)].sort((a, b) => a - b),
      geometryRepairRegionCount: repairedIndexes.length > 0 ? regions.length - fallbackLocators.length : 0,
      duplicateOwnershipAttemptCount,
      fallbackScope: fallbackLocators.length > 0 ? "region" : "none",
      fallbackReasonCodes: [...fallbackReasonCodes].sort(),
      fallbackRegionLocators: fallbackLocators,
      normalizedFallbackArea: fallbackLocators.reduce((sum, locator) =>
        sum + (locator.bbox ? locator.bbox.width * locator.bbox.height : 0), 0),
    });
  }

  issues = issues.filter((issue) =>
    issue.code !== "pdf-import/tagged-text-unclaimed"
    || typeof issue.context?.pageIndex !== "number"
    || !pagesWithHybridResidual.has(issue.context.pageIndex)
  );
  const document: ImportDocumentV2 = {
    schema: IMPORT_DOCUMENT_SCHEMA_V2,
    sourceKind: "pdf",
    ...(tagged.document.titleCandidate ? { titleCandidate: tagged.document.titleCandidate } : {}),
    blocks: mergePdfBlocksByEvidence(tagged.document.blocks, additions, evidence),
    assets: [...tagged.document.assets],
    issues,
  };
  const audit = auditPdfCharacterOwnershipV2(facts, evidence);
  const ownership = audit.ownership;
  const pageOutcomes = reconciliations.map((reconciliation) => {
    const counts = boundaryCounts(reconciliation.pageIndex, evidence, boundaries);
    const pageOwnership = ownership.filter((entry) => entry.pageIndex === reconciliation.pageIndex);
    return {
      pageIndex: reconciliation.pageIndex,
      mode: reconciliation.mode,
      projectedNodeIds: reconciliation.projectedNodeIds,
      visibleCharacterCount: facts.pages[reconciliation.pageIndex]!.characters
        .filter((character) => isVisibleCharacter(character.value)).length,
      uniquelyOwnedCharacterCount: pageOwnership.length,
      explicitBoundaryCount: counts.explicit,
      inferredBoundaryCount: counts.inferred,
      unresolvedBoundaryCount: counts.unresolved,
      geometryRepairedCharacterCount: reconciliation.geometryRepairedCharacterIndexes.length,
      geometryRepairRegionCount: reconciliation.geometryRepairRegionCount,
      duplicateOwnershipAttemptCount: Math.max(
        reconciliation.duplicateOwnershipAttemptCount,
        audit.duplicateOwnershipAttemptsByPage.find((entry) =>
          entry.pageIndex === reconciliation.pageIndex
        )?.count ?? 0,
      ),
      residualReportedCharacterCount: pageOwnership.filter((entry) => entry.outcome === "reported").length,
      fallbackScope: reconciliation.fallbackScope,
      fallbackReasonCodes: reconciliation.fallbackReasonCodes,
      fallbackRegionLocators: reconciliation.fallbackRegionLocators,
      normalizedFallbackArea: reconciliation.normalizedFallbackArea,
    };
  });
  const requiresFallbackPages = pageOutcomes.filter((outcome) => outcome.fallbackScope !== "none")
    .map((outcome) => outcome.pageIndex);
  const digestInput = {
    schema: PDF_HYBRID_SEMANTICS_SCHEMA_V2,
    factsDigest,
    policyRevision: PDF_HYBRID_POLICY_REVISION_V2,
    textAssemblyPolicyRevision: PDF_TEXT_ASSEMBLY_POLICY_REVISION_V2,
    document,
    evidence,
    boundaries,
    transformations,
    ownership,
    pageOutcomes,
    requiresFallbackPages,
  };
  return { ...digestInput, semanticDigest: await digestPdfCanonical(digestInput) };
}
