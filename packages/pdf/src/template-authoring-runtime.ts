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
  type WikiPdfTemplateDesignV1,
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
  generateCanonicalPdfTemplateSourceV1,
  clonePdfTemplateRuntime,
  validatePdfTemplateManifest,
  validatePdfTemplatePack,
  type PdfTemplateVisualsV1,
} from "./template-pack.js";
import { loadPdfTemplatePack } from "./template-pack.js";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";
import type { ExportBlock } from "./types.js";
import { validatePdfOutput } from "./validate.js";
import {
  PDF_DOCX_TEMPLATE_ASSET_IDENTITY_V1,
  materializePdfTemplateAssetFields,
  pdfTemplateAssetExtension,
  sha256PdfTemplateBytes,
} from "./template-assets.js";

const encoder = new TextEncoder();

export const PDF_COMPOSITION_PROOF_TITLES_V1 = [
  "Template proof",
  "A declarative template compatibility proof for complex documents",
  "A deliberately extensive declarative template compatibility proof for complex cross-functional documents and long page titles",
] as const;

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
    const visual = materializePdfTemplateAssetFields(
      assets,
      design,
      PDF_DOCX_TEMPLATE_ASSET_IDENTITY_V1
    );
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
                .replace(/[._]+/g, "-")}.${pdfTemplateAssetExtension(
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
    const loadedPack = await loadPdfTemplatePack(input.packBytes);
    const compositionProof = loadedPack.canonicalSource.revision === "4";
    const pack = compositionProof
      ? clonePdfTemplateRuntime(loadedPack)
      : loadedPack;
    if (compositionProof) {
      // Exercise dormant composition code even when the recipe selects a
      // disabled-by-default cover or closing page. The canonical source is
      // unchanged: both feature flags are runtime settings.
      const manifestDesign = pack.manifest.design as WikiPdfTemplateDesignV1;
      const snapshotDesign = pack.runtimeSnapshot.design as WikiPdfTemplateDesignV1;
      manifestDesign.features.cover.enabled = true;
      manifestDesign.features.closingPage.enabled = true;
      snapshotDesign.features.cover.enabled = true;
      snapshotDesign.features.closingPage.enabled = true;
    }
    const prepared = await preparePdfDocument([...NEUTRAL_FEATURE_ZOO], {
      resolve: async () => {
        throw new Error("Neutral template feature zoo has no document assets");
      },
    });
    const titles = compositionProof
      ? PDF_COMPOSITION_PROOF_TITLES_V1
      : (["Template compatibility proof"] as const);
    let primary:
      | TemplateGeneratedPackCompileResultV1
      | undefined;
    for (const title of titles) {
      const bundle = serializePdfDocument(prepared, {
        metadata: {
          title,
          space: "NEUTRAL",
          version: 1,
          author: "atlcli",
          language: "en",
          exportedAt: new Date("2026-07-27T00:00:00.000Z"),
        },
        settings: {
          cover: compositionProof,
          outline: true,
        },
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
      primary ??= {
        digest: await sha256PdfTemplateBytes(result.pdf),
        pageCount: inspection.pageCount,
      };
    }
    return primary!;
  }
}
