/**
 * PDF-specific template-pack validation and loading.
 *
 * Validation is intentionally split into three observable phases:
 *  1. `validateManifest` in `@atlcli/template-pack` validates portable shape.
 *  2. `validatePdfTemplateManifest` validates the PDF catalog and geometry.
 *  3. `validatePdfTemplatePack` validates the actual payload bytes and VFS.
 */
import {
  computePayloadSha256,
  unpackTemplate,
  validateManifest,
  type TemplateAssetDescriptorV1,
  type TemplateAssetMediaTypeV1,
  type TemplateAssetReferenceV1,
  type TemplateCapabilityCatalogV1,
  type TemplateManifest,
  type WikiPdfTemplateImageDecorationV1,
  type WikiPdfTemplatePageBorderV1,
  type WikiPdfTemplatePageDecorationV1,
} from "@atlcli/template-pack";
import { decodeSvgSource, findSvgSafetyViolation } from "@atlcli/confluence";
import { PDF_TEMPLATE_CAPABILITIES_V1 } from "./design-catalog.js";
import { PDF_RUNTIME_ASSETS } from "./runtime-assets.js";
import { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "./template-asset-capabilities.js";

export const PDF_TEMPLATE_ASSET_SLOTS_V1 = [
  "asset.logo",
  "asset.pageBackground",
  "asset.coverBackground",
  "asset.headerDecoration",
  "asset.footerDecoration",
] as const;
export type PdfTemplateAssetSlotV1 =
  (typeof PDF_TEMPLATE_ASSET_SLOTS_V1)[number];

export const PDF_TEMPLATE_DECORATION_IDS_V1 = [
  "asset.pageBackground",
  "asset.coverBackground",
  "asset.headerDecoration",
  "asset.footerDecoration",
  "decoration.pageBorder",
] as const;
export type PdfTemplateDecorationIdV1 =
  (typeof PDF_TEMPLATE_DECORATION_IDS_V1)[number];

export const PDF_TEMPLATE_WRITERS_V1 = {
  logo: "typst.logo",
  imageDecoration: "typst.image-decoration",
  pageBorder: "typst.page-border",
} as const;

export type PdfTemplateValidationPhase =
  | "pdf-manifest"
  | "pack-integrity";

export type PdfTemplateValidationReason =
  | "unknown-slot"
  | "unknown-decoration"
  | "unknown-writer"
  | "invalid-scope"
  | "invalid-geometry"
  | "unsupported-decoration"
  | "unsupported-section-scope"
  | "missing-payload"
  | "unreferenced-payload"
  | "hash-mismatch"
  | "media-mismatch"
  | "descriptor-mismatch"
  | "asset-budget-exceeded"
  | "unsafe-svg"
  | "vfs-collision"
  | "payload-digest-mismatch"
  | "non-bundled-font"
  | "canonical-source-mismatch";

export class PdfTemplateValidationError extends Error {
  constructor(
    readonly phase: PdfTemplateValidationPhase,
    readonly reason: PdfTemplateValidationReason,
    message: string,
    readonly path?: string
  ) {
    super(message);
    this.name = "PdfTemplateValidationError";
  }
}

export interface ResolvedPdfTemplateAssetV1 {
  slot: PdfTemplateAssetSlotV1;
  descriptorId: string;
  descriptor: TemplateAssetDescriptorV1;
  reference: TemplateAssetReferenceV1;
  bytes: Uint8Array;
  /** Compiler-owned absolute VFS path; never read from the manifest. */
  vfsPath: string;
}

export interface ValidatedPdfTemplatePackV1 {
  manifest: TemplateManifest;
  entrySource: string;
  assets: Readonly<
    Partial<Record<PdfTemplateAssetSlotV1, ResolvedPdfTemplateAssetV1>>
  >;
  decorations: readonly WikiPdfTemplatePageDecorationV1[];
}

export interface PdfTemplateVisualsV1 {
  assets: Readonly<
    Partial<
      Record<
        PdfTemplateAssetSlotV1,
        Pick<ResolvedPdfTemplateAssetV1, "vfsPath" | "reference">
      >
    >
  >;
  decorations: readonly WikiPdfTemplatePageDecorationV1[];
}

const SLOT_SET = new Set<string>(PDF_TEMPLATE_ASSET_SLOTS_V1);
const DECORATION_SET = new Set<string>(PDF_TEMPLATE_DECORATION_IDS_V1);
const LENGTH_RE = /^(-?(?:0|[1-9]\d*)(?:\.\d+)?)(pt|mm|cm|in)$/;
const UNITS_IN_MM: Readonly<Record<string, number>> = {
  pt: 25.4 / 72,
  mm: 1,
  cm: 10,
  in: 25.4,
};
const MAX_PLACEMENT_MM = 1_000;
const MAX_BORDER_INSET_MM = 100;
const MAX_BORDER_WIDTH_MM = 10;
const CANONICAL_SOURCE_API = "wiki.pdf-canonical-typst";

function reject(
  phase: PdfTemplateValidationPhase,
  reason: PdfTemplateValidationReason,
  path: string,
  message: string
): never {
  throw new PdfTemplateValidationError(
    phase,
    reason,
    `${path}: ${message}`,
    path
  );
}

function lengthMm(value: string, path: string): number {
  const match = LENGTH_RE.exec(value);
  if (!match) {
    reject("pdf-manifest", "invalid-geometry", path, "unsupported length");
  }
  return Number(match[1]) * UNITS_IN_MM[match[2]]!;
}

function validateGeometry(
  decoration: WikiPdfTemplateImageDecorationV1,
  path: string
): void {
  const placement = decoration.placement;
  const values = [
    ["x", lengthMm(placement.x, `${path}.placement.x`)],
    ["y", lengthMm(placement.y, `${path}.placement.y`)],
    ["width", lengthMm(placement.width, `${path}.placement.width`)],
    ["height", lengthMm(placement.height, `${path}.placement.height`)],
  ] as const;
  for (const [name, value] of values) {
    if (
      Math.abs(value) > MAX_PLACEMENT_MM ||
      ((name === "width" || name === "height") && value <= 0)
    ) {
      reject(
        "pdf-manifest",
        "invalid-geometry",
        `${path}.placement.${name}`,
        `must fit the bounded ${MAX_PLACEMENT_MM}mm renderer canvas`
      );
    }
  }
  // Typst 0.14.2 has no general alpha compositor/crop primitive for image
  // content. Keep the portable fields but reject unproven execution in PDF V1.
  if (placement.opacity !== undefined && placement.opacity !== 1) {
    reject(
      "pdf-manifest",
      "unsupported-decoration",
      `${path}.placement.opacity`,
      "PDF V1 supports only opaque image decorations"
    );
  }
  if (placement.crop !== undefined) {
    reject(
      "pdf-manifest",
      "unsupported-decoration",
      `${path}.placement.crop`,
      "PDF V1 does not execute image crop geometry"
    );
  }
}

function expectedImageDecoration(
  id: string
): {
  layer: WikiPdfTemplateImageDecorationV1["layer"];
  scopes: readonly WikiPdfTemplateImageDecorationV1["scope"][];
  relativeTo: WikiPdfTemplateImageDecorationV1["placement"]["relativeTo"];
} | undefined {
  switch (id) {
    case "asset.pageBackground":
      return {
        layer: "page-background",
        scopes: ["all", "odd", "even"],
        relativeTo: "page",
      };
    case "asset.coverBackground":
      return {
        layer: "page-background",
        scopes: ["first"],
        relativeTo: "page",
      };
    case "asset.headerDecoration":
      return {
        layer: "header",
        scopes: ["all", "first", "odd", "even"],
        relativeTo: "margin",
      };
    case "asset.footerDecoration":
      return {
        layer: "footer",
        scopes: ["all", "first", "odd", "even"],
        relativeTo: "margin",
      };
    default:
      return undefined;
  }
}

function validateBorder(
  border: WikiPdfTemplatePageBorderV1,
  path: string
): void {
  for (const [side, value] of Object.entries(border.inset)) {
    const mm = lengthMm(value, `${path}.inset.${side}`);
    if (mm < 0 || mm > MAX_BORDER_INSET_MM) {
      reject(
        "pdf-manifest",
        "invalid-geometry",
        `${path}.inset.${side}`,
        `must be in [0, ${MAX_BORDER_INSET_MM}]mm`
      );
    }
  }
  const width = lengthMm(border.stroke.width, `${path}.stroke.width`);
  if (width <= 0 || width > MAX_BORDER_WIDTH_MM) {
    reject(
      "pdf-manifest",
      "invalid-geometry",
      `${path}.stroke.width`,
      `must be in (0, ${MAX_BORDER_WIDTH_MM}]mm`
    );
  }
}

/**
 * Phase 2: validate only PDF catalog ownership, writers, scopes, and geometry.
 * This function does not inspect payload bytes.
 */
export function validatePdfTemplateManifest(
  manifest: TemplateManifest,
  catalog: TemplateCapabilityCatalogV1 = PDF_TEMPLATE_CAPABILITIES_V1
): TemplateManifest {
  if (manifest.engine.kind !== "typst" || manifest.engine.api !== "wiki.pdf-template/v1") {
    reject(
      "pdf-manifest",
      "canonical-source-mismatch",
      "engine",
      "must target wiki.pdf-template/v1"
    );
  }
  // Force the caller to provide the actual renderer-owned catalog rather than
  // a same-shaped arbitrary object. This is an execution allowlist, not a UI
  // hint.
  if (
    catalog.id !== PDF_TEMPLATE_CAPABILITIES_V1.id ||
    catalog.version !== PDF_TEMPLATE_CAPABILITIES_V1.version
  ) {
    reject(
      "pdf-manifest",
      "canonical-source-mismatch",
      "catalog",
      "does not match the PDF V1 capability catalog"
    );
  }
  if (
    manifest.canonicalSource !== undefined &&
    manifest.canonicalSource.api !== CANONICAL_SOURCE_API
  ) {
    reject(
      "pdf-manifest",
      "canonical-source-mismatch",
      "canonicalSource.api",
      `must be "${CANONICAL_SOURCE_API}"`
    );
  }

  const assets = manifest.assets ?? {};
  for (const [slot, reference] of Object.entries(assets)) {
    if (!SLOT_SET.has(slot)) {
      reject("pdf-manifest", "unknown-slot", `assets.${slot}`, "is not cataloged");
    }
    const expectedWriter =
      slot === "asset.logo"
        ? PDF_TEMPLATE_WRITERS_V1.logo
        : PDF_TEMPLATE_WRITERS_V1.imageDecoration;
    if (reference.writer !== expectedWriter) {
      reject(
        "pdf-manifest",
        "unknown-writer",
        `assets.${slot}.writer`,
        `must be "${expectedWriter}"`
      );
    }
    if (slot === "asset.logo") {
      const descriptor = manifest.assetDescriptors?.[reference.descriptor];
      if (descriptor?.mediaType === "image/jpeg") {
        reject(
          "pdf-manifest",
          "unsupported-decoration",
          `assets.${slot}`,
          "logo slots support PNG or SVG"
        );
      }
      if (reference.decorative || !reference.alt?.trim()) {
        reject(
          "pdf-manifest",
          "unsupported-decoration",
          `assets.${slot}`,
          "a logo is meaning-bearing and requires non-empty alt text"
        );
      }
    } else if (!reference.decorative) {
      reject(
        "pdf-manifest",
        "unsupported-decoration",
        `assets.${slot}.decorative`,
        "page ornaments must be decorative in PDF V1"
      );
    }
  }

  const seen = new Set<string>();
  for (const [index, decoration] of (manifest.decorations ?? []).entries()) {
    const path = `decorations[${index}]`;
    if (!DECORATION_SET.has(decoration.id)) {
      reject("pdf-manifest", "unknown-decoration", `${path}.id`, "is not cataloged");
    }
    if (seen.has(decoration.id)) {
      reject("pdf-manifest", "unknown-decoration", `${path}.id`, "must be unique");
    }
    seen.add(decoration.id);
    if (decoration.kind === "page-border") {
      if (decoration.id !== "decoration.pageBorder") {
        reject("pdf-manifest", "unknown-decoration", `${path}.id`, "is not a page border id");
      }
      if (decoration.writer !== PDF_TEMPLATE_WRITERS_V1.pageBorder) {
        reject(
          "pdf-manifest",
          "unknown-writer",
          `${path}.writer`,
          `must be "${PDF_TEMPLATE_WRITERS_V1.pageBorder}"`
        );
      }
      validateBorder(decoration, path);
      continue;
    }
    const expected = expectedImageDecoration(decoration.id);
    if (!expected) {
      reject("pdf-manifest", "unknown-decoration", `${path}.id`, "is not an image slot");
    }
    if (decoration.writer !== PDF_TEMPLATE_WRITERS_V1.imageDecoration) {
      reject(
        "pdf-manifest",
        "unknown-writer",
        `${path}.writer`,
        `must be "${PDF_TEMPLATE_WRITERS_V1.imageDecoration}"`
      );
    }
    if (decoration.asset !== decoration.id || !assets[decoration.asset]) {
      reject(
        "pdf-manifest",
        "unknown-slot",
        `${path}.asset`,
        "must reference its identically named cataloged asset slot"
      );
    }
    if (
      decoration.layer !== expected.layer ||
      decoration.placement.relativeTo !== expected.relativeTo
    ) {
      reject(
        "pdf-manifest",
        "invalid-geometry",
        path,
        `must use ${expected.layer}/${expected.relativeTo}`
      );
    }
    if (!expected.scopes.includes(decoration.scope)) {
      reject(
        "pdf-manifest",
        "invalid-scope",
        `${path}.scope`,
        `is not supported for ${decoration.id}`
      );
    }
    if (!decoration.decorative || decoration.alt !== undefined) {
      reject(
        "pdf-manifest",
        "unsupported-decoration",
        path,
        "page decorations must be artifacts without alt text"
      );
    }
    validateGeometry(decoration, path);
  }

  for (const slot of Object.keys(assets)) {
    if (slot !== "asset.logo" && !seen.has(slot)) {
      reject(
        "pdf-manifest",
        "unknown-decoration",
        `assets.${slot}`,
        "has no matching decoration"
      );
    }
  }
  return manifest;
}

function startsWith(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.byteLength >= prefix.length &&
    prefix.every((byte, index) => bytes[index] === byte)
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

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (
    bytes.byteLength < 24 ||
    !startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR"
  ) {
    return undefined;
  }
  const width = readUint32(bytes, 16);
  const height = readUint32(bytes, 20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (!startsWith(bytes, [0xff, 0xd8])) return undefined;
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
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += length + 2;
  }
  return undefined;
}

function svgDimensions(source: string): { width: number; height: number } | undefined {
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1] ?? "";
  const number = (name: string): number | undefined => {
    const raw = new RegExp(
      String.raw`\b${name}\s*=\s*["']\s*(\d+(?:\.\d+)?)`,
      "i"
    ).exec(root)?.[1];
    if (!raw) return undefined;
    const value = Math.ceil(Number(raw));
    return value > 0 ? value : undefined;
  };
  const width = number("width");
  const height = number("height");
  if (width && height) return { width, height };
  const viewBox =
    /\bviewBox\s*=\s*["']\s*-?\d+(?:\.\d+)?\s+-?\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/i.exec(
      root
    );
  return viewBox
    ? { width: Math.ceil(Number(viewBox[1])), height: Math.ceil(Number(viewBox[2])) }
    : undefined;
}

function svgComplexity(source: string): {
  elements: number;
  paths: number;
  filters: number;
} {
  return {
    elements: [
      ...source.matchAll(
        /<\s*(?![!?/])(?:[A-Za-z_][\w.-]*:)?[A-Za-z_][\w.-]*/g
      ),
    ].length,
    paths: [
      ...source.matchAll(/<\s*(?:[A-Za-z_][\w.-]*:)?path\b/gi),
    ].length,
    filters: [
      ...source.matchAll(
        /<\s*(?:[A-Za-z_][\w.-]*:)?fe(?:Blend|ColorMatrix|ComponentTransfer|Composite|ConvolveMatrix|DiffuseLighting|DisplacementMap|DropShadow|Flood|GaussianBlur|Image|Merge|Morphology|Offset|SpecularLighting|Tile|Turbulence)\b/gi
      ),
    ].length,
  };
}

function actualAsset(
  mediaType: TemplateAssetMediaTypeV1,
  bytes: Uint8Array,
  path: string
): { width: number; height: number } {
  if (mediaType === "image/png") {
    const dimensions = pngDimensions(bytes);
    if (!dimensions) {
      reject("pack-integrity", "media-mismatch", path, "bytes are not a valid PNG");
    }
    return dimensions;
  }
  if (mediaType === "image/jpeg") {
    const dimensions = jpegDimensions(bytes);
    if (!dimensions) {
      reject("pack-integrity", "media-mismatch", path, "bytes are not a valid JPEG");
    }
    return dimensions;
  }
  const source = decodeSvgSource(bytes);
  if (!/<svg(?:\s|>)/i.test(source.replace(/^\uFEFF/u, "").trimStart())) {
    reject("pack-integrity", "media-mismatch", path, "bytes do not contain an SVG root");
  }
  const violation = findSvgSafetyViolation(source);
  if (violation) {
    reject(
      "pack-integrity",
      "unsafe-svg",
      path,
      `${violation.rule}: ${violation.detail}`
    );
  }
  const dimensions = svgDimensions(source);
  if (!dimensions) {
    reject("pack-integrity", "descriptor-mismatch", path, "SVG has no bounded dimensions");
  }
  const complexity = svgComplexity(source);
  const budget = PDF_TEMPLATE_ASSET_CAPABILITIES_V1.svg;
  if (
    complexity.elements > budget.maxElements ||
    complexity.paths > budget.maxPathElements ||
    complexity.filters > budget.maxFilterPrimitives
  ) {
    reject(
      "pack-integrity",
      "asset-budget-exceeded",
      path,
      "SVG complexity exceeds the renderer budget"
    );
  }
  return dimensions;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function extension(mediaType: TemplateAssetMediaTypeV1): string {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  return "svg";
}

function vfsPath(descriptorId: string, mediaType: TemplateAssetMediaTypeV1): string {
  const safe = descriptorId.toLowerCase().replace(/[._]+/g, "-");
  return `template-assets/${safe}.${extension(mediaType)}`;
}

/**
 * Phase 3: validate bytes, payload inventory, budgets, and fixed VFS mapping.
 */
export async function validatePdfTemplatePack(
  manifest: TemplateManifest,
  files: Readonly<Record<string, Uint8Array>>
): Promise<ValidatedPdfTemplatePackV1> {
  const descriptors = manifest.assetDescriptors ?? {};
  const references = manifest.assets ?? {};
  const referencedDescriptors = new Set(
    Object.values(references).map(({ descriptor }) => descriptor)
  );
  for (const descriptorId of Object.keys(descriptors)) {
    if (!referencedDescriptors.has(descriptorId)) {
      reject(
        "pack-integrity",
        "unreferenced-payload",
        `assetDescriptors.${descriptorId}`,
        "is not referenced by an asset slot"
      );
    }
  }

  const descriptorPaths = new Map<string, string>();
  const resolvedByDescriptor = new Map<
    string,
    Omit<ResolvedPdfTemplateAssetV1, "slot" | "reference">
  >();
  const vfsOwners = new Map<string, string>();
  for (const [descriptorId, descriptor] of Object.entries(descriptors)) {
    const existingPathOwner = descriptorPaths.get(descriptor.path);
    if (existingPathOwner) {
      reject(
        "pack-integrity",
        "vfs-collision",
        `assetDescriptors.${descriptorId}.path`,
        `duplicates descriptor "${existingPathOwner}"`
      );
    }
    descriptorPaths.set(descriptor.path, descriptorId);
    const bytes = files[descriptor.path];
    if (!bytes) {
      reject(
        "pack-integrity",
        "missing-payload",
        descriptor.path,
        "is declared but absent"
      );
    }
    if (bytes.byteLength !== descriptor.byteLength) {
      reject(
        "pack-integrity",
        "descriptor-mismatch",
        descriptor.path,
        "byte length differs from the manifest"
      );
    }
    if (bytes.byteLength > PDF_TEMPLATE_ASSET_CAPABILITIES_V1.maxBytes) {
      reject(
        "pack-integrity",
        "asset-budget-exceeded",
        descriptor.path,
        "byte length exceeds the renderer budget"
      );
    }
    if ((await sha256Hex(bytes)) !== descriptor.sha256) {
      reject(
        "pack-integrity",
        "hash-mismatch",
        descriptor.path,
        "SHA-256 differs from the manifest"
      );
    }
    const dimensions = actualAsset(descriptor.mediaType, bytes, descriptor.path);
    if (
      dimensions.width !== descriptor.dimensions.width ||
      dimensions.height !== descriptor.dimensions.height
    ) {
      reject(
        "pack-integrity",
        "descriptor-mismatch",
        descriptor.path,
        "pixel dimensions differ from the manifest"
      );
    }
    const budget = PDF_TEMPLATE_ASSET_CAPABILITIES_V1;
    if (
      dimensions.width > budget.maxWidth ||
      dimensions.height > budget.maxHeight ||
      dimensions.width * dimensions.height > budget.maxPixels
    ) {
      reject(
        "pack-integrity",
        "asset-budget-exceeded",
        descriptor.path,
        "pixel dimensions exceed the renderer budget"
      );
    }
    const target = vfsPath(descriptorId, descriptor.mediaType);
    const existingVfsOwner = vfsOwners.get(target);
    if (existingVfsOwner) {
      reject(
        "pack-integrity",
        "vfs-collision",
        `assetDescriptors.${descriptorId}`,
        `maps to the same compiler path as "${existingVfsOwner}"`
      );
    }
    vfsOwners.set(target, descriptorId);
    resolvedByDescriptor.set(descriptorId, {
      descriptorId,
      descriptor,
      bytes: new Uint8Array(bytes),
      vfsPath: target,
    });
  }

  if (manifest.provenance?.payloadSha256) {
    const actual = await computePayloadSha256(files as Record<string, Uint8Array>);
    if (actual !== manifest.provenance.payloadSha256) {
      reject(
        "pack-integrity",
        "payload-digest-mismatch",
        "provenance.payloadSha256",
        "does not match the archive payload"
      );
    }
  }

  if (manifest.canonicalSource) {
    const allowed = new Set([
      manifest.engine.entry,
      ...Object.values(descriptors).map(({ path }) => path),
    ]);
    const foreign = Object.keys(files).find((path) => !allowed.has(path));
    if (foreign) {
      reject(
        "pack-integrity",
        "unreferenced-payload",
        foreign,
        "is not part of a canonical authoring pack"
      );
    }
  }

  const assets: Partial<
    Record<PdfTemplateAssetSlotV1, ResolvedPdfTemplateAssetV1>
  > = {};
  for (const [unknownSlot, reference] of Object.entries(references)) {
    const slot = unknownSlot as PdfTemplateAssetSlotV1;
    const resolved = resolvedByDescriptor.get(reference.descriptor);
    if (!resolved) {
      reject(
        "pack-integrity",
        "missing-payload",
        `assets.${slot}.descriptor`,
        "could not be resolved"
      );
    }
    assets[slot] = { slot, reference, ...resolved };
  }
  return {
    manifest,
    entrySource: new TextDecoder().decode(files[manifest.engine.entry]),
    assets,
    decorations: manifest.decorations ?? [],
  };
}

/**
 * Full loader: structural unzip, engine-neutral import gate, PDF manifest
 * gate, then byte-integrity gate.
 */
export async function loadPdfTemplatePack(
  bytes: Uint8Array
): Promise<ValidatedPdfTemplatePackV1> {
  const unpacked = unpackTemplate(bytes);
  const manifest = validateManifest(unpacked.manifest, {
    availableFonts: PDF_RUNTIME_ASSETS.fonts,
  });
  validatePdfTemplateManifest(manifest, PDF_TEMPLATE_CAPABILITIES_V1);
  return validatePdfTemplatePack(manifest, unpacked.files);
}

export interface DocxUniformPageBorderInputV1 {
  section: number;
  offsetFrom: string;
  sides: readonly {
    side: "bottom" | "left" | "right" | "top";
    style?: string;
    color?: string;
    widthEighthPoints?: number;
  }[];
}

/**
 * Materialize the one page-border shape PDF V1 can prove. Every section must
 * carry the same page-relative, four-sided single stroke.
 */
export function buildUniformPdfPageBorderV1(
  sections: readonly DocxUniformPageBorderInputV1[],
  inset = "6mm"
): WikiPdfTemplatePageBorderV1 | undefined {
  if (sections.length === 0) return undefined;
  const normalize = (section: DocxUniformPageBorderInputV1): string => {
    if (section.offsetFrom !== "page") {
      reject(
        "pdf-manifest",
        "unsupported-decoration",
        `sections[${section.section}].offsetFrom`,
        "offsetFrom=text is inventory-only"
      );
    }
    const ordered = [...section.sides].sort((left, right) =>
      left.side.localeCompare(right.side)
    );
    if (
      ordered.length !== 4 ||
      new Set(ordered.map(({ side }) => side)).size !== 4 ||
      ordered.some(
        ({ style, color, widthEighthPoints }) =>
          style !== "single" ||
          !color ||
          !/^#?[0-9A-Fa-f]{6}$/.test(color) ||
          !widthEighthPoints ||
          widthEighthPoints <= 0
      )
    ) {
      reject(
        "pdf-manifest",
        "unsupported-decoration",
        `sections[${section.section}].sides`,
        "individual sides, border art, and non-single strokes are inventory-only"
      );
    }
    const first = ordered[0]!;
    if (
      ordered.some(
        ({ style, color, widthEighthPoints }) =>
          style !== first.style ||
          color!.replace(/^#/u, "").toUpperCase() !==
            first.color!.replace(/^#/u, "").toUpperCase() ||
          widthEighthPoints !== first.widthEighthPoints
      )
    ) {
      reject(
        "pdf-manifest",
        "unsupported-decoration",
        `sections[${section.section}].sides`,
        "individual border-side styling is inventory-only"
      );
    }
    return `${first.color!.replace(/^#/u, "").toUpperCase()}:${first.widthEighthPoints}`;
  };
  const signatures = sections.map(normalize);
  if (new Set(signatures).size !== 1) {
    reject(
      "pdf-manifest",
      "unsupported-section-scope",
      "sections",
      "page borders differ between sections"
    );
  }
  const [color, eighthPoints] = signatures[0]!.split(":");
  return {
    kind: "page-border",
    id: "decoration.pageBorder",
    writer: PDF_TEMPLATE_WRITERS_V1.pageBorder,
    scope: "all",
    offsetFrom: "page",
    inset: { top: inset, right: inset, bottom: inset, left: inset },
    stroke: {
      style: "single",
      color: `#${color}`,
      width: `${Number(eighthPoints) / 8}pt`,
    },
  };
}
