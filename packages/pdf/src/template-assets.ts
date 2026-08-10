/**
 * Shared, browser-safe materialization for renderer-owned template assets.
 *
 * Hosts resolve bytes; this module derives every executable/archive identity
 * from the declared slot and verified content. Source filenames never become
 * descriptor ids, archive paths, or compiler VFS paths.
 */
import type { TemplateRuntimeAssetV1 } from "@atlcli/pdf-template-authoring";
import {
  type TemplateAssetDescriptorV1,
  type TemplateAssetReferenceV1,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateDesignV3,
  type WikiPdfTemplateImageDecorationV1,
  type WikiPdfTemplatePageDecorationV1,
} from "@atlcli/template-pack";
import { decodeSvgSource, findSvgSafetyViolation } from "@atlcli/confluence";
import { PDF_TEMPLATE_ASSET_CAPABILITIES_V1 } from "./template-asset-capabilities.js";
import {
  PDF_TEMPLATE_WRITERS_V1,
  type PdfTemplateAssetSlotV1,
} from "./template-pack.js";

export async function sha256PdfTemplateBytes(
  bytes: Uint8Array
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function pdfTemplateAssetExtension(
  mediaType: string
): "jpg" | "png" | "svg" {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/svg+xml") return "svg";
  throw new Error(`Unsupported PDF template asset media type: ${mediaType}`);
}

export function pdfTemplateAssetDimensions(
  mediaType: string,
  bytes: Uint8Array
): { width: number; height: number; unit: "pixel" } {
  if (
    mediaType === "image/png" &&
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      unit: "pixel",
    };
  }
  if (mediaType === "image/svg+xml") {
    const source = decodeSvgSource(bytes);
    const width = Number(/\bwidth=["'](\d+(?:\.\d+)?)["']/u.exec(source)?.[1]);
    const height = Number(/\bheight=["'](\d+(?:\.\d+)?)["']/u.exec(source)?.[1]);
    if (
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0
    ) {
      return { width, height, unit: "pixel" };
    }
  }
  if (
    mediaType === "image/jpeg" &&
    bytes.byteLength >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8
  ) {
    let offset = 2;
    while (offset + 8 < bytes.byteLength) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb,
          0xcd, 0xce, 0xcf,
        ].includes(marker)
      ) {
        return {
          width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
          height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
          unit: "pixel",
        };
      }
      if (length < 2) break;
      offset += length + 2;
    }
  }
  throw new Error("Template asset has no trustworthy intrinsic dimensions");
}

/** Preflight recipe bytes before any canonical Typst is generated. */
export async function validatePdfTemplateAssetPreflight(
  asset: TemplateRuntimeAssetV1
): Promise<void> {
  if (!/^[a-f0-9]{64}$/u.test(asset.sha256)) {
    throw new Error(`Asset ${asset.slot} has an invalid SHA-256`);
  }
  if ((await sha256PdfTemplateBytes(asset.bytes)) !== asset.sha256) {
    throw new Error(`Asset ${asset.slot} SHA-256 does not match its bytes`);
  }
  const dimensions = pdfTemplateAssetDimensions(asset.mediaType, asset.bytes);
  const budget = PDF_TEMPLATE_ASSET_CAPABILITIES_V1;
  if (
    asset.bytes.byteLength > budget.maxBytes ||
    dimensions.width > budget.maxWidth ||
    dimensions.height > budget.maxHeight ||
    dimensions.width * dimensions.height > budget.maxPixels
  ) {
    throw new Error(`Asset ${asset.slot} exceeds the renderer budget`);
  }
  if (asset.mediaType === "image/svg+xml") {
    const violation = findSvgSafetyViolation(decodeSvgSource(asset.bytes));
    if (violation) {
      throw new Error(`Asset ${asset.slot} contains unsafe SVG: ${violation}`);
    }
  }
}

function pageDimensions(
  design: WikiPdfTemplateDesignV1 | WikiPdfTemplateDesignV3
): { width: string; height: string } {
  const page = design.page;
  const base: readonly [string | number, string | number] = "size" in page
    ? page.size === "letter"
      ? [215.9, 279.4]
      : [210, 297]
    : page.format.kind === "preset"
      ? page.format.name === "letter"
        ? [215.9, 279.4]
        : [210, 297]
      : [page.format.width, page.format.height];
  const [width, height] =
    page?.orientation === "landscape" ? [base[1], base[0]] : base;
  return {
    width: typeof width === "number" ? `${width}mm` : width,
    height: typeof height === "number" ? `${height}mm` : height,
  };
}

function defaultDecoration(
  asset: TemplateRuntimeAssetV1,
  design: WikiPdfTemplateDesignV1 | WikiPdfTemplateDesignV3
): WikiPdfTemplateImageDecorationV1 | undefined {
  const page = pageDimensions(design);
  const common = {
    kind: "image" as const,
    id: asset.slot,
    writer: PDF_TEMPLATE_WRITERS_V1.imageDecoration,
    asset: asset.slot,
    decorative: asset.accessibility.decorative,
    ...(asset.accessibility.alt ? { alt: asset.accessibility.alt } : {}),
  };
  switch (asset.slot) {
    case "asset.pageBackground":
      return {
        ...common,
        scope: "all",
        layer: "page-background",
        placement: {
          relativeTo: "page",
          fit: "stretch",
          x: "0mm",
          y: "0mm",
          ...page,
        },
      };
    case "asset.coverBackground":
      return {
        ...common,
        scope: "first",
        layer: "page-background",
        placement: {
          relativeTo: "page",
          fit: "stretch",
          x: "0mm",
          y: "0mm",
          ...page,
        },
      };
    case "asset.headerDecoration":
      return {
        ...common,
        scope: "all",
        layer: "header",
        placement: {
          relativeTo: "margin",
          fit: "contain",
          x: "0mm",
          y: "0mm",
          width: "35mm",
          height: "8mm",
        },
      };
    case "asset.footerDecoration":
      return {
        ...common,
        scope: "all",
        layer: "footer",
        placement: {
          relativeTo: "margin",
          fit: "contain",
          x: "0mm",
          y: "0mm",
          width: "35mm",
          height: "8mm",
        },
      };
    default:
      return undefined;
  }
}

function decorationFor(
  asset: TemplateRuntimeAssetV1,
  design: WikiPdfTemplateDesignV1 | WikiPdfTemplateDesignV3
): WikiPdfTemplateImageDecorationV1 | undefined {
  if (asset.slot === "asset.logo") return undefined;
  const fallback = defaultDecoration(asset, design);
  if (asset.rendering.kind === "slot-default") return fallback;
  const placement = asset.rendering.placement;
  if (!fallback || !placement) {
    throw new Error(`Asset ${asset.slot} has no supported PDF placement`);
  }
  return {
    ...fallback,
    placement:
      placement as unknown as WikiPdfTemplateImageDecorationV1["placement"],
  };
}

export interface PdfTemplateAssetIdentityV1 {
  descriptorId(asset: TemplateRuntimeAssetV1): string;
  archivePath(
    asset: TemplateRuntimeAssetV1,
    descriptorId: string,
    extension: "jpg" | "png" | "svg"
  ): string;
}

export interface PdfTemplateAssetFieldsV1 {
  descriptors: Record<string, TemplateAssetDescriptorV1>;
  references: Record<string, TemplateAssetReferenceV1>;
  decorations: WikiPdfTemplatePageDecorationV1[];
  files: Record<string, Uint8Array>;
}

export function materializePdfTemplateAssetFields(
  assets: readonly TemplateRuntimeAssetV1[],
  design: WikiPdfTemplateDesignV1 | WikiPdfTemplateDesignV3,
  identity: PdfTemplateAssetIdentityV1
): PdfTemplateAssetFieldsV1 {
  const descriptors: Record<string, TemplateAssetDescriptorV1> = {};
  const references: Record<string, TemplateAssetReferenceV1> = {};
  const decorations: WikiPdfTemplatePageDecorationV1[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const asset of [...assets].sort((left, right) =>
    left.slot.localeCompare(right.slot)
  )) {
    const slot = asset.slot as PdfTemplateAssetSlotV1;
    const descriptorId = identity.descriptorId(asset);
    const extension = pdfTemplateAssetExtension(asset.mediaType);
    const path = identity.archivePath(asset, descriptorId, extension);
    descriptors[descriptorId] = {
      path,
      sha256: asset.sha256,
      mediaType: asset.mediaType as TemplateAssetDescriptorV1["mediaType"],
      byteLength: asset.bytes.byteLength,
      dimensions: pdfTemplateAssetDimensions(asset.mediaType, asset.bytes),
    };
    references[slot] = {
      descriptor: descriptorId,
      writer:
        slot === "asset.logo"
          ? PDF_TEMPLATE_WRITERS_V1.logo
          : PDF_TEMPLATE_WRITERS_V1.imageDecoration,
      decorative: asset.accessibility.decorative,
      ...(asset.accessibility.alt ? { alt: asset.accessibility.alt } : {}),
      ...(slot === "asset.logo" &&
      asset.rendering.kind !== "slot-default" &&
      asset.rendering.placement
        ? {
            placement:
              asset.rendering
                .placement as unknown as TemplateAssetReferenceV1["placement"],
          }
        : {}),
    };
    const decoration = decorationFor(asset, design);
    if (decoration) decorations.push(decoration);
    files[path] = new Uint8Array(asset.bytes);
  }
  return { descriptors, references, decorations, files };
}

/** Preserve the characterized DOCX-derived pack identities exactly. */
export const PDF_DOCX_TEMPLATE_ASSET_IDENTITY_V1: PdfTemplateAssetIdentityV1 = {
  descriptorId: (asset) => asset.slot.replace(/^asset\./u, "asset-"),
  archivePath: (asset, _descriptorId, extension) =>
    `assets/${asset.slot}/${asset.sha256}.${extension}`,
};

/** Recipe identities are content-addressed and never inherit source names. */
export const PDF_RECIPE_TEMPLATE_ASSET_IDENTITY_V1: PdfTemplateAssetIdentityV1 = {
  descriptorId: (asset) => {
    const slot = asset.slot
      .replace(/^asset\./u, "asset-")
      .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .replace(/[._]+/gu, "-")
      .toLowerCase();
    return `${slot}-${asset.sha256}`;
  },
  archivePath: (_asset, descriptorId, extension) =>
    `assets/${descriptorId}.${extension}`,
};
