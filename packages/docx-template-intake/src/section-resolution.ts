import { sha256Hex } from "@atlcli/core";
import type {
  TemplateDiagnosticV1,
  TemplateEvidenceV1,
} from "@atlcli/pdf-template-authoring";
import { mappingDiagnostic } from "./mapping-messages.js";

export const DOCX_SECTION_RESOLUTION_RULE_V1 = {
  id: "atlcli.docx-section-resolution",
  version: "1",
  pageToleranceTwips: 24,
} as const;

export type DocxPageFormatV1 = "a4" | "letter" | "custom";
export type DocxMasterVariantV1 = "default" | "even" | "first";
export type DocxDecorationKindV1 = "footer" | "header";

export interface DocxPageGeometryInputV1 {
  widthTwips: number;
  heightTwips: number;
  orientation?: "landscape" | "portrait";
  marginTopTwips: number;
  marginRightTwips: number;
  marginBottomTwips: number;
  marginLeftTwips: number;
}

export interface DocxSectionInputV1 {
  section: number;
  locator: string;
  page: DocxPageGeometryInputV1;
  columnCount?: number;
  titlePage?: boolean;
  pageNumberStart?: number;
  headers?: Partial<Record<DocxMasterVariantV1, string>>;
  footers?: Partial<Record<DocxMasterVariantV1, string>>;
}

export interface DocxSectionResolutionInputV1 {
  evenAndOddHeaders: boolean;
  sections: readonly DocxSectionInputV1[];
}

export interface ResolvedDocxPageGeometryV1
  extends DocxPageGeometryInputV1 {
  orientation: "landscape" | "portrait";
  format: DocxPageFormatV1;
}

export interface ResolvedDocxSectionV1 {
  section: number;
  evidence: TemplateEvidenceV1;
  page: ResolvedDocxPageGeometryV1;
  columnCount: number;
  titlePage: boolean;
  pageNumberStart?: number;
  pageNumberRestart: boolean;
  headers: Partial<Record<DocxMasterVariantV1, string>>;
  footers: Partial<Record<DocxMasterVariantV1, string>>;
  activeVariants: readonly DocxMasterVariantV1[];
}

export interface ResolvedDocxDecorationV1 {
  kind: DocxDecorationKindV1;
  variant: DocxMasterVariantV1;
  section: number;
  partFingerprint?: string;
  status: "inactive" | "native" | "unsupported-section-scope";
  evidence: TemplateEvidenceV1;
}

export interface DocxSectionResolutionV1 {
  rule: typeof DOCX_SECTION_RESOLUTION_RULE_V1;
  sections: readonly ResolvedDocxSectionV1[];
  globalPage?: ResolvedDocxPageGeometryV1;
  geometryUniform: boolean;
  decorations: readonly ResolvedDocxDecorationV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
}

const PAGE_FORMATS = {
  a4: { widthTwips: 11_906, heightTwips: 16_838 },
  letter: { widthTwips: 12_240, heightTwips: 15_840 },
} as const;

async function fingerprint(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

function within(left: number, right: number): boolean {
  return (
    Math.abs(left - right) <= DOCX_SECTION_RESOLUTION_RULE_V1.pageToleranceTwips
  );
}

export function normalizeDocxPageGeometry(
  page: DocxPageGeometryInputV1
): ResolvedDocxPageGeometryV1 {
  const orientation =
    page.orientation ??
    (page.widthTwips > page.heightTwips ? "landscape" : "portrait");
  const portraitWidth =
    orientation === "landscape" ? page.heightTwips : page.widthTwips;
  const portraitHeight =
    orientation === "landscape" ? page.widthTwips : page.heightTwips;
  const match = (
    Object.entries(PAGE_FORMATS) as [
      Exclude<DocxPageFormatV1, "custom">,
      { widthTwips: number; heightTwips: number },
    ][]
  ).find(
    ([, value]) =>
      within(portraitWidth, value.widthTwips) &&
      within(portraitHeight, value.heightTwips)
  );
  return {
    ...page,
    orientation,
    format: match?.[0] ?? "custom",
  };
}

function pageIdentity(page: ResolvedDocxPageGeometryV1): string {
  return JSON.stringify({
    format: page.format,
    widthTwips: page.widthTwips,
    heightTwips: page.heightTwips,
    orientation: page.orientation,
    marginTopTwips: page.marginTopTwips,
    marginRightTwips: page.marginRightTwips,
    marginBottomTwips: page.marginBottomTwips,
    marginLeftTwips: page.marginLeftTwips,
  });
}

async function resolveReferences(
  current: Partial<Record<DocxMasterVariantV1, string>> | undefined,
  previous: Partial<Record<DocxMasterVariantV1, string>>
): Promise<Partial<Record<DocxMasterVariantV1, string>>> {
  const result: Partial<Record<DocxMasterVariantV1, string>> = {};
  for (const variant of ["default", "even", "first"] as const) {
    const raw = current?.[variant];
    if (raw) result[variant] = await fingerprint(raw);
    else if (previous[variant]) result[variant] = previous[variant];
  }
  return result;
}

function variants(
  section: DocxSectionInputV1,
  evenAndOddHeaders: boolean
): DocxMasterVariantV1[] {
  return [
    "default",
    ...(evenAndOddHeaders ? (["even"] as const) : []),
    ...(section.titlePage ? (["first"] as const) : []),
  ];
}

function uniformDecoration(
  sections: readonly ResolvedDocxSectionV1[],
  kind: DocxDecorationKindV1,
  variant: DocxMasterVariantV1
): boolean {
  const values = sections.map((section) => section[`${kind}s`][variant] ?? "");
  return new Set(values).size === 1;
}

/** Resolve effective section masters and fail closed on unsupported scoping. */
export async function resolveDocxSections(
  input: DocxSectionResolutionInputV1
): Promise<DocxSectionResolutionV1> {
  const ordered = [...input.sections].sort(
    (left, right) => left.section - right.section
  );
  const sections: ResolvedDocxSectionV1[] = [];
  let inheritedHeaders: Partial<Record<DocxMasterVariantV1, string>> = {};
  let inheritedFooters: Partial<Record<DocxMasterVariantV1, string>> = {};
  for (const [ordinal, section] of ordered.entries()) {
    const headers = await resolveReferences(section.headers, inheritedHeaders);
    const footers = await resolveReferences(section.footers, inheritedFooters);
    inheritedHeaders = headers;
    inheritedFooters = footers;
    sections.push({
      section: section.section,
      evidence: {
        id: `evidence:section.${ordinal}`,
        partRef: "document",
        locator: section.locator,
        sectionIndex: section.section,
      },
      page: normalizeDocxPageGeometry(section.page),
      columnCount:
        section.columnCount !== undefined &&
        Number.isSafeInteger(section.columnCount) &&
        section.columnCount > 0
          ? section.columnCount
          : 1,
      titlePage: section.titlePage ?? false,
      ...(section.pageNumberStart === undefined
        ? {}
        : { pageNumberStart: section.pageNumberStart }),
      pageNumberRestart: section.pageNumberStart !== undefined,
      headers,
      footers,
      activeVariants: variants(section, input.evenAndOddHeaders),
    });
  }

  const identities = new Set(sections.map(({ page }) => pageIdentity(page)));
  const geometryUniform = identities.size <= 1;
  const hasRestart = sections.some(({ pageNumberRestart }) => pageNumberRestart);
  const decorations: ResolvedDocxDecorationV1[] = [];
  const diagnostics: TemplateDiagnosticV1[] = [];

  for (const section of sections) {
    for (const kind of ["header", "footer"] as const) {
      for (const variant of ["default", "even", "first"] as const) {
        const active = section.activeVariants.includes(variant);
        const partFingerprint = section[`${kind}s`][variant];
        let status: ResolvedDocxDecorationV1["status"] = "inactive";
        if (active && partFingerprint) {
          const scopeSupported =
            variant === "first"
              ? sections.length === 1
              : sections.length === 1 ||
                (geometryUniform &&
                  !hasRestart &&
                  uniformDecoration(sections, kind, variant));
          status = scopeSupported ? "native" : "unsupported-section-scope";
          if (!scopeSupported) {
            diagnostics.push(
              mappingDiagnostic(
                "DOCX_SECTION_SCOPE_UNSUPPORTED",
                { section: section.section, variant: `${kind}.${variant}` },
                "warning"
              )
            );
          }
        }
        decorations.push({
          kind,
          variant,
          section: section.section,
          ...(partFingerprint ? { partFingerprint } : {}),
          status,
          evidence: section.evidence,
        });
      }
    }
  }

  const globalPage =
    geometryUniform && sections.length > 0 ? sections[0]?.page : undefined;
  if (globalPage?.format === "custom") {
    diagnostics.push(
      mappingDiagnostic(
        "DOCX_PAGE_CUSTOM_SIZE",
        {
          widthTwips: globalPage.widthTwips,
          heightTwips: globalPage.heightTwips,
        },
        "warning"
      )
    );
  }
  return {
    rule: DOCX_SECTION_RESOLUTION_RULE_V1,
    sections,
    ...(globalPage ? { globalPage } : {}),
    geometryUniform,
    decorations,
    diagnostics,
  };
}
