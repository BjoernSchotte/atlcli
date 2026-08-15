/**
 * Engine-neutral visual-asset and page-decoration manifest contract.
 *
 * This module validates portable data only. It deliberately knows nothing
 * about PDF slot names, Typst writers, bundled fonts, compiler VFS paths, or
 * payload bytes. Those checks belong to the consuming engine.
 */
import { ManifestValidationError } from "./manifest-error.js";

export type TemplateAssetMediaTypeV1 =
  | "image/jpeg"
  | "image/png"
  | "image/svg+xml";

export interface TemplateAssetDescriptorV1 {
  path: string;
  sha256: string;
  mediaType: TemplateAssetMediaTypeV1;
  byteLength: number;
  dimensions: { width: number; height: number; unit: "pixel" };
}

export interface TemplateAssetReferenceV1 {
  descriptor: string;
  writer: string;
  decorative: boolean;
  alt?: string;
  placement?: WikiPdfTemplateImageDecorationV1["placement"];
}

export type TemplateDecorationScopeV1 = "all" | "first" | "odd" | "even";

export type WikiPdfTemplateImageClipV1 =
  | { kind: "rect" }
  | { kind: "rounded-rect"; radius: string }
  | { kind: "circle" };

export interface WikiPdfTemplateImageDecorationV1 {
  kind: "image";
  id: string;
  writer: string;
  scope: TemplateDecorationScopeV1;
  layer: "page-background" | "header" | "footer";
  /** A key in the manifest's `assets` reference map. */
  asset: string;
  placement: {
    relativeTo: "page" | "margin";
    fit?: "contain" | "cover" | "stretch";
    x: string;
    y: string;
    width: string;
    height: string;
    opacity?: number;
    rotation?: number;
    crop?: { left: number; top: number; right: number; bottom: number };
    clip?: WikiPdfTemplateImageClipV1;
  };
  decorative: boolean;
  alt?: string;
}

export interface WikiPdfTemplatePageBorderV1 {
  kind: "page-border";
  id: string;
  writer: string;
  scope: "all";
  offsetFrom: "page";
  inset: { top: string; right: string; bottom: string; left: string };
  stroke: {
    style: "single";
    color: string;
    width: string;
  };
}

export type WikiPdfTemplatePageDecorationV1 =
  | WikiPdfTemplateImageDecorationV1
  | WikiPdfTemplatePageBorderV1;

export interface WikiPdfCanonicalSourceV1 {
  api: string;
  revision: string;
}

export interface TemplateVisualManifestFieldsV1 {
  assetDescriptors?: Readonly<Record<string, TemplateAssetDescriptorV1>>;
  assets?: Readonly<Record<string, TemplateAssetReferenceV1>>;
  decorations?: readonly WikiPdfTemplatePageDecorationV1[];
  canonicalSource?: WikiPdfCanonicalSourceV1;
}

const ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const REVISION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const WRITER_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;
const LENGTH_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:pt|mm|cm|in)$/;
const COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
const MAX_ITEMS = 64;
const MAX_TEXT = 512;
const MAX_ABSOLUTE_LENGTH = 1_000_000;

function fail(path: string, message: string): never {
  throw new ManifestValidationError("shape-error", `${path} ${message}`, path);
}

function object(
  value: unknown,
  path: string
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string
): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown) fail(`${path}.${unknown}`, "is not recognized");
}

function id(value: unknown, path: string): string {
  if (typeof value !== "string" || !ID_RE.test(value)) {
    fail(path, "must be a stable identifier");
  }
  return value;
}

function writer(value: unknown, path: string): string {
  if (typeof value !== "string" || !WRITER_RE.test(value)) {
    fail(path, "must be a stable writer identifier");
  }
  return value;
}

function text(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    [...value].length > MAX_TEXT ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(path, `must be non-empty safe text of at most ${MAX_TEXT} code points`);
  }
  return value;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function finite(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum
  ) {
    fail(path, `must be a finite number in [${minimum}, ${maximum}]`);
  }
  return value;
}

function positiveInteger(value: unknown, path: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    fail(path, "must be a positive safe integer");
  }
  return value;
}

function portablePath(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..") ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail(path, "must be a safe relative archive path");
  }
  return value;
}

function length(value: unknown, path: string, allowNegative: boolean): string {
  if (typeof value !== "string" || !LENGTH_RE.test(value)) {
    fail(path, "must be a finite pt/mm/cm/in length");
  }
  const numeric = Number.parseFloat(value);
  if (
    !Number.isFinite(numeric) ||
    Math.abs(numeric) > MAX_ABSOLUTE_LENGTH ||
    (!allowNegative && numeric < 0)
  ) {
    fail(path, `must be ${allowNegative ? "bounded" : "non-negative"}`);
  }
  return value;
}

function altFor(
  value: Record<string, unknown>,
  decorative: boolean,
  path: string
): string | undefined {
  if (!decorative && value.alt === undefined) {
    fail(`${path}.alt`, "is required for a meaning-bearing asset");
  }
  return value.alt === undefined ? undefined : text(value.alt, `${path}.alt`);
}

function validateDescriptors(
  value: unknown
): Readonly<Record<string, TemplateAssetDescriptorV1>> | undefined {
  if (value === undefined) return undefined;
  const record = object(value, "assetDescriptors");
  if (Object.keys(record).length > MAX_ITEMS) {
    fail("assetDescriptors", `must contain at most ${MAX_ITEMS} entries`);
  }
  const validated: Record<string, TemplateAssetDescriptorV1> = {};
  for (const [key, unknownDescriptor] of Object.entries(record)) {
    id(key, `assetDescriptors.${key}`);
    const descriptor = object(unknownDescriptor, `assetDescriptors.${key}`);
    exactKeys(
      descriptor,
      ["path", "sha256", "mediaType", "byteLength", "dimensions"],
      `assetDescriptors.${key}`
    );
    const mediaType = descriptor.mediaType;
    if (
      mediaType !== "image/jpeg" &&
      mediaType !== "image/png" &&
      mediaType !== "image/svg+xml"
    ) {
      fail(`assetDescriptors.${key}.mediaType`, "is not a supported image media type");
    }
    if (typeof descriptor.sha256 !== "string" || !SHA256_RE.test(descriptor.sha256)) {
      fail(`assetDescriptors.${key}.sha256`, "must be a lowercase SHA-256 digest");
    }
    const dimensions = object(
      descriptor.dimensions,
      `assetDescriptors.${key}.dimensions`
    );
    exactKeys(
      dimensions,
      ["width", "height", "unit"],
      `assetDescriptors.${key}.dimensions`
    );
    if (dimensions.unit !== "pixel") {
      fail(`assetDescriptors.${key}.dimensions.unit`, 'must be "pixel"');
    }
    validated[key] = {
      path: portablePath(descriptor.path, `assetDescriptors.${key}.path`),
      sha256: descriptor.sha256,
      mediaType,
      byteLength: positiveInteger(
        descriptor.byteLength,
        `assetDescriptors.${key}.byteLength`
      ),
      dimensions: {
        width: positiveInteger(
          dimensions.width,
          `assetDescriptors.${key}.dimensions.width`
        ),
        height: positiveInteger(
          dimensions.height,
          `assetDescriptors.${key}.dimensions.height`
        ),
        unit: "pixel",
      },
    };
  }
  return validated;
}

function validateReferences(
  value: unknown,
  descriptors: Readonly<Record<string, TemplateAssetDescriptorV1>>
): Readonly<Record<string, TemplateAssetReferenceV1>> | undefined {
  if (value === undefined) return undefined;
  const record = object(value, "assets");
  if (Object.keys(record).length > MAX_ITEMS) {
    fail("assets", `must contain at most ${MAX_ITEMS} entries`);
  }
  const validated: Record<string, TemplateAssetReferenceV1> = {};
  for (const [key, unknownReference] of Object.entries(record)) {
    id(key, `assets.${key}`);
    const reference = object(unknownReference, `assets.${key}`);
    exactKeys(
      reference,
      ["descriptor", "writer", "decorative", "alt", "placement"],
      `assets.${key}`
    );
    const descriptor = id(reference.descriptor, `assets.${key}.descriptor`);
    if (!descriptors[descriptor]) {
      fail(`assets.${key}.descriptor`, `references unknown descriptor "${descriptor}"`);
    }
    const decorative = boolean(reference.decorative, `assets.${key}.decorative`);
    const alt = altFor(reference, decorative, `assets.${key}`);
    validated[key] = {
      descriptor,
      writer: writer(reference.writer, `assets.${key}.writer`),
      decorative,
      ...(alt === undefined ? {} : { alt }),
      ...(reference.placement === undefined
        ? {}
        : {
            placement: validatePlacement(
              reference.placement,
              `assets.${key}.placement`
            ),
          }),
    };
  }
  return validated;
}

function validatePlacement(
  value: unknown,
  path: string
): WikiPdfTemplateImageDecorationV1["placement"] {
  const placement = object(value, path);
  exactKeys(
    placement,
    ["relativeTo", "fit", "x", "y", "width", "height", "opacity", "rotation", "crop", "clip"],
    path
  );
  if (placement.relativeTo !== "page" && placement.relativeTo !== "margin") {
    fail(`${path}.relativeTo`, 'must be "page" or "margin"');
  }
  if (
    placement.fit !== undefined &&
    placement.fit !== "contain" &&
    placement.fit !== "cover" &&
    placement.fit !== "stretch"
  ) {
    fail(`${path}.fit`, "is not recognized");
  }
  let crop: WikiPdfTemplateImageDecorationV1["placement"]["crop"];
  if (placement.crop !== undefined) {
    const value = object(placement.crop, `${path}.crop`);
    exactKeys(value, ["left", "top", "right", "bottom"], `${path}.crop`);
    crop = {
      left: finite(value.left, `${path}.crop.left`, 0, 1),
      top: finite(value.top, `${path}.crop.top`, 0, 1),
      right: finite(value.right, `${path}.crop.right`, 0, 1),
      bottom: finite(value.bottom, `${path}.crop.bottom`, 0, 1),
    };
    if (crop.left + crop.right >= 1 || crop.top + crop.bottom >= 1) {
      fail(`${path}.crop`, "must leave a positive visible area");
    }
  }
  let clip: WikiPdfTemplateImageDecorationV1["placement"]["clip"];
  if (placement.clip !== undefined) {
    const value = object(placement.clip, `${path}.clip`);
    if (value.kind === "rounded-rect") {
      exactKeys(value, ["kind", "radius"], `${path}.clip`);
      clip = {
        kind: "rounded-rect",
        radius: length(value.radius, `${path}.clip.radius`, false),
      };
    } else if (value.kind === "rect" || value.kind === "circle") {
      exactKeys(value, ["kind"], `${path}.clip`);
      clip = { kind: value.kind };
    } else {
      fail(`${path}.clip.kind`, 'must be "rect", "rounded-rect", or "circle"');
    }
  }
  return {
    relativeTo: placement.relativeTo,
    ...(placement.fit === undefined
      ? {}
      : { fit: placement.fit as "contain" | "cover" | "stretch" }),
    x: length(placement.x, `${path}.x`, true),
    y: length(placement.y, `${path}.y`, true),
    width: length(placement.width, `${path}.width`, false),
    height: length(placement.height, `${path}.height`, false),
    ...(placement.opacity === undefined
      ? {}
      : { opacity: finite(placement.opacity, `${path}.opacity`, 0, 1) }),
    ...(placement.rotation === undefined
      ? {}
      : { rotation: finite(placement.rotation, `${path}.rotation`, -180, 180) }),
    ...(crop === undefined ? {} : { crop }),
    ...(clip === undefined ? {} : { clip }),
  };
}

function validateDecorations(
  value: unknown,
  assets: Readonly<Record<string, TemplateAssetReferenceV1>>
): readonly WikiPdfTemplatePageDecorationV1[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ITEMS) {
    fail("decorations", `must be an array of at most ${MAX_ITEMS} entries`);
  }
  const ids = new Set<string>();
  return value.map((unknownDecoration, index) => {
    const path = `decorations[${index}]`;
    const decoration = object(unknownDecoration, path);
    if (decoration.kind === "image") {
      exactKeys(
        decoration,
        ["kind", "id", "writer", "scope", "layer", "asset", "placement", "decorative", "alt"],
        path
      );
      const decorationId = id(decoration.id, `${path}.id`);
      if (ids.has(decorationId)) fail(`${path}.id`, "must be unique");
      ids.add(decorationId);
      if (
        decoration.scope !== "all" &&
        decoration.scope !== "first" &&
        decoration.scope !== "odd" &&
        decoration.scope !== "even"
      ) {
        fail(`${path}.scope`, "is not recognized");
      }
      if (
        decoration.layer !== "page-background" &&
        decoration.layer !== "header" &&
        decoration.layer !== "footer"
      ) {
        fail(`${path}.layer`, "is not recognized");
      }
      const asset = id(decoration.asset, `${path}.asset`);
      if (!assets[asset]) fail(`${path}.asset`, `references unknown asset "${asset}"`);
      const decorative = boolean(decoration.decorative, `${path}.decorative`);
      const alt = altFor(decoration, decorative, path);
      return {
        kind: "image",
        id: decorationId,
        writer: writer(decoration.writer, `${path}.writer`),
        scope: decoration.scope,
        layer: decoration.layer,
        asset,
        placement: validatePlacement(decoration.placement, `${path}.placement`),
        decorative,
        ...(alt === undefined ? {} : { alt }),
      };
    }
    if (decoration.kind === "page-border") {
      exactKeys(
        decoration,
        ["kind", "id", "writer", "scope", "offsetFrom", "inset", "stroke"],
        path
      );
      const decorationId = id(decoration.id, `${path}.id`);
      if (ids.has(decorationId)) fail(`${path}.id`, "must be unique");
      ids.add(decorationId);
      if (decoration.scope !== "all") fail(`${path}.scope`, 'must be "all"');
      if (decoration.offsetFrom !== "page") {
        fail(`${path}.offsetFrom`, 'must be "page"');
      }
      const inset = object(decoration.inset, `${path}.inset`);
      exactKeys(inset, ["top", "right", "bottom", "left"], `${path}.inset`);
      const stroke = object(decoration.stroke, `${path}.stroke`);
      exactKeys(stroke, ["style", "color", "width"], `${path}.stroke`);
      if (stroke.style !== "single") {
        fail(`${path}.stroke.style`, 'must be "single"');
      }
      if (typeof stroke.color !== "string" || !COLOR_RE.test(stroke.color)) {
        fail(`${path}.stroke.color`, "must be a #RRGGBB color");
      }
      return {
        kind: "page-border",
        id: decorationId,
        writer: writer(decoration.writer, `${path}.writer`),
        scope: "all",
        offsetFrom: "page",
        inset: {
          top: length(inset.top, `${path}.inset.top`, false),
          right: length(inset.right, `${path}.inset.right`, false),
          bottom: length(inset.bottom, `${path}.inset.bottom`, false),
          left: length(inset.left, `${path}.inset.left`, false),
        },
        stroke: {
          style: "single",
          color: stroke.color.toUpperCase(),
          width: length(stroke.width, `${path}.stroke.width`, false),
        },
      };
    }
    fail(`${path}.kind`, 'must be "image" or "page-border"');
  });
}

function validateCanonicalSource(
  value: unknown
): WikiPdfCanonicalSourceV1 | undefined {
  if (value === undefined) return undefined;
  const source = object(value, "canonicalSource");
  exactKeys(source, ["api", "revision"], "canonicalSource");
  return {
    api: id(source.api, "canonicalSource.api"),
    revision:
      typeof source.revision === "string" && REVISION_RE.test(source.revision)
        ? source.revision
        : fail("canonicalSource.revision", "must be a stable revision"),
  };
}

export function validateTemplateVisualManifestFieldsV1(
  value: Record<string, unknown>
): TemplateVisualManifestFieldsV1 {
  const assetDescriptors = validateDescriptors(value.assetDescriptors);
  const assets = validateReferences(value.assets, assetDescriptors ?? {});
  const decorations = validateDecorations(value.decorations, assets ?? {});
  return {
    ...(assetDescriptors === undefined ? {} : { assetDescriptors }),
    ...(assets === undefined ? {} : { assets }),
    ...(decorations === undefined ? {} : { decorations }),
    ...(value.canonicalSource === undefined
      ? {}
      : { canonicalSource: validateCanonicalSource(value.canonicalSource)! }),
  };
}
