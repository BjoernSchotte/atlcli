/**
 * PDF-owned runtime adapters for template authoring.
 *
 * The host-neutral package supplies the workflow. The CLI injects the current
 * PDF catalog/baseline source generator and the real pinned Typst-WASM gate.
 */
import { fileURLToPath } from "node:url";
import { sha256Hex } from "@atlcli/core";
import {
  PDF_CANONICAL_SOURCE_API_V1,
  PDF_CANONICAL_SOURCE_REVISION,
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_WRITERS_V1,
  loadPdfTemplatePack,
  preparePdfDocument,
  validatePdfOutput,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  type ExportBlock,
  type PdfTemplateAssetSlotV1,
  type PdfTemplateVisualsV1,
} from "@atlcli/pdf";
import {
  BUILTIN_PDF_FALLBACK_LABELS,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  createAtlcliTypstTemplate,
  serializePdfDocument,
} from "@atlcli/pdf/internal";
import { BrowserPdfCompiler } from "@atlcli/pdf-compiler-browser";
import type {
  AuthoringResolutionSnapshotV1,
  TemplateGeneratedPackCompilerV1,
  TemplateGeneratedPackCompileInputV1,
  TemplateGeneratedPackCompileResultV1,
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

const encoder = new TextEncoder();

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
    if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
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
        [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
          marker
        )
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
    placement: placement as unknown as WikiPdfTemplateImageDecorationV1["placement"],
  };
}

function manifestAssetFields(
  snapshot: AuthoringResolutionSnapshotV1,
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
    };
    const decoration = decorationFor(asset, design);
    if (decoration) decorations.push(decoration);
    files[path] = new Uint8Array(asset.bytes);
  }
  return { descriptors, references, decorations, files };
}

export class CliPdfTemplateRuntimeMaterializer
  implements TemplateRuntimeMaterializer
{
  async materialize(
    snapshot: AuthoringResolutionSnapshotV1,
    assets: readonly TemplateRuntimeAssetV1[]
  ): Promise<TemplateRuntimeMaterializationV1> {
    const design = validateDesign(snapshot.design, "authoringSnapshot.design");
    const visual = manifestAssetFields(snapshot, assets, design);
    const manifest = validateManifest({
      ...BUILTIN_PDF_TEMPLATE_MANIFEST,
      id: `imported-${snapshot.snapshotDigest.slice(0, 16)}`,
      name: "Imported PDF design",
      version: "1.0.0",
      design,
      canonicalSource: {
        api: PDF_CANONICAL_SOURCE_API_V1,
        revision: PDF_CANONICAL_SOURCE_REVISION,
      },
      assetDescriptors: visual.descriptors,
      assets: visual.references,
      decorations: visual.decorations,
      provenance: undefined,
    });
    validatePdfTemplateManifest(manifest);
    const temporaryFiles = {
      ...visual.files,
      "atlcli.typ": new Uint8Array(),
    };
    const loaded = await validatePdfTemplatePack(manifest, temporaryFiles);
    const visuals: PdfTemplateVisualsV1 = {
      assets: Object.fromEntries(
        Object.entries(loaded.assets).map(([slot, value]) => [
          slot,
          { vfsPath: value.vfsPath, reference: value.reference },
        ])
      ),
      decorations: loaded.decorations,
    };
    const canonicalTypst = createAtlcliTypstTemplate(
      design,
      BUILTIN_PDF_FALLBACK_LABELS,
      visuals
    );
    const files = {
      ...visual.files,
      "atlcli.typ": encoder.encode(canonicalTypst),
    };
    return {
      manifest,
      canonicalTypst,
      runtimeSnapshot: {
        design,
        assets: Object.fromEntries(
          assets
            .map(({ slot, sha256, mediaType, accessibility, rendering }) => [
              slot,
              { sha256, mediaType, accessibility, rendering },
            ])
            .sort(([left], [right]) => String(left).localeCompare(String(right)))
        ),
      },
      files,
    };
  }
}

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer()
  );
}

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

export class CliGeneratedPdfTemplateCompiler
  implements TemplateGeneratedPackCompilerV1
{
  #compiler?: BrowserPdfCompiler;

  async #getCompiler(): Promise<BrowserPdfCompiler> {
    if (this.#compiler) return this.#compiler;
    const [wasm, ...fonts] = await Promise.all([
      packageBytes("@atlcli/pdf-compiler-browser/wasm"),
      ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
        packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
      ),
    ]);
    this.#compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
    return this.#compiler;
  }

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
    const result = await (await this.#getCompiler()).compile(bundle);
    const errors = result.diagnostics.filter(
      ({ severity }) => severity === "error"
    );
    if (!result.pdf || errors.length > 0) {
      throw new Error(
        `Generated PDF template failed its executable gate: ${JSON.stringify(errors)}`
      );
    }
    const inspection = validatePdfOutput(result.pdf);
    if (!inspection.tagged || !inspection.hasOutline) {
      throw new Error("Generated PDF template lost tagged output or outline");
    }
    return {
      digest: await sha256Hex(result.pdf),
      pageCount: 1,
    };
  }

  async reset(): Promise<void> {
    await this.#compiler?.reset();
    this.#compiler = undefined;
  }
}
