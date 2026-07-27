import { sha256Hex } from "@atlcli/core";
import {
  DOCX_TEMPLATE_INTAKE_BUDGET,
  unzipDocx,
} from "@atlcli/docx/scan";
import type {
  TemplateCapabilityCatalogV1,
} from "@atlcli/template-pack";
import type {
  TemplateDiagnosticV1,
  TemplateImportProgressEventV1,
} from "@atlcli/pdf-template-authoring";
import {
  matchDocxTemplate,
  type DocxTemplateMatchResultV1,
} from "./matching.js";
import {
  analyzeDocxTemplateArchive,
  type DocxIntakeArchive,
  type DocxTemplateFactsV1,
} from "./ooxml-facts.js";
import {
  analyzeDocxOpcArchive,
  type DocxOpcFactsV1,
} from "./opc.js";
import {
  resolveDocxSections,
  type DocxPageGeometryInputV1,
  type DocxSectionInputV1,
  type DocxSectionResolutionV1,
} from "./section-resolution.js";
import {
  resolveDocxStyles,
  type DocxStyleDefinitionInputV1,
  type DocxStylePropertiesInputV1,
  type DocxStyleResolutionV1,
  type DocxStyleUsageInputV1,
} from "./style-resolution.js";
import { streamXmlPart, type XmlElementEventV1 } from "./streaming.js";
import type {
  DocxFontScriptV1,
  DocxThemeDefinitionV1,
  DocxThemeFontReferenceV1,
} from "./theme-resolution.js";

export const DOCX_RESOLVED_DESIGN_SCHEMA_V1 =
  "atlcli.docx-resolved-design/1" as const;
export const DOCX_CATALOG_ANALYSIS_SCHEMA_V1 =
  "atlcli.docx-catalog-analysis/1" as const;

const WORD_URIS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const DRAWING_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const RELATIONSHIP_URIS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);

interface ZipEntry {
  name: string;
  dir: boolean;
  asUint8Array(): Uint8Array;
}

interface ExtractedDesignInput {
  styles: DocxStyleDefinitionInputV1[];
  usage: DocxStyleUsageInputV1[];
  docDefaults: DocxStylePropertiesInputV1;
  theme: DocxThemeDefinitionV1;
  sections: DocxSectionInputV1[];
  evenAndOddHeaders: boolean;
}

export interface ResolvedDocxDesignV1 {
  schema: typeof DOCX_RESOLVED_DESIGN_SCHEMA_V1;
  sourceDigest: string;
  facts: DocxTemplateFactsV1;
  styles: DocxStyleResolutionV1;
  theme: DocxThemeDefinitionV1;
  sections: DocxSectionResolutionV1;
  diagnostics: readonly TemplateDiagnosticV1[];
}

export interface DocxCatalogAnalysisV1
  extends Omit<ResolvedDocxDesignV1, "schema"> {
  schema: typeof DOCX_CATALOG_ANALYSIS_SCHEMA_V1;
  matching: DocxTemplateMatchResultV1;
}

function entry(
  zip: DocxIntakeArchive,
  partRef: string
): ZipEntry | undefined {
  const candidate = zip.files[partRef];
  return candidate && !candidate.dir ? candidate : undefined;
}

function isWord(event: XmlElementEventV1): boolean {
  return WORD_URIS.has(event.uri);
}

function isDrawing(event: XmlElementEventV1): boolean {
  return DRAWING_URIS.has(event.uri);
}

function attribute(
  event: XmlElementEventV1,
  local: string,
  uris?: ReadonlySet<string>
): string | undefined {
  return event.attributes.find(
    (item) =>
      item.local === local &&
      (uris === undefined || item.uri === "" || uris.has(item.uri))
  )?.value;
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function onOff(value: string | undefined): boolean {
  return value === undefined || !["0", "false", "off"].includes(value);
}

function themeFont(value: string | undefined): DocxThemeFontReferenceV1["theme"] {
  const match = /^(major|minor)(Ascii|HAnsi|EastAsia|Bidi|Cs)$/.exec(
    value ?? ""
  );
  if (!match) return undefined;
  const script: DocxFontScriptV1 =
    match[2] === "Ascii"
      ? "ascii"
      : match[2] === "HAnsi"
        ? "hAnsi"
        : match[2] === "EastAsia"
          ? "eastAsia"
          : "cs";
  return `${match[1] as "major" | "minor"}-${script}`;
}

function applyProperty(
  event: XmlElementEventV1,
  target: DocxStylePropertiesInputV1
): void {
  if (!isWord(event)) return;
  if (event.local === "rFonts") {
    const fonts =
      (target.fonts as Partial<
        Record<DocxFontScriptV1, DocxThemeFontReferenceV1>
      > | undefined) ?? {};
    for (const script of ["ascii", "hAnsi", "eastAsia", "cs"] as const) {
      const family = attribute(event, script, WORD_URIS);
      const themed = themeFont(
        attribute(
          event,
          script === "cs" ? "cstheme" : `${script}Theme`,
          WORD_URIS
        )
      );
      if (family || themed) {
        fonts[script] = {
          ...(family ? { family } : {}),
          ...(themed ? { theme: themed } : {}),
        };
      }
    }
    target.fonts = fonts;
  } else if (event.local === "sz") {
    target.sizeHalfPoints = integer(attribute(event, "val", WORD_URIS));
  } else if (event.local === "b") {
    target.bold = onOff(attribute(event, "val", WORD_URIS));
  } else if (event.local === "color") {
    const rgb = attribute(event, "val", WORD_URIS);
    const theme = attribute(event, "themeColor", WORD_URIS);
    const tint = attribute(event, "themeTint", WORD_URIS);
    const shade = attribute(event, "themeShade", WORD_URIS);
    target.color = {
      ...(rgb && rgb !== "auto" ? { rgb } : {}),
      ...(theme ? { theme } : {}),
      ...(tint ? { tint } : {}),
      ...(shade ? { shade } : {}),
    };
  } else if (event.local === "spacing") {
    target.spacingBeforeTwips = integer(
      attribute(event, "before", WORD_URIS)
    );
    target.spacingAfterTwips = integer(attribute(event, "after", WORD_URIS));
    target.lineTwips = integer(attribute(event, "line", WORD_URIS));
  } else if (event.local === "outlineLvl") {
    target.outlineLevel = integer(attribute(event, "val", WORD_URIS));
  } else if (event.local === "jc") {
    target.alignment = attribute(event, "val", WORD_URIS);
  } else if (event.local === "ilvl") {
    target.numberingLevel = integer(attribute(event, "val", WORD_URIS));
  } else if (event.local === "tblStylePr") {
    const region = attribute(event, "type", WORD_URIS);
    const regions = Array.isArray(target.tableConditionalRegions)
      ? [...target.tableConditionalRegions]
      : [];
    if (region) regions.push(region);
    target.tableConditionalRegions = regions;
  }
}

function parseStyles(bytes: Uint8Array): {
  docDefaults: DocxStylePropertiesInputV1;
  styles: DocxStyleDefinitionInputV1[];
  defaultParagraphStyle?: string;
} {
  const docDefaults: DocxStylePropertiesInputV1 = {};
  const styles: DocxStyleDefinitionInputV1[] = [];
  let current:
    | (DocxStyleDefinitionInputV1 & {
        properties: DocxStylePropertiesInputV1;
        depth: number;
        isDefault: boolean;
      })
    | undefined;
  let defaultsDepth = 0;
  let defaultParagraphStyle: string | undefined;
  streamXmlPart("word/styles.xml", bytes, {
    open(event) {
      if (!isWord(event)) return;
      if (event.local === "docDefaults") defaultsDepth = event.depth;
      if (event.local === "style") {
        const kind = attribute(event, "type", WORD_URIS);
        const styleId = attribute(event, "styleId", WORD_URIS);
        if (
          styleId &&
          (kind === "paragraph" || kind === "character" || kind === "table")
        ) {
          current = {
            styleId,
            kind,
            locator: `styles.${styles.length}`,
            properties: {},
            depth: event.depth,
            isDefault:
              attribute(event, "default", WORD_URIS) !== undefined &&
              onOff(attribute(event, "default", WORD_URIS)),
          };
        }
        return;
      }
      if (current) {
        if (event.local === "name") {
          current.displayName = attribute(event, "val", WORD_URIS);
        } else if (event.local === "basedOn") {
          current.basedOn = attribute(event, "val", WORD_URIS);
        } else if (event.local === "qFormat") {
          current.qFormat = onOff(attribute(event, "val", WORD_URIS));
        } else if (event.local === "uiPriority") {
          current.uiPriority = integer(attribute(event, "val", WORD_URIS));
        }
        applyProperty(event, current.properties);
      } else if (defaultsDepth > 0) {
        applyProperty(event, docDefaults);
      }
    },
    close(event) {
      if (
        current &&
        WORD_URIS.has(event.uri) &&
        event.local === "style" &&
        event.depth === current.depth
      ) {
        const { depth: _depth, isDefault, ...style } = current;
        styles.push(style);
        if (isDefault && style.kind === "paragraph") {
          defaultParagraphStyle = style.styleId;
        }
        current = undefined;
      }
      if (
        event.local === "docDefaults" &&
        WORD_URIS.has(event.uri) &&
        event.depth === defaultsDepth
      ) {
        defaultsDepth = 0;
      }
    },
  });
  return { docDefaults, styles, defaultParagraphStyle };
}

function parseTheme(bytes: Uint8Array): DocxThemeDefinitionV1 {
  const colors: Record<string, string> = {};
  const fonts: DocxThemeDefinitionV1["fonts"] = { major: {}, minor: {} };
  let colorSlot: string | undefined;
  let fontFamily: "major" | "minor" | undefined;
  streamXmlPart("word/theme/theme.xml", bytes, {
    open(event) {
      if (!isDrawing(event)) return;
      if (
        [
          "dk1",
          "lt1",
          "dk2",
          "lt2",
          "accent1",
          "accent2",
          "accent3",
          "accent4",
          "accent5",
          "accent6",
          "hlink",
          "folHlink",
        ].includes(event.local)
      ) {
        colorSlot = event.local;
      } else if (colorSlot && event.local === "srgbClr") {
        const value = attribute(event, "val");
        if (value) colors[colorSlot] = value;
      } else if (colorSlot && event.local === "sysClr") {
        const value = attribute(event, "lastClr") ?? attribute(event, "val");
        if (value) colors[colorSlot] = value;
      } else if (event.local === "majorFont") {
        fontFamily = "major";
      } else if (event.local === "minorFont") {
        fontFamily = "minor";
      } else if (fontFamily) {
        const typeface = attribute(event, "typeface");
        if (!typeface) return;
        if (event.local === "latin") {
          fonts[fontFamily].ascii = typeface;
          fonts[fontFamily].hAnsi = typeface;
        } else if (event.local === "ea") {
          fonts[fontFamily].eastAsia = typeface;
        } else if (event.local === "cs") {
          fonts[fontFamily].cs = typeface;
        }
      }
    },
    close(event) {
      if (DRAWING_URIS.has(event.uri) && event.local === colorSlot) {
        colorSlot = undefined;
      }
      if (
        DRAWING_URIS.has(event.uri) &&
        ((event.local === "majorFont" && fontFamily === "major") ||
          (event.local === "minorFont" && fontFamily === "minor"))
      ) {
        fontFamily = undefined;
      }
    },
  });
  return { colors, fonts };
}

function relationshipTargets(
  opc: DocxOpcFactsV1
): ReadonlyMap<string, string> {
  return new Map(
    opc.relationships
      .filter(
        ({ sourcePartRef, target }) =>
          sourcePartRef === "word/document.xml" && target.kind === "internal"
      )
      .map((relationship) => [
        relationship.relationshipRef,
        relationship.target.kind === "internal"
          ? relationship.target.partRef
          : relationship.relationshipRef,
      ])
  );
}

function semanticPart(
  opc: DocxOpcFactsV1,
  kind: "settings" | "styles" | "theme",
  fallback: string
): string {
  const relationship = opc.relationships.find(
    ({ sourcePartRef, target, kind: relationshipKind }) =>
      sourcePartRef === "word/document.xml" &&
      relationshipKind === kind &&
      target.kind === "internal" &&
      target.exists
  );
  return relationship?.target.kind === "internal"
    ? relationship.target.partRef
    : fallback;
}

function parseDocument(
  bytes: Uint8Array,
  defaultParagraphStyle: string | undefined,
  relationshipMap: ReadonlyMap<string, string>
): { usage: DocxStyleUsageInputV1[]; sections: DocxSectionInputV1[] } {
  const usage: DocxStyleUsageInputV1[] = [];
  const sections: DocxSectionInputV1[] = [];
  let deletionDepth = 0;
  let paragraph:
    | {
        depth: number;
        styleId?: string;
        properties: DocxStylePropertiesInputV1;
        locator: string;
      }
    | undefined;
  let currentSection:
    | {
        depth: number;
        page: Partial<DocxPageGeometryInputV1>;
        titlePage: boolean;
        pageNumberStart?: number;
        headers: NonNullable<DocxSectionInputV1["headers"]>;
        footers: NonNullable<DocxSectionInputV1["footers"]>;
      }
    | undefined;
  let paragraphOrdinal = 0;
  streamXmlPart("word/document.xml", bytes, {
    open(event) {
      if (!isWord(event)) return;
      if (event.local === "del") deletionDepth += 1;
      if (event.local === "p") {
        paragraph = {
          depth: event.depth,
          styleId: defaultParagraphStyle,
          properties: {},
          locator: `document.paragraph.${paragraphOrdinal}`,
        };
        paragraphOrdinal += 1;
      } else if (paragraph && event.local === "pStyle") {
        paragraph.styleId = attribute(event, "val", WORD_URIS);
      }
      if (paragraph) applyProperty(event, paragraph.properties);

      if (event.local === "sectPr") {
        currentSection = {
          depth: event.depth,
          page: {},
          titlePage: false,
          headers: {},
          footers: {},
        };
      } else if (currentSection && event.local === "pgSz") {
        currentSection.page.widthTwips = integer(
          attribute(event, "w", WORD_URIS)
        );
        currentSection.page.heightTwips = integer(
          attribute(event, "h", WORD_URIS)
        );
        const orientation = attribute(event, "orient", WORD_URIS);
        if (orientation === "portrait" || orientation === "landscape") {
          currentSection.page.orientation = orientation;
        }
      } else if (currentSection && event.local === "pgMar") {
        currentSection.page.marginTopTwips = integer(
          attribute(event, "top", WORD_URIS)
        );
        currentSection.page.marginRightTwips = integer(
          attribute(event, "right", WORD_URIS)
        );
        currentSection.page.marginBottomTwips = integer(
          attribute(event, "bottom", WORD_URIS)
        );
        currentSection.page.marginLeftTwips = integer(
          attribute(event, "left", WORD_URIS)
        );
      } else if (currentSection && event.local === "titlePg") {
        currentSection.titlePage = onOff(attribute(event, "val", WORD_URIS));
      } else if (currentSection && event.local === "pgNumType") {
        currentSection.pageNumberStart = integer(
          attribute(event, "start", WORD_URIS)
        );
      } else if (
        currentSection &&
        (event.local === "headerReference" ||
          event.local === "footerReference")
      ) {
        const variant = attribute(event, "type", WORD_URIS);
        const relationshipId = attribute(event, "id", RELATIONSHIP_URIS);
        if (
          relationshipId &&
          (variant === "default" || variant === "even" || variant === "first")
        ) {
          const target = relationshipMap.get(relationshipId) ?? relationshipId;
          const collection =
            event.local === "headerReference"
              ? currentSection.headers
              : currentSection.footers;
          collection[variant] = target;
        }
      } else if (event.local === "tblStyle") {
        const styleId = attribute(event, "val", WORD_URIS);
        if (styleId && deletionDepth === 0) {
          usage.push({
            styleId,
            count: 1,
            story: "document",
            section: sections.length,
            locator: `document.table.${usage.length}`,
          });
        }
      }
    },
    close(event) {
      if (
        paragraph &&
        WORD_URIS.has(event.uri) &&
        event.local === "p" &&
        event.depth === paragraph.depth
      ) {
        if (paragraph.styleId) {
          usage.push({
            styleId: paragraph.styleId,
            count: 1,
            story: "document",
            section: sections.length,
            locator: paragraph.locator,
            deleted: deletionDepth > 0,
            ...(Object.keys(paragraph.properties).length > 0
              ? { direct: paragraph.properties }
              : {}),
          });
        }
        paragraph = undefined;
      }
      if (
        currentSection &&
        WORD_URIS.has(event.uri) &&
        event.local === "sectPr" &&
        event.depth === currentSection.depth
      ) {
        const candidate = currentSection.page;
        if (
          candidate.widthTwips !== undefined &&
          candidate.heightTwips !== undefined &&
          candidate.marginTopTwips !== undefined &&
          candidate.marginRightTwips !== undefined &&
          candidate.marginBottomTwips !== undefined &&
          candidate.marginLeftTwips !== undefined
        ) {
          sections.push({
            section: sections.length,
            locator: `document.section.${sections.length}`,
            page: candidate as DocxPageGeometryInputV1,
            titlePage: currentSection.titlePage,
            ...(currentSection.pageNumberStart === undefined
              ? {}
              : { pageNumberStart: currentSection.pageNumberStart }),
            headers: currentSection.headers,
            footers: currentSection.footers,
          });
        }
        currentSection = undefined;
      }
      if (WORD_URIS.has(event.uri) && event.local === "del") {
        deletionDepth -= 1;
      }
    },
  });
  return { usage, sections };
}

function parseSettings(bytes: Uint8Array | undefined): {
  evenAndOddHeaders: boolean;
  colorMapping: Record<string, string>;
} {
  let evenAndOddHeaders = false;
  const colorMapping: Record<string, string> = {};
  if (!bytes) return { evenAndOddHeaders, colorMapping };
  streamXmlPart("word/settings.xml", bytes, {
    open(event) {
      if (!isWord(event)) return;
      if (event.local === "evenAndOddHeaders") {
        evenAndOddHeaders = onOff(attribute(event, "val", WORD_URIS));
      } else if (event.local === "clrSchemeMapping") {
        for (const item of event.attributes) {
          if (item.uri === "" || WORD_URIS.has(item.uri)) {
            colorMapping[item.local] = item.value;
          }
        }
      }
    },
  });
  return { evenAndOddHeaders, colorMapping };
}

function extractDesignInput(
  zip: DocxIntakeArchive,
  opc: DocxOpcFactsV1
): ExtractedDesignInput {
  const stylesPart = entry(
    zip,
    semanticPart(opc, "styles", "word/styles.xml")
  );
  const styleInput = stylesPart
    ? parseStyles(stylesPart.asUint8Array())
    : { docDefaults: {}, styles: [], defaultParagraphStyle: undefined };
  const themePart = entry(
    zip,
    semanticPart(opc, "theme", "word/theme/theme1.xml")
  );
  const theme = themePart
    ? parseTheme(themePart.asUint8Array())
    : { colors: {}, fonts: { major: {}, minor: {} } };
  const settingsPart = entry(
    zip,
    semanticPart(opc, "settings", "word/settings.xml")
  );
  const settings = parseSettings(settingsPart?.asUint8Array());
  theme.colorMapping = settings.colorMapping;
  const documentPart = entry(zip, "word/document.xml");
  const document = documentPart
    ? parseDocument(
        documentPart.asUint8Array(),
        styleInput.defaultParagraphStyle,
        relationshipTargets(opc)
      )
    : { usage: [], sections: [] };
  return {
    styles: styleInput.styles,
    usage: document.usage,
    docDefaults: styleInput.docDefaults,
    theme,
    sections: document.sections,
    evenAndOddHeaders: settings.evenAndOddHeaders,
  };
}

/** Secure one-unzip DOCX -> resolved design facts pipeline. */
export async function resolveDocxTemplateDesign(
  bytes: Uint8Array,
  options: {
    progress?: (event: TemplateImportProgressEventV1) => void;
  } = {}
): Promise<ResolvedDocxDesignV1> {
  const sourceBytes = new Uint8Array(bytes);
  const sourceDigest = await sha256Hex(sourceBytes);
  const zip = unzipDocx(sourceBytes, DOCX_TEMPLATE_INTAKE_BUDGET);
  const opc = await analyzeDocxOpcArchive(zip, { progress: options.progress });
  const facts = await analyzeDocxTemplateArchive(zip, opc, options);
  const extracted = extractDesignInput(zip, opc);
  const styles = await resolveDocxStyles({
    docDefaults: extracted.docDefaults,
    styles: extracted.styles,
    usage: extracted.usage,
  });
  const sections = await resolveDocxSections({
    evenAndOddHeaders: extracted.evenAndOddHeaders,
    sections: extracted.sections,
  });
  const diagnostics = [
    ...facts.diagnostics,
    ...styles.diagnostics,
    ...sections.diagnostics,
  ];
  return {
    schema: DOCX_RESOLVED_DESIGN_SCHEMA_V1,
    sourceDigest,
    facts,
    styles,
    theme: extracted.theme,
    sections,
    diagnostics,
  };
}

/** Secure one-unzip DOCX -> catalog candidates convenience API for every host. */
export async function analyzeDocxTemplateForCatalog(
  bytes: Uint8Array,
  options: {
    catalog: TemplateCapabilityCatalogV1;
    bundledFontFamilies: readonly string[];
    progress?: (event: TemplateImportProgressEventV1) => void;
  }
): Promise<DocxCatalogAnalysisV1> {
  const design = await resolveDocxTemplateDesign(bytes, {
    progress: options.progress,
  });
  const matching = await matchDocxTemplate({
    analysisDigest: design.sourceDigest,
    catalog: options.catalog,
    styles: design.styles,
    theme: design.theme,
    sections: design.sections,
    bundledFontFamilies: options.bundledFontFamilies,
    progress: options.progress,
  });
  return {
    ...design,
    schema: DOCX_CATALOG_ANALYSIS_SCHEMA_V1,
    diagnostics: [...design.diagnostics, ...matching.diagnostics],
    matching,
  };
}
