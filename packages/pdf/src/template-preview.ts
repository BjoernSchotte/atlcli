/**
 * PDF implementation of the host-neutral TemplatePreviewCompiler port.
 *
 * The adapter receives structured request data and resolves the corresponding
 * runtime model through an injected function. It returns bytes and typed
 * page/region references; it never observes project paths, terminal state, DOM
 * nodes, or browser storage.
 */
import type {
  TemplatePreviewCompiler,
  TemplatePreviewRegionReferenceV1,
  TemplatePreviewRequestV1,
  TemplatePreviewResultV1,
} from "@atlcli/pdf-template-authoring";
import type { TemplateManifest } from "@atlcli/template-pack";
import type { PdfCompilePort } from "./compiler.js";
import { typstString } from "./escape.js";
import { preparePdfDocument } from "./prepare.js";
import { serializePdfDocument } from "./serialize.js";
import { createAtlcliTypstTemplate } from "./template.js";
import type {
  ValidatedPdfTemplatePackV1,
} from "./template-pack.js";
import type {
  PdfSourceBundle,
  PreparedPdfAsset,
} from "./types.js";
import { validatePdfOutput } from "./validate.js";

export interface PdfTemplatePreviewModelV1 {
  baseline: TemplateManifest;
  current: TemplateManifest;
  /** Present when accepted visual assets/decorations belong in the preview. */
  currentPack?: ValidatedPdfTemplatePackV1;
}

export interface PdfTemplatePreviewCompilerOptionsV1 {
  compiler: PdfCompilePort;
  resolveModel(
    request: TemplatePreviewRequestV1
  ): Promise<PdfTemplatePreviewModelV1>;
}

export class PdfTemplatePreviewError extends Error {
  constructor(
    readonly code:
      | "compile-failed"
      | "invalid-model"
      | "missing-summary"
      | "no-contact-assets",
    message: string
  ) {
    super(message);
    this.name = "PdfTemplatePreviewError";
  }
}

function visualAssets(
  pack: ValidatedPdfTemplatePackV1 | undefined
): PreparedPdfAsset[] {
  const byPath = new Map<string, PreparedPdfAsset>();
  for (const asset of Object.values(pack?.assets ?? {})) {
    if (!asset || byPath.has(asset.vfsPath)) continue;
    byPath.set(asset.vfsPath, {
      path: asset.vfsPath,
      bytes: new Uint8Array(asset.bytes),
      mediaType: asset.descriptor.mediaType,
    });
  }
  return [...byPath.values()].sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

function visuals(
  pack: ValidatedPdfTemplatePackV1 | undefined
): Parameters<typeof createAtlcliTypstTemplate>[2] {
  if (!pack) return undefined;
  return {
    assets: Object.fromEntries(
      Object.entries(pack.assets).map(([slot, asset]) => [
        slot,
        { vfsPath: asset!.vfsPath, reference: asset!.reference },
      ])
    ),
    decorations: pack.decorations,
  };
}

function paper(manifest: TemplateManifest): string {
  return manifest.design?.page.size === "letter" ? "us-letter" : "a4";
}

function pageFlip(manifest: TemplateManifest): boolean {
  return manifest.design?.page.orientation === "landscape";
}

function requiredDesign(manifest: TemplateManifest): NonNullable<TemplateManifest["design"]> {
  if (!manifest.design) {
    throw new PdfTemplatePreviewError(
      "invalid-model",
      `Preview manifest "${manifest.id}" has no complete design`
    );
  }
  return manifest.design;
}

function previewTemplate(model: PdfTemplatePreviewModelV1): string {
  const current = requiredDesign(model.current);
  return createAtlcliTypstTemplate(
    current,
    {},
    visuals(model.currentPack)
  );
}

function basePageSource(model: PdfTemplatePreviewModelV1): string {
  const current = requiredDesign(model.current);
  const margin = current.page.margin;
  return `#import "atlcli.typ": template-page-decorations, template-header-decorations, template-footer-decorations
#set document(title: "PDF template preview", author: "atlcli")
#set text(font: ${typstString(current.typography.fonts.body)}, size: ${current.typography.roles.body!.size}, fill: rgb(${typstString(current.tokens.colors.ink)}), lang: "en")
#set page(
  paper: ${typstString(paper(model.current))},
  flipped: ${pageFlip(model.current) ? "true" : "false"},
  fill: rgb(${typstString(current.tokens.colors.paper)}),
  margin: (top: ${margin.top}, right: ${margin.right}, bottom: ${margin.bottom}, left: ${margin.left}),
  background: template-page-decorations(),
  header: template-header-decorations(),
  footer: template-footer-decorations(),
)
`;
}

function summaryRows(
  summary: NonNullable<TemplatePreviewRequestV1["summary"]>
): string {
  return [
    ["Ready to apply", summary.readyToApply],
    ["Needs review", summary.needsReview],
    ["Cannot transfer", summary.cannotTransfer],
    ["Blockers", summary.blockers],
    ["Unanswered", summary.unanswered],
  ]
    .map(
      ([label, value]) =>
        `[${label}], [#text(weight: "bold")[${value}]]`
    )
    .join(",\n    ");
}

function designReviewBundle(
  request: TemplatePreviewRequestV1,
  model: PdfTemplatePreviewModelV1
): PdfSourceBundle {
  if (!request.summary) {
    throw new PdfTemplatePreviewError(
      "missing-summary",
      "A design-review preview requires the exact TemplateImportViewV1 summary"
    );
  }
  const baseline = requiredDesign(model.baseline);
  const current = requiredDesign(model.current);
  const baselineFont = baseline.typography.fonts.body;
  const currentFont = current.typography.fonts.body;
  const baselineAccent = baseline.branding.accent;
  const currentAccent = current.branding.accent;
  const baselinePage = `${baseline.page.size} / ${baseline.page.orientation}`;
  const currentPage = `${current.page.size} / ${current.page.orientation}`;
  const main = `${basePageSource(model)}
= Design review

This preview compares the selected baseline with the current draft. Counts are
copied from the same import view used by every host.

#table(
  columns: (1fr, auto),
  inset: 6pt,
  stroke: 0.5pt + rgb("#D8DCE3"),
  [Choice status], [Count],
  ${summaryRows(request.summary)},
)

#pagebreak()

= Baseline and current

#grid(
  columns: (1fr, 1fr),
  gutter: 12pt,
  [
    *Baseline*
    #v(8pt)
    #rect(width: 100%, height: 12mm, fill: rgb(${typstString(baselineAccent)}))
    #v(8pt)
    #text(font: ${typstString(baselineFont)}, size: ${baseline.typography.roles.body!.size})[
      Short sample. The quick brown fox jumps over the lazy dog.

      Long sample: a realistic paragraph demonstrates line length, rhythm,
      punctuation, and hierarchy without exposing source-document content.
    ]
    #v(8pt)
    Page: ${baselinePage}
    Margins: ${baseline.page.margin.top} / ${baseline.page.margin.right} /
    ${baseline.page.margin.bottom} / ${baseline.page.margin.left}
  ],
  [
    *Current draft*
    #v(8pt)
    #rect(width: 100%, height: 12mm, fill: rgb(${typstString(currentAccent)}))
    #v(8pt)
    #text(font: ${typstString(currentFont)}, size: ${current.typography.roles.body!.size})[
      Short sample. The quick brown fox jumps over the lazy dog.

      Long sample: a realistic paragraph demonstrates line length, rhythm,
      punctuation, and hierarchy without exposing source-document content.
    ]
    #v(8pt)
    Page: ${currentPage}
    Margins: ${current.page.margin.top} / ${current.page.margin.right} /
    ${current.page.margin.bottom} / ${current.page.margin.left}
  ],
)
`;
  return {
    main,
    template: previewTemplate(model),
    assets: visualAssets(model.currentPack),
    sourceMap: [],
    notes: [],
  };
}

async function compatibilityBundle(
  model: PdfTemplatePreviewModelV1
): Promise<PdfSourceBundle> {
  const prepared = await preparePdfDocument(
    [
      {
        type: "heading",
        level: 1,
        content: [{ type: "text", text: "Compatibility proof" }],
      },
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text: "Neutral semantic content exercises headings, paragraphs, tables, code, and page transitions.",
          },
        ],
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
                    content: [{ type: "text", text: "Capability" }],
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
                    content: [{ type: "text", text: "Template API" }],
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
                    content: [{ type: "text", text: "Pass" }],
                  },
                ],
              },
            ],
          },
        ],
      },
      {
        type: "codeBlock",
        language: "typescript",
        code: "const portable = true;",
      },
      { type: "pageBreak" },
      {
        type: "heading",
        level: 1,
        content: [{ type: "text", text: "Page transition" }],
      },
    ],
    {
      resolve: async () => {
        throw new Error("compatibility proof has no document assets");
      },
    }
  );
  return serializePdfDocument(prepared, {
    metadata: {
      title: "Compatibility proof",
      space: "PREVIEW",
      version: 1,
      author: "atlcli",
      language: "en",
      exportedAt: new Date("2026-01-01T00:00:00.000Z"),
    },
    settings: { cover: false, outline: true },
    ...(model.currentPack
      ? { templatePack: model.currentPack }
      : { templateManifest: model.current }),
  });
}

function contactSheetBundle(
  model: PdfTemplatePreviewModelV1
): PdfSourceBundle {
  const assets = Object.values(model.currentPack?.assets ?? {}).filter(
    (asset): asset is NonNullable<typeof asset> => asset !== undefined
  );
  if (assets.length === 0) {
    throw new PdfTemplatePreviewError(
      "no-contact-assets",
      "An asset contact sheet requires at least one verified visual asset"
    );
  }
  const cells = assets
    .sort((left, right) => left.slot.localeCompare(right.slot))
    .map(
      (asset, index) => `[
  #figure(
    image(${typstString(asset.vfsPath)}, width: 55mm, height: 35mm, fit: "contain"),
    caption: [Candidate ${index + 1}],
    alt: ${typstString(`Preview of candidate ${index + 1}`)},
    outlined: false,
  )
  #text(size: 8pt)[Role: ${asset.slot}; occurrences: 1]
]`
    )
    .join(",\n");
  return {
    main: `${basePageSource(model)}
= Asset contact sheet

The sheet contains verified local candidates only. It includes no source paths,
document text, relationship identifiers, or source alt text.

#grid(columns: (1fr, 1fr), gutter: 10pt, ${cells})
`,
    template: previewTemplate(model),
    assets: visualAssets(model.currentPack),
    sourceMap: [],
    notes: [],
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export class PdfTemplatePreviewCompiler implements TemplatePreviewCompiler {
  constructor(private readonly options: PdfTemplatePreviewCompilerOptionsV1) {}

  async render(
    request: TemplatePreviewRequestV1
  ): Promise<TemplatePreviewResultV1> {
    const model = await this.options.resolveModel(request);
    if (
      model.currentPack &&
      model.currentPack.manifest.id !== model.current.id
    ) {
      throw new PdfTemplatePreviewError(
        "invalid-model",
        "Current manifest and resolved pack do not describe the same template"
      );
    }
    const bundle =
      request.purpose === "design-review"
        ? designReviewBundle(request, model)
        : request.purpose === "asset-contact-sheet"
          ? contactSheetBundle(model)
          : await compatibilityBundle(model);
    const compiled = await this.options.compiler.compile(bundle);
    const errors = compiled.diagnostics.filter(
      ({ severity }) => severity === "error"
    );
    if (!compiled.pdf || errors.length > 0) {
      throw new PdfTemplatePreviewError(
        "compile-failed",
        `Template preview did not compile (${errors
          .map(({ message }) => message)
          .join("; ") || "no PDF bytes"})`
      );
    }
    const inspection = validatePdfOutput(compiled.pdf);
    const regions: TemplatePreviewRegionReferenceV1[] =
      request.purpose === "design-review"
        ? [
            { page: 1, region: "summary" },
            { page: 2, region: "baseline" },
            { page: 2, region: "current" },
          ]
        : request.purpose === "asset-contact-sheet"
          ? [{ page: 1, region: "asset-grid" }]
          : [{ page: 1, region: "feature-zoo" }];
    return {
      digest: await sha256Hex(compiled.pdf),
      mediaType: "application/pdf",
      byteLength: compiled.pdf.byteLength,
      pageCount: inspection.pageCount,
      regions,
      output: { kind: "bytes", bytes: compiled.pdf },
    };
  }
}
