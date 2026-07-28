import { describe, expect, test } from "bun:test";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_RUNTIME_ASSETS,
} from "@atlcli/pdf";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
} from "@atlcli/pdf/internal";
import {
  createTemplateDecisionState,
  deriveSafeCandidates,
  projectTemplateImportView,
  resolveTemplateLayers,
} from "@atlcli/pdf-template-authoring";
import type { TemplateCapabilityCatalogV1 } from "@atlcli/template-pack";
import { analyzeDocxTemplateForCatalog } from "./design-analysis.js";
import { DOCX_MAPPING_MESSAGE_REGISTRY_V1 } from "./mapping-messages.js";
import {
  DOCX_PDF_MAPPING_RULE_V1,
  matchDocxTemplate,
} from "./matching.js";
import {
  resolveDocxSections,
  type DocxPageGeometryInputV1,
} from "./section-resolution.js";
import { resolveDocxStyles } from "./style-resolution.js";
import type { DocxThemeDefinitionV1 } from "./theme-resolution.js";
import {
  buildDocx,
  documentXml,
  officeRelationshipType,
  relationshipsXml,
  W_TRANSITIONAL,
} from "./test-support.js";

const THEME: DocxThemeDefinitionV1 = {
  colors: {
    accent1: "4B57A3",
    dk1: "172B4D",
    lt1: "FCFBF8",
  },
  fonts: {
    major: { ascii: "Source Sans 3" },
    minor: { ascii: "Source Serif 4" },
  },
};

const page = (
  overrides: Partial<DocxPageGeometryInputV1> = {}
): DocxPageGeometryInputV1 => ({
  widthTwips: 11_906,
  heightTwips: 16_838,
  marginTopTwips: 1_304,
  marginRightTwips: 1_247,
  marginBottomTwips: 1_134,
  marginLeftTwips: 1_247,
  ...overrides,
});

async function representativeStyles(fontFamily = "Source Serif 4") {
  return resolveDocxStyles({
    docDefaults: {
      fonts: { ascii: { family: fontFamily } },
      sizeHalfPoints: 20,
    },
    styles: [
      {
        styleId: "Normal",
        kind: "paragraph" as const,
        qFormat: true,
        locator: "styles.body",
        properties: { spacingAfterTwips: 120 },
      },
      {
        styleId: "Heading1",
        kind: "paragraph" as const,
        qFormat: true,
        locator: "styles.h1",
        properties: {
          fonts: { ascii: { theme: "major-ascii" } },
          sizeHalfPoints: 36,
          bold: true,
          outlineLevel: 0,
          spacingBeforeTwips: 240,
          spacingAfterTwips: 120,
        },
      },
      {
        styleId: "Heading2",
        kind: "paragraph" as const,
        qFormat: true,
        locator: "styles.h2",
        properties: {
          sizeHalfPoints: 28,
          bold: true,
          outlineLevel: 1,
        },
      },
      {
        styleId: "Heading3",
        kind: "paragraph" as const,
        qFormat: true,
        locator: "styles.h3",
        properties: {
          sizeHalfPoints: 24,
          bold: true,
          outlineLevel: 2,
        },
      },
      {
        styleId: "Code",
        kind: "paragraph" as const,
        qFormat: true,
        locator: "styles.code",
        properties: {
          fonts: { ascii: { family: "Source Code Pro" } },
          sizeHalfPoints: 17,
        },
      },
      {
        styleId: "TableNormal",
        kind: "table" as const,
        qFormat: true,
        locator: "styles.table",
        properties: {
          sizeHalfPoints: 18,
          tableConditionalRegions: ["firstRow", "band1Horz"],
        },
      },
      {
        styleId: "Unused",
        displayName: "Heading 1",
        kind: "paragraph" as const,
        locator: "styles.unused",
      },
    ],
    usage: [
      {
        styleId: "Normal",
        count: 30,
        story: "document",
        section: 0,
        locator: "body.usage",
      },
      {
        styleId: "Heading1",
        count: 4,
        story: "document",
        section: 0,
        locator: "h1.usage",
      },
      {
        styleId: "Heading2",
        count: 6,
        story: "document",
        section: 0,
        locator: "h2.usage",
      },
      {
        styleId: "Heading3",
        count: 8,
        story: "document",
        section: 0,
        locator: "h3.usage",
      },
      {
        styleId: "Code",
        count: 5,
        story: "document",
        section: 0,
        locator: "code.usage",
      },
      {
        styleId: "TableNormal",
        count: 3,
        story: "document",
        section: 0,
        locator: "table.usage",
      },
    ],
  });
}

async function uniformSections() {
  return resolveDocxSections({
    evenAndOddHeaders: false,
    sections: [
      {
        section: 0,
        locator: "section.0",
        page: page(),
        headers: { default: "header-main" },
        footers: { default: "footer-main" },
      },
      {
        section: 1,
        locator: "section.1",
        page: page(),
      },
    ],
  });
}

const bundledFamilies = [
  ...new Set(PDF_RUNTIME_ASSETS.fonts.map(({ family }) => family)),
];
const baselineDesign = BUILTIN_PDF_TEMPLATE_MANIFEST.design! as unknown as Readonly<
  Record<string, unknown>
>;

describe("DOCX-to-PDF matching", () => {
  test("drives the resolvers and catalog matcher from real allowlisted OOXML in one public flow", async () => {
    const stylesXml = [
      `<w:styles xmlns:w="${W_TRANSITIONAL}">`,
      `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>`,
      `<w:style w:type="paragraph" w:styleId="Normal" w:default="1"><w:qFormat/><w:rPr><w:rFonts w:ascii="Source Serif 4"/></w:rPr></w:style>`,
      `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="Heading 1"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:outlineLvl w:val="0"/><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:rFonts w:asciiTheme="majorAscii"/><w:sz w:val="36"/><w:b/></w:rPr></w:style>`,
      `</w:styles>`,
    ].join("");
    const themeXml = [
      `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:themeElements>`,
      `<a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="172B4D"/></a:dk1><a:lt1><a:srgbClr val="FCFBF8"/></a:lt1><a:accent1><a:srgbClr val="4B57A3"/></a:accent1></a:clrScheme>`,
      `<a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Source Sans 3"/></a:majorFont><a:minorFont><a:latin typeface="Source Serif 4"/></a:minorFont></a:fontScheme>`,
      `</a:themeElements></a:theme>`,
    ].join("");
    const settingsXml = `<w:settings xmlns:w="${W_TRANSITIONAL}"><w:evenAndOddHeaders/><w:clrSchemeMapping w:accent1="accent1" w:dark1="dk1" w:light1="lt1"/></w:settings>`;
    const documentRelationships = relationshipsXml([
      { id: "rStyles", type: officeRelationshipType("styles"), target: "styles.xml" },
      { id: "rTheme", type: officeRelationshipType("theme"), target: "theme/theme1.xml" },
      { id: "rSettings", type: officeRelationshipType("settings"), target: "settings.xml" },
      { id: "rHeader", type: officeRelationshipType("header"), target: "header1.xml" },
      { id: "rFooter", type: officeRelationshipType("footer"), target: "footer1.xml" },
    ]);
    const body = [
      `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>neutral</w:t></w:r></w:p>`,
      `<w:p><w:r><w:t>neutral</w:t></w:r></w:p>`,
      `<w:sectPr>`,
      `<w:headerReference w:type="default" r:id="rHeader"/>`,
      `<w:footerReference w:type="default" r:id="rFooter"/>`,
      `<w:pgSz w:w="11906" w:h="16838"/>`,
      `<w:pgMar w:top="1304" w:right="1247" w:bottom="1134" w:left="1247"/>`,
      `</w:sectPr>`,
    ].join("");
    const bytes = buildDocx({
      "word/document.xml": documentXml(body),
      "word/_rels/document.xml.rels": documentRelationships,
      "word/styles.xml": stylesXml,
      "word/theme/theme1.xml": themeXml,
      "word/settings.xml": settingsXml,
      "word/header1.xml": `<w:hdr xmlns:w="${W_TRANSITIONAL}"/>`,
      "word/footer1.xml": `<w:ftr xmlns:w="${W_TRANSITIONAL}"/>`,
    });
    const result = await analyzeDocxTemplateForCatalog(bytes, {
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      bundledFontFamilies: bundledFamilies,
    });
    expect(result.facts.inventory).toMatchObject({
      styles: 2,
      themeColorSlots: 3,
      settingsParts: 1,
      sections: 1,
      headers: 1,
      footers: 1,
    });
    expect(result.styles.styles.find(({ role }) => role === "h1")).toMatchObject({
      usageCount: 1,
      properties: { sizeHalfPoints: 36, outlineLevel: 0 },
    });
    expect(result.sections.globalPage).toMatchObject({
      format: "a4",
      marginTopTwips: 1304,
    });
    expect(
      result.matching.candidates.map(({ conceptCode }) => conceptCode)
    ).toEqual(
      expect.arrayContaining([
        "DOCX_CONCEPT_BODY",
        "DOCX_CONCEPT_COLOR",
        "DOCX_CONCEPT_HEADING_1",
        "DOCX_CONCEPT_PAGE",
      ])
    );
    expect(JSON.stringify(result)).not.toContain("neutral");
    expect(JSON.stringify(result)).not.toContain("Heading 1");
  });

  test("creates consistent body, H1-H3, code, table, page, and central-color groups", async () => {
    const result = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await representativeStyles(),
      theme: THEME,
      sections: await uniformSections(),
      bundledFontFamilies: bundledFamilies,
    });
    const concepts = new Set(result.candidates.map(({ conceptCode }) => conceptCode));
    expect(concepts).toEqual(
      new Set([
        "DOCX_CONCEPT_BODY",
        "DOCX_CONCEPT_CODE",
        "DOCX_CONCEPT_COLOR",
        "DOCX_CONCEPT_FOOTER",
        "DOCX_CONCEPT_HEADER",
        "DOCX_CONCEPT_HEADING_1",
        "DOCX_CONCEPT_HEADING_2",
        "DOCX_CONCEPT_HEADING_3",
        "DOCX_CONCEPT_PAGE",
        "DOCX_CONCEPT_TABLE",
      ])
    );
    expect(
      result.candidates.some(({ evidence }) =>
        evidence.some(({ locator }) => locator === "styles.unused")
      )
    ).toBe(false);
    expect(
      result.candidates
        .flatMap(({ explanations }) => explanations)
        .some(({ code }) => code === "DOCX_MAPPING_TABLE_CONDITIONAL")
    ).toBe(true);
  });

  test("never writes a capability absent from the injected catalog", async () => {
    const catalog: TemplateCapabilityCatalogV1 = {
      schema: "atlcli.template-capability-catalog/1",
      id: "test.restricted",
      version: 1,
      descriptors: [
        {
          path: "typography.roles.h1.size",
          valueKind: "length",
          required: true,
          consumers: ["test"],
        },
      ],
    };
    const result = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog,
      styles: await representativeStyles(),
      theme: THEME,
      sections: await uniformSections(),
      bundledFontFamilies: bundledFamilies,
    });
    expect(
      result.candidates
        .flatMap(({ writes }) => writes)
        .every(({ target }) => target === "typography.roles.h1.size")
    ).toBe(true);
    expect(result.diagnostics.map(({ code }) => code)).toContain(
      "DOCX_MAPPING_CAPABILITY_ABSENT"
    );
  });

  test("globalizes only uniform native pages and keeps conflicts/custom paper blocked", async () => {
    const native = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await resolveDocxStyles({ styles: [], usage: [] }),
      theme: THEME,
      sections: await uniformSections(),
      bundledFontFamilies: bundledFamilies,
      centralColors: [],
    });
    const nativePage = native.candidates.find(
      ({ conceptCode }) => conceptCode === "DOCX_CONCEPT_PAGE"
    );
    expect(nativePage).toMatchObject({
      compatibility: "native",
      adoption: "safe",
    });
    expect(nativePage?.writes.find(({ target }) => target === "page.size")?.value).toBe(
      "a4"
    );

    const conflictingSections = await resolveDocxSections({
      evenAndOddHeaders: false,
      sections: [
        { section: 0, locator: "section.0", page: page() },
        {
          section: 1,
          locator: "section.1",
          page: page({ widthTwips: 12_240, heightTwips: 15_840 }),
        },
      ],
    });
    const conflicting = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await resolveDocxStyles({ styles: [], usage: [] }),
      theme: THEME,
      sections: conflictingSections,
      bundledFontFamilies: bundledFamilies,
      centralColors: [],
    });
    const conflictPages = conflicting.candidates.filter(
      ({ conceptCode }) => conceptCode === "DOCX_CONCEPT_PAGE"
    );
    expect(conflictPages).toHaveLength(2);
    expect(
      conflictPages.every(
        ({ compatibility, adoption }) =>
          compatibility === "unsupported" && adoption === "blocked"
      )
    ).toBe(true);
    expect(new Set(conflictPages.map(({ semanticKey }) => semanticKey)).size).toBe(2);

    const customSections = await resolveDocxSections({
      evenAndOddHeaders: false,
      sections: [
        {
          section: 0,
          locator: "section.0",
          page: page({ widthTwips: 12_000, heightTwips: 16_000 }),
        },
      ],
    });
    const custom = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await resolveDocxStyles({ styles: [], usage: [] }),
      theme: THEME,
      sections: customSections,
      bundledFontFamilies: bundledFamilies,
      centralColors: [],
    });
    expect(
      custom.candidates.find(
        ({ conceptCode }) => conceptCode === "DOCX_CONCEPT_PAGE"
      )
    ).toMatchObject({ compatibility: "unsupported", adoption: "blocked" });
    expect(customSections.sections[0]?.page).toMatchObject({
      format: "custom",
      widthTwips: 12_000,
      heightTwips: 16_000,
    });
  });

  test("never includes a non-bundled font in the safe-policy set", async () => {
    const result = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await representativeStyles("Private Sans"),
      theme: THEME,
      sections: await uniformSections(),
      bundledFontFamilies: bundledFamilies,
      centralColors: [],
    });
    const nonBundled = result.candidates.find(({ writes }) =>
      writes.some(
        ({ target, value }) =>
          target === "typography.fonts.body" && value === "Private Sans"
      )
    );
    expect(nonBundled).toMatchObject({
      kind: "font",
      compatibility: "unsupported",
      adoption: "blocked",
    });
    const safe = deriveSafeCandidates(
      createTemplateDecisionState(),
      result.candidates,
      {
        catalog: PDF_TEMPLATE_CAPABILITIES_V1,
        baseline: baselineDesign,
        catalogDigest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
        sourceDigest: "source",
        importerVersion: "test",
        mappingVersion: DOCX_PDF_MAPPING_RULE_V1.version,
      }
    );
    expect(safe.map(({ id }) => id)).not.toContain(nonBundled?.id);
  });

  test("freezes direct-formatting thresholds and keeps qualifying aggregates review-only", async () => {
    const base = {
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await resolveDocxStyles({ styles: [], usage: [] }),
      theme: THEME,
      sections: await resolveDocxSections({
        evenAndOddHeaders: false,
        sections: [],
      }),
      bundledFontFamilies: bundledFamilies,
      centralColors: [],
    };
    const result = await matchDocxTemplate({
      ...base,
      directFormatting: [
        {
          role: "h1",
          properties: { sizeHalfPoints: 40, bold: true },
          count: 7,
          totalCount: 10,
          evidence: {
            id: "evidence:direct.h1",
            partRef: "document",
            locator: "direct.h1",
          },
        },
        {
          role: "h2",
          properties: { sizeHalfPoints: 30 },
          count: 4,
          totalCount: 5,
          evidence: {
            id: "evidence:direct.h2",
            partRef: "document",
            locator: "direct.h2",
          },
        },
      ],
    });
    const direct = result.candidates.filter(({ group }) =>
      group.id.startsWith("group:direct.")
    );
    expect(direct).toHaveLength(1);
    expect(direct[0]).toMatchObject({
      adoption: "review",
      confidence: "corroborated",
      valueNature: "inferred",
    });
    expect(DOCX_PDF_MAPPING_RULE_V1.directFormatting).toEqual({
      minimumOccurrences: 5,
      minimumDominance: 0.7,
    });
  });

  test("emits complete explainable candidates and business-facing review items", async () => {
    const match = await matchDocxTemplate({
      analysisDigest: "analysis",
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      styles: await representativeStyles(),
      theme: THEME,
      sections: await uniformSections(),
      bundledFontFamilies: bundledFamilies,
    });
    expect(match.candidates.length).toBeGreaterThan(10);
    for (const candidate of match.candidates) {
      expect(candidate.valueNature).toBeDefined();
      expect(candidate.confidence).toBeDefined();
      expect(candidate.compatibility).toBeDefined();
      expect(candidate.adoption).toBeDefined();
      expect(candidate.rule).toEqual(DOCX_PDF_MAPPING_RULE_V1);
      expect(candidate.evidence.length).toBeGreaterThan(0);
      expect(candidate.explanations.length).toBeGreaterThan(0);
      expect(candidate.evidence.every(({ locator }) => locator.length > 0)).toBe(
        true
      );
    }

    const decisions = createTemplateDecisionState();
    const snapshot = await resolveTemplateLayers({
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      catalogDigest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      baseline: {
        id: BUILTIN_PDF_TEMPLATE_MANIFEST.id,
        version: BUILTIN_PDF_TEMPLATE_MANIFEST.version,
        design: baselineDesign,
      },
      sourceDigest: "source",
      decisions,
      candidates: match.candidates,
      mappingVersion: DOCX_PDF_MAPPING_RULE_V1.version,
    });
    const view = projectTemplateImportView({
      generation: "generation:test",
      analysisDigest: "analysis",
      baseline: baselineDesign,
      candidates: match.candidates,
      decisions,
      snapshot,
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      presentation: PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
      messageRegistries: [DOCX_MAPPING_MESSAGE_REGISTRY_V1],
      diagnostics: match.diagnostics,
      inventoryDiagnosticCodes: match.diagnostics.map(({ code }) => code),
      previewDigest: "preview",
      hasHistory: false,
    });
    const items = view.sections.flatMap(({ items: sectionItems }) => sectionItems);
    const labels = new Set(items.map(({ labelCode }) => labelCode));
    expect(labels.has("DOCX_CONCEPT_BODY")).toBe(true);
    expect(labels.has("DOCX_CONCEPT_COLOR")).toBe(true);
    expect(labels.has("DOCX_CONCEPT_HEADING_1")).toBe(true);
    expect(labels.has("DOCX_CONCEPT_PAGE")).toBe(true);
    for (const item of items) {
      const primary = JSON.stringify({
        labelCode: item.labelCode,
        baseline: item.baseline,
        proposed: item.proposed,
        effective: item.effective,
      });
      expect(primary).not.toContain("candidate:");
      expect(primary).not.toContain("typography.");
      expect(primary).not.toContain("tokens.");
      expect(item.details.candidateIds.length).toBeGreaterThan(0);
      expect(item.details.candidateFingerprints.length).toBeGreaterThan(0);
      expect(
        item.details.candidateFingerprints.every((value) =>
          /^[a-f0-9]{64}$/.test(value)
        )
      ).toBe(true);
      expect(item.details.targets.length).toBeGreaterThan(0);
    }
  });
});
