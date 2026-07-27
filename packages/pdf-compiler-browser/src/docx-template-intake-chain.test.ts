/**
 * Independent real-editor proof chain:
 * DOCX oracle -> scene -> explicit asset decision -> resolved snapshot ->
 * generated pack descriptor -> rendered PDF pixel bounds.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
  analyzeDocxTemplateImport,
} from "@atlcli/docx-template-intake";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
  PdfTemplateRuntimeMaterializer,
  isPdfBytesHandle,
  loadPdfTemplatePack,
  runPdfExport,
  validatePdfOutput,
  type PdfBytesHandle,
  type PdfTemplateRuntimeV1,
} from "@atlcli/pdf";
import {
  AUTHORING_MESSAGE_REGISTRY_V1,
  InMemoryTemplateAssetStore,
  createTemplateProjectState,
  projectTemplateImportView,
  reduceTemplateImportAction,
  resolveTemplateLayers,
  type TemplateMessageRegistryV1,
} from "@atlcli/pdf-template-authoring";
import { packTemplate } from "@atlcli/template-pack";
import { REAL_VISUAL_FIXTURE_ORACLES } from "../../docx-template-intake/src/fixtures/visual-oracles.js";
import {
  compareVisualOracle,
  projectVisualOracle,
} from "../../docx-template-intake/src/visual-oracle.js";
import { ensurePdfFonts } from "../../pdf/scripts/ensure-fonts.js";
import { ensureVendoredTypst } from "../scripts/vendor-typst.js";
import { BrowserPdfCompiler } from "./index.js";

const BASELINE_DESIGN =
  BUILTIN_PDF_TEMPLATE_MANIFEST.design as unknown as Readonly<
    Record<string, unknown>
  >;
const MESSAGE_REGISTRIES: readonly TemplateMessageRegistryV1[] = [
  AUTHORING_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
];
const FIXTURE_DIRECTORY = resolve(
  import.meta.dir,
  "../../docx-template-intake/src/fixtures"
);
const EXPECTED_CANDIDATE_COUNTS = {
  "neutral-word-16.111.1.docx": {
    safe: 0,
    review: 7,
    blocked: 9,
    openAfterBackgroundDecision: 6,
  },
  "neutral-libreoffice-7.1.1.2.docx": {
    safe: 3,
    review: 5,
    blocked: 9,
    openAfterBackgroundDecision: 7,
  },
} as const;
let compiler: BrowserPdfCompiler;

async function packageBytes(specifier: string): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(
    await Bun.file(fileURLToPath(import.meta.resolve(specifier))).arrayBuffer()
  );
}

beforeAll(async () => {
  await ensurePdfFonts({ logger: () => {} });
  await ensureVendoredTypst();
  const [wasm, ...fonts] = await Promise.all([
    packageBytes("@atlcli/pdf-compiler-browser/wasm"),
    ...PDF_RUNTIME_ASSETS.fonts.map((font) =>
      packageBytes(`@atlcli/pdf/fonts/${font.fileName}`)
    ),
  ]);
  compiler = new BrowserPdfCompiler({ wasm: wasm.buffer, fonts });
});

afterAll(async () => {
  await compiler?.reset();
});

class Sink {
  bytes?: Uint8Array;

  async emit(_name: string, value: Uint8Array | PdfBytesHandle): Promise<void> {
    this.bytes = isPdfBytesHandle(value)
      ? await value.asUint8Array()
      : new Uint8Array(value);
  }
}

interface Ppm {
  width: number;
  height: number;
  pixels: Uint8Array;
}

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    throw new Error(`${label} must be an object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function parsePpm(bytes: Uint8Array): Ppm {
  let offset = 0;
  const token = (): string => {
    while ([0x20, 0x0a, 0x0d].includes(bytes[offset] ?? -1)) offset += 1;
    const start = offset;
    while (
      offset < bytes.length &&
      ![0x20, 0x0a, 0x0d].includes(bytes[offset] ?? -1)
    ) {
      offset += 1;
    }
    return new TextDecoder().decode(bytes.subarray(start, offset));
  };
  if (token() !== "P6") throw new Error("Expected a Poppler PPM page");
  const width = Number(token());
  const height = Number(token());
  if (token() !== "255") throw new Error("Expected 8-bit Poppler pixels");
  while ([0x20, 0x0a, 0x0d].includes(bytes[offset] ?? -1)) offset += 1;
  return { width, height, pixels: bytes.subarray(offset) };
}

async function raster(pdf: Uint8Array): Promise<Ppm> {
  const directory = await mkdtemp(join(tmpdir(), "atlcli-intake-chain-"));
  try {
    const input = join(directory, "proof.pdf");
    const prefix = join(directory, "page");
    await Bun.write(input, pdf);
    const process = Bun.spawn(["pdftoppm", "-f", "1", "-singlefile", "-r", "36", input, prefix], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await process.exited) !== 0) {
      throw new Error(await new Response(process.stderr).text());
    }
    const file = (await readdir(directory)).find((name) => name.endsWith(".ppm"));
    if (!file) throw new Error("Poppler produced no raster page");
    return parsePpm(
      new Uint8Array(await Bun.file(join(directory, file)).arrayBuffer())
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function changedPixelBounds(
  baseline: Ppm,
  imported: Ppm
): { populated: boolean; coverage: number; bbox: [number, number, number, number] } {
  if (
    baseline.width !== imported.width ||
    baseline.height !== imported.height
  ) {
    throw new Error("Raster dimensions differ");
  }
  let changed = 0;
  let minX = baseline.width;
  let minY = baseline.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < baseline.height; y += 1) {
    for (let x = 0; x < baseline.width; x += 1) {
      const index = (y * baseline.width + x) * 3;
      const difference =
        Math.abs(baseline.pixels[index]! - imported.pixels[index]!) +
        Math.abs(baseline.pixels[index + 1]! - imported.pixels[index + 1]!) +
        Math.abs(baseline.pixels[index + 2]! - imported.pixels[index + 2]!);
      if (difference <= 24) continue;
      changed += 1;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return {
    populated: changed > 0,
    coverage: changed / (baseline.width * baseline.height),
    bbox: [minX, minY, maxX, maxY],
  };
}

async function compile(pack?: PdfTemplateRuntimeV1): Promise<Uint8Array> {
  const sink = new Sink();
  await runPdfExport(
    {
      blocks: [
        {
          type: "heading",
          level: 1,
          content: [{ type: "text", text: "Real editor fixture" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Independent visual chain." }],
        },
      ],
      metadata: {
        title: "Real editor fixture proof",
        space: "NEUTRAL",
        version: 1,
        author: "atlcli",
        language: "en",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: false, outline: true },
      ...(pack ? { templatePack: pack } : {}),
      profile: "tagged",
      filename: "real-editor-proof.pdf",
    },
    {
      assets: {
        async resolve(): Promise<never> {
          throw new Error("The proof document has no document assets");
        },
      },
      compiler,
      output: sink,
      now: (() => {
        let tick = 0;
        return () => tick++;
      })(),
    }
  );
  if (!sink.bytes) throw new Error("PDF output was not emitted");
  return sink.bytes;
}

describe("real Word and LibreOffice DOCX-to-render chain", () => {
  for (const [fixture, expectedOracle] of Object.entries(
    REAL_VISUAL_FIXTURE_ORACLES
  )) {
    it(`${fixture} preserves the reviewed oracle through an explicit background decision and rendered bbox`, async () => {
      const bytes = new Uint8Array(
        await Bun.file(resolve(FIXTURE_DIRECTORY, fixture)).arrayBuffer()
      );
      const store = new InMemoryTemplateAssetStore();
      const intake = await analyzeDocxTemplateImport(bytes, {
        catalog: PDF_TEMPLATE_CAPABILITIES_V1,
        bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(({ family }) => family),
        assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
        assetStore: store,
      });
      expect(
        compareVisualOracle(
          expectedOracle,
          projectVisualOracle(intake.visualAnalysis!)
        )
      ).toEqual([]);
      const oracle = expectedOracle[0]!;
      const privateAsset = intake.privateAssetCandidates.find(
        ({ asset }) => asset.sha256 === oracle.assetSha256
      );
      if (!privateAsset) throw new Error("Reviewed fixture asset is unavailable");
      let project = await createTemplateProjectState({
        analysis: intake.analysis,
        assetHandles: intake.assetHandles,
        catalog: {
          id: PDF_TEMPLATE_CAPABILITIES_V1.id,
          version: PDF_TEMPLATE_CAPABILITIES_V1.version,
          digest: PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
          descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
        },
        baseline: {
          id: BUILTIN_PDF_TEMPLATE_MANIFEST.id,
          version: BUILTIN_PDF_TEMPLATE_MANIFEST.version,
          design: BASELINE_DESIGN,
        },
      });
      const generation = `fixture:${fixture}`;
      const projection = {
        generation,
        analysisDigest: project.analysis.digest,
        baseline: BASELINE_DESIGN,
        candidates: project.analysis.candidates,
        decisions: project.decisions,
        snapshot: project.snapshot,
        catalog: PDF_TEMPLATE_CAPABILITIES_V1,
        presentation: PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
        messageRegistries: MESSAGE_REGISTRIES,
        diagnostics: project.analysis.diagnostics,
        inventoryDiagnosticCodes: project.analysis.inventoryDiagnosticCodes,
        previewDigest: project.snapshot.snapshotDigest,
        hasHistory: false,
      };
      const view = projectTemplateImportView(projection);
      const expectedCounts =
        EXPECTED_CANDIDATE_COUNTS[
          fixture as keyof typeof EXPECTED_CANDIDATE_COUNTS
        ];
      expect(
        project.analysis.candidates.filter(
          ({ adoption }) => adoption === "safe"
        )
      ).toHaveLength(expectedCounts.safe);
      expect(
        project.analysis.candidates.filter(
          ({ adoption }) => adoption === "review"
        )
      ).toHaveLength(expectedCounts.review);
      expect(
        project.analysis.candidates.filter(
          ({ adoption }) => adoption === "blocked"
        )
      ).toHaveLength(expectedCounts.blocked);
      const item = view.sections
        .flatMap(({ items }) => items)
        .find(({ details }) =>
          details.candidateIds.includes(privateAsset.candidateId)
        );
      const action = item?.actions.find(
        ({ kind }) => kind === "review-asset"
      );
      expect(action?.enabled).toBe(true);
      const decisions = await reduceTemplateImportAction(
        project.decisions,
        {
          id: action!.id,
          kind: "review-asset",
          candidateId: privateAsset.candidateId,
          assetSha256: privateAsset.asset.sha256,
          role: "asset.pageBackground",
          useConfirmed: true,
          rightsConfirmed: true,
          accessibility: { decorative: true },
          rendering: { kind: "slot-default" },
        },
        {
          projection,
          decisionContext: {
            catalog: PDF_TEMPLATE_CAPABILITIES_V1,
            baseline: BASELINE_DESIGN,
            catalogDigest: project.catalog.digest,
            sourceDigest: project.analysis.sourceDigest,
            importerVersion: "atlcli.pdf-template-import/1",
            mappingVersion: project.analysis.mappingVersion,
          },
        }
      );
      const snapshot = await resolveTemplateLayers({
        catalog: PDF_TEMPLATE_CAPABILITIES_V1,
        catalogDigest: project.catalog.digest,
        baseline: {
          id: project.baseline.id,
          version: project.baseline.version,
          design: BASELINE_DESIGN,
        },
        sourceDigest: project.analysis.sourceDigest,
        decisions,
        candidates: project.analysis.candidates,
        mappingVersion: project.analysis.mappingVersion,
      });
      project = structuredClone({ ...project, decisions, snapshot });
      const decidedView = projectTemplateImportView({
        ...projection,
        decisions: project.decisions,
        snapshot: project.snapshot,
      });
      expect(decidedView.summary.unanswered).toBe(
        expectedCounts.openAfterBackgroundDecision
      );
      const accepted = project.decisions.decisions.find(
        (decision) => decision.kind === "accept-asset"
      );
      if (!accepted || accepted.kind !== "accept-asset") {
        throw new Error("Asset decision was not recorded");
      }
      expect(accepted).toMatchObject({
        assetSha256: oracle.assetSha256,
        role: "asset.pageBackground",
        useConfirmed: true,
        rightsConfirmed: true,
        accessibility: { decorative: true },
      });
      expect(project.snapshot.assets["asset.pageBackground"]).toMatchObject({
        assetSha256: oracle.assetSha256,
      });
      const assetBytes = await store.get(privateAsset.asset);
      const materialized = await new PdfTemplateRuntimeMaterializer().materialize(
        project.snapshot,
        [
          {
            slot: "asset.pageBackground",
            sha256: oracle.assetSha256,
            mediaType: privateAsset.asset.mediaType,
            bytes: assetBytes,
            accessibility: { decorative: true },
            rendering: { kind: "slot-default" },
          },
        ]
      );
      const reference =
        materialized.manifest.assets?.["asset.pageBackground"];
      const descriptor = reference
        ? materialized.manifest.assetDescriptors?.[reference.descriptor]
        : undefined;
      expect(descriptor).toMatchObject({
        sha256: oracle.assetSha256,
        mediaType: privateAsset.asset.mediaType,
      });
      const runtime = await loadPdfTemplatePack(
        await packTemplate({
          manifest: materialized.manifest,
          files: materialized.files,
        })
      );
      const [baselinePdf, importedPdf] = await Promise.all([
        compile(),
        compile(runtime),
      ]);
      expect(validatePdfOutput(importedPdf)).toMatchObject({
        tagged: true,
        hasOutline: true,
        pageCount: 3,
      });
      const [baselineRaster, importedRaster] = await Promise.all([
        raster(baselinePdf),
        raster(importedPdf),
      ]);
      const rendered = changedPixelBounds(baselineRaster, importedRaster);
      expect(rendered.populated).toBe(true);
      expect(rendered.coverage).toBeGreaterThan(0.2);
      expect(rendered.bbox[0]).toBeLessThan(rendered.bbox[2]);
      expect(rendered.bbox[1]).toBeLessThan(rendered.bbox[3]);

      const runtimeBackground = record(
        record(materialized.runtimeSnapshot.assets, "runtime assets")[
          "asset.pageBackground"
        ],
        "runtime page background"
      );
      const proofChain = {
        oracle,
        scene: projectVisualOracle(intake.visualAnalysis!)[0],
        decision: {
          assetSha256: accepted.assetSha256,
          role: accepted.role,
        },
        runtimeSnapshot: runtimeBackground,
        packEntry: descriptor,
        rendered: { page: 1, ...rendered },
      };
      expect(proofChain.scene).toEqual(proofChain.oracle);
      expect(proofChain.decision.assetSha256).toBe(
        proofChain.oracle.assetSha256
      );
      expect(proofChain.runtimeSnapshot.sha256).toBe(
        proofChain.oracle.assetSha256
      );
      expect(proofChain.packEntry?.sha256).toBe(
        proofChain.oracle.assetSha256
      );
    }, 120_000);
  }
});
