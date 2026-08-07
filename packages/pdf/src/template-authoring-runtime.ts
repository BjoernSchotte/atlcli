/**
 * Browser-compatible PDF runtime materializer for the host-neutral authoring
 * workflow. It converts one resolved snapshot plus explicitly accepted asset
 * bytes into the only canonical pack shape the PDF loader will execute.
 */
import type {
  AuthoringResolutionSnapshotV1,
  TemplateGeneratedPackCompileInputV1,
  TemplateGeneratedPackCompileResultV1,
  TemplateGeneratedPackCompilerV1,
  TemplateRuntimeAssetV1,
  TemplateRuntimeMaterializationV1,
  TemplateRuntimeMaterializer,
} from "@atlcli/pdf-template-authoring";
import {
  validateDesign,
  validateManifest,
  type TemplateAssetDescriptorV1,
  type TemplateAssetReferenceV1,
  type WikiPdfTemplateDesignV1,
  type WikiPdfTemplateImageDecorationV1,
  type WikiPdfTemplatePageDecorationV1,
} from "@atlcli/template-pack";
import { BUILTIN_PDF_TEMPLATE_MANIFEST } from "./builtin-template.js";
import type { PdfCompilePort } from "./compiler.js";
import {
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
} from "./design-catalog.js";
import {
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION,
  PDF_TEMPLATE_WRITERS_V1,
  generateCanonicalPdfTemplateSourceV1,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  type PdfTemplateAssetSlotV1,
  type PdfTemplateVisualsV1,
} from "./template-pack.js";
import { loadPdfTemplatePack } from "./template-pack.js";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";
import type { ExportBlock } from "./types.js";
import { validatePdfOutput } from "./validate.js";

const encoder = new TextEncoder();

const NEUTRAL_FEATURE_ZOO: readonly ExportBlock[] = [
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Compatibility proof" }],
  },
  {
    type: "paragraph",
    content: [{ type: "text", text: "Neutral template content." }],
  },
  {
    type: "table",
    rows: [
      {
        cells: [
          {
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Feature" }],
              },
            ],
          },
          {
            header: true,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Result" }],
              },
            ],
          },
        ],
      },
      {
        cells: [
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Typography" }],
              },
            ],
          },
          {
            header: false,
            colspan: 1,
            rowspan: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Rendered" }],
              },
            ],
          },
        ],
      },
    ],
  },
];

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    Uint8Array.from(bytes)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function extension(mediaType: string): "jpg" | "png" | "svg" {
  if (mediaType === "image/png") return "png";
  if (mediaType === "image/jpeg") return "jpg";
  if (mediaType === "image/svg+xml") return "svg";
  throw new Error(`Unsupported PDF template asset media type: ${mediaType}`);
}

function dimensions(
  mediaType: string,
  bytes: Uint8Array
): { width: number; height: number; unit: "pixel" } {
  if (
    mediaType === "image/png" &&
    bytes.byteLength >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return {
      width: view.getUint32(16),
      height: view.getUint32(20),
      unit: "pixel",
    };
  }
  if (mediaType === "image/svg+xml") {
    const source = new TextDecoder().decode(bytes);
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
  if (mediaType === "image/jpeg") {
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

function pageDimensions(
  design: WikiPdfTemplateDesignV1
): { width: string; height: string } {
  const page = design.page;
  const base =
    page?.size === "letter"
      ? ([215.9, 279.4] as const)
      : ([210, 297] as const);
  const [width, height] =
    page?.orientation === "landscape" ? [base[1], base[0]] : base;
  return { width: `${width}mm`, height: `${height}mm` };
}

function defaultDecoration(
  asset: TemplateRuntimeAssetV1,
  design: WikiPdfTemplateDesignV1
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
  design: WikiPdfTemplateDesignV1
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

function manifestAssetFields(
  assets: readonly TemplateRuntimeAssetV1[],
  design: WikiPdfTemplateDesignV1
): {
  descriptors: Record<string, TemplateAssetDescriptorV1>;
  references: Record<string, TemplateAssetReferenceV1>;
  decorations: WikiPdfTemplatePageDecorationV1[];
  files: Record<string, Uint8Array>;
} {
  const descriptors: Record<string, TemplateAssetDescriptorV1> = {};
  const references: Record<string, TemplateAssetReferenceV1> = {};
  const decorations: WikiPdfTemplatePageDecorationV1[] = [];
  const files: Record<string, Uint8Array> = {};
  for (const asset of [...assets].sort((left, right) =>
    left.slot.localeCompare(right.slot)
  )) {
    const slot = asset.slot as PdfTemplateAssetSlotV1;
    const descriptorId = slot.replace(/^asset\./u, "asset-");
    const path = `assets/${slot}/${asset.sha256}.${extension(asset.mediaType)}`;
    descriptors[descriptorId] = {
      path,
      sha256: asset.sha256,
      mediaType: asset.mediaType as TemplateAssetDescriptorV1["mediaType"],
      byteLength: asset.bytes.byteLength,
      dimensions: dimensions(asset.mediaType, asset.bytes),
    };
    references[slot] = {
      descriptor: descriptorId,
      writer:
        slot === "asset.logo"
          ? PDF_TEMPLATE_WRITERS_V1.logo
          : PDF_TEMPLATE_WRITERS_V1.imageDecoration,
      decorative: asset.accessibility.decorative,
      ...(asset.accessibility.alt
        ? { alt: asset.accessibility.alt }
        : {}),
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

export class PdfTemplateRuntimeMaterializer
  implements TemplateRuntimeMaterializer
{
  async materialize(
    snapshot: AuthoringResolutionSnapshotV1,
    assets: readonly TemplateRuntimeAssetV1[]
  ): Promise<TemplateRuntimeMaterializationV1> {
    const design = validateDesign(
      snapshot.design,
      "authoringSnapshot.design"
    );
    const visual = manifestAssetFields(assets, design);
    const manifest = validateManifest({
      ...BUILTIN_PDF_TEMPLATE_MANIFEST,
      id: `imported-${snapshot.snapshotDigest.slice(0, 16)}`,
      name: "Imported PDF design",
      version: "1.0.0",
      design,
      capabilityCatalog: {
        id: PDF_TEMPLATE_CAPABILITIES_V1.id,
        version: PDF_TEMPLATE_CAPABILITIES_V1.version,
        digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
      },
      canonicalSource: {
        api: PDF_CANONICAL_SOURCE_API_V1,
        // DOCX-derived durable projects stay on the characterized V1/rev3
        // contract until an explicit migration is implemented.
        revision: PDF_DOCX_AUTHORING_CANONICAL_SOURCE_REVISION,
      },
      assetDescriptors: visual.descriptors,
      assets: visual.references,
      decorations: visual.decorations,
      provenance: undefined,
    });
    validatePdfTemplateManifest(manifest);
    const visuals: PdfTemplateVisualsV1 = {
      assets: Object.fromEntries(
        Object.entries(manifest.assets ?? {}).map(([slot, reference]) => {
          const descriptor =
            manifest.assetDescriptors?.[reference.descriptor];
          if (!descriptor) {
            throw new Error(
              `PDF template asset ${slot} has no validated descriptor`
            );
          }
          return [
            slot,
            {
              vfsPath: `template-assets/${reference.descriptor
                .toLowerCase()
                .replace(/[._]+/g, "-")}.${extension(
                descriptor.mediaType
              )}`,
              reference,
            },
          ];
        })
      ),
      decorations: manifest.decorations ?? [],
    };
    const canonicalTypst = generateCanonicalPdfTemplateSourceV1(
      manifest,
      visuals
    );
    const files = {
      ...visual.files,
      "atlcli.typ": encoder.encode(canonicalTypst),
    };
    await validatePdfTemplatePack(manifest, files);
    return {
      manifest,
      canonicalTypst,
      runtimeSnapshot: {
        design,
        assets: Object.fromEntries(
          assets
            .map(
              ({
                slot,
                sha256,
                mediaType,
                accessibility,
                rendering,
              }) => [
                slot,
                {
                  sha256,
                  mediaType,
                  accessibility,
                  rendering,
                },
              ]
            )
            .sort(([left], [right]) =>
              String(left).localeCompare(String(right))
            )
        ),
      },
      files,
    };
  }
}

/**
 * Real, browser-safe executable gate for a generated template pack.
 *
 * Hosts inject the pinned compiler port. The same neutral feature document,
 * loader, serializer, tagged-PDF checks, and digest calculation therefore run
 * in the CLI, browser harness, Studio, and extension shapes.
 */
export class PdfGeneratedTemplateProofCompiler
  implements TemplateGeneratedPackCompilerV1
{
  constructor(private readonly compiler: PdfCompilePort) {}

  async compile(
    input: TemplateGeneratedPackCompileInputV1
  ): Promise<TemplateGeneratedPackCompileResultV1> {
    const pack = await loadPdfTemplatePack(input.packBytes);
    const prepared = await preparePdfDocument([...NEUTRAL_FEATURE_ZOO], {
      resolve: async () => {
        throw new Error("Neutral template feature zoo has no document assets");
      },
    });
    const bundle = serializePdfDocument(prepared, {
      metadata: {
        title: "Template compatibility proof",
        space: "NEUTRAL",
        version: 1,
        author: "atlcli",
        language: "en",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: false, outline: true },
      templatePack: pack,
    });
    const result = await this.compiler.compile(bundle);
    const errors = result.diagnostics.filter(
      ({ severity }) => severity === "error"
    );
    if (!result.pdf || errors.length > 0) {
      throw new Error(
        `Generated PDF template failed its executable gate: ${JSON.stringify(
          errors
        )}`
      );
    }
    const inspection = validatePdfOutput(result.pdf);
    if (
      !inspection.tagged ||
      !inspection.hasOutline ||
      inspection.embeddedFontFiles < 1
    ) {
      throw new Error(
        "Generated PDF template lost tagged output, outline, or embedded fonts"
      );
    }
    return {
      digest: await sha256(result.pdf),
      pageCount: inspection.pageCount,
    };
  }
}
