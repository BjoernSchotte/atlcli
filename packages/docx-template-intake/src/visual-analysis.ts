import {
  decodeSvgSource,
  findSvgSafetyViolation,
} from "@atlcli/confluence";
import { sha256Hex } from "@atlcli/core";
import {
  DOCX_TEMPLATE_INTAKE_BUDGET,
  unzipDocx,
} from "@atlcli/docx/scan";
import {
  validateTemplateDiagnostic,
  type CandidateCompatibilityV1,
  type CandidateConfidenceV1,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type TemplateDiagnosticV1,
  type TemplateExplanationV1,
} from "@atlcli/pdf-template-authoring";
import {
  validateTemplateAssetCapabilitiesV1,
  type TemplateAssetCapabilitiesV1,
} from "@atlcli/template-pack";
import {
  MARKUP_COMPATIBILITY_PROFILE_V1,
  type DocxIntakeArchive,
} from "./ooxml-facts.js";
import {
  analyzeDocxOpcArchive,
  type DocxOpcFactsV1,
  type OpcRelationshipFactV1,
} from "./opc.js";
import type {
  DocxMasterVariantV1,
  DocxSectionResolutionV1,
  ResolvedDocxSectionV1,
} from "./section-resolution.js";
import { streamXmlPart } from "./streaming.js";
import {
  SaxesParser,
  type SaxesAttributeNS,
  type SaxesTagNS,
} from "./vendor/saxes-runtime.js";
import { DOCX_VISUAL_MESSAGE_REGISTRY_V1 } from "./visual-messages.js";

export const DOCX_VISUAL_ANALYSIS_SCHEMA_V1 =
  "atlcli.docx-visual-analysis/1" as const;
export const DOCX_VISUAL_PRIVATE_SIDECAR_SCHEMA_V1 =
  "atlcli.docx-visual-private-sidecar/1" as const;
export const DOCX_VISUAL_ANALYSIS_RULE_V1 = {
  id: "atlcli.docx-visual-analysis",
  version: "1",
  pageFillMinimum: 0.8,
  logoMaximumWidth: 2_000,
  logoMaximumHeight: 800,
  watermarkMinimumCoverage: 0.35,
  watermarkMinimumRotation: 15,
  watermarkMaximumOpacity: 0.9,
} as const;

const WORD_URIS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const DRAWING_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
]);
const DRAWING_WORD_URIS = new Set([
  "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
  "http://purl.oclc.org/ooxml/drawingml/wordprocessingDrawing",
]);
const RELATIONSHIP_URIS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
]);
const MCE_URI =
  "http://schemas.openxmlformats.org/markup-compatibility/2006";
const VML_URI = "urn:schemas-microsoft-com:vml";
type SupportedMediaType =
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml";
type VisualKind =
  | "background"
  | "chart"
  | "group"
  | "picture"
  | "shape"
  | "smartart"
  | "textbox";

export interface DocxVisualDimensionsV1 {
  width: number;
  height: number;
  unit: "pixel";
}

export interface DocxVisualAssetV1 {
  sha256: string;
  mediaType: SupportedMediaType;
  byteLength: number;
  dimensions?: DocxVisualDimensionsV1;
  handle: TemplateAssetHandleV1;
}

export interface DocxVisualSourceUseV1 {
  kind: "inline-xml" | "relationship";
  sourcePartRef: string;
  relationshipRef?: string;
  targetFingerprint?: string;
  elementFingerprint?: string;
  alternateContent?: {
    groupId: string;
    branch: string;
    selected: boolean;
  };
  altText?: {
    present: boolean;
    fingerprint?: string;
  };
}

export interface DocxSceneRepresentationV1 {
  kind: "drawingml" | "raster-fallback" | "svg" | "vml";
  assetSha256?: string;
  selected: boolean;
  sourceUse: DocxVisualSourceUseV1;
}

export interface DocxAnchorAxisV1 {
  relativeFrom: string;
  value:
    | { kind: "align"; align: string }
    | { kind: "offset"; emu: number };
}

export type DocxScenePlacementV1 =
  | {
      kind: "inline";
      width: number;
      height: number;
      unit: "emu";
    }
  | {
      kind: "anchor";
      horizontal: DocxAnchorAxisV1;
      vertical: DocxAnchorAxisV1;
      extent: { width: number; height: number; unit: "emu" };
      simplePos?: { x: number; y: number; unit: "emu" };
      useSimplePos: boolean;
      effectExtent?: {
        top: number;
        right: number;
        bottom: number;
        left: number;
        unit: "emu";
      };
      distance: {
        top: number;
        right: number;
        bottom: number;
        left: number;
        unit: "emu";
      };
      wrap: { kind: string; polygonFingerprint?: string };
      relativeHeight?: number;
      behindDoc?: boolean;
      allowOverlap?: boolean;
      layoutInCell?: boolean;
      resolution: "layout-dependent" | "local-exact" | "page-resolved";
    };

export interface SceneCandidateV1 {
  id: string;
  kind: VisualKind;
  scope: {
    story: "document" | "footer" | "header";
    section: number;
    master?: DocxMasterVariantV1;
  };
  representations: readonly DocxSceneRepresentationV1[];
  placement?: DocxScenePlacementV1;
  transform?: {
    xfrm?: {
      offset: { x: number; y: number; unit: "emu" };
      extent: { width: number; height: number; unit: "emu" };
      flipH: boolean;
      flipV: boolean;
    };
    rotation?: { value: number; unit: "degree" };
    crop?: {
      left: number;
      top: number;
      right: number;
      bottom: number;
      unit: "percent";
    };
  };
  paint?: { opacity?: number; fill?: string; stroke?: string };
  compatibility: CandidateCompatibilityV1;
  sectionScope:
    | "native"
    | "not-applicable"
    | "unsupported-section-scope";
}

export interface RoleSuggestionV1 {
  sceneId: string;
  role:
    | "cover-art"
    | "footer-decoration"
    | "header-decoration"
    | "logo"
    | "page-background"
    | "watermark";
  confidence: CandidateConfidenceV1;
  explanations: readonly TemplateExplanationV1[];
}

export interface AssetReviewDescriptorV1 {
  id: string;
  asset: TemplateAssetHandleV1;
  occurrenceCount: number;
  locations: readonly {
    story: "document" | "footer" | "header";
    section: number;
    master?: DocxMasterVariantV1;
  }[];
  proposedRole?: RoleSuggestionV1["role"];
  explanations: readonly TemplateExplanationV1[];
  supportedPlacementChoices: readonly (
    | "candidate-placement"
    | "custom-placement"
    | "slot-default"
  )[];
  thumbnailPossible: boolean;
  defaultDecision: "do-not-include";
  rights: "unknown";
  semanticRole: "unconfirmed";
  accessibility: "unanswered";
  placement: "unanswered";
}

export interface DocxBackgroundFactV1 {
  story: "document";
  color?: string;
  themeColor?: {
    slot: string;
    tint?: string;
    shade?: string;
  };
  drawingPresent: boolean;
}

export interface DocxPageBorderFactV1 {
  section: number;
  offsetFrom: string;
  sides: readonly {
    side: "bottom" | "left" | "right" | "top";
    style?: string;
    color?: string;
    widthEighthPoints?: number;
  }[];
  compatibility: CandidateCompatibilityV1;
}

export interface DocxVisualAnalysisV1 {
  schema: typeof DOCX_VISUAL_ANALYSIS_SCHEMA_V1;
  sourceDigest: string;
  capability: { id: string; version: number };
  rule: typeof DOCX_VISUAL_ANALYSIS_RULE_V1;
  assets: readonly DocxVisualAssetV1[];
  scenes: readonly SceneCandidateV1[];
  roleSuggestions: readonly RoleSuggestionV1[];
  assetReview: readonly AssetReviewDescriptorV1[];
  backgrounds: readonly DocxBackgroundFactV1[];
  pageBorders: readonly DocxPageBorderFactV1[];
  inventory: {
    charts: number;
    smartart: number;
    vml: number;
    groups: number;
    textboxes: number;
    emfWmf: number;
    complexEffects: number;
    externalImages: number;
  };
  diagnostics: readonly TemplateDiagnosticV1[];
}

export interface DocxVisualPrivateRecordV1 {
  sceneId: string;
  sourcePartName: string;
  relationshipId?: string;
  relationshipTarget?: string;
  shapeName?: string;
  shapeTitle?: string;
  shapeDescription?: string;
  sourceAltText?: string;
}

export interface DocxVisualPrivateSidecarV1 {
  schema: typeof DOCX_VISUAL_PRIVATE_SIDECAR_SCHEMA_V1;
  records: readonly DocxVisualPrivateRecordV1[];
}

export interface DocxVisualAnalysisBundleV1 {
  analysis: DocxVisualAnalysisV1;
  privateSource: DocxVisualPrivateSidecarV1;
}

interface ZipEntry {
  name: string;
  dir: boolean;
  asUint8Array(): Uint8Array;
}

interface ContentTypes {
  defaults: Map<string, string>;
  overrides: Map<string, string>;
}

interface MutableAxis {
  relativeFrom: string;
  align?: string;
  offset?: number;
}

interface MutableRawScene {
  ordinal: number;
  partRef: string;
  story: "document" | "footer" | "header";
  section: number;
  kind: VisualKind;
  representationKind: DocxSceneRepresentationV1["kind"];
  relationshipId?: string;
  alternate?: {
    groupId: string;
    branch: string;
    selected: boolean;
    sceneOrdinal: number;
  };
  inline?: { width: number; height: number };
  anchor?: {
    horizontal: MutableAxis;
    vertical: MutableAxis;
    extent: { width: number; height: number };
    simplePos?: { x: number; y: number };
    useSimplePos: boolean;
    effectExtent?: {
      top: number;
      right: number;
      bottom: number;
      left: number;
    };
    distance: { top: number; right: number; bottom: number; left: number };
    wrap: string;
    relativeHeight?: number;
    behindDoc?: boolean;
    allowOverlap?: boolean;
    layoutInCell?: boolean;
  };
  xfrm?: {
    offset: { x: number; y: number };
    extent: { width: number; height: number };
    flipH: boolean;
    flipV: boolean;
  };
  rotation?: number;
  crop?: { left: number; top: number; right: number; bottom: number };
  opacity?: number;
  shapeName?: string;
  shapeTitle?: string;
  shapeDescription?: string;
  altText?: string;
  elementTokens: string[];
  complexEffects: number;
}

interface MutableAlternate {
  depth: number;
  groupId: string;
  choiceSelected: boolean;
  choiceOrdinal: number;
  fallbackOrdinal: number;
}

interface MutableBranch {
  depth: number;
  groupId: string;
  branch: string;
  selected: boolean;
  sceneOrdinal: number;
}

interface RawParseResult {
  scenes: MutableRawScene[];
  backgrounds: DocxBackgroundFactV1[];
  borders: DocxPageBorderFactV1[];
  inventory: {
    charts: number;
    smartart: number;
    vml: number;
    groups: number;
    textboxes: number;
    complexEffects: number;
  };
}

interface VerifiedByPart {
  partRef: string;
  sha256: string;
  mediaType: SupportedMediaType;
  byteLength: number;
  dimensions?: DocxVisualDimensionsV1;
  handle: TemplateAssetHandleV1;
}

function entry(
  archive: DocxIntakeArchive,
  partRef: string
): ZipEntry | undefined {
  const candidate = archive.files[partRef];
  return candidate && !candidate.dir ? candidate : undefined;
}

function integer(value: string | undefined): number | undefined {
  if (value === undefined || !/^-?\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function booleanValue(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return !["0", "false", "off"].includes(value.toLowerCase());
}

function attr(
  tag: SaxesTagNS,
  local: string,
  uris?: ReadonlySet<string>
): string | undefined {
  return (Object.values(tag.attributes) as SaxesAttributeNS[]).find(
    (item) =>
      item.local === local &&
      (uris === undefined || item.uri === "" || uris.has(item.uri))
  )?.value;
}

function safeColor(value: string | undefined): string | undefined {
  return value && /^[0-9A-Fa-f]{6}$/.test(value)
    ? `#${value.toUpperCase()}`
    : undefined;
}

function visualDiagnostic(
  code: string,
  reason: string,
  severity: TemplateDiagnosticV1["severity"] = "warning"
): TemplateDiagnosticV1 {
  const diagnostic: TemplateDiagnosticV1 = {
    code,
    params: { reason },
    severity,
    recoveryActions:
      severity === "error" ? ["reanalyze"] : ["acknowledge-inventory"],
  };
  validateTemplateDiagnostic(diagnostic, [
    DOCX_VISUAL_MESSAGE_REGISTRY_V1,
  ]);
  return diagnostic;
}

function roleExplanation(
  code: string,
  params: Readonly<Record<string, string | number | boolean>>,
  evidenceRefs: readonly string[]
): TemplateExplanationV1 {
  const diagnostic: TemplateDiagnosticV1 = {
    code,
    params,
    severity: "info",
    recoveryActions: [],
  };
  validateTemplateDiagnostic(diagnostic, [
    DOCX_VISUAL_MESSAGE_REGISTRY_V1,
  ]);
  return { code, params, evidenceRefs };
}

function parseContentTypes(
  archive: DocxIntakeArchive
): ContentTypes {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  const contentTypes = entry(archive, "[Content_Types].xml");
  if (!contentTypes) return { defaults, overrides };
  streamXmlPart(
    "[Content_Types].xml",
    contentTypes.asUint8Array(),
    {
      open(event) {
        const value = (name: string): string | undefined =>
          event.attributes.find(({ local }) => local === name)?.value;
        if (event.local === "Default") {
          const extension = value("Extension")?.toLowerCase();
          const contentType = value("ContentType")?.toLowerCase();
          if (extension && contentType) defaults.set(extension, contentType);
        } else if (event.local === "Override") {
          const partName = value("PartName")?.replace(/^\/+/, "");
          const contentType = value("ContentType")?.toLowerCase();
          if (partName && contentType) overrides.set(partName, contentType);
        }
      },
    }
  );
  return { defaults, overrides };
}

function declaredMediaType(
  partRef: string,
  contentTypes: ContentTypes
): string | undefined {
  const override = contentTypes.overrides.get(partRef);
  if (override) return override;
  const extension = partRef.slice(partRef.lastIndexOf(".") + 1).toLowerCase();
  return contentTypes.defaults.get(extension);
}

function bytesStartWith(
  bytes: Uint8Array,
  prefix: readonly number[]
): boolean {
  return (
    bytes.byteLength >= prefix.length &&
    prefix.every((value, index) => bytes[index] === value)
  );
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

function pngDimensions(
  bytes: Uint8Array
): DocxVisualDimensionsV1 | undefined {
  if (
    bytes.byteLength < 24 ||
    !bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  ) {
    return undefined;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  return width > 0 && height > 0
    ? { width, height, unit: "pixel" }
    : undefined;
}

function jpegDimensions(
  bytes: Uint8Array
): DocxVisualDimensionsV1 | undefined {
  if (!bytesStartWith(bytes, [0xff, 0xd8])) return undefined;
  let offset = 2;
  while (offset + 8 < bytes.byteLength) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + length + 2 > bytes.byteLength) return undefined;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
      const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
      return width > 0 && height > 0
        ? { width, height, unit: "pixel" }
        : undefined;
    }
    offset += length + 2;
  }
  return undefined;
}

function svgDimensions(source: string): DocxVisualDimensionsV1 | undefined {
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1] ?? "";
  const numeric = (name: string): number | undefined => {
    const value = new RegExp(
      String.raw`\b${name}\s*=\s*["']\s*(\d+(?:\.\d+)?)`,
      "i"
    ).exec(root)?.[1];
    if (!value) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.ceil(parsed)
      : undefined;
  };
  const width = numeric("width");
  const height = numeric("height");
  if (width && height) return { width, height, unit: "pixel" };
  const viewBox =
    /\bviewBox\s*=\s*["']\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(
      root
    );
  if (!viewBox) return undefined;
  return {
    width: Math.ceil(Number(viewBox[3])),
    height: Math.ceil(Number(viewBox[4])),
    unit: "pixel",
  };
}

function sniffMedia(
  bytes: Uint8Array
):
  | {
      mediaType: SupportedMediaType;
      dimensions?: DocxVisualDimensionsV1;
      svgSource?: string;
    }
  | { unsupported: "emf-wmf" }
  | undefined {
  const png = pngDimensions(bytes);
  if (png) return { mediaType: "image/png", dimensions: png };
  const jpeg = jpegDimensions(bytes);
  if (jpeg) return { mediaType: "image/jpeg", dimensions: jpeg };
  if (
    bytesStartWith(bytes, [0xd7, 0xcd, 0xc6, 0x9a]) ||
    bytesStartWith(bytes, [0x01, 0x00, 0x09, 0x00]) ||
    (bytes.byteLength >= 44 &&
      bytes[40] === 0x20 &&
      bytes[41] === 0x45 &&
      bytes[42] === 0x4d &&
      bytes[43] === 0x46)
  ) {
    return { unsupported: "emf-wmf" };
  }
  const svgSource = decodeSvgSource(bytes);
  if (/<svg(?:\s|>)/i.test(svgSource.replace(/^\uFEFF/, "").trimStart())) {
    return {
      mediaType: "image/svg+xml",
      ...(svgDimensions(svgSource)
        ? { dimensions: svgDimensions(svgSource) }
        : {}),
      svgSource,
    };
  }
  return undefined;
}

function svgComplexity(source: string): {
  elements: number;
  paths: number;
  filters: number;
} {
  const elements = [...source.matchAll(/<\s*(?![!?/])(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*/g)]
    .length;
  const paths = [...source.matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?path\b/gi)]
    .length;
  const filters = [
    ...source.matchAll(
      /<\s*(?:[A-Za-z_][\w.-]*:)?fe(?:Blend|ColorMatrix|ComponentTransfer|Composite|ConvolveMatrix|DiffuseLighting|DisplacementMap|DropShadow|Flood|GaussianBlur|Image|Merge|Morphology|Offset|SpecularLighting|Tile|Turbulence)\b/gi
    ),
  ].length;
  return { elements, paths, filters };
}

function assetLimitReason(
  byteLength: number,
  dimensions: DocxVisualDimensionsV1 | undefined,
  capabilities: TemplateAssetCapabilitiesV1,
  svgSource?: string
): string | undefined {
  if (byteLength > capabilities.maxBytes) return "bytes";
  if (dimensions?.width !== undefined && dimensions.width > capabilities.maxWidth) {
    return "width";
  }
  if (
    dimensions?.height !== undefined &&
    dimensions.height > capabilities.maxHeight
  ) {
    return "height";
  }
  if (
    dimensions &&
    dimensions.width * dimensions.height > capabilities.maxPixels
  ) {
    return "pixels";
  }
  if (svgSource) {
    const complexity = svgComplexity(svgSource);
    if (complexity.elements > capabilities.svg.maxElements) {
      return "svg-elements";
    }
    if (complexity.paths > capabilities.svg.maxPathElements) {
      return "svg-paths";
    }
    if (complexity.filters > capabilities.svg.maxFilterPrimitives) {
      return "svg-filters";
    }
  }
  return undefined;
}

function storyForPart(
  partRef: string
): "document" | "footer" | "header" | undefined {
  if (partRef === "word/document.xml") return "document";
  if (/^word\/header[^/]*\.xml$/i.test(partRef)) return "header";
  if (/^word\/footer[^/]*\.xml$/i.test(partRef)) return "footer";
  return undefined;
}

function numericText(value: string): number | undefined {
  const normalized = value.trim();
  return /^-?\d+$/.test(normalized) ? integer(normalized) : undefined;
}

function parseVisualPart(
  partRef: string,
  bytes: Uint8Array,
  partOrdinal: number
): RawParseResult {
  streamXmlPart(partRef, bytes);
  const story = storyForPart(partRef);
  if (!story) {
    return {
      scenes: [],
      backgrounds: [],
      borders: [],
      inventory: {
        charts: 0,
        smartart: 0,
        vml: 0,
        groups: 0,
        textboxes: 0,
        complexEffects: 0,
      },
    };
  }
  const scenes: MutableRawScene[] = [];
  const backgrounds: DocxBackgroundFactV1[] = [];
  const borders: DocxPageBorderFactV1[] = [];
  const inventory = {
    charts: 0,
    smartart: 0,
    vml: 0,
    groups: 0,
    textboxes: 0,
    complexEffects: 0,
  };
  const parser = new SaxesParser({ xmlns: true });
  const alternates: MutableAlternate[] = [];
  const branches: MutableBranch[] = [];
  const prefixStack: Record<string, string>[] = [{}];
  let depth = 0;
  let section = 0;
  let current: MutableRawScene | undefined;
  let sceneDepth = 0;
  let positionAxis: "horizontal" | "vertical" | undefined;
  let textTarget: "align" | "offset" | undefined;
  let textValue = "";
  let xfrmDepth = 0;
  let border:
    | {
        depth: number;
        section: number;
        offsetFrom: string;
        sides: DocxPageBorderFactV1["sides"][number][];
      }
    | undefined;
  let backgroundDepth = 0;

  const currentAlternate = (): MutableBranch | undefined =>
    branches[branches.length - 1];
  const newScene = (
    tag: SaxesTagNS,
    kind: VisualKind,
    representationKind: DocxSceneRepresentationV1["kind"]
  ): void => {
    if (current) return;
    const branch = currentAlternate();
    const alternate = branch
      ? {
          groupId: branch.groupId,
          branch: branch.branch,
          selected: branch.selected,
          sceneOrdinal: branch.sceneOrdinal,
        }
      : undefined;
    if (branch) branch.sceneOrdinal += 1;
    current = {
      ordinal: scenes.length,
      partRef,
      story,
      section,
      kind,
      representationKind,
      ...(alternate ? { alternate } : {}),
      elementTokens: [`${tag.uri}#${tag.local}`],
      complexEffects: 0,
    };
    sceneDepth = depth;
  };

  parser.on("doctype", () => {
    throw new Error("doctype-forbidden");
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    depth += 1;
    const prefixes = {
      ...(prefixStack[prefixStack.length - 1] ?? {}),
      ...tag.ns,
    };
    prefixStack.push(prefixes);

    if (tag.uri === MCE_URI && tag.local === "AlternateContent") {
      alternates.push({
        depth,
        groupId: `alternate.${partOrdinal}.${alternates.length}`,
        choiceSelected: false,
        choiceOrdinal: 0,
        fallbackOrdinal: 0,
      });
      return;
    }
    const alternate = alternates[alternates.length - 1];
    if (
      alternate &&
      depth === alternate.depth + 1 &&
      tag.uri === MCE_URI &&
      (tag.local === "Choice" || tag.local === "Fallback")
    ) {
      let selected = false;
      let branch: string;
      if (tag.local === "Choice") {
        const requires = (attr(tag, "Requires") ?? "")
          .trim()
          .split(/\s+/)
          .filter(Boolean);
        selected =
          !alternate.choiceSelected &&
          requires.length > 0 &&
          requires.every((prefix) =>
            MARKUP_COMPATIBILITY_PROFILE_V1.understoodNamespaces.includes(
              prefixes[prefix] ?? ""
            )
          );
        if (selected) alternate.choiceSelected = true;
        branch = `choice.${alternate.choiceOrdinal}`;
        alternate.choiceOrdinal += 1;
      } else {
        selected = !alternate.choiceSelected;
        branch = `fallback.${alternate.fallbackOrdinal}`;
        alternate.fallbackOrdinal += 1;
      }
      branches.push({
        depth,
        groupId: alternate.groupId,
        branch,
        selected,
        sceneOrdinal: 0,
      });
      return;
    }

    if (
      DRAWING_WORD_URIS.has(tag.uri) &&
      (tag.local === "inline" || tag.local === "anchor")
    ) {
      newScene(tag, "picture", "drawingml");
      if (current && tag.local === "anchor") {
        current.anchor = {
          horizontal: { relativeFrom: "unknown" },
          vertical: { relativeFrom: "unknown" },
          extent: { width: 0, height: 0 },
          useSimplePos: booleanValue(attr(tag, "simplePos")) ?? false,
          distance: {
            top: integer(attr(tag, "distT")) ?? 0,
            right: integer(attr(tag, "distR")) ?? 0,
            bottom: integer(attr(tag, "distB")) ?? 0,
            left: integer(attr(tag, "distL")) ?? 0,
          },
          wrap: "none",
          ...(integer(attr(tag, "relativeHeight")) === undefined
            ? {}
            : { relativeHeight: integer(attr(tag, "relativeHeight")) }),
          ...(booleanValue(attr(tag, "behindDoc")) === undefined
            ? {}
            : { behindDoc: booleanValue(attr(tag, "behindDoc")) }),
          ...(booleanValue(attr(tag, "allowOverlap")) === undefined
            ? {}
            : { allowOverlap: booleanValue(attr(tag, "allowOverlap")) }),
          ...(booleanValue(attr(tag, "layoutInCell")) === undefined
            ? {}
            : { layoutInCell: booleanValue(attr(tag, "layoutInCell")) }),
        };
      }
    } else if (tag.uri === VML_URI && tag.local === "shape") {
      inventory.vml += 1;
      newScene(tag, "shape", "vml");
      if (current) {
        current.shapeName = attr(tag, "id");
        current.shapeTitle = attr(tag, "title");
        current.shapeDescription = attr(tag, "alt");
        current.altText = attr(tag, "alt");
      }
    } else if (tag.uri === VML_URI && tag.local === "textbox") {
      inventory.textboxes += 1;
      if (current) current.kind = "textbox";
      else newScene(tag, "textbox", "vml");
    }

    if (current) {
      current.elementTokens.push(`${tag.uri}#${tag.local}`);
      if (DRAWING_WORD_URIS.has(tag.uri) && tag.local === "docPr") {
        current.shapeName = attr(tag, "name");
        current.shapeTitle = attr(tag, "title");
        current.shapeDescription = attr(tag, "descr");
        current.altText = attr(tag, "descr") ?? attr(tag, "title");
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        tag.local === "blip"
      ) {
        current.relationshipId =
          attr(tag, "embed", RELATIONSHIP_URIS) ??
          attr(tag, "link", RELATIONSHIP_URIS);
      } else if (tag.uri === VML_URI && tag.local === "imagedata") {
        current.relationshipId =
          attr(tag, "id", RELATIONSHIP_URIS) ?? attr(tag, "relid");
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        tag.local === "extent"
      ) {
        const width = integer(attr(tag, "cx")) ?? 0;
        const height = integer(attr(tag, "cy")) ?? 0;
        if (current.anchor) current.anchor.extent = { width, height };
        else current.inline = { width, height };
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        tag.local === "effectExtent" &&
        current.anchor
      ) {
        current.anchor.effectExtent = {
          left: integer(attr(tag, "l")) ?? 0,
          top: integer(attr(tag, "t")) ?? 0,
          right: integer(attr(tag, "r")) ?? 0,
          bottom: integer(attr(tag, "b")) ?? 0,
        };
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        tag.local === "simplePos" &&
        current.anchor
      ) {
        current.anchor.simplePos = {
          x: integer(attr(tag, "x")) ?? 0,
          y: integer(attr(tag, "y")) ?? 0,
        };
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        (tag.local === "positionH" || tag.local === "positionV") &&
        current.anchor
      ) {
        positionAxis = tag.local === "positionH" ? "horizontal" : "vertical";
        current.anchor[positionAxis].relativeFrom =
          attr(tag, "relativeFrom") ?? "unknown";
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        (tag.local === "align" || tag.local === "posOffset")
      ) {
        textTarget = tag.local === "align" ? "align" : "offset";
        textValue = "";
      } else if (
        DRAWING_WORD_URIS.has(tag.uri) &&
        tag.local.startsWith("wrap") &&
        current.anchor
      ) {
        current.anchor.wrap = tag.local.slice(4).toLowerCase() || "none";
      } else if (DRAWING_URIS.has(tag.uri) && tag.local === "srcRect") {
        current.crop = {
          left: (integer(attr(tag, "l")) ?? 0) / 1_000,
          top: (integer(attr(tag, "t")) ?? 0) / 1_000,
          right: (integer(attr(tag, "r")) ?? 0) / 1_000,
          bottom: (integer(attr(tag, "b")) ?? 0) / 1_000,
        };
      } else if (DRAWING_URIS.has(tag.uri) && tag.local === "xfrm") {
        xfrmDepth = depth;
        current.xfrm = {
          offset: { x: 0, y: 0 },
          extent: { width: 0, height: 0 },
          flipH: booleanValue(attr(tag, "flipH")) ?? false,
          flipV: booleanValue(attr(tag, "flipV")) ?? false,
        };
        const rotation = integer(attr(tag, "rot"));
        if (rotation !== undefined) current.rotation = rotation / 60_000;
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        tag.local === "off" &&
        current.xfrm &&
        xfrmDepth > 0
      ) {
        current.xfrm.offset = {
          x: integer(attr(tag, "x")) ?? 0,
          y: integer(attr(tag, "y")) ?? 0,
        };
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        tag.local === "ext" &&
        current.xfrm &&
        xfrmDepth > 0
      ) {
        current.xfrm.extent = {
          width: integer(attr(tag, "cx")) ?? 0,
          height: integer(attr(tag, "cy")) ?? 0,
        };
      } else if (DRAWING_URIS.has(tag.uri) && tag.local === "alpha") {
        const opacity = integer(attr(tag, "val"));
        if (opacity !== undefined) current.opacity = opacity / 100_000;
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        tag.local === "graphicData"
      ) {
        const uri = attr(tag, "uri") ?? "";
        if (/chart/i.test(uri)) {
          current.kind = "chart";
          inventory.charts += 1;
        } else if (/diagram/i.test(uri)) {
          current.kind = "smartart";
          inventory.smartart += 1;
        }
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        (tag.local === "grpSp" || tag.local === "grpSpPr")
      ) {
        current.kind = "group";
        inventory.groups += 1;
      } else if (
        DRAWING_URIS.has(tag.uri) &&
        [
          "effectDag",
          "effectLst",
          "filter",
          "glow",
          "reflection",
          "softEdge",
        ].includes(tag.local)
      ) {
        current.complexEffects += 1;
        inventory.complexEffects += 1;
      }
    }

    if (WORD_URIS.has(tag.uri) && tag.local === "background") {
      backgroundDepth = depth;
      backgrounds.push({
        story: "document",
        ...(safeColor(attr(tag, "color", WORD_URIS))
          ? { color: safeColor(attr(tag, "color", WORD_URIS)) }
          : {}),
        ...(attr(tag, "themeColor", WORD_URIS)
          ? {
              themeColor: {
                slot: attr(tag, "themeColor", WORD_URIS)!,
                ...(attr(tag, "themeTint", WORD_URIS)
                  ? { tint: attr(tag, "themeTint", WORD_URIS) }
                  : {}),
                ...(attr(tag, "themeShade", WORD_URIS)
                  ? { shade: attr(tag, "themeShade", WORD_URIS) }
                  : {}),
              },
            }
          : {}),
        drawingPresent: false,
      });
    } else if (WORD_URIS.has(tag.uri) && tag.local === "pgBorders") {
      border = {
        depth,
        section,
        offsetFrom: attr(tag, "offsetFrom", WORD_URIS) ?? "page",
        sides: [],
      };
    } else if (
      border &&
      WORD_URIS.has(tag.uri) &&
      ["top", "right", "bottom", "left"].includes(tag.local)
    ) {
      border.sides.push({
        side: tag.local as "bottom" | "left" | "right" | "top",
        ...(attr(tag, "val", WORD_URIS)
          ? { style: attr(tag, "val", WORD_URIS) }
          : {}),
        ...(safeColor(attr(tag, "color", WORD_URIS))
          ? { color: safeColor(attr(tag, "color", WORD_URIS)) }
          : {}),
        ...(integer(attr(tag, "sz", WORD_URIS)) === undefined
          ? {}
          : { widthEighthPoints: integer(attr(tag, "sz", WORD_URIS)) }),
      });
    }
    if (
      WORD_URIS.has(tag.uri) &&
      (tag.local === "pict" || tag.local === "object") &&
      backgroundDepth > 0 &&
      backgrounds.length > 0
    ) {
      backgrounds[backgrounds.length - 1]!.drawingPresent = true;
    }
  });
  parser.on("text", (text: string) => {
    if (textTarget) textValue += text;
  });
  parser.on("closetag", (tag: SaxesTagNS) => {
    if (
      current &&
      textTarget &&
      positionAxis &&
      DRAWING_WORD_URIS.has(tag.uri) &&
      (tag.local === "align" || tag.local === "posOffset") &&
      current.anchor
    ) {
      if (textTarget === "align") {
        current.anchor[positionAxis].align = textValue.trim();
      } else {
        current.anchor[positionAxis].offset = numericText(textValue);
      }
      textTarget = undefined;
      textValue = "";
    }
    if (
      current &&
      DRAWING_URIS.has(tag.uri) &&
      tag.local === "xfrm" &&
      depth === xfrmDepth
    ) {
      xfrmDepth = 0;
    }
    if (
      current &&
      depth === sceneDepth &&
      ((DRAWING_WORD_URIS.has(tag.uri) &&
        (tag.local === "inline" || tag.local === "anchor")) ||
        (tag.uri === VML_URI && tag.local === "shape"))
    ) {
      scenes.push(current);
      current = undefined;
      sceneDepth = 0;
      positionAxis = undefined;
      textTarget = undefined;
      textValue = "";
    }
    if (
      border &&
      WORD_URIS.has(tag.uri) &&
      tag.local === "pgBorders" &&
      depth === border.depth
    ) {
      const native =
        border.offsetFrom === "page" &&
        border.sides.length === 4 &&
        border.sides.every(
          (side) =>
            side.style === "single" &&
            side.color === border!.sides[0]?.color &&
            side.widthEighthPoints === border!.sides[0]?.widthEighthPoints
        );
      borders.push({
        section: border.section,
        offsetFrom: border.offsetFrom,
        sides: border.sides,
        compatibility: native ? "native" : "unsupported",
      });
      border = undefined;
    }
    if (
      WORD_URIS.has(tag.uri) &&
      tag.local === "sectPr" &&
      story === "document"
    ) {
      section += 1;
    }
    if (
      WORD_URIS.has(tag.uri) &&
      tag.local === "background" &&
      depth === backgroundDepth
    ) {
      backgroundDepth = 0;
    }
    const branch = branches[branches.length - 1];
    if (
      branch &&
      tag.uri === MCE_URI &&
      (tag.local === "Choice" || tag.local === "Fallback") &&
      depth === branch.depth
    ) {
      branches.pop();
    }
    const alternate = alternates[alternates.length - 1];
    if (
      alternate &&
      tag.uri === MCE_URI &&
      tag.local === "AlternateContent" &&
      depth === alternate.depth
    ) {
      alternates.pop();
    }
    prefixStack.pop();
    depth -= 1;
  });
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  parser.write(source).close();
  return { scenes, backgrounds, borders, inventory };
}

function supportedAnchorReference(
  value: string,
  axis: "horizontal" | "vertical",
  section: ResolvedDocxSectionV1 | undefined
): boolean {
  if (
    axis === "horizontal" &&
    value === "column" &&
    section?.columnCount === 1
  ) {
    return true;
  }
  return [
    "bottomMargin",
    "insideMargin",
    "leftMargin",
    "margin",
    "outsideMargin",
    "page",
    "rightMargin",
    "topMargin",
  ].includes(value);
}

function scenePlacement(
  raw: MutableRawScene,
  sections: DocxSectionResolutionV1
): DocxScenePlacementV1 | undefined {
  if (raw.inline) {
    return {
      kind: "inline",
      width: raw.inline.width,
      height: raw.inline.height,
      unit: "emu",
    };
  }
  if (!raw.anchor) return undefined;
  const axis = (value: MutableAxis): DocxAnchorAxisV1 => ({
    relativeFrom: value.relativeFrom,
    value:
      value.align !== undefined
        ? { kind: "align", align: value.align }
        : { kind: "offset", emu: value.offset ?? 0 },
  });
  const localExact = raw.anchor.useSimplePos && raw.anchor.simplePos !== undefined;
  const section = sections.sections.find(
    (candidate) => candidate.section === raw.section
  );
  const pageResolved =
    supportedAnchorReference(
      raw.anchor.horizontal.relativeFrom,
      "horizontal",
      section
    ) &&
    supportedAnchorReference(
      raw.anchor.vertical.relativeFrom,
      "vertical",
      section
    );
  return {
    kind: "anchor",
    horizontal: axis(raw.anchor.horizontal),
    vertical: axis(raw.anchor.vertical),
    extent: {
      width: raw.anchor.extent.width,
      height: raw.anchor.extent.height,
      unit: "emu",
    },
    ...(raw.anchor.simplePos
      ? { simplePos: { ...raw.anchor.simplePos, unit: "emu" as const } }
      : {}),
    useSimplePos: raw.anchor.useSimplePos,
    ...(raw.anchor.effectExtent
      ? { effectExtent: { ...raw.anchor.effectExtent, unit: "emu" as const } }
      : {}),
    distance: { ...raw.anchor.distance, unit: "emu" },
    wrap: { kind: raw.anchor.wrap },
    ...(raw.anchor.relativeHeight === undefined
      ? {}
      : { relativeHeight: raw.anchor.relativeHeight }),
    ...(raw.anchor.behindDoc === undefined
      ? {}
      : { behindDoc: raw.anchor.behindDoc }),
    ...(raw.anchor.allowOverlap === undefined
      ? {}
      : { allowOverlap: raw.anchor.allowOverlap }),
    ...(raw.anchor.layoutInCell === undefined
      ? {}
      : { layoutInCell: raw.anchor.layoutInCell }),
    resolution: localExact
      ? "local-exact"
      : pageResolved
        ? "page-resolved"
        : "layout-dependent",
  };
}

function sourceOrdinal(
  partRef: string,
  sourceParts: readonly string[]
): string {
  const story = storyForPart(partRef) ?? "document";
  const sameStory = sourceParts.filter(
    (candidate) => storyForPart(candidate) === story
  );
  const ordinal = sameStory.indexOf(partRef);
  return `${story}.${Math.max(0, ordinal)}`;
}

function relationshipFor(
  opc: DocxOpcFactsV1,
  partRef: string,
  relationshipId: string | undefined
): OpcRelationshipFactV1 | undefined {
  if (!relationshipId) return undefined;
  return opc.relationships.find(
    (relationship) =>
      relationship.sourcePartRef === partRef &&
      relationship.relationshipRef === relationshipId &&
      relationship.kind === "image"
  );
}

function decorationAssignments(
  raw: MutableRawScene,
  sections: DocxSectionResolutionV1,
  partFingerprint: string
): {
  section: number;
  master?: DocxMasterVariantV1;
  status: SceneCandidateV1["sectionScope"];
}[] {
  if (raw.story === "document") {
    return [{ section: raw.section, status: "not-applicable" }];
  }
  const kind = raw.story === "header" ? "header" : "footer";
  const assigned = sections.decorations
    .filter(
      (decoration) =>
        decoration.kind === kind &&
        decoration.partFingerprint === partFingerprint &&
        decoration.status !== "inactive"
    )
    .map((decoration) => ({
      section: decoration.section,
      master: decoration.variant,
      status:
        decoration.status === "native"
          ? ("native" as const)
          : ("unsupported-section-scope" as const),
    }));
  return assigned.length > 0
    ? assigned
    : [{ section: 0, status: "unsupported-section-scope" }];
}

function sceneCompatibility(
  raw: MutableRawScene,
  placement: DocxScenePlacementV1 | undefined,
  sectionScope: SceneCandidateV1["sectionScope"],
  referencedAssetAvailable: boolean
): CandidateCompatibilityV1 {
  if (
    (raw.relationshipId !== undefined && !referencedAssetAvailable) ||
    sectionScope === "unsupported-section-scope" ||
    raw.kind === "chart" ||
    raw.kind === "group" ||
    raw.kind === "shape" ||
    raw.kind === "smartart" ||
    raw.kind === "textbox" ||
    raw.representationKind === "vml" ||
    raw.complexEffects > 0
  ) {
    return "unsupported";
  }
  if (
    placement?.kind === "anchor" &&
    placement.resolution === "layout-dependent"
  ) {
    return "unsupported";
  }
  return "native";
}

function sceneTransform(
  raw: MutableRawScene
): SceneCandidateV1["transform"] | undefined {
  if (!raw.xfrm && raw.rotation === undefined && !raw.crop) return undefined;
  return {
    ...(raw.xfrm
      ? {
          xfrm: {
            offset: { ...raw.xfrm.offset, unit: "emu" as const },
            extent: { ...raw.xfrm.extent, unit: "emu" as const },
            flipH: raw.xfrm.flipH,
            flipV: raw.xfrm.flipV,
          },
        }
      : {}),
    ...(raw.rotation === undefined
      ? {}
      : {
          rotation: {
            value: raw.rotation,
            unit: "degree" as const,
          },
        }),
    ...(raw.crop
      ? { crop: { ...raw.crop, unit: "percent" as const } }
      : {}),
  };
}

function distinctLocations(
  scenes: readonly SceneCandidateV1[]
): AssetReviewDescriptorV1["locations"] {
  const seen = new Set<string>();
  return scenes.flatMap(({ scope }) => {
    const key = `${scope.story}:${scope.section}:${scope.master ?? ""}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [scope];
  });
}

function sceneExtent(
  scene: SceneCandidateV1
): { width: number; height: number } | undefined {
  if (scene.placement?.kind === "inline") {
    return {
      width: scene.placement.width,
      height: scene.placement.height,
    };
  }
  if (scene.placement?.kind === "anchor") {
    return {
      width: scene.placement.extent.width,
      height: scene.placement.extent.height,
    };
  }
  return undefined;
}

function sceneCoverage(
  scene: SceneCandidateV1,
  sections: DocxSectionResolutionV1
): number {
  const page = sections.sections.find(
    ({ section }) => section === scene.scope.section
  )?.page;
  const extent = sceneExtent(scene);
  if (!page || !extent) return 0;
  const pageArea =
    page.widthTwips * 635 * (page.heightTwips * 635);
  return pageArea > 0
    ? Math.min(1, (extent.width * extent.height) / pageArea)
    : 0;
}

function inferRoles(
  scenes: readonly SceneCandidateV1[],
  assets: readonly DocxVisualAssetV1[],
  sections: DocxSectionResolutionV1
): RoleSuggestionV1[] {
  const suggestions: RoleSuggestionV1[] = [];
  for (const scene of scenes) {
    const selectedAsset = scene.representations.find(
      ({ selected, assetSha256 }) => selected && assetSha256
    )?.assetSha256;
    if (!selectedAsset) continue;
    const asset = assets.find(({ sha256 }) => sha256 === selectedAsset);
    const evidenceRef = `scene:${scene.id}`;
    const sameAssetScenes = scenes.filter((candidate) =>
      candidate.representations.some(
        ({ selected, assetSha256 }) =>
          selected && assetSha256 === selectedAsset
      )
    );
    if (
      scene.scope.story === "header" &&
      sameAssetScenes.filter(({ scope }) => scope.story === "header").length >=
        2 &&
      (asset?.dimensions?.width ?? Number.POSITIVE_INFINITY) <=
        DOCX_VISUAL_ANALYSIS_RULE_V1.logoMaximumWidth &&
      (asset?.dimensions?.height ?? Number.POSITIVE_INFINITY) <=
        DOCX_VISUAL_ANALYSIS_RULE_V1.logoMaximumHeight
    ) {
      const occurrences = sameAssetScenes.filter(
        ({ scope }) => scope.story === "header"
      ).length;
      suggestions.push({
        sceneId: scene.id,
        role: "logo",
        confidence: "corroborated",
        explanations: [
          roleExplanation(
            "DOCX_VISUAL_ROLE_REPEATED_HEADER",
            { occurrences },
            [evidenceRef]
          ),
        ],
      });
    }
    const coverage = sceneCoverage(scene, sections);
    if (
      scene.placement?.kind === "anchor" &&
      scene.placement.behindDoc === true &&
      coverage >= DOCX_VISUAL_ANALYSIS_RULE_V1.pageFillMinimum
    ) {
      suggestions.push({
        sceneId: scene.id,
        role: "page-background",
        confidence: "corroborated",
        explanations: [
          roleExplanation(
            "DOCX_VISUAL_ROLE_PAGE_FILL",
            { coverage: Math.round(coverage * 100) / 100 },
            [evidenceRef]
          ),
        ],
      });
    }
    if (scene.scope.master === "first") {
      suggestions.push({
        sceneId: scene.id,
        role: "cover-art",
        confidence: "corroborated",
        explanations: [
          roleExplanation(
            "DOCX_VISUAL_ROLE_FIRST_ONLY",
            { section: scene.scope.section },
            [evidenceRef]
          ),
        ],
      });
    }
    const rotation = Math.abs(scene.transform?.rotation?.value ?? 0);
    const opacity = scene.paint?.opacity ?? 1;
    if (
      coverage >= DOCX_VISUAL_ANALYSIS_RULE_V1.watermarkMinimumCoverage &&
      (rotation >=
        DOCX_VISUAL_ANALYSIS_RULE_V1.watermarkMinimumRotation ||
        opacity < DOCX_VISUAL_ANALYSIS_RULE_V1.watermarkMaximumOpacity)
    ) {
      suggestions.push({
        sceneId: scene.id,
        role: "watermark",
        confidence: "corroborated",
        explanations: [
          roleExplanation(
            "DOCX_VISUAL_ROLE_WATERMARK",
            { rotation, opacity },
            [evidenceRef]
          ),
        ],
      });
    }
  }
  return suggestions.sort((left, right) =>
    `${left.sceneId}:${left.role}`.localeCompare(
      `${right.sceneId}:${right.role}`
    )
  );
}

async function verifyAssets(
  archive: DocxIntakeArchive,
  opc: DocxOpcFactsV1,
  capabilities: TemplateAssetCapabilitiesV1,
  assetStore: TemplateAssetStore
): Promise<{
  byPart: Map<string, VerifiedByPart>;
  assets: DocxVisualAssetV1[];
  diagnostics: TemplateDiagnosticV1[];
  emfWmf: number;
  externalImages: number;
}> {
  const contentTypes = parseContentTypes(archive);
  const diagnostics: TemplateDiagnosticV1[] = [];
  const byPart = new Map<string, VerifiedByPart>();
  const byDigest = new Map<string, VerifiedByPart>();
  let emfWmf = 0;
  let externalImages = 0;
  const internalParts = new Set<string>();
  for (const relationship of opc.relationships) {
    if (relationship.kind !== "image") continue;
    if (relationship.target.kind === "external-unresolved") {
      externalImages += 1;
      diagnostics.push(
        visualDiagnostic(
          "DOCX_VISUAL_EXTERNAL_IMAGE",
          relationship.target.scheme
        )
      );
    } else if (
      relationship.target.kind === "internal" &&
      relationship.target.exists
    ) {
      internalParts.add(relationship.target.partRef);
    }
  }
  for (const partRef of [...internalParts].sort()) {
    const mediaEntry = entry(archive, partRef);
    if (!mediaEntry) continue;
    const bytes = mediaEntry.asUint8Array();
    if (bytes.byteLength > capabilities.maxBytes) {
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_ASSET_LIMIT", "bytes", "error")
      );
      continue;
    }
    const sniffed = sniffMedia(bytes);
    if (sniffed && "unsupported" in sniffed) {
      emfWmf += 1;
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_UNSUPPORTED", sniffed.unsupported)
      );
      continue;
    }
    if (!sniffed) {
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_ASSET_CORRUPT", "magic")
      );
      continue;
    }
    const declared = declaredMediaType(partRef, contentTypes);
    if (declared !== sniffed.mediaType) {
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_ASSET_CORRUPT", "content-type")
      );
      continue;
    }
    if (!capabilities.mediaTypes.includes(sniffed.mediaType)) {
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_UNSUPPORTED", "media-type")
      );
      continue;
    }
    if (sniffed.svgSource) {
      const violation = findSvgSafetyViolation(sniffed.svgSource);
      if (violation) {
        diagnostics.push(
          visualDiagnostic("DOCX_VISUAL_SVG_UNSAFE", violation.rule, "error")
        );
        continue;
      }
    }
    const limit = assetLimitReason(
      bytes.byteLength,
      sniffed.dimensions,
      capabilities,
      sniffed.svgSource
    );
    if (limit) {
      diagnostics.push(
        visualDiagnostic("DOCX_VISUAL_ASSET_LIMIT", limit, "error")
      );
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    let verified = byDigest.get(sha256);
    if (!verified) {
      const handle = await assetStore.put({
        sha256,
        mediaType: sniffed.mediaType,
        bytes,
      });
      if (
        handle.id !== `asset:${sha256}` ||
        handle.sha256 !== sha256 ||
        handle.mediaType !== sniffed.mediaType ||
        handle.byteLength !== bytes.byteLength
      ) {
        throw new Error("Template asset store returned an unsafe handle");
      }
      verified = {
        partRef,
        sha256,
        mediaType: sniffed.mediaType,
        byteLength: bytes.byteLength,
        ...(sniffed.dimensions ? { dimensions: sniffed.dimensions } : {}),
        handle,
      };
      byDigest.set(sha256, verified);
    }
    byPart.set(partRef, verified);
  }
  const assets = [...byDigest.values()]
    .map(
      ({
        sha256,
        mediaType,
        byteLength,
        dimensions,
        handle,
      }): DocxVisualAssetV1 => ({
        sha256,
        mediaType,
        byteLength,
        ...(dimensions ? { dimensions } : {}),
        handle,
      })
    )
    .sort((left, right) => left.sha256.localeCompare(right.sha256));
  return {
    byPart,
    assets,
    diagnostics,
    emfWmf,
    externalImages,
  };
}

/**
 * Internal archive-level implementation used by the combined intake flow.
 * Portable output contains no free source names; those are returned only in
 * the explicitly private sidecar.
 */
export async function analyzeDocxVisualArchive(
  archive: DocxIntakeArchive,
  opc: DocxOpcFactsV1,
  options: {
    capabilities: TemplateAssetCapabilitiesV1;
    assetStore: TemplateAssetStore;
    sections: DocxSectionResolutionV1;
    sourceDigest: string;
  }
): Promise<DocxVisualAnalysisBundleV1> {
  const capabilities = validateTemplateAssetCapabilitiesV1(
    options.capabilities
  );
  const verified = await verifyAssets(
    archive,
    opc,
    capabilities,
    options.assetStore
  );
  const sourceParts = opc.parts
    .map(({ partRef }) => partRef)
    .filter((partRef) => storyForPart(partRef) !== undefined)
    .sort();
  const rawParts = sourceParts.map((partRef, ordinal) => {
    const sourceEntry = entry(archive, partRef);
    return sourceEntry
      ? parseVisualPart(partRef, sourceEntry.asUint8Array(), ordinal)
      : undefined;
  }).filter((value): value is RawParseResult => value !== undefined);
  const rawScenes = rawParts.flatMap(({ scenes }) => scenes);
  const privateRecords: DocxVisualPrivateRecordV1[] = [];
  const scenesById = new Map<string, SceneCandidateV1>();
  const diagnostics = [...verified.diagnostics];

  for (const raw of rawScenes) {
    const relationship = relationshipFor(
      opc,
      raw.partRef,
      raw.relationshipId
    );
    const targetPart =
      relationship?.target.kind === "internal"
        ? relationship.target.partRef
        : undefined;
    const asset = targetPart ? verified.byPart.get(targetPart) : undefined;
    const partFingerprint = await sha256Hex(
      new TextEncoder().encode(raw.partRef)
    );
    const assignments = decorationAssignments(
      raw,
      options.sections,
      partFingerprint
    );
    const sceneBase = raw.alternate
      ? `${raw.alternate.groupId}.scene.${raw.alternate.sceneOrdinal}`
      : `scene.${sourceOrdinal(raw.partRef, sourceParts)}.${raw.ordinal}`;
    const elementFingerprint = await sha256Hex(
      new TextEncoder().encode(
        `${raw.partRef}\0${raw.ordinal}\0${raw.elementTokens.join("\0")}`
      )
    );
    const altFingerprint = raw.altText
      ? await sha256Hex(new TextEncoder().encode(raw.altText))
      : undefined;
    const sourcePartRef = sourceOrdinal(raw.partRef, sourceParts);
    const sourceUse: DocxVisualSourceUseV1 = relationship
      ? {
          kind: "relationship",
          sourcePartRef,
          relationshipRef: `relationship.${opc.relationships
            .filter(
              (candidate) =>
                candidate.sourcePartRef === raw.partRef &&
                candidate.kind === "image"
            )
            .indexOf(relationship)}.${relationship.relationshipFingerprint.slice(0, 12)}`,
          targetFingerprint:
            relationship.target.kind === "internal"
              ? await sha256Hex(
                  new TextEncoder().encode(relationship.target.partRef)
                )
              : relationship.target.kind === "external-unresolved"
                ? relationship.target.fingerprint
                : relationship.relationshipFingerprint,
          ...(raw.alternate
            ? {
                alternateContent: {
                  groupId: raw.alternate.groupId,
                  branch: raw.alternate.branch,
                  selected: raw.alternate.selected,
                },
              }
            : {}),
          altText: {
            present: raw.altText !== undefined,
            ...(altFingerprint ? { fingerprint: altFingerprint } : {}),
          },
        }
      : {
          kind: "inline-xml",
          sourcePartRef,
          elementFingerprint,
          ...(raw.alternate
            ? {
                alternateContent: {
                  groupId: raw.alternate.groupId,
                  branch: raw.alternate.branch,
                  selected: raw.alternate.selected,
                },
              }
            : {}),
          altText: {
            present: raw.altText !== undefined,
            ...(altFingerprint ? { fingerprint: altFingerprint } : {}),
          },
        };
    const representation: DocxSceneRepresentationV1 = {
      kind:
        asset?.mediaType === "image/svg+xml"
          ? "svg"
          : raw.alternate?.branch.startsWith("fallback.")
            ? "raster-fallback"
          : raw.representationKind,
      ...(asset ? { assetSha256: asset.sha256 } : {}),
      selected: raw.alternate?.selected ?? true,
      sourceUse,
    };
    const placement = scenePlacement(raw, options.sections);
    for (const assignment of assignments) {
      const id = `${sceneBase}.section.${assignment.section}.${assignment.master ?? "body"}`;
      const existing = scenesById.get(id);
      if (existing) {
        const promote =
          representation.selected &&
          !existing.representations.some(({ selected }) => selected);
        const compatibility = sceneCompatibility(
          raw,
          placement,
          assignment.status,
          raw.relationshipId === undefined || asset !== undefined
        );
        scenesById.set(id, {
          ...existing,
          representations: [...existing.representations, representation],
          ...(promote
            ? {
                kind: raw.kind,
                ...(placement ? { placement } : {}),
                ...(sceneTransform(raw)
                  ? { transform: sceneTransform(raw) }
                  : {}),
                ...(raw.opacity === undefined
                  ? {}
                  : { paint: { opacity: raw.opacity } }),
                compatibility,
              }
            : {}),
        });
      } else {
        const compatibility = sceneCompatibility(
          raw,
          placement,
          assignment.status,
          raw.relationshipId === undefined || asset !== undefined
        );
        scenesById.set(id, {
          id,
          kind: raw.kind,
          scope: {
            story: raw.story,
            section: assignment.section,
            ...(assignment.master ? { master: assignment.master } : {}),
          },
          representations: [representation],
          ...(placement ? { placement } : {}),
          ...(sceneTransform(raw)
            ? { transform: sceneTransform(raw) }
            : {}),
          ...(raw.opacity === undefined
            ? {}
            : { paint: { opacity: raw.opacity } }),
          compatibility,
          sectionScope: assignment.status,
        });
        if (
          compatibility === "unsupported" &&
          (raw.kind !== "picture" || raw.complexEffects > 0)
        ) {
          diagnostics.push(
            visualDiagnostic("DOCX_VISUAL_UNSUPPORTED", raw.kind)
          );
        }
      }
      privateRecords.push({
        sceneId: id,
        sourcePartName: raw.partRef,
        ...(raw.relationshipId
          ? { relationshipId: raw.relationshipId }
          : {}),
        ...(targetPart ? { relationshipTarget: targetPart } : {}),
        ...(raw.shapeName ? { shapeName: raw.shapeName } : {}),
        ...(raw.shapeTitle ? { shapeTitle: raw.shapeTitle } : {}),
        ...(raw.shapeDescription
          ? { shapeDescription: raw.shapeDescription }
          : {}),
        ...(raw.altText ? { sourceAltText: raw.altText } : {}),
      });
    }
  }
  const scenes = [...scenesById.values()].sort((left, right) =>
    left.id.localeCompare(right.id)
  );
  const roleSuggestions = inferRoles(
    scenes,
    verified.assets,
    options.sections
  );
  const assetReview = verified.assets.map(
    (asset): AssetReviewDescriptorV1 => {
      const assetScenes = scenes.filter(({ representations }) =>
        representations.some(
          ({ assetSha256 }) => assetSha256 === asset.sha256
        )
      );
      const suggestions = roleSuggestions.filter(({ sceneId }) =>
        assetScenes.some(({ id }) => id === sceneId)
      );
      const placementsAreFreezable = assetScenes.every(
        ({ compatibility, placement }) =>
          compatibility === "native" &&
          (placement?.kind !== "anchor" ||
            placement.resolution !== "layout-dependent")
      );
      return {
        id: `asset-review.${asset.sha256}`,
        asset: asset.handle,
        occurrenceCount: assetScenes.length,
        locations: distinctLocations(assetScenes),
        ...(suggestions[0]?.role
          ? { proposedRole: suggestions[0].role }
          : {}),
        explanations: suggestions.flatMap(({ explanations }) => explanations),
        supportedPlacementChoices: [
          "slot-default",
          ...(placementsAreFreezable
            ? (["candidate-placement"] as const)
            : []),
          "custom-placement",
        ],
        thumbnailPossible: true,
        defaultDecision: "do-not-include",
        rights: "unknown",
        semanticRole: "unconfirmed",
        accessibility: "unanswered",
        placement: "unanswered",
      };
    }
  );
  const rawInventory = rawParts.reduce(
    (sum, part) => ({
      charts: sum.charts + part.inventory.charts,
      smartart: sum.smartart + part.inventory.smartart,
      vml: sum.vml + part.inventory.vml,
      groups: sum.groups + part.inventory.groups,
      textboxes: sum.textboxes + part.inventory.textboxes,
      complexEffects:
        sum.complexEffects + part.inventory.complexEffects,
    }),
    {
      charts: 0,
      smartart: 0,
      vml: 0,
      groups: 0,
      textboxes: 0,
      complexEffects: 0,
    }
  );
  return {
    analysis: {
      schema: DOCX_VISUAL_ANALYSIS_SCHEMA_V1,
      sourceDigest: options.sourceDigest,
      capability: {
        id: capabilities.id,
        version: capabilities.version,
      },
      rule: DOCX_VISUAL_ANALYSIS_RULE_V1,
      assets: verified.assets,
      scenes,
      roleSuggestions,
      assetReview,
      backgrounds: rawParts.flatMap(({ backgrounds: values }) => values),
      pageBorders: rawParts.flatMap(({ borders: values }) => values),
      inventory: {
        ...rawInventory,
        emfWmf: verified.emfWmf,
        externalImages: verified.externalImages,
      },
      diagnostics,
    },
    privateSource: {
      schema: DOCX_VISUAL_PRIVATE_SIDECAR_SCHEMA_V1,
      records: privateRecords,
    },
  };
}

/** Secure bytes-in visual analysis for CLI, browser studio, and extension. */
export async function analyzeDocxVisualAssets(
  bytes: Uint8Array,
  options: {
    capabilities: TemplateAssetCapabilitiesV1;
    assetStore: TemplateAssetStore;
    sections: DocxSectionResolutionV1;
  }
): Promise<DocxVisualAnalysisBundleV1> {
  const sourceBytes = new Uint8Array(bytes);
  const sourceDigest = await sha256Hex(sourceBytes);
  const archive = unzipDocx(sourceBytes, DOCX_TEMPLATE_INTAKE_BUDGET);
  const opc = await analyzeDocxOpcArchive(archive);
  return analyzeDocxVisualArchive(archive, opc, {
    ...options,
    sourceDigest,
  });
}
