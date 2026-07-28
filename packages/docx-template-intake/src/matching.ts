import { sha256Hex } from "@atlcli/core";
import {
  createTemplateCandidate,
  deriveSemanticReconciliationKey,
  validateTemplateImportProgressEvent,
  type CandidateAdoptionV1,
  type CandidateCompatibilityV1,
  type CandidateConfidenceV1,
  type CandidateKindV1,
  type CandidateWriteV1,
  type TemplateCandidateV1,
  type TemplateDiagnosticV1,
  type TemplateEvidenceV1,
  type TemplateExplanationV1,
  type TemplateImportProgressEventV1,
} from "@atlcli/pdf-template-authoring";
import type { TemplateCapabilityCatalogV1 } from "@atlcli/template-pack";
import { canonicalIntakeJson } from "./canonical.js";
import {
  mappingDiagnostic,
  mappingExplanation,
} from "./mapping-messages.js";
import type {
  DocxSectionResolutionV1,
  ResolvedDocxPageGeometryV1,
} from "./section-resolution.js";
import type {
  DocxSemanticStyleRoleV1,
  ResolvedDocxStylePropertiesV1,
  ResolvedDocxStyleV1,
  DocxStyleResolutionV1,
} from "./style-resolution.js";
import {
  resolveDocxThemeColor,
  resolveDocxThemeFont,
  type DocxFontScriptV1,
  type DocxThemeColorReferenceV1,
  type DocxThemeDefinitionV1,
  type DocxThemeFontReferenceV1,
} from "./theme-resolution.js";

export const DOCX_PDF_MAPPING_RULE_V1 = {
  id: "atlcli.docx-to-pdf",
  version: "1",
  directFormatting: {
    minimumOccurrences: 5,
    minimumDominance: 0.7,
  },
} as const;

export interface DocxCentralColorInputV1 {
  concept: "accent" | "ink" | "paper";
  reference: DocxThemeColorReferenceV1;
  locator: string;
}

export interface DocxDirectFormattingAggregateV1 {
  role: Exclude<DocxSemanticStyleRoleV1, "table">;
  properties: ResolvedDocxStylePropertiesV1;
  count: number;
  totalCount: number;
  evidence: TemplateEvidenceV1;
}

export interface DocxTemplateMatchingInputV1 {
  analysisDigest: string;
  catalog: TemplateCapabilityCatalogV1;
  styles: DocxStyleResolutionV1;
  theme: DocxThemeDefinitionV1;
  sections: DocxSectionResolutionV1;
  bundledFontFamilies: readonly string[];
  centralColors?: readonly DocxCentralColorInputV1[];
  directFormatting?: readonly DocxDirectFormattingAggregateV1[];
  progress?: (event: TemplateImportProgressEventV1) => void;
}

export interface DocxTemplateMatchResultV1 {
  rule: typeof DOCX_PDF_MAPPING_RULE_V1;
  candidates: readonly TemplateCandidateV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
}

interface CandidateSpec {
  conceptCode: string;
  concept: string;
  scope: string;
  groupId: string;
  groupAtomic: boolean;
  writes: readonly CandidateWriteV1[];
  rank: number;
  kind: CandidateKindV1;
  valueNature: "source-explicit" | "source-derived" | "inferred";
  confidence: CandidateConfidenceV1;
  compatibility: CandidateCompatibilityV1;
  adoption: CandidateAdoptionV1;
  evidence: readonly TemplateEvidenceV1[];
  explanations: readonly TemplateExplanationV1[];
  diagnostics?: readonly TemplateDiagnosticV1[];
}

const ROLE_CONCEPT: Readonly<Record<DocxSemanticStyleRoleV1, string>> = {
  body: "DOCX_CONCEPT_BODY",
  h1: "DOCX_CONCEPT_HEADING_1",
  h2: "DOCX_CONCEPT_HEADING_2",
  h3: "DOCX_CONCEPT_HEADING_3",
  code: "DOCX_CONCEPT_CODE",
  table: "DOCX_CONCEPT_TABLE",
};
const ROLE_TARGET: Readonly<Record<DocxSemanticStyleRoleV1, string>> = {
  body: "body",
  h1: "h1",
  h2: "h2",
  h3: "h3",
  code: "code",
  table: "tableCell",
};
const FONT_ROLE: Readonly<
  Record<DocxSemanticStyleRoleV1, "body" | "heading" | "mono">
> = {
  body: "body",
  h1: "heading",
  h2: "heading",
  h3: "heading",
  code: "mono",
  table: "body",
};

function emitProgress(
  callback: ((event: TemplateImportProgressEventV1) => void) | undefined,
  completed: number,
  total: number
): void {
  const event: TemplateImportProgressEventV1 = {
    schema: "wiki.pdf-template-import-progress/v1",
    operationId: "docx.matching",
    phase: "matching",
    completed,
    total,
  };
  validateTemplateImportProgressEvent(event);
  callback?.(event);
}

function points(halfPoints: number): string {
  const value = halfPoints / 2;
  return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}pt`;
}

function millimeters(twips: number): string {
  const value = (twips * 25.4) / 1440;
  return `${Number(value.toFixed(3))}mm`;
}

function resolvedFont(
  properties: ResolvedDocxStylePropertiesV1,
  theme: DocxThemeDefinitionV1
): {
  family?: string;
  script?: DocxFontScriptV1;
  reference?: DocxThemeFontReferenceV1;
} {
  for (const script of ["ascii", "hAnsi", "eastAsia", "cs"] as const) {
    const reference = properties.fonts?.[script];
    const family = resolveDocxThemeFont(reference, script, theme);
    if (family) return { family, script, reference };
  }
  return {};
}

function roleMetricWrites(
  role: DocxSemanticStyleRoleV1,
  properties: ResolvedDocxStylePropertiesV1
): CandidateWriteV1[] {
  const targetRole = ROLE_TARGET[role];
  const writes: CandidateWriteV1[] = [
    {
      target: `typography.roles.${targetRole}.font`,
      value: FONT_ROLE[role],
    },
  ];
  if (properties.sizeHalfPoints !== undefined) {
    writes.push({
      target: `typography.roles.${targetRole}.size`,
      value: points(properties.sizeHalfPoints),
    });
  }
  if (
    properties.bold !== undefined &&
    role !== "body" &&
    role !== "code" &&
    role !== "table"
  ) {
    writes.push({
      target: `typography.roles.${targetRole}.weight`,
      value: properties.bold ? "bold" : "regular",
    });
  }
  if (role === "body" && properties.spacingAfterTwips !== undefined) {
    writes.push({
      target: "tokens.layout.paragraphSpacing",
      value: points(properties.spacingAfterTwips / 10),
    });
  }
  if (role === "h1" || role === "h2" || role === "h3") {
    if (properties.spacingBeforeTwips !== undefined) {
      writes.push({
        target: `tokens.layout.${role}Above`,
        value: points(properties.spacingBeforeTwips / 10),
      });
    }
    if (properties.spacingAfterTwips !== undefined) {
      writes.push({
        target: `tokens.layout.${role}Below`,
        value: points(properties.spacingAfterTwips / 10),
      });
    }
  }
  return writes;
}

function pageWrites(page: ResolvedDocxPageGeometryV1): CandidateWriteV1[] {
  return [
    ...(page.format === "custom"
      ? []
      : [{ target: "page.size", value: page.format }]),
    { target: "page.orientation", value: page.orientation },
    { target: "page.margin.top", value: millimeters(page.marginTopTwips) },
    {
      target: "page.margin.right",
      value: millimeters(page.marginRightTwips),
    },
    {
      target: "page.margin.bottom",
      value: millimeters(page.marginBottomTwips),
    },
    { target: "page.margin.left", value: millimeters(page.marginLeftTwips) },
  ];
}

function diagnosticsKey(item: TemplateDiagnosticV1): string {
  return `${item.code}:${canonicalIntakeJson(item.params)}`;
}

function uniformProperties(style: ResolvedDocxStyleV1): {
  properties: ResolvedDocxStylePropertiesV1;
  direct: boolean;
} {
  if (style.uses.length === 0) {
    return { properties: style.properties, direct: false };
  }
  const identities = new Set(
    style.uses.map(({ properties }) => canonicalIntakeJson(properties))
  );
  return identities.size === 1
    ? { properties: style.uses[0]?.properties ?? style.properties, direct: true }
    : { properties: style.properties, direct: false };
}

/** Produce versioned candidates only for targets present in the injected catalog. */
export async function matchDocxTemplate(
  input: DocxTemplateMatchingInputV1
): Promise<DocxTemplateMatchResultV1> {
  const candidates: TemplateCandidateV1[] = [];
  const diagnostics: TemplateDiagnosticV1[] = [
    ...input.styles.diagnostics,
    ...input.sections.diagnostics,
  ];
  const catalogPaths = new Set(
    input.catalog.descriptors.map(({ path }) => path)
  );
  const bundled = new Set(
    input.bundledFontFamilies.map((family) => family.trim().toLowerCase())
  );
  let ordinal = 0;
  const total =
    input.styles.styles.length +
    (input.centralColors?.length ?? 3) +
    input.sections.sections.length +
    (input.directFormatting?.length ?? 0);
  emitProgress(input.progress, 0, total);
  let completed = 0;

  const add = async (spec: CandidateSpec): Promise<void> => {
    const writes = spec.writes.filter(({ target }) => {
      if (catalogPaths.has(target)) return true;
      diagnostics.push(
        mappingDiagnostic(
          "DOCX_MAPPING_CAPABILITY_ABSENT",
          { target },
          "warning"
        )
      );
      return false;
    });
    if (writes.length === 0 || spec.evidence.length === 0) return;
    const semanticKey = await deriveSemanticReconciliationKey({
      ruleId: DOCX_PDF_MAPPING_RULE_V1.id,
      concept: spec.concept,
      scope: spec.scope,
    });
    candidates.push(
      await createTemplateCandidate({
        analysisDigest: input.analysisDigest,
        ordinal,
        conceptCode: spec.conceptCode,
        semanticKey,
        group: {
          id: spec.groupId,
          cardinality: "zero-or-one",
          atomic: spec.groupAtomic,
        },
        writes,
        rank: spec.rank,
        kind: spec.kind,
        valueNature: spec.valueNature,
        confidence: spec.confidence,
        compatibility: spec.compatibility,
        adoption: spec.adoption,
        evidence: spec.evidence,
        rule: DOCX_PDF_MAPPING_RULE_V1,
        explanations: spec.explanations,
        diagnostics: spec.diagnostics ?? [],
      })
    );
    ordinal += 1;
  };

  for (const style of input.styles.styles) {
    completed += 1;
    emitProgress(input.progress, completed, total);
    if (
      !style.resolvable ||
      !style.role ||
      !style.roleConfidence ||
      style.roleConfidence === "suggestive" ||
      style.usageCount === 0
    ) {
      continue;
    }
    const effective = uniformProperties(style);
    const confidence: CandidateConfidenceV1 =
      style.roleConfidence === "conclusive" && effective.direct
        ? "conclusive"
        : "corroborated";
    const explanations: TemplateExplanationV1[] = [];
    if (style.roleSignals.includes("standard-style-id")) {
      explanations.push(
        mappingExplanation(
          "DOCX_MAPPING_STANDARD_STYLE",
          { role: style.role, style: style.styleRef },
          [style.evidence.id]
        )
      );
    }
    if (effective.properties.outlineLevel !== undefined) {
      explanations.push(
        mappingExplanation(
          "DOCX_MAPPING_OUTLINE_LEVEL",
          {
            level: effective.properties.outlineLevel,
            role: style.role,
          },
          [style.evidence.id]
        )
      );
    }
    explanations.push(
      mappingExplanation(
        "DOCX_MAPPING_REPEATED_USAGE",
        { count: style.usageCount, role: style.role },
        [style.evidence.id]
      )
    );
    if (
      style.role === "table" &&
      effective.properties.tableConditionalRegions?.length
    ) {
      explanations.push(
        mappingExplanation(
          "DOCX_MAPPING_TABLE_CONDITIONAL",
          {
            regions: effective.properties.tableConditionalRegions.length,
            role: style.role,
          },
          [style.evidence.id]
        )
      );
    }
    await add({
      conceptCode: ROLE_CONCEPT[style.role],
      concept: `style.${style.role}.metrics`,
      scope: "document",
      groupId: `group:style.${style.role}.metrics`,
      groupAtomic: true,
      writes: roleMetricWrites(style.role, effective.properties),
      rank: 100,
      kind: "token",
      valueNature: "source-derived",
      confidence,
      compatibility: "native",
      adoption: confidence === "conclusive" ? "safe" : "review",
      evidence: [style.evidence],
      explanations,
    });

    const font = resolvedFont(effective.properties, input.theme);
    if (font.family && font.script) {
      const isBundled = bundled.has(font.family.toLowerCase());
      const fontFingerprint = await sha256Hex(
        new TextEncoder().encode(font.family)
      );
      const fontDiagnostic = isBundled
        ? []
        : [
            mappingDiagnostic(
              "DOCX_MAPPING_FONT_SUBSTITUTION_REQUIRED",
              { font: fontFingerprint, role: style.role },
              "warning"
            ),
          ];
      await add({
        conceptCode: ROLE_CONCEPT[style.role],
        concept: `style.${style.role}.font`,
        scope: "document",
        groupId: `group:style.${style.role}.font`,
        groupAtomic: true,
        writes: [
          {
            target: `typography.fonts.${FONT_ROLE[style.role]}`,
            value: font.family,
          },
        ],
        rank: 100,
        kind: isBundled ? "token" : "font",
        valueNature: "source-derived",
        confidence,
        compatibility: isBundled ? "native" : "unsupported",
        adoption:
          isBundled && confidence === "conclusive" ? "safe" : isBundled ? "review" : "blocked",
        evidence: [style.evidence],
        explanations: [
          mappingExplanation(
            isBundled
              ? "DOCX_MAPPING_FONT_BUNDLED"
              : "DOCX_MAPPING_FONT_SUBSTITUTION_REQUIRED",
            isBundled
              ? { role: style.role }
              : { font: fontFingerprint, role: style.role },
            [style.evidence.id]
          ),
          ...(font.reference?.theme
            ? [
                mappingExplanation(
                  "DOCX_MAPPING_THEME_FONT",
                  { role: style.role, script: font.script },
                  [style.evidence.id]
                ),
              ]
            : []),
        ],
        diagnostics: fontDiagnostic,
      });
    }
  }

  const colors =
    input.centralColors ??
    ([
      {
        concept: "accent",
        reference: { theme: "accent1" },
        locator: "theme.color.accent",
      },
      {
        concept: "ink",
        reference: { theme: "dk1" },
        locator: "theme.color.ink",
      },
      {
        concept: "paper",
        reference: { theme: "lt1" },
        locator: "theme.color.paper",
      },
    ] satisfies readonly DocxCentralColorInputV1[]);
  for (const color of colors) {
    completed += 1;
    emitProgress(input.progress, completed, total);
    const value = resolveDocxThemeColor(color.reference, input.theme);
    if (!value) continue;
    const evidence: TemplateEvidenceV1 = {
      id: `evidence:color.${color.concept}`,
      partRef: "theme",
      locator: color.locator,
    };
    const targets =
      color.concept === "accent"
        ? ["branding.accent", "tokens.colors.accent"]
        : [`tokens.colors.${color.concept}`];
    await add({
      conceptCode: "DOCX_CONCEPT_COLOR",
      concept: `color.${color.concept}`,
      scope: "document",
      groupId: `group:color.${color.concept}`,
      groupAtomic: targets.length > 1,
      writes: targets.map((target) => ({ target, value })),
      rank: 80,
      kind: "token",
      valueNature: color.reference.rgb
        ? "source-explicit"
        : "source-derived",
      confidence: "corroborated",
      compatibility: "native",
      adoption: "review",
      evidence: [evidence],
      explanations: [
        mappingExplanation(
          "DOCX_MAPPING_THEME_COLOR",
          { slot: color.concept },
          [evidence.id]
        ),
      ],
    });
  }

  const pageSources = input.sections.globalPage
    ? [
        {
          page: input.sections.globalPage,
          section: "global",
          evidence: input.sections.sections.map(({ evidence }) => evidence),
          supported: input.sections.globalPage.format !== "custom",
        },
      ]
    : input.sections.sections.map(({ page, section, evidence }) => ({
        page,
        section: `section.${section}`,
        evidence: [evidence],
        supported: false,
      }));
  for (const source of pageSources) {
    completed += 1;
    emitProgress(input.progress, Math.min(completed, total), total);
    const supported = source.supported;
    await add({
      conceptCode: "DOCX_CONCEPT_PAGE",
      concept: "page.master",
      scope: source.section,
      groupId: `group:page.${source.section}`,
      groupAtomic: true,
      writes: pageWrites(source.page),
      rank: 120,
      kind: "token",
      valueNature: "source-explicit",
      confidence: "conclusive",
      compatibility: supported ? "native" : "unsupported",
      adoption: supported ? "safe" : "blocked",
      evidence: source.evidence,
      explanations: [
        mappingExplanation(
          "DOCX_MAPPING_PAGE_FORMAT",
          { format: source.page.format },
          [source.evidence[0]?.id as string]
        ),
        ...(input.sections.geometryUniform
          ? [
              mappingExplanation(
                "DOCX_MAPPING_SECTION_UNIFORM",
                { count: input.sections.sections.length },
                source.evidence.map(({ id }) => id)
              ),
            ]
          : []),
      ],
      diagnostics:
        source.page.format === "custom"
          ? [
              mappingDiagnostic(
                "DOCX_PAGE_CUSTOM_SIZE",
                {
                  widthTwips: source.page.widthTwips,
                  heightTwips: source.page.heightTwips,
                },
                "warning"
              ),
            ]
          : [],
    });
  }

  for (const kind of ["header", "footer"] as const) {
    const active = input.sections.decorations.filter(
      (item) => item.kind === kind && item.status !== "inactive"
    );
    if (active.length === 0) continue;
    const supported = active.every(({ status }) => status === "native");
    const evidence = active.map(({ evidence }) => evidence);
    await add({
      conceptCode:
        kind === "header" ? "DOCX_CONCEPT_HEADER" : "DOCX_CONCEPT_FOOTER",
      concept: `decoration.${kind}`,
      scope: "document",
      groupId: `group:decoration.${kind}`,
      groupAtomic: true,
      writes: [{ target: `features.${kind}.enabled`, value: true }],
      rank: 70,
      kind: "token",
      valueNature: "source-derived",
      confidence: supported ? "conclusive" : "blocked",
      compatibility: supported ? "native" : "unsupported",
      adoption: supported ? "safe" : "blocked",
      evidence,
      explanations: [
        mappingExplanation(
          "DOCX_MAPPING_SECTION_UNIFORM",
          { count: input.sections.sections.length },
          evidence.map(({ id }) => id)
        ),
      ],
      diagnostics: supported
        ? []
        : active
            .filter(({ status }) => status === "unsupported-section-scope")
            .map(({ section, variant }) =>
              mappingDiagnostic(
                "DOCX_SECTION_SCOPE_UNSUPPORTED",
                { section, variant: `${kind}.${variant}` },
                "warning"
              )
            ),
    });
  }

  for (const aggregate of input.directFormatting ?? []) {
    completed += 1;
    emitProgress(input.progress, Math.min(completed, total), total);
    const ratio =
      aggregate.totalCount > 0 ? aggregate.count / aggregate.totalCount : 0;
    if (
      aggregate.count <
        DOCX_PDF_MAPPING_RULE_V1.directFormatting.minimumOccurrences ||
      ratio < DOCX_PDF_MAPPING_RULE_V1.directFormatting.minimumDominance
    ) {
      continue;
    }
    await add({
      conceptCode: ROLE_CONCEPT[aggregate.role],
      concept: `direct.${aggregate.role}`,
      scope: "document",
      groupId: `group:direct.${aggregate.role}`,
      groupAtomic: true,
      writes: roleMetricWrites(aggregate.role, aggregate.properties),
      rank: 200,
      kind: "token",
      valueNature: "inferred",
      confidence: "corroborated",
      compatibility: "native",
      adoption: "review",
      evidence: [aggregate.evidence],
      explanations: [
        mappingExplanation(
          "DOCX_MAPPING_DIRECT_FORMAT_DOMINANCE",
          {
            count: aggregate.count,
            ratio: Number(ratio.toFixed(4)),
            role: aggregate.role,
          },
          [aggregate.evidence.id]
        ),
      ],
    });
  }

  const uniqueDiagnostics = [
    ...new Map(
      diagnostics.map((item) => [diagnosticsKey(item), item])
    ).values(),
  ].sort((left, right) =>
    diagnosticsKey(left).localeCompare(diagnosticsKey(right))
  );
  candidates.sort((left, right) =>
    left.semanticKey.localeCompare(right.semanticKey) ||
    left.candidateFingerprint.localeCompare(right.candidateFingerprint)
  );
  emitProgress(input.progress, total, total);
  return {
    rule: DOCX_PDF_MAPPING_RULE_V1,
    candidates,
    diagnostics: uniqueDiagnostics,
  };
}
