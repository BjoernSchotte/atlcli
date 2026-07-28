import { sha256Hex } from "@atlcli/core";
import type {
  TemplateDiagnosticV1,
  TemplateEvidenceV1,
} from "@atlcli/pdf-template-authoring";
import { mappingDiagnostic } from "./mapping-messages.js";
import type {
  DocxFontScriptV1,
  DocxThemeColorReferenceV1,
  DocxThemeFontReferenceV1,
} from "./theme-resolution.js";

export const DOCX_STYLE_RESOLUTION_RULE_V1 = {
  id: "atlcli.docx-style-resolution",
  version: "1",
} as const;

export type DocxStyleKindV1 = "character" | "paragraph" | "table";
export type DocxSemanticStyleRoleV1 =
  | "body"
  | "h1"
  | "h2"
  | "h3"
  | "code"
  | "table";
export type DocxSemanticConfidenceV1 =
  | "conclusive"
  | "corroborated"
  | "suggestive";

export interface DocxStylePropertiesInputV1 {
  fonts?: unknown;
  sizeHalfPoints?: unknown;
  bold?: unknown;
  color?: unknown;
  spacingBeforeTwips?: unknown;
  spacingAfterTwips?: unknown;
  lineTwips?: unknown;
  outlineLevel?: unknown;
  alignment?: unknown;
  numberingLevel?: unknown;
  tableConditionalRegions?: unknown;
}

export interface ResolvedDocxStylePropertiesV1 {
  fonts?: Partial<Record<DocxFontScriptV1, DocxThemeFontReferenceV1>>;
  sizeHalfPoints?: number;
  bold?: boolean;
  color?: DocxThemeColorReferenceV1;
  spacingBeforeTwips?: number;
  spacingAfterTwips?: number;
  lineTwips?: number;
  outlineLevel?: number;
  alignment?: "center" | "justify" | "left" | "right";
  numberingLevel?: number;
  tableConditionalRegions?: readonly string[];
}

export interface DocxStyleDefinitionInputV1 {
  styleId: string;
  kind: DocxStyleKindV1;
  basedOn?: string;
  displayName?: string;
  qFormat?: boolean;
  uiPriority?: number;
  properties?: DocxStylePropertiesInputV1;
  locator: string;
}

export interface DocxStyleUsageInputV1 {
  styleId: string;
  count: number;
  story: string;
  section: number;
  locator: string;
  deleted?: boolean;
  direct?: DocxStylePropertiesInputV1;
}

export interface DocxStyleResolutionInputV1 {
  docDefaults?: DocxStylePropertiesInputV1;
  styles: readonly DocxStyleDefinitionInputV1[];
  usage: readonly DocxStyleUsageInputV1[];
}

export interface ResolvedDocxStyleUseV1 {
  evidence: TemplateEvidenceV1;
  count: number;
  story: string;
  section: number;
  properties: ResolvedDocxStylePropertiesV1;
}

export interface ResolvedDocxStyleV1 {
  styleRef: string;
  styleFingerprint: string;
  kind: DocxStyleKindV1;
  resolvable: boolean;
  chain: readonly string[];
  properties: ResolvedDocxStylePropertiesV1;
  role?: DocxSemanticStyleRoleV1;
  roleConfidence?: DocxSemanticConfidenceV1;
  roleSignals: readonly string[];
  usageCount: number;
  uses: readonly ResolvedDocxStyleUseV1[];
  evidence: TemplateEvidenceV1;
  diagnostics: readonly TemplateDiagnosticV1[];
}

export interface DocxStyleResolutionV1 {
  rule: typeof DOCX_STYLE_RESOLUTION_RULE_V1;
  styles: readonly ResolvedDocxStyleV1[];
  diagnostics: readonly TemplateDiagnosticV1[];
  revisionsPresent: boolean;
}

const STANDARD_STYLE_IDS: Readonly<Record<string, string>> = {
  normal: "body",
  heading1: "h1",
  heading2: "h2",
  heading3: "h3",
  code: "code",
  htmlpreformatted: "code",
  tablenormal: "table",
};
const ALIGNMENTS = new Set(["center", "justify", "left", "right"]);
const TABLE_REGIONS = new Set([
  "band1Horz",
  "band1Vert",
  "firstCol",
  "firstRow",
  "lastCol",
  "lastRow",
]);

async function fingerprint(value: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(value));
}

function normalized(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^A-Za-z0-9]/g, "")
    .toLowerCase();
}

function standardRole(styleId: string): DocxSemanticStyleRoleV1 | undefined {
  const standard = STANDARD_STYLE_IDS[normalized(styleId)];
  return standard as DocxSemanticStyleRoleV1 | undefined;
}

function headingNameLevel(name: string | undefined): number | undefined {
  if (!name) return undefined;
  const compact = normalized(name);
  const stems = [
    "heading",
    "uberschrift",
    "titre",
    "encabezado",
    "titolo",
    "naglowek",
  ];
  const stem = stems.find((candidate) => compact.startsWith(candidate));
  if (!stem) return undefined;
  const level = Number(compact.slice(stem.length));
  return level >= 1 && level <= 3 ? level : undefined;
}

function diagnosticKey(item: TemplateDiagnosticV1): string {
  return `${item.code}:${JSON.stringify(item.params)}`;
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validFontReference(value: unknown): value is DocxThemeFontReferenceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  return (
    (item.family === undefined || typeof item.family === "string") &&
    (item.theme === undefined ||
      (typeof item.theme === "string" &&
        /^(?:major|minor)-(?:ascii|hAnsi|eastAsia|cs)$/.test(item.theme)))
  );
}

function validColor(value: unknown): value is DocxThemeColorReferenceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const item = value as Record<string, unknown>;
  const byte = (candidate: unknown) =>
    candidate === undefined ||
    (typeof candidate === "number" &&
      Number.isInteger(candidate) &&
      candidate >= 0 &&
      candidate <= 255) ||
    (typeof candidate === "string" && /^[0-9A-Fa-f]{2}$/.test(candidate));
  return (
    (item.rgb === undefined || typeof item.rgb === "string") &&
    (item.theme === undefined || typeof item.theme === "string") &&
    byte(item.tint) &&
    byte(item.shade)
  );
}

async function sanitizeProperties(
  input: DocxStylePropertiesInputV1 | undefined,
  styleFingerprint: string,
  diagnostics: TemplateDiagnosticV1[]
): Promise<ResolvedDocxStylePropertiesV1> {
  if (!input) return {};
  const result: ResolvedDocxStylePropertiesV1 = {};
  const invalid = (property: string) => {
    diagnostics.push(
      mappingDiagnostic(
        "DOCX_STYLE_INVALID_PROPERTY",
        { property, style: styleFingerprint },
        "warning"
      )
    );
  };
  if (input.fonts !== undefined) {
    if (
      typeof input.fonts !== "object" ||
      input.fonts === null ||
      Array.isArray(input.fonts)
    ) {
      invalid("fonts");
    } else {
      const fonts: Partial<
        Record<DocxFontScriptV1, DocxThemeFontReferenceV1>
      > = {};
      for (const script of [
        "ascii",
        "hAnsi",
        "eastAsia",
        "cs",
      ] as const) {
        const value = (input.fonts as Record<string, unknown>)[script];
        if (value === undefined) continue;
        if (validFontReference(value)) fonts[script] = { ...value };
        else invalid(`fonts.${script}`);
      }
      if (Object.keys(fonts).length > 0) result.fonts = fonts;
    }
  }
  const integers = [
    "sizeHalfPoints",
    "spacingBeforeTwips",
    "spacingAfterTwips",
    "lineTwips",
    "outlineLevel",
    "numberingLevel",
  ] as const;
  for (const property of integers) {
    const value = input[property];
    if (value === undefined) continue;
    if (!validNonNegativeInteger(value)) invalid(property);
    else result[property] = value;
  }
  if (input.bold !== undefined) {
    if (typeof input.bold !== "boolean") invalid("bold");
    else result.bold = input.bold;
  }
  if (input.alignment !== undefined) {
    if (
      typeof input.alignment !== "string" ||
      !ALIGNMENTS.has(input.alignment)
    ) {
      invalid("alignment");
    } else {
      result.alignment = input.alignment as ResolvedDocxStylePropertiesV1["alignment"];
    }
  }
  if (input.color !== undefined) {
    if (!validColor(input.color)) invalid("color");
    else result.color = { ...input.color };
  }
  if (input.tableConditionalRegions !== undefined) {
    if (
      !Array.isArray(input.tableConditionalRegions) ||
      input.tableConditionalRegions.some(
        (region) => typeof region !== "string" || !TABLE_REGIONS.has(region)
      )
    ) {
      invalid("tableConditionalRegions");
    } else {
      result.tableConditionalRegions = [
        ...new Set(input.tableConditionalRegions as string[]),
      ].sort();
    }
  }
  return result;
}

function mergeProperties(
  ...layers: readonly ResolvedDocxStylePropertiesV1[]
): ResolvedDocxStylePropertiesV1 {
  const merged: ResolvedDocxStylePropertiesV1 = {};
  for (const layer of layers) {
    Object.assign(merged, layer);
    if (layer.fonts) {
      merged.fonts = { ...merged.fonts, ...layer.fonts };
    }
  }
  return merged;
}

function classifyRole(
  style: DocxStyleDefinitionInputV1,
  chain: readonly DocxStyleDefinitionInputV1[],
  properties: ResolvedDocxStylePropertiesV1,
  usageCount: number
): {
  role?: DocxSemanticStyleRoleV1;
  confidence?: DocxSemanticConfidenceV1;
  signals: string[];
} {
  const signals: string[] = [];
  const standard = standardRole(style.styleId);
  const outline = properties.outlineLevel;
  const outlineRole =
    outline !== undefined && outline >= 0 && outline <= 2
      ? (`h${outline + 1}` as DocxSemanticStyleRoleV1)
      : undefined;
  const nameLevel = headingNameLevel(style.displayName);
  const nameRole = nameLevel
    ? (`h${nameLevel}` as DocxSemanticStyleRoleV1)
    : undefined;
  if (standard) signals.push("standard-style-id");
  if (outlineRole) signals.push("outline-level");
  if (nameRole) signals.push("localized-display-name");
  if (style.qFormat) signals.push("quick-format");
  if (style.uiPriority !== undefined && style.uiPriority <= 9) {
    signals.push("ui-priority");
  }
  if (chain.length > 1) signals.push("inheritance");
  if (usageCount > 0) signals.push("actual-usage");

  let role = standard ?? outlineRole;
  if (!role && nameRole && (style.qFormat || outlineRole)) role = nameRole;
  if (!role && style.kind === "table" && usageCount > 0) role = "table";
  if (role === "table" && style.kind !== "table") role = undefined;
  if (role && role !== "table" && style.kind !== "paragraph") role = undefined;
  if (!role) return { signals };

  const evidenceAgrees =
    (!outlineRole || outlineRole === role) && (!nameRole || nameRole === role);
  if (usageCount === 0) {
    return { role, confidence: "suggestive", signals };
  }
  if (
    evidenceAgrees &&
    standard === role &&
    (style.qFormat || outlineRole === role)
  ) {
    return { role, confidence: "conclusive", signals };
  }
  if (
    evidenceAgrees &&
    (outlineRole === role || style.qFormat || standard === role)
  ) {
    return { role, confidence: "corroborated", signals };
  }
  return { role, confidence: "suggestive", signals };
}

/** Resolve docDefaults -> basedOn chain -> style -> per-use direct formatting. */
export async function resolveDocxStyles(
  input: DocxStyleResolutionInputV1
): Promise<DocxStyleResolutionV1> {
  const diagnostics: TemplateDiagnosticV1[] = [];
  const definitions = new Map(
    input.styles.map((style) => [style.styleId, style])
  );
  const fingerprints = new Map<string, string>();
  for (const style of input.styles) {
    fingerprints.set(style.styleId, await fingerprint(style.styleId));
  }
  const defaults = await sanitizeProperties(
    input.docDefaults,
    await fingerprint("doc-defaults"),
    diagnostics
  );
  const memo = new Map<
    string,
    {
      chain: DocxStyleDefinitionInputV1[];
      properties: ResolvedDocxStylePropertiesV1;
      valid: boolean;
    }
  >();
  const resolving = new Set<string>();

  const resolve = async (
    style: DocxStyleDefinitionInputV1
  ): Promise<{
    chain: DocxStyleDefinitionInputV1[];
    properties: ResolvedDocxStylePropertiesV1;
    valid: boolean;
  }> => {
    const cached = memo.get(style.styleId);
    if (cached) return cached;
    const styleFingerprint =
      fingerprints.get(style.styleId) ?? (await fingerprint(style.styleId));
    if (resolving.has(style.styleId)) {
      diagnostics.push(
        mappingDiagnostic(
          "DOCX_STYLE_CYCLE",
          { style: styleFingerprint },
          "error",
          ["reanalyze"]
        )
      );
      return { chain: [style], properties: defaults, valid: false };
    }
    resolving.add(style.styleId);
    let inherited = {
      chain: [] as DocxStyleDefinitionInputV1[],
      properties: defaults,
      valid: true,
    };
    if (style.basedOn) {
      const parent = definitions.get(style.basedOn);
      if (!parent) {
        diagnostics.push(
          mappingDiagnostic(
            "DOCX_STYLE_MISSING_PARENT",
            {
              parent: await fingerprint(style.basedOn),
              style: styleFingerprint,
            },
            "warning"
          )
        );
        inherited = { ...inherited, valid: false };
      } else {
        inherited = await resolve(parent);
      }
    }
    const own = await sanitizeProperties(
      style.properties,
      styleFingerprint,
      diagnostics
    );
    resolving.delete(style.styleId);
    const value = {
      chain: [...inherited.chain, style],
      properties: mergeProperties(inherited.properties, own),
      valid: inherited.valid,
    };
    memo.set(style.styleId, value);
    return value;
  };

  const styles: ResolvedDocxStyleV1[] = [];
  let revisionsPresent = false;
  for (const [ordinal, style] of [...input.styles]
    .sort((left, right) => left.styleId.localeCompare(right.styleId))
    .entries()) {
    const resolved = await resolve(style);
    const styleFingerprint =
      fingerprints.get(style.styleId) ?? (await fingerprint(style.styleId));
    const standard = STANDARD_STYLE_IDS[normalized(style.styleId)];
    const styleRef = standard
      ? `style.standard.${standard}`
      : `style.custom.${styleFingerprint.slice(0, 24)}`;
    const visibleUses = input.usage.filter(
      (usage) => usage.styleId === style.styleId && !usage.deleted
    );
    revisionsPresent ||= input.usage.some(
      (usage) => usage.styleId === style.styleId && usage.deleted
    );
    const usageCount = visibleUses.reduce((sum, usage) => sum + usage.count, 0);
    const classification = classifyRole(
      style,
      resolved.chain,
      resolved.properties,
      usageCount
    );
    const evidence: TemplateEvidenceV1 = {
      id: `evidence:style.${ordinal}`,
      partRef: "styles",
      locator: style.locator,
      styleChain: resolved.chain.map((item) => {
        const role = STANDARD_STYLE_IDS[normalized(item.styleId)];
        const itemFingerprint = fingerprints.get(item.styleId) as string;
        return role
          ? `style.standard.${role}`
          : `style.custom.${itemFingerprint.slice(0, 24)}`;
      }),
    };
    const uses: ResolvedDocxStyleUseV1[] = [];
    for (const [useOrdinal, usage] of visibleUses.entries()) {
      const direct = await sanitizeProperties(
        usage.direct,
        styleFingerprint,
        diagnostics
      );
      uses.push({
        evidence: {
          id: `evidence:style.${ordinal}.use.${useOrdinal}`,
          partRef: usage.story,
          locator: usage.locator,
          sectionIndex: usage.section,
          styleChain: evidence.styleChain,
        },
        count: usage.count,
        story: usage.story,
        section: usage.section,
        properties: mergeProperties(resolved.properties, direct),
      });
    }
    styles.push({
      styleRef,
      styleFingerprint,
      kind: style.kind,
      resolvable: resolved.valid,
      chain: evidence.styleChain ?? [],
      properties: resolved.properties,
      ...(classification.role ? { role: classification.role } : {}),
      ...(classification.confidence
        ? { roleConfidence: classification.confidence }
        : {}),
      roleSignals: classification.signals.sort(),
      usageCount,
      uses,
      evidence,
      diagnostics: [],
    });
  }
  const unique = [
    ...new Map(diagnostics.map((item) => [diagnosticKey(item), item])).values(),
  ].sort((left, right) => diagnosticKey(left).localeCompare(diagnosticKey(right)));
  return {
    rule: DOCX_STYLE_RESOLUTION_RULE_V1,
    styles,
    diagnostics: unique,
    revisionsPresent,
  };
}
