/**
 * Host-neutral DOCX-to-PDF-template intake application boundary.
 *
 * The analyzer owns OOXML facts and candidate projection. Hosts inject the
 * supported PDF catalog, font inventory, asset capability catalog, asset
 * store, and progress sink. No source path, terminal state, filesystem
 * adapter, or localized copy crosses this boundary.
 */
import {
  createTemplateCandidate,
  deriveSemanticReconciliationKey,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type TemplateCandidateV1,
  type TemplateDiagnosticV1,
  type TemplateImportProgressEventV1,
  type TemplateProjectAnalysisV1,
} from "@atlcli/pdf-template-authoring";
import {
  canonicalCapabilityJson,
  type TemplateAssetCapabilitiesV1,
  type TemplateCapabilityCatalogV1,
} from "@atlcli/template-pack";
import { sha256Hex } from "@atlcli/core";
import {
  analyzeDocxTemplateForCatalog,
} from "./design-analysis.js";
import { DOCX_PDF_MAPPING_RULE_V1 } from "./matching.js";
import {
  analyzeDocxVisualAssets,
  DOCX_VISUAL_ANALYSIS_RULE_V1,
  type DocxVisualAnalysisV1,
  type DocxVisualPrivateSidecarV1,
  type SceneCandidateV1,
} from "./visual-analysis.js";
import type {
  DocxSectionResolutionV1,
  ResolvedDocxPageGeometryV1,
  ResolvedDocxSectionV1,
} from "./section-resolution.js";

export const DOCX_TEMPLATE_IMPORT_APPLICATION_SCHEMA_V1 =
  "wiki.pdf-template-docx-application/v1" as const;

export interface DocxTemplatePrivateAssetCandidateV1 {
  candidateId: string;
  semanticKey: string;
  asset: TemplateAssetHandleV1;
  occurrenceCount: number;
  proposedRole?: string;
  supportedPlacementChoices: readonly string[];
  candidatePlacement?: Readonly<Record<string, unknown>>;
}

export interface DocxTemplateImportApplicationResultV1 {
  schema: typeof DOCX_TEMPLATE_IMPORT_APPLICATION_SCHEMA_V1;
  analysis: TemplateProjectAnalysisV1;
  assetHandles: Readonly<Record<string, TemplateAssetHandleV1>>;
  visualAnalysis?: DocxVisualAnalysisV1;
  privateVisual?: DocxVisualPrivateSidecarV1;
  privateAssetCandidates: readonly DocxTemplatePrivateAssetCandidateV1[];
}

export interface AnalyzeDocxTemplateImportOptionsV1 {
  catalog: TemplateCapabilityCatalogV1;
  bundledFontFamilies: readonly string[];
  assetCapabilities: TemplateAssetCapabilitiesV1;
  assetStore: TemplateAssetStore;
  metadataOnly?: boolean;
  progress?: (event: TemplateImportProgressEventV1) => void;
}

function runtimeAssetRole(role: string | undefined): string | undefined {
  switch (role) {
    case "logo":
    case "asset.logo":
      return "asset.logo";
    case "page-background":
    case "asset.pageBackground":
      return "asset.pageBackground";
    case "cover-art":
    case "asset.coverBackground":
      return "asset.coverBackground";
    case "header-decoration":
    case "asset.headerDecoration":
      return "asset.headerDecoration";
    case "footer-decoration":
    case "asset.footerDecoration":
      return "asset.footerDecoration";
    default:
      return undefined;
  }
}

function emuLength(value: number): string {
  return `${Number((value / 36000).toFixed(3))}mm`;
}

function supportedCandidatePlacement(
  scene: SceneCandidateV1 | undefined,
  sections: DocxSectionResolutionV1
): Readonly<Record<string, unknown>> | undefined {
  if (
    scene?.placement?.kind !== "anchor" ||
    scene.placement.resolution === "layout-dependent"
  ) {
    return undefined;
  }
  const extent = scene.placement.extent;
  const horizontal = scene.placement.horizontal;
  const vertical = scene.placement.vertical;
  const section = sections.sections.find(
    (candidate) => candidate.section === scene.scope.section
  );
  if (
    horizontal.value.kind !== "offset" ||
    vertical.value.kind !== "offset" ||
    !section
  ) {
    return undefined;
  }
  const marginOffset = (
    axis: "horizontal" | "vertical",
    relativeFrom: string,
    emu: number,
    resolvedSection: ResolvedDocxSectionV1,
    page: ResolvedDocxPageGeometryV1
  ): number | undefined => {
    if (relativeFrom === "margin") return emu;
    if (
      axis === "horizontal" &&
      relativeFrom === "column" &&
      resolvedSection.columnCount === 1
    ) {
      return emu;
    }
    if (relativeFrom === "page") {
      const marginTwips =
        axis === "horizontal"
          ? page.marginLeftTwips
          : page.marginTopTwips;
      return emu - marginTwips * 635;
    }
    return undefined;
  };
  const x = marginOffset(
    "horizontal",
    horizontal.relativeFrom,
    horizontal.value.emu,
    section,
    section.page
  );
  const y = marginOffset(
    "vertical",
    vertical.relativeFrom,
    vertical.value.emu,
    section,
    section.page
  );
  if (x === undefined || y === undefined) return undefined;
  return {
    relativeTo: "margin",
    fit: "contain",
    x: emuLength(x),
    y: emuLength(y),
    width: emuLength(extent.width),
    height: emuLength(extent.height),
  };
}

async function projectVisualCandidates(
  analysisDigest: string,
  visual: DocxVisualAnalysisV1,
  sections: DocxSectionResolutionV1
): Promise<{
  candidates: readonly TemplateCandidateV1[];
  privateCandidates: readonly DocxTemplatePrivateAssetCandidateV1[];
}> {
  const candidates: TemplateCandidateV1[] = [];
  const privateCandidates: DocxTemplatePrivateAssetCandidateV1[] = [];
  for (const [ordinal, review] of visual.assetReview.entries()) {
    const roleSuggestion = visual.roleSuggestions.find(
      (suggestion) =>
        suggestion.role === review.proposedRole &&
        visual.scenes
          .find(({ id }) => id === suggestion.sceneId)
          ?.representations.some(
            ({ selected, assetSha256 }) =>
              selected && assetSha256 === review.asset.sha256
          )
    );
    const scene =
      visual.scenes.find(({ id }) => id === roleSuggestion?.sceneId) ??
      visual.scenes.find((entry) =>
        entry.representations.some(
          ({ selected, assetSha256 }) =>
            selected && assetSha256 === review.asset.sha256
        )
      );
    const proposedRole = runtimeAssetRole(review.proposedRole);
    const semanticKey = await deriveSemanticReconciliationKey({
      ruleId: DOCX_VISUAL_ANALYSIS_RULE_V1.id,
      concept: "visual-asset",
      scope: `sha-${review.asset.sha256}`,
    });
    const canAssignSupportedRole =
      scene?.compatibility === "native" &&
      scene.sectionScope !== "unsupported-section-scope";
    const compatibility = canAssignSupportedRole ? "native" : "unsupported";
    const candidate = await createTemplateCandidate({
      analysisDigest,
      ordinal: 1_000_000 + ordinal,
      conceptCode: "DOCX_CONCEPT_VISUAL_ASSET",
      semanticKey,
      group: {
        id: `asset.${review.asset.sha256}`,
        cardinality: "zero-or-one",
        atomic: true,
      },
      writes: [],
      rank: 10,
      kind: "asset",
      valueNature: "source-explicit",
      confidence: canAssignSupportedRole ? "corroborated" : "blocked",
      compatibility,
      adoption: canAssignSupportedRole ? "review" : "blocked",
      evidence: [
        {
          id: `asset-evidence-${ordinal}`,
          partRef: "visual",
          locator: `asset.${ordinal + 1}`,
          ...(scene ? { sectionIndex: scene.scope.section } : {}),
        },
      ],
      rule: DOCX_VISUAL_ANALYSIS_RULE_V1,
      explanations: review.explanations,
      diagnostics: [],
      layoutDependent:
        scene?.placement?.kind === "anchor" &&
        scene.placement.resolution === "layout-dependent",
    });
    candidates.push(candidate);
    privateCandidates.push({
      candidateId: candidate.id,
      semanticKey,
      asset: review.asset,
      occurrenceCount: review.occurrenceCount,
      ...(proposedRole ? { proposedRole } : {}),
      supportedPlacementChoices: [...review.supportedPlacementChoices],
      ...(supportedCandidatePlacement(scene, sections)
        ? { candidatePlacement: supportedCandidatePlacement(scene, sections) }
        : {}),
    });
  }
  return { candidates, privateCandidates };
}

function inventoryCodes(
  diagnostics: readonly TemplateDiagnosticV1[]
): readonly string[] {
  return [
    ...new Set(
      diagnostics
        .filter(
          ({ severity, code }) =>
            severity !== "info" &&
            (code.includes("UNSUPPORTED") ||
              code.includes("UNKNOWN") ||
              code.includes("EXTERNAL") ||
              code.includes("CAPABILITY_ABSENT") ||
              code.includes("REVISIONS"))
        )
        .map(({ code }) => code)
    ),
  ].sort();
}

/**
 * Analyze once and return the complete portable authoring input plus
 * host-private asset handles. Unknown graphic roles stay reviewable when the
 * source occurrence itself is native: assigning a supported role is an
 * explicit user design decision, not an inferred Word placement.
 */
export async function analyzeDocxTemplateImport(
  bytes: Uint8Array,
  options: AnalyzeDocxTemplateImportOptionsV1
): Promise<DocxTemplateImportApplicationResultV1> {
  const catalogAnalysis = await analyzeDocxTemplateForCatalog(bytes, {
    catalog: options.catalog,
    bundledFontFamilies: options.bundledFontFamilies,
    ...(options.progress ? { progress: options.progress } : {}),
  });
  const visual = options.metadataOnly
    ? undefined
    : await analyzeDocxVisualAssets(bytes, {
        capabilities: options.assetCapabilities,
        assetStore: options.assetStore,
        sections: catalogAnalysis.sections,
      });
  const projected = visual
    ? await projectVisualCandidates(
      catalogAnalysis.sourceDigest,
        visual.analysis,
        catalogAnalysis.sections
      )
    : { candidates: [], privateCandidates: [] };
  const diagnostics = [
    ...catalogAnalysis.diagnostics,
    ...(visual?.analysis.diagnostics ?? []),
  ].sort((left, right) =>
    `${left.code}:${canonicalCapabilityJson(left.params)}`.localeCompare(
      `${right.code}:${canonicalCapabilityJson(right.params)}`
    )
  );
  const candidates = [
    ...catalogAnalysis.matching.candidates,
    ...projected.candidates,
  ];
  const portable = {
    sourceDigest: catalogAnalysis.sourceDigest,
    mappingVersion: `${DOCX_PDF_MAPPING_RULE_V1.version}+${DOCX_VISUAL_ANALYSIS_RULE_V1.version}`,
    candidates,
    diagnostics,
    inventoryDiagnosticCodes: inventoryCodes(diagnostics),
    hasVisualCandidates: (visual?.analysis.assetReview.length ?? 0) > 0,
  };
  const analysis: TemplateProjectAnalysisV1 = {
    digest: await sha256Hex(
      new TextEncoder().encode(canonicalCapabilityJson(portable))
    ),
    ...portable,
  };
  return structuredClone({
    schema: DOCX_TEMPLATE_IMPORT_APPLICATION_SCHEMA_V1,
    analysis,
    assetHandles: Object.fromEntries(
      (visual?.analysis.assets ?? []).map(({ sha256, handle }) => [
        sha256,
        handle,
      ])
    ),
    ...(visual ? { visualAnalysis: visual.analysis } : {}),
    ...(visual ? { privateVisual: visual.privateSource } : {}),
    privateAssetCandidates: projected.privateCandidates,
  });
}
