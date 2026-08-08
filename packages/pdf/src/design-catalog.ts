/**
 * Versioned renderer-owned PDF design capability catalog.
 *
 * This is the sole inventory of design leaves the Typst template, serializer,
 * settings bindings, and engine policy may consume or write. Presentation
 * metadata is projected into a separate registry so UX grouping and copy can
 * evolve without changing runtime validation or its digest.
 */
import {
  TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
  TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2,
  TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
  flattenDesign,
  unflattenDesign,
  validateCapabilityCatalogV1,
  validateCapabilityCatalogV2,
  validateCapabilityPresentationRegistryV1,
  validateCapabilityPresentationRegistryV2,
  validateCompleteBaseline,
  validateCompleteBaselineV2,
  validateDesignAgainstCatalog,
  validateDesignOverlayAgainstCatalogV2,
  type CapabilityEditKindV1,
  type CapabilityComparisonKindV1,
  type CapabilityValueFormatV1,
  type CapabilityValueKindV1,
  type CapabilityValueKindV2,
  type TemplateCapabilityCatalogV1,
  type TemplateCapabilityCatalogV2,
  type TemplateCapabilityDescriptorV1,
  type TemplateCapabilityDescriptorV2,
  type TemplateCapabilityPresentationRegistryV1
} from "@atlcli/template-pack";
import type { WikiPdfTemplateDesignV1 } from "@atlcli/template-pack";

interface OwnedDescriptor extends TemplateCapabilityDescriptorV1 {
  journey: "details" | "primary";
}

interface OwnedDescriptorV3 extends TemplateCapabilityDescriptorV2 {
  journey: "details" | "primary";
}

const FONT_ROLES = ["body", "heading", "mono"] as const;
const WEIGHTS = ["regular", "medium", "semibold", "bold"] as const;
const HEADER_MODES = ["title", "chapter", "custom"] as const;

const descriptor = (
  path: string,
  valueKind: CapabilityValueKindV1,
  journey: OwnedDescriptor["journey"],
  options: Omit<
    TemplateCapabilityDescriptorV1,
    "consumers" | "path" | "required" | "valueKind"
  > & { required?: boolean } = {}
): OwnedDescriptor => ({
  path,
  valueKind,
  journey,
  required: options.required ?? true,
  consumers: ["pdf.renderer"],
  ...(options.runtimeWriters ? { runtimeWriters: options.runtimeWriters } : {}),
  ...(options.writeOrder ? { writeOrder: options.writeOrder } : {}),
  ...(options.enumValues ? { enumValues: options.enumValues } : {}),
  ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
  ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
});

const binding = (id: string) =>
  [{ kind: "runtime-binding" as const, id: `setting.${id}` }] as const;
const policy = (id: string) =>
  [{ kind: "engine-policy" as const, id: `theme.${id}` }] as const;

const ROLE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  body: ["font", "size"],
  adfSmallText: ["font", "size"],
  h1: ["font", "size", "weight"],
  h2: ["font", "size", "weight"],
  h3: ["font", "size", "weight"],
  code: ["font", "size"],
  tableCell: ["font", "size"],
  numbering: ["font", "size", "weight"],
  runningHead: ["font", "size"],
  coverEyebrow: ["font", "size", "weight", "tracking"],
  coverTitle: ["font", "size", "weight"],
  coverMetaLabel: ["font", "size", "weight", "tracking"],
  coverMetaValue: ["font", "size"],
  closingEyebrow: ["font", "size", "weight", "tracking"],
  closingTitle: ["font", "size", "weight"],
  closingMetaLabel: ["font", "size", "weight", "tracking"],
  closingMetaValue: ["font", "size"],
  colophon: ["font", "size"],
  statusBadge: ["font", "size", "weight"],
  taskMarker: ["font", "size", "weight"],
};

const PRIMARY_ROLES = new Set(["body", "h1", "h2", "h3", "code", "tableCell"]);

const COLOR_NAMES = [
  "accent",
  "ink",
  "paper",
  "coverTitleInk",
  "warmSlate",
  "muted",
  "hairline",
  "heading3",
  "codeBackground",
  "neutral",
  "taskChecked",
  "taskUnchecked",
  "mention",
  "placeholder",
  "tableStroke",
  "tableHeaderBackground",
  "smartCardInlineBackground",
  "smartCardBlockBackground",
  "smartCardBlockStroke",
  "mediaGroupBackground",
  "watermark",
] as const;

const LAYOUT_NAMES = [
  "paragraphLeading",
  "paragraphSpacing",
  "adfBlockIndentStep",
  "listBodyIndent",
  "listSpacing",
  "enumBodyIndent",
  "enumSpacing",
  "h1Above",
  "h1Below",
  "h2Above",
  "h2Below",
  "h3Above",
  "h3Below",
  "inlineCodeInsetX",
  "inlineCodeInsetY",
  "inlineCodeRadius",
  "codeInset",
  "codeRadius",
  "codeTitleBelow",
  "calloutStroke",
  "calloutInsetX",
  "calloutInsetY",
  "calloutRadius",
  "calloutAbove",
  "calloutBelow",
  "calloutIconGap",
  "smartCardInlineInsetX",
  "smartCardInlineInsetY",
  "smartCardInlineRadius",
  "smartCardBlockInset",
  "smartCardBlockRadius",
  "inlineMediaBaseline",
  "inlineMediaInset",
  "inlineMediaChipInsetX",
  "inlineMediaChipInsetY",
  "inlineMediaChipRadius",
  "mediaWrapColumnGutter",
  "mediaFrameInset",
  "mediaFrameDefaultStroke",
  "statusBadgeInsetX",
  "statusBadgeInsetY",
  "statusBadgeRadius",
  "denseBadgeCompactInsetX",
  "denseBadgeInsetX",
  "denseBadgeInsetY",
  "denseBadgeRadius",
  "denseBadgeLeading",
  "denseBadgeWidthAdjust",
  "taskGridMarker",
  "taskGridGutter",
  "taskListBodyIndent",
  "pageLayoutColumnGutter",
  "pageLayoutInsetX",
  "denseTableThreshold",
  "tableCellInsetY",
  "tableCellInsetNormalX",
  "tableCellInsetDenseX",
  "coverTopPad",
  "coverLogoBelow",
  "coverLogoHeight",
  "coverLogoWidth",
  "coverEyebrowGap",
  "coverTitleGap",
  "coverRuleLength",
  "coverRuleStroke",
  "coverMetaGap",
  "coverMetaColLabel",
  "coverMetaColGutter",
  "coverMetaRowGutter",
  "coverTitleLeading",
  "closingTopPad",
  "closingEyebrowGap",
  "closingTitleGap",
  "closingRuleLength",
  "closingRuleStroke",
  "closingMetaGap",
  "closingColophonGap",
  "closingTitleLeading",
] as const;

const RATIO_NAMES = [
  "coverBlockWidth",
  "closingBlockWidth",
  "statusBadgeLighten",
  "watermarkOpacityScale",
] as const;
const CALLOUT_NAMES = ["info", "note", "warning", "tip", "success", "error", "panel"] as const;
const STATUS_NAMES = [
  "neutral",
  "grey",
  "gray",
  "purple",
  "red",
  "yellow",
  "green",
  "blue",
  "default",
] as const;

const OWNED_DESCRIPTORS_V1: readonly OwnedDescriptor[] = [
  descriptor("page.size", "enum", "primary", {
    enumValues: ["a4", "letter"],
    runtimeWriters: binding("page"),
  }),
  descriptor("page.orientation", "enum", "primary", {
    enumValues: ["portrait", "landscape"],
    runtimeWriters: binding("orientation"),
  }),
  ...(["top", "bottom", "left", "right"] as const).map((side) =>
    descriptor(`page.margin.${side}`, "length", "primary")
  ),
  descriptor("features.cover.enabled", "boolean", "primary", {
    runtimeWriters: binding("cover"),
  }),
  descriptor("features.outline.enabled", "boolean", "primary", {
    runtimeWriters: binding("outline"),
  }),
  descriptor("features.outline.depth", "number", "primary", {
    minimum: 1,
    maximum: 6,
  }),
  descriptor("features.header.enabled", "boolean", "primary"),
  descriptor("features.header.mode", "enum", "primary", {
    enumValues: HEADER_MODES,
  }),
  descriptor("features.footer.enabled", "boolean", "primary"),
  descriptor("features.closingPage.enabled", "boolean", "primary"),
  descriptor("branding.accent", "color", "primary", {
    runtimeWriters: binding("accentColor"),
  }),
  descriptor("branding.organizationName", "string", "primary", {
    required: false,
    runtimeWriters: binding("organizationName"),
  }),
  ...FONT_ROLES.map((role) =>
    descriptor(`typography.fonts.${role}`, "font-family", "primary")
  ),
  ...Object.entries(ROLE_PROPERTIES).flatMap(([role, properties]) =>
    properties.map((property) =>
      descriptor(
        `typography.roles.${role}.${property}`,
        property === "size" || property === "tracking"
          ? "length"
          : property === "font"
            ? "font-role"
            : "weight",
        PRIMARY_ROLES.has(role) ? "primary" : "details",
        property === "font"
          ? { enumValues: FONT_ROLES }
          : property === "weight"
            ? { enumValues: WEIGHTS }
            : {}
      )
    )
  ),
  ...COLOR_NAMES.map((name) =>
    descriptor(`tokens.colors.${name}`, "color", "primary", {
      ...(name === "accent" ? { runtimeWriters: binding("accentColor") } : {}),
      ...(name === "ink" ? { runtimeWriters: policy("colors.ink") } : {}),
      ...(name === "paper" ? { runtimeWriters: policy("colors.paper") } : {}),
    })
  ),
  ...LAYOUT_NAMES.map((name) => descriptor(`tokens.layout.${name}`, "length", "details")),
  ...RATIO_NAMES.map((name) =>
    descriptor(`tokens.ratios.${name}`, "number", "details", {
      minimum: 0,
      maximum: 100,
    })
  ),
  descriptor("tokens.contrast.minimum", "number", "primary", {
    minimum: 1,
    maximum: 21,
    runtimeWriters: policy("table.coloredCellText.minimumContrast"),
  }),
  ...CALLOUT_NAMES.flatMap((kind) =>
    (["background", "foreground"] as const).map((channel) =>
      descriptor(`semanticPalettes.callouts.${kind}.${channel}`, "color", "primary")
    )
  ),
  ...STATUS_NAMES.map((name) =>
    descriptor(`semanticPalettes.statuses.${name}`, "color", "primary")
  ),
];

const V2_ROLE_PROPERTIES: Readonly<Record<string, readonly string[]>> = {
  closingWebsite: ["font", "size", "weight"],
  closingLegal: ["font", "size", "weight"],
  coverTitleCompact: ["font", "size", "weight"],
  coverTitleMinimum: ["font", "size", "weight"],
};

const optionalV2 = (
  path: string,
  valueKind: CapabilityValueKindV1,
  journey: OwnedDescriptor["journey"],
  options: Omit<
    TemplateCapabilityDescriptorV1,
    "consumers" | "path" | "required" | "valueKind"
  > = {}
): OwnedDescriptor => descriptor(path, valueKind, journey, { ...options, required: false });

const OWNED_DESCRIPTORS_V2_ONLY: readonly OwnedDescriptor[] = [
  optionalV2("compositions.cover.kind", "enum", "primary", {
    enumValues: ["standard", "type-cut"],
  }),
  optionalV2("compositions.cover.logo", "enum", "primary", {
    enumValues: ["show", "hide"],
  }),
  optionalV2("compositions.cover.metadataPosition", "enum", "primary", {
    enumValues: ["flow", "bottom"],
  }),
  optionalV2("compositions.cover.typeCut.angle", "number", "primary", {
    minimum: -180,
    maximum: 180,
  }),
  optionalV2("compositions.cover.typeCut.stop", "number", "primary", {
    minimum: 0,
    maximum: 100,
  }),
  optionalV2("compositions.closingPage.kind", "enum", "primary", {
    enumValues: ["document-summary", "brand-lockup"],
  }),
  ...(["logo", "website", "legalNotice"] as const).map((name) =>
    optionalV2(`compositions.closingPage.${name}`, "enum", "primary", {
      enumValues: ["show", "hide"],
    })
  ),
  optionalV2("compositions.closingPage.align", "enum", "primary", {
    enumValues: ["left", "center", "right"],
  }),
  ...(["websiteLabel", "websiteUrl", "legalNotice"] as const).map((name) =>
    optionalV2(`branding.${name}`, "string", "primary")
  ),
  ...(["coverTitleInverse", "closingPageBackground", "closingBrandText"] as const).map(
    (name) => optionalV2(`tokens.colors.${name}`, "color", "primary")
  ),
  ...([
    "coverTitleFrameHeight",
    "coverMetaBottomInset",
    "closingBrandBottomInset",
    "closingBrandBlockWidth",
    "closingBrandLogoWidth",
    "closingBrandLogoHeight",
    "closingBrandLogoGap",
    "closingBrandTextGap",
  ] as const).map((name) => optionalV2(`tokens.layout.${name}`, "length", "details")),
  ...Object.entries(V2_ROLE_PROPERTIES).flatMap(([role, properties]) =>
    properties.map((property) =>
      optionalV2(
        `typography.roles.${role}.${property}`,
        property === "size"
          ? "length"
          : property === "font"
            ? "font-role"
            : "weight",
        "details",
        property === "font"
          ? { enumValues: FONT_ROLES }
          : property === "weight"
            ? { enumValues: WEIGHTS }
            : {}
      )
    )
  ),
];

const OWNED_DESCRIPTORS_V2: readonly OwnedDescriptor[] = [...OWNED_DESCRIPTORS_V1, ...OWNED_DESCRIPTORS_V2_ONLY];

export const PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE = ">=0.15.1 <0.16" as const;

const descriptorV3 = (
  path: string,
  valueKind: CapabilityValueKindV2,
  journey: OwnedDescriptorV3["journey"],
  options: Partial<TemplateCapabilityDescriptorV2> = {}
): OwnedDescriptorV3 => ({
  path,
  valueKind,
  journey,
  required: options.required ?? true,
  owner: options.owner ?? "template",
  consumers: options.consumers ?? ["pdf.renderer.v5"],
  compilerRange: options.compilerRange ?? PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
  stability: options.stability ?? "stable",
  proofs: options.proofs ?? ["contract", "canonical-source", "compile"],
  ...(options.runtimeWriters ? { runtimeWriters: options.runtimeWriters } : {}),
  ...(options.writeOrder ? { writeOrder: options.writeOrder } : {}),
  ...(options.enumValues ? { enumValues: options.enumValues } : {}),
  ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
  ...(options.maximum !== undefined ? { maximum: options.maximum } : {})
});

const OWNED_DESCRIPTORS_V3_BASELINE: readonly OwnedDescriptorV3[] = OWNED_DESCRIPTORS_V2.filter(
  ({ path }) => !path.startsWith("page.") && !path.startsWith("features.")
).map(({ journey, ...capability }) => ({
  ...capability,
  journey,
  required:
    capability.path === "compositions.cover.kind" ||
    capability.path === "compositions.cover.logo" ||
    capability.path.startsWith("compositions.closingPage.")
      ? true
      : capability.required,
  owner: "template",
  consumers: ["pdf.renderer.v5"],
  compilerRange: PDF_TEMPLATE_CATALOG_V3_COMPILER_RANGE,
  stability: "stable",
  proofs: ["contract", "canonical-source", "compile"]
}));

const OWNED_DESCRIPTORS_V3_ONLY: readonly OwnedDescriptorV3[] = [
  descriptorV3("page.format.kind", "enum", "primary", {
    enumValues: ["preset", "custom"]
  }),
  descriptorV3("page.format.name", "enum", "primary", {
    required: false,
    enumValues: ["a4", "letter"]
  }),
  descriptorV3("page.format.width", "length", "details", { required: false }),
  descriptorV3("page.format.height", "length", "details", { required: false }),
  descriptorV3("page.orientation", "enum", "primary", {
    enumValues: ["portrait", "landscape"]
  }),
  descriptorV3("page.binding", "enum", "primary", {
    enumValues: ["left", "right"]
  }),
  descriptorV3("page.margin.mode", "enum", "primary", {
    enumValues: ["physical", "logical"]
  }),
  ...(["top", "bottom", "left", "right", "inside", "outside"] as const).map((name) =>
    descriptorV3(`page.margin.${name}`, "length", "details", {
      required: false
    })
  ),
  descriptorV3("page.bleed", "object", "details", {
    required: false,
    proofs: ["contract", "canonical-source", "compile", "semantic-pdf"]
  }),
  descriptorV3("compositions.running.header", "object", "primary", {
    proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
  }),
  descriptorV3("compositions.running.footer", "object", "primary", {
    proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
  }),
  descriptorV3("navigation.contents", "object", "primary", {
    proofs: ["contract", "canonical-source", "compile", "semantic-pdf"]
  }),
  descriptorV3("navigation.bookmarks", "object", "primary", {
    proofs: ["contract", "canonical-source", "compile", "semantic-pdf"]
  }),
  descriptorV3("navigation.headingNumbers", "object", "primary"),
  descriptorV3("navigation.pageNumbers", "object", "primary"),
  ...(["paragraph", "list", "enumeration", "table", "outline", "callout", "codeBlock"] as const).map((name) =>
    descriptorV3(`components.${name}`, "object", "primary", {
      proofs: ["contract", "canonical-source", "compile", "semantic-pdf", "visual-pdf"]
    })
  ),
  descriptorV3("paints", "object", "details", {
    required: false,
    proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
  }),
  descriptorV3("decorations", "array", "details", {
    required: false,
    proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
  }),
  ...[...new Set([...Object.keys(ROLE_PROPERTIES), ...Object.keys(V2_ROLE_PROPERTIES)])].flatMap((role) =>
    (["style", "stretch", "kerning", "ligatures", "numberType", "numberWidth"] as const).map((property) =>
      descriptorV3(`typography.roles.${role}.${property}`, property === "kerning" ? "boolean" : "enum", "details", {
        required: false,
        ...(property === "style"
          ? { enumValues: ["normal", "italic", "oblique"] }
          : property === "stretch"
            ? { enumValues: ["normal", "condensed", "expanded"] }
            : property === "ligatures"
              ? { enumValues: ["common", "none"] }
              : property === "numberType"
                ? { enumValues: ["lining", "old-style"] }
                : property === "numberWidth"
                  ? { enumValues: ["proportional", "tabular"] }
                  : {}),
        proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
      })
    )
  ),
  ...FONT_ROLES.map((role) =>
    descriptorV3(`typography.fontAxes.${role}`, "object", "details", {
      required: false,
      stability: "experimental",
      proofs: ["contract", "canonical-source", "compile", "visual-pdf"]
    })
  )
];

const OWNED_DESCRIPTORS_V3: readonly OwnedDescriptorV3[] = [
  ...OWNED_DESCRIPTORS_V3_BASELINE,
  ...OWNED_DESCRIPTORS_V3_ONLY
];

export const PDF_TEMPLATE_CAPABILITIES_V1: TemplateCapabilityCatalogV1 =
  validateCapabilityCatalogV1({
    schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
    id: "atlcli.pdf-template",
    version: 1,
    descriptors: OWNED_DESCRIPTORS_V1.map(({ journey: _journey, ...capability }) => capability),
  });

export const PDF_TEMPLATE_CAPABILITIES_V2: TemplateCapabilityCatalogV1 =
  validateCapabilityCatalogV1({
    schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V1,
    id: "atlcli.pdf-template",
    version: 2,
    descriptors: OWNED_DESCRIPTORS_V2.map(({ journey: _journey, ...capability }) => capability),
  });

const pathRequirement = (id: string) => ({ kind: "path" as const, id });
const assetRequirement = (id: string) => ({ kind: "asset" as const, id });

/**
 * Catalog V3 is a declaration-only T1 contract. It becomes executable only
 * when canonical revision 5 is registered in `PdfCatalogRuntime` during T3.
 */
export const PDF_TEMPLATE_CAPABILITIES_V3: TemplateCapabilityCatalogV2 = validateCapabilityCatalogV2({
  schema: TEMPLATE_CAPABILITY_CATALOG_SCHEMA_V2,
  id: "atlcli.pdf-template",
  version: 3,
  descriptors: OWNED_DESCRIPTORS_V3.map(({ journey: _journey, ...capability }) => capability),
  assets: [
    "asset.coverBackground",
    "asset.footerDecoration",
    "asset.headerDecoration",
    "asset.logo",
    "asset.pageBackground"
  ],
  labels: ["coverEyebrow"],
  constraints: [
    {
      when: [{ path: "page.format.kind", equals: "preset" }],
      require: [pathRequirement("page.format.name")],
      forbid: [pathRequirement("page.format.width"), pathRequirement("page.format.height")]
    },
    {
      when: [{ path: "page.format.kind", equals: "custom" }],
      require: [pathRequirement("page.format.width"), pathRequirement("page.format.height")],
      forbid: [pathRequirement("page.format.name")]
    },
    {
      when: [{ path: "page.margin.mode", equals: "physical" }],
      require: [
        pathRequirement("page.margin.top"),
        pathRequirement("page.margin.bottom"),
        pathRequirement("page.margin.left"),
        pathRequirement("page.margin.right")
      ],
      forbid: [pathRequirement("page.margin.inside"), pathRequirement("page.margin.outside")]
    },
    {
      when: [{ path: "page.margin.mode", equals: "logical" }],
      require: [
        pathRequirement("page.margin.top"),
        pathRequirement("page.margin.bottom"),
        pathRequirement("page.margin.inside"),
        pathRequirement("page.margin.outside")
      ],
      forbid: [pathRequirement("page.margin.left"), pathRequirement("page.margin.right")]
    },
    {
      when: [{ path: "compositions.cover.kind", equals: "standard" }],
      forbid: [pathRequirement("compositions.cover.typeCut.angle"), pathRequirement("compositions.cover.typeCut.stop")]
    },
    {
      when: [{ path: "compositions.cover.kind", equals: "type-cut" }],
      require: [
        pathRequirement("compositions.cover.typeCut.angle"),
        pathRequirement("compositions.cover.typeCut.stop"),
        pathRequirement("tokens.colors.coverTitleInverse"),
        pathRequirement("tokens.layout.coverTitleFrameHeight"),
        pathRequirement("typography.roles.coverTitleCompact.font"),
        pathRequirement("typography.roles.coverTitleCompact.size"),
        pathRequirement("typography.roles.coverTitleCompact.weight"),
        pathRequirement("typography.roles.coverTitleMinimum.font"),
        pathRequirement("typography.roles.coverTitleMinimum.size"),
        pathRequirement("typography.roles.coverTitleMinimum.weight"),
        assetRequirement("asset.coverBackground")
      ]
    },
    {
      when: [
        { path: "compositions.cover.kind", equals: "type-cut" },
        { path: "compositions.cover.metadataPosition", equals: "bottom" }
      ],
      require: [pathRequirement("tokens.layout.coverMetaBottomInset")]
    },
    {
      when: [{ path: "compositions.closingPage.kind", equals: "brand-lockup" }],
      require: [
        pathRequirement("tokens.colors.closingPageBackground"),
        pathRequirement("tokens.colors.closingBrandText"),
        pathRequirement("tokens.layout.closingBrandBottomInset"),
        pathRequirement("tokens.layout.closingBrandBlockWidth")
      ]
    },
    {
      when: [
        { path: "compositions.closingPage.kind", equals: "brand-lockup" },
        { path: "compositions.closingPage.logo", equals: "show" }
      ],
      require: [
        pathRequirement("tokens.layout.closingBrandLogoWidth"),
        pathRequirement("tokens.layout.closingBrandLogoHeight"),
        pathRequirement("tokens.layout.closingBrandLogoGap"),
        assetRequirement("asset.logo")
      ]
    },
    {
      when: [
        { path: "compositions.closingPage.kind", equals: "brand-lockup" },
        { path: "compositions.closingPage.website", equals: "show" }
      ],
      require: [
        pathRequirement("branding.websiteLabel"),
        pathRequirement("branding.websiteUrl"),
        pathRequirement("tokens.layout.closingBrandTextGap"),
        pathRequirement("typography.roles.closingWebsite.font"),
        pathRequirement("typography.roles.closingWebsite.size"),
        pathRequirement("typography.roles.closingWebsite.weight")
      ]
    },
    {
      when: [
        { path: "compositions.closingPage.kind", equals: "brand-lockup" },
        { path: "compositions.closingPage.legalNotice", equals: "show" }
      ],
      require: [
        pathRequirement("branding.legalNotice"),
        pathRequirement("tokens.layout.closingBrandTextGap"),
        pathRequirement("typography.roles.closingLegal.font"),
        pathRequirement("typography.roles.closingLegal.size"),
        pathRequirement("typography.roles.closingLegal.weight")
      ]
    }
  ]
});

export const PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1: readonly string[] = Object.freeze(
  OWNED_DESCRIPTORS_V1.filter(({ journey }) => journey === "details")
    .map(({ path }) => path)
    .sort()
);

export const PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V2: readonly string[] = Object.freeze(
  OWNED_DESCRIPTORS_V2.filter(({ journey }) => journey === "details")
    .map(({ path }) => path)
    .sort()
);

export const PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V3: readonly string[] = Object.freeze(
  OWNED_DESCRIPTORS_V3.filter(({ journey }) => journey === "details")
    .map(({ path }) => path)
    .sort()
);

function presentationShape(valueKind: CapabilityValueKindV1): {
  comparisonKind: CapabilityComparisonKindV1;
  editKind: CapabilityEditKindV1;
  valueFormat: CapabilityValueFormatV1;
} {
  switch (valueKind) {
    case "boolean":
      return {
        valueFormat: "boolean",
        comparisonKind: "exact",
        editKind: "toggle"
      };
    case "color":
      return {
        valueFormat: "color",
        comparisonKind: "visual",
        editKind: "color"
      };
    case "length":
    case "number":
      return {
        valueFormat: valueKind,
        comparisonKind: "numeric",
        editKind: "number"
      };
    case "font-family":
      return {
        valueFormat: "font",
        comparisonKind: "visual",
        editKind: "font"
      };
    case "enum":
    case "font-role":
    case "weight":
      return {
        valueFormat: "text",
        comparisonKind: "exact",
        editKind: "choice"
      };
    case "string":
      return { valueFormat: "text", comparisonKind: "exact", editKind: "text" };
  }
}

function presentationShapeV2(valueKind: CapabilityValueKindV2): {
  comparisonKind: CapabilityComparisonKindV1;
  editKind: CapabilityEditKindV1;
  valueFormat: CapabilityValueFormatV1;
} {
  if (valueKind === "array" || valueKind === "object") {
    return { valueFormat: "text", comparisonKind: "exact", editKind: "text" };
  }
  return presentationShape(valueKind);
}

function presentationSection(path: string): string {
  if (path.startsWith("page.")) return "page";
  if (path.startsWith("features.")) return "document";
  if (path.startsWith("compositions.")) return "document";
  if (path.startsWith("branding.")) return "brand";
  if (path.startsWith("typography.")) return "typography";
  if (path.startsWith("semanticPalettes.")) return "semantic-colors";
  if (path.startsWith("navigation.")) return "navigation";
  if (path.startsWith("components.")) return "components";
  if (path === "paints" || path === "decorations") return "decorations";
  return "colors";
}

export const PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1: TemplateCapabilityPresentationRegistryV1 =
  validateCapabilityPresentationRegistryV1(
    PDF_TEMPLATE_CAPABILITIES_V1,
    {
      schema: TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
      id: "atlcli.pdf-template.primary",
      version: 1,
      descriptors: OWNED_DESCRIPTORS_V1.filter(({ journey }) => journey === "primary").map(
        ({ path, valueKind }, order) => ({
          target: path,
          section: presentationSection(path),
          order,
          messageCode: `ATLCLI_PDF_CAPABILITY_${presentationSection(path)
            .replaceAll("-", "_")
            .toUpperCase()}_VALUE`,
          ...presentationShape(valueKind),
        })
      ),
    },
    PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V1
  );

export const PDF_TEMPLATE_CAPABILITY_PRESENTATION_V2: TemplateCapabilityPresentationRegistryV1 =
  validateCapabilityPresentationRegistryV1(
    PDF_TEMPLATE_CAPABILITIES_V2,
    {
      schema: TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
      id: "atlcli.pdf-template.primary",
      version: 2,
      descriptors: OWNED_DESCRIPTORS_V2.filter(({ journey }) => journey === "primary").map(
        ({ path, valueKind }, order) => ({
          target: path,
          section: presentationSection(path),
          order,
          messageCode: `ATLCLI_PDF_CAPABILITY_${presentationSection(path)
            .replaceAll("-", "_")
            .toUpperCase()}_VALUE`,
          ...presentationShape(valueKind),
        })
      ),
    },
    PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V2
  );

export const PDF_TEMPLATE_CAPABILITY_PRESENTATION_V3: TemplateCapabilityPresentationRegistryV1 =
  validateCapabilityPresentationRegistryV2(
    PDF_TEMPLATE_CAPABILITIES_V3,
    {
      schema: TEMPLATE_CAPABILITY_PRESENTATION_SCHEMA_V1,
      id: "atlcli.pdf-template.primary",
      version: 3,
      descriptors: OWNED_DESCRIPTORS_V3.filter(({ journey }) => journey === "primary").map(
        ({ path, valueKind }, order) => ({
          target: path,
          section: presentationSection(path),
          order,
          messageCode: `ATLCLI_PDF_CAPABILITY_${presentationSection(path).replaceAll("-", "_").toUpperCase()}_VALUE`,
          ...presentationShapeV2(valueKind)
        })
      )
    },
    PDF_TEMPLATE_DETAILS_ONLY_CAPABILITIES_V3
  );

/**
 * Pinned SHA-256 values are filled from the canonical functions and asserted in
 * `design-catalog.test.ts`. They are copied into authoring snapshots/projects
 * starting in T2.
 */
export const PDF_TEMPLATE_CAPABILITY_DIGEST_V1 =
  "d871153baebf8e1cc318736ea34103213882e5d9569aa0efc820b226753a885c" as const;
export const PDF_TEMPLATE_PRESENTATION_REVISION_V1 =
  "4b9725c298b76d2627ab45ccd061134a011b56d27837fd68d409dd0f0e6b246d" as const;
export const PDF_TEMPLATE_CAPABILITY_DIGEST_V2 =
  "bf635cc84dcad85e2a5b91e53f3bf21a19e65a74d64a0cf31e7cc185fdb79607" as const;
export const PDF_TEMPLATE_PRESENTATION_REVISION_V2 =
  "60bbedbf085b411cdf77fc685a6a652dbfe2f12621a840356197a87d3fe424e2" as const;
export const PDF_TEMPLATE_CAPABILITY_DIGEST_V3 =
  "33610de2c362f101413690b3dd3dbee6d5b71571ab762d43374673b445b885dd" as const;
export const PDF_TEMPLATE_PRESENTATION_REVISION_V3 =
  "a40f5cc18c02d34db74408e329fd1fe1e704c91ec06685f4477e3150fdf11a5a" as const;

/** Exact aliases used by the pre-catalog renderer for sparse V1 manifests. */
export const PDF_TEMPLATE_LEGACY_FALLBACK_ALIASES_V1: Readonly<
  Record<string, string>
> = Object.freeze({
  "semanticPalettes.callouts.error.background":
    "semanticPalettes.callouts.warning.background",
  "semanticPalettes.callouts.error.foreground":
    "semanticPalettes.callouts.warning.foreground",
  "semanticPalettes.callouts.success.background":
    "semanticPalettes.callouts.tip.background",
  "semanticPalettes.callouts.success.foreground":
    "semanticPalettes.callouts.tip.foreground",
});

const CAPABILITIES_BY_PATH_V1 = new Map(
  PDF_TEMPLATE_CAPABILITIES_V1.descriptors.map((entry) => [entry.path, entry])
);
const CAPABILITIES_BY_PATH_V2 = new Map(
  PDF_TEMPLATE_CAPABILITIES_V2.descriptors.map((entry) => [entry.path, entry])
);

function readPath(design: WikiPdfTemplateDesignV1, path: string): unknown {
  let cursor: unknown = design;
  for (const segment of path.split(".")) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[segment];
  }
  return cursor;
}

function readPdfDesignCapabilityForCatalog<T>(
  design: WikiPdfTemplateDesignV1,
  path: string,
  capabilities: ReadonlyMap<string, TemplateCapabilityDescriptorV1>
): T {
  if (!capabilities.has(path)) {
    throw new Error(`Unknown PDF design capability "${path}"`);
  }
  const value = readPath(design, path);
  if (value === undefined) throw new Error(`PDF design capability "${path}" is missing`);
  return value as T;
}

/** Catalog-V1-gated leaf read used by revisions 1–3. */
export function readPdfDesignCapability<T = unknown>(
  design: WikiPdfTemplateDesignV1,
  path: string
): T {
  return readPdfDesignCapabilityForCatalog<T>(design, path, CAPABILITIES_BY_PATH_V1);
}

/** Catalog-V2-gated leaf read used only by canonical revision 4. */
export function readPdfDesignCapabilityV2<T = unknown>(
  design: WikiPdfTemplateDesignV1,
  path: string
): T {
  return readPdfDesignCapabilityForCatalog<T>(design, path, CAPABILITIES_BY_PATH_V2);
}

/**
 * Catalog-explicit read for schema-V2 revisions. Revision 5 passes its selected
 * catalog here; there is deliberately no process-global "latest" V3 alias.
 */
export function readPdfDesignCapabilityFromCatalogV2<T = unknown>(
  design: unknown,
  catalog: TemplateCapabilityCatalogV2,
  path: string
): T {
  if (!catalog.descriptors.some((descriptor) => descriptor.path === path)) {
    throw new Error(`Unknown PDF design capability "${path}"`);
  }
  const projection = validateDesignOverlayAgainstCatalogV2(design, catalog);
  if (!(path in projection.flat)) {
    throw new Error(`PDF design capability "${path}" is missing`);
  }
  return projection.flat[path] as T;
}

/** Complete, catalog-explicit validation boundary for schema-V2 revisions. */
export function projectPdfDesignThroughCatalogSchemaV2(
  design: unknown,
  catalog: TemplateCapabilityCatalogV2
): Record<string, unknown> {
  return validateCompleteBaselineV2(design, catalog);
}

/**
 * Strict authoring projection. Unknown or missing required leaves fail before
 * any Typst source is generated.
 */
export function projectPdfDesignThroughCatalog(
  design: WikiPdfTemplateDesignV1
): WikiPdfTemplateDesignV1 {
  return validateCompleteBaseline(
    design,
    PDF_TEMPLATE_CAPABILITIES_V1
  ) as unknown as WikiPdfTemplateDesignV1;
}

/** Strict catalog-V2 projection for canonical revision 4 authoring. */
export function projectPdfDesignThroughCatalogV2(
  design: WikiPdfTemplateDesignV1
): WikiPdfTemplateDesignV1 {
  const validation = validateDesignAgainstCatalog(
    design,
    PDF_TEMPLATE_CAPABILITIES_V2,
    "authoring"
  );
  return unflattenDesign(validation.flat) as unknown as WikiPdfTemplateDesignV1;
}

/**
 * Project the V1-compatible renderer baseline out of a catalog-V2 design.
 *
 * Canonical revision 4 deliberately reuses the characterized revision-3
 * document renderer and replaces only its composition pages. This adapter is
 * the one explicit boundary where V2-only leaves are dropped; all required V1
 * leaves must still be present and valid.
 */
export function projectPdfDesignV1SubsetFromCatalogV2(
  design: WikiPdfTemplateDesignV1
): WikiPdfTemplateDesignV1 {
  const validation = validateDesignAgainstCatalog(
    design,
    PDF_TEMPLATE_CAPABILITIES_V1,
    "legacy"
  );
  return validateCompleteBaseline(
    unflattenDesign(validation.flat),
    PDF_TEMPLATE_CAPABILITIES_V1
  ) as unknown as WikiPdfTemplateDesignV1;
}

/**
 * Explicit compatibility adapter for a known historical baseline.
 *
 * Only catalog-declared leaves from the sparse design are overlaid onto the
 * characterized baseline. Unknown leaves are reported and never executed.
 */
export function materializeLegacyPdfDesign(
  sparseDesign: WikiPdfTemplateDesignV1,
  characterizedBaseline: WikiPdfTemplateDesignV1,
  fallbackAliases: Readonly<Record<string, string>> = {}
): {
  design: WikiPdfTemplateDesignV1;
  ignoredCapabilities: readonly string[];
} {
  const baseline = validateCompleteBaseline(
    characterizedBaseline,
    PDF_TEMPLATE_CAPABILITIES_V1
  );
  const legacy = validateDesignAgainstCatalog(
    sparseDesign,
    PDF_TEMPLATE_CAPABILITIES_V1,
    "legacy"
  );
  const merged: Record<string, unknown> = {
    ...flattenDesign(baseline),
    ...legacy.flat,
  };
  for (const [target, source] of Object.entries(fallbackAliases)) {
    if (target in legacy.flat) continue;
    if (source in legacy.flat) merged[target] = legacy.flat[source];
  }
  return {
    design: validateCompleteBaseline(
      unflattenDesign(merged),
      PDF_TEMPLATE_CAPABILITIES_V1
    ) as unknown as WikiPdfTemplateDesignV1,
    ignoredCapabilities: legacy.ignoredCapabilities,
  };
}

/** Catalog-gated immutable write for bindings and engine policy. */
function writePdfDesignCapabilityForCatalog(
  design: WikiPdfTemplateDesignV1,
  path: string,
  value: unknown,
  writerId: string,
  capabilities: ReadonlyMap<string, TemplateCapabilityDescriptorV1>,
  catalog: TemplateCapabilityCatalogV1
): WikiPdfTemplateDesignV1 {
  const capability = capabilities.get(path);
  if (!capability) throw new Error(`Unknown PDF design capability "${path}"`);
  if (!capability.runtimeWriters?.some((writer) => writer.id === writerId)) {
    throw new Error(`PDF design capability "${path}" is not writable by "${writerId}"`);
  }
  const validation = validateDesignAgainstCatalog(
    unflattenDesign({ [path]: value }),
    {
      ...catalog,
      descriptors: [capability],
    },
    "legacy"
  );
  if (!(path in validation.flat)) {
    throw new Error(`Invalid PDF design capability value at "${path}"`);
  }
  const copy = structuredClone(design) as unknown as Record<string, unknown>;
  const segments = path.split(".");
  let cursor = copy;
  for (const segment of segments.slice(0, -1)) {
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments.at(-1)!] = value;
  return copy as unknown as WikiPdfTemplateDesignV1;
}

/** Catalog-V1-gated immutable write for revisions 1-3. */
export function writePdfDesignCapability(
  design: WikiPdfTemplateDesignV1,
  path: string,
  value: unknown,
  writerId: string
): WikiPdfTemplateDesignV1 {
  return writePdfDesignCapabilityForCatalog(
    design,
    path,
    value,
    writerId,
    CAPABILITIES_BY_PATH_V1,
    PDF_TEMPLATE_CAPABILITIES_V1
  );
}

/** Catalog-V2-gated immutable write for canonical revision 4. */
export function writePdfDesignCapabilityV2(
  design: WikiPdfTemplateDesignV1,
  path: string,
  value: unknown,
  writerId: string
): WikiPdfTemplateDesignV1 {
  return writePdfDesignCapabilityForCatalog(
    design,
    path,
    value,
    writerId,
    CAPABILITIES_BY_PATH_V2,
    PDF_TEMPLATE_CAPABILITIES_V2
  );
}
