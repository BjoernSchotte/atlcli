/**
 * Shared DOCX-template intake conformance driver.
 *
 * Browser and Bun hosts call this exact function with their own real
 * PdfCompilePort. The workflow itself uses only structured-clone-safe DTOs and
 * explicit in-memory ports.
 */
import {
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
  analyzeDocxTemplateImport,
} from "@atlcli/docx-template-intake/browser";
import {
  DOCX_TEMPLATE_INTAKE_FIXTURE_BYTES,
  DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE,
} from "@atlcli/export-fixtures";
import {
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_RUNTIME_ASSETS,
  PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITIES_V1,
  PDF_TEMPLATE_CAPABILITY_DIGEST_V1,
  PDF_TEMPLATE_CAPABILITY_PRESENTATION_V1,
  PdfGeneratedTemplateProofCompiler,
  PdfTemplatePreviewCompiler,
  PdfTemplateRuntimeMaterializer,
  loadPdfTemplatePack,
  runPdfExport,
  validatePdfOutput,
  type ExportBlock,
  type PdfAssetResolver,
  type PdfCompilePort,
  type PdfOutputInspection,
  type ValidatedPdfTemplatePackV1,
} from "@atlcli/pdf/browser";
import {
  AUTHORING_MESSAGE_REGISTRY_V1,
  InMemoryTemplateAssetStore,
  InMemoryTemplateProjectRepository,
  buildGeneratedPdfTemplatePack,
  buildTemplateProject,
  createTemplateProjectState,
  projectTemplateImportView,
  reduceTemplateImportAction,
  renderTemplateProjectPreviews,
  resolveTemplateLayers,
  type TemplateDecisionContextV1,
  type TemplateDecisionStateV1,
  type TemplateImportActionV1,
  type TemplateImportProjectionInputV1,
  type TemplateImportViewV1,
  type TemplateMessageRegistryV1,
  type TemplateProjectGenerationV1,
  type TemplateProjectPreviewArtifactV1,
  type TemplateProjectStateV1,
  type TemplateRuntimeAssetV1,
} from "@atlcli/pdf-template-authoring/browser";
import { packTemplate } from "@atlcli/template-pack";
import { MemoryOutputSink } from "./memory-output.js";

const PROJECT_ID = "browser:docx-template-intake";
const IMPORTER_VERSION = "atlcli.pdf-template-import/1";
export const DOCX_TEMPLATE_INTAKE_EXPECTED_PDF_PAGES = 6;
const MESSAGE_REGISTRIES: readonly TemplateMessageRegistryV1[] = [
  AUTHORING_MESSAGE_REGISTRY_V1,
  DOCX_INTAKE_MESSAGE_REGISTRY_V1,
  DOCX_FACTS_MESSAGE_REGISTRY_V1,
  DOCX_MAPPING_MESSAGE_REGISTRY_V1,
  DOCX_VISUAL_MESSAGE_REGISTRY_V1,
];
const BASELINE_DESIGN =
  BUILTIN_PDF_TEMPLATE_MANIFEST.design as unknown as Readonly<
    Record<string, unknown>
  >;

const noAssets: PdfAssetResolver = {
  async resolve(): Promise<never> {
    throw new Error("The template-intake conformance export has no document assets.");
  },
};

const FINAL_BLOCKS: readonly ExportBlock[] = [
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Template intake proof" }],
  },
  {
    type: "paragraph",
    content: [
      {
        type: "text",
        text: "The same reviewed design is rendered by browser and Bun hosts.",
      },
    ],
  },
  { type: "pageBreak" },
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Odd page" }],
  },
  { type: "pageBreak" },
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "Even page" }],
  },
  { type: "pageBreak" },
  {
    type: "heading",
    level: 1,
    content: [{ type: "text", text: "All-page proof" }],
  },
];

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function deterministicClock(): () => number {
  let tick = 0;
  return () => tick++;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((byte, index) => byte === right[index])
  );
}

function decisionContext(
  project: TemplateProjectStateV1
): TemplateDecisionContextV1 {
  return {
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    baseline: BASELINE_DESIGN,
    catalogDigest: project.catalog.digest,
    sourceDigest: project.analysis.sourceDigest,
    importerVersion: IMPORTER_VERSION,
    mappingVersion: project.analysis.mappingVersion,
  };
}

function projection(
  generation: string,
  project: TemplateProjectStateV1,
  hasHistory: boolean
): TemplateImportProjectionInputV1 {
  return {
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
    hasHistory,
  };
}

async function resolveProject(
  project: TemplateProjectStateV1,
  decisions: TemplateDecisionStateV1
): Promise<TemplateProjectStateV1> {
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
  return clone({ ...project, decisions, snapshot });
}

async function commit(
  repository: InMemoryTemplateProjectRepository,
  project: TemplateProjectStateV1,
  current: TemplateProjectGenerationV1 | undefined
): Promise<TemplateProjectGenerationV1> {
  return repository.commit(
    clone({
      projectId: PROJECT_ID,
      expectedGeneration: current?.generation ?? null,
      analysisDigest: project.analysis.digest,
      decisions: project.decisions,
      snapshotDigest: project.snapshot.snapshotDigest,
      project,
      privateIntake: {
        schema: "atlcli.pdf-template-private-intake/1",
        source: { name: "synthetic-brand.docx", metadataOnly: false },
        assetCount: Object.keys(project.assetHandles).length,
      },
    })
  );
}

function projectView(
  generation: TemplateProjectGenerationV1,
  project: TemplateProjectStateV1,
  hasHistory: boolean
): TemplateImportViewV1 {
  return projectTemplateImportView(
    clone(projection(generation.generation, project, hasHistory))
  );
}

async function applyAction(
  repository: InMemoryTemplateProjectRepository,
  generation: TemplateProjectGenerationV1,
  project: TemplateProjectStateV1,
  action: TemplateImportActionV1
): Promise<{
  generation: TemplateProjectGenerationV1;
  project: TemplateProjectStateV1;
  view: TemplateImportViewV1;
}> {
  const history = await repository.listHistory(PROJECT_ID);
  const currentProjection = projection(
    generation.generation,
    project,
    history.length > 1
  );
  const decisions = await reduceTemplateImportAction(
    project.decisions,
    clone(action),
    {
      projection: clone(currentProjection),
      decisionContext: decisionContext(project),
    }
  );
  const nextProject = await resolveProject(project, decisions);
  const nextGeneration = await commit(repository, nextProject, generation);
  return {
    generation: nextGeneration,
    project: nextProject,
    view: projectView(nextGeneration, nextProject, true),
  };
}

function actionProjection(view: TemplateImportViewV1) {
  const projectAction = (action: TemplateImportViewV1["availableActions"][number]) => ({
    id: action.id,
    kind: action.kind,
    enabled: action.enabled,
    confirmation: action.confirmation,
    affectedItems: action.affectedItems,
    disabledReason: action.disabledReason
      ? {
          code: action.disabledReason.code,
          severity: action.disabledReason.severity,
          params: action.disabledReason.params,
        }
      : null,
  });
  return {
    generation: view.generation,
    stage: view.stage,
    summary: view.summary,
    sections: view.sections.map((section) => ({
      id: section.id,
      itemCount: section.itemCount,
      attentionCount: section.attentionCount,
      items: section.items.map((item) => ({
        id: item.id,
        semanticKey: item.semanticKey,
        state: item.state,
        actions: item.actions.map(projectAction),
      })),
    })),
    diagnostics: view.diagnostics.map(({ code, severity, params }) => ({
      code,
      severity,
      params,
    })),
    availableActions: view.availableActions.map(projectAction),
    nextActions: view.nextActions,
    preview: view.preview,
  };
}

async function runtimeAssets(
  project: TemplateProjectStateV1,
  store: InMemoryTemplateAssetStore
): Promise<readonly TemplateRuntimeAssetV1[]> {
  const accepted = project.decisions.decisions.filter(
    (
      decision
    ): decision is Extract<
      TemplateDecisionStateV1["decisions"][number],
      { kind: "accept-asset" }
    > => decision.kind === "accept-asset"
  );
  return Promise.all(
    accepted
      .sort((left, right) => left.role.localeCompare(right.role))
      .map(async (decision) => {
        const handle = project.assetHandles[decision.assetSha256];
        if (!handle) throw new Error(`Missing accepted asset ${decision.assetSha256}`);
        await store.verify(handle);
        return {
          slot: decision.role,
          sha256: decision.assetSha256,
          mediaType: handle.mediaType,
          bytes: await store.get(handle),
          accessibility: decision.accessibility,
          rendering: decision.rendering,
        };
      })
  );
}

async function compileFinal(
  compiler: PdfCompilePort,
  pack: ValidatedPdfTemplatePackV1
) {
  const output = new MemoryOutputSink();
  const report = await runPdfExport(
    {
      blocks: [...FINAL_BLOCKS],
      metadata: {
        title: "DOCX template intake conformance",
        space: "NEUTRAL",
        version: 1,
        author: "atlcli",
        exporter: "atlcli browser harness",
        language: "en",
        region: "GB",
        exportedAt: new Date("2026-07-27T00:00:00.000Z"),
      },
      settings: { cover: false, outline: true },
      templatePack: pack,
      profile: "tagged",
      filename: "DOCX Template Intake.pdf",
    },
    { assets: noAssets, compiler, output, now: deterministicClock() }
  );
  return { report, bytes: output.single.bytes };
}

export interface DocxTemplateIntakeCaseResult {
  compilerVersion: string;
  digests: Record<string, string>;
  reportNotes: Array<{ code: string; severity: string }>;
  deterministicWarmRepeat: boolean;
  parity: Readonly<Record<string, unknown>>;
}

export interface DocxTemplateIntakeFlowOutput {
  result: DocxTemplateIntakeCaseResult;
  finalPdfBytes: Uint8Array;
}

export async function runDocxTemplateIntakeFlow(
  compiler: PdfCompilePort
): Promise<DocxTemplateIntakeFlowOutput> {
  const assetStore = new InMemoryTemplateAssetStore();
  const repository = new InMemoryTemplateProjectRepository();
  const analyzed = await analyzeDocxTemplateImport(
    new Uint8Array(DOCX_TEMPLATE_INTAKE_FIXTURE_BYTES),
    {
      catalog: PDF_TEMPLATE_CAPABILITIES_V1,
      bundledFontFamilies: PDF_RUNTIME_ASSETS.fonts.map(({ family }) => family),
      assetCapabilities: PDF_TEMPLATE_ASSET_CAPABILITIES_V1,
      assetStore,
    }
  );
  if (
    analyzed.analysis.sourceDigest !==
    DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.sourceDigest
  ) {
    throw new Error("Synthetic DOCX source digest drifted from its reviewed oracle");
  }
  let project = await createTemplateProjectState({
    analysis: clone(analyzed.analysis),
    assetHandles: clone(analyzed.assetHandles),
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
  let generation = await commit(repository, project, undefined);
  const views: TemplateImportViewV1[] = [
    projectView(generation, project, false),
  ];

  const roleBySha = new Map<string, string>([
    [
      DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.background.assetSha256,
      "asset.pageBackground",
    ],
    [
      DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE.header.assetSha256,
      "asset.headerDecoration",
    ],
  ]);
  for (const asset of analyzed.privateAssetCandidates) {
    const role = roleBySha.get(asset.asset.sha256);
    if (!role) continue;
    const view = views.at(-1)!;
    const item = view.sections
      .flatMap(({ items }) => items)
      .find(({ details }) => details.candidateIds.includes(asset.candidateId));
    const descriptor = item?.actions.find(
      ({ kind }) => kind === "review-asset"
    );
    if (!descriptor?.enabled) {
      throw new Error(`Asset review is unavailable for ${asset.asset.sha256}`);
    }
    const applied = await applyAction(repository, generation, project, {
      id: descriptor.id,
      kind: "review-asset",
      candidateId: asset.candidateId,
      assetSha256: asset.asset.sha256,
      role,
      useConfirmed: true,
      rightsConfirmed: true,
      accessibility: { decorative: true },
      rendering: { kind: "slot-default" },
    });
    generation = applied.generation;
    project = applied.project;
    views.push(applied.view);
  }

  for (const kind of [
    "apply-ready",
    "keep-current-for-remaining",
    "acknowledge-inventory",
  ] as const) {
    const view = views.at(-1)!;
    const descriptor = view.availableActions.find(
      (action) => action.kind === kind
    );
    if (!descriptor?.enabled) continue;
    const applied = await applyAction(repository, generation, project, {
      id: descriptor.id,
      kind,
    });
    generation = applied.generation;
    project = applied.project;
    views.push(applied.view);
  }

  const beforePreview = views.at(-1)!;
  if (beforePreview.stage !== "ready-to-preview") {
    throw new Error(`Expected ready-to-preview, received ${beforePreview.stage}`);
  }
  const materializer = new PdfTemplateRuntimeMaterializer();
  const materialized = await materializer.materialize(
    project.snapshot,
    await runtimeAssets(project, assetStore)
  );
  const runtimePack = await loadPdfTemplatePack(
    await packTemplate({
      manifest: materialized.manifest,
      files: materialized.files,
    })
  );
  const previewCompiler = new PdfTemplatePreviewCompiler({
    compiler,
    resolveModel: async () => ({
      baseline: BUILTIN_PDF_TEMPLATE_MANIFEST,
      current: materialized.manifest,
      currentPack: runtimePack,
      reviewAssets: await Promise.all(
        analyzed.privateAssetCandidates.map(async (asset, index) => ({
          id: asset.candidateId,
          vfsPath: `review-assets/candidate-${index + 1}.svg`,
          bytes: await assetStore.get(asset.asset),
          mediaType: asset.asset.mediaType,
          occurrenceCount: asset.occurrenceCount,
          ...(asset.proposedRole ? { proposedRole: asset.proposedRole } : {}),
        }))
      ),
    }),
  });
  const rendered = await renderTemplateProjectPreviews({
    generation: generation.generation,
    snapshotDigest: project.snapshot.snapshotDigest,
    summary: beforePreview.summary,
    hasVisualCandidates: true,
    compiler: previewCompiler,
  });
  const previewAction = beforePreview.availableActions.find(
    ({ kind }) => kind === "preview"
  );
  if (!previewAction?.enabled) throw new Error("Preview action is unavailable");
  const previewed = await applyAction(repository, generation, project, {
    id: previewAction.id,
    kind: "preview",
  });
  generation = previewed.generation;
  project = previewed.project;
  const reboundPreviews = Object.fromEntries(
    Object.entries(rendered).map(([purpose, artifact]) => [
      purpose,
      { ...artifact, generation: generation.generation },
    ])
  ) as Readonly<
    Record<
      TemplateProjectPreviewArtifactV1["purpose"],
      TemplateProjectPreviewArtifactV1
    >
  >;
  for (const artifact of Object.values(reboundPreviews)) {
    await repository.putPreview(PROJECT_ID, artifact);
  }
  const readyToBuild = projectView(generation, project, true);
  views.push(readyToBuild);
  if (readyToBuild.stage !== "ready-to-build") {
    throw new Error(`Expected ready-to-build, received ${readyToBuild.stage}`);
  }

  const build = await buildTemplateProject({
    generation: generation.generation,
    project,
    catalog: project.catalog,
    baseline: project.baseline,
    view: readyToBuild,
    previews: reboundPreviews,
    assetStore,
    materializer,
  });
  const proofCompiler = new PdfGeneratedTemplateProofCompiler(compiler);
  const firstPack = await buildGeneratedPdfTemplatePack(build, proofCompiler);
  const secondPack = await buildGeneratedPdfTemplatePack(build, proofCompiler);
  if (!equalBytes(firstPack.bytes, secondPack.bytes)) {
    throw new Error("Generated template pack was not byte-identical on warm repeat");
  }
  const finalRuntime = await loadPdfTemplatePack(firstPack.bytes);
  const firstPdf = await compileFinal(compiler, finalRuntime);
  const secondPdf = await compileFinal(compiler, finalRuntime);
  const deterministicWarmRepeat = equalBytes(firstPdf.bytes, secondPdf.bytes);
  if (!deterministicWarmRepeat) {
    throw new Error("Generated template PDF was not byte-identical on warm repeat");
  }
  const inspection: PdfOutputInspection = validatePdfOutput(firstPdf.bytes);
  if (
    inspection.pageCount !== DOCX_TEMPLATE_INTAKE_EXPECTED_PDF_PAGES ||
    !inspection.tagged ||
    !inspection.hasOutline ||
    inspection.embeddedFontFiles < 1
  ) {
    throw new Error(
      `Final PDF failed page, tag, outline, or embedded-font proof: ${JSON.stringify(
        inspection
      )}`
    );
  }

  const selectedScenes = (analyzed.visualAnalysis?.scenes ?? []).map((scene) => {
    const selected = scene.representations.find(({ selected }) => selected);
    const sourceUse = selected?.sourceUse;
    return {
      assetSha256: selected?.assetSha256,
      relationshipRef:
        sourceUse?.kind === "relationship"
          ? sourceUse.relationshipRef
          : undefined,
      targetFingerprint:
        sourceUse?.kind === "relationship"
          ? sourceUse.targetFingerprint
          : undefined,
      alternateBranch: sourceUse?.alternateContent?.branch ?? "",
      crop: scene.transform?.crop ?? null,
      horizontalReference:
        scene.placement?.kind === "anchor"
          ? scene.placement.horizontal.relativeFrom
          : "",
      verticalReference:
        scene.placement?.kind === "anchor"
          ? scene.placement.vertical.relativeFrom
          : "",
      section: scene.scope.section,
      master: scene.scope.master ?? "",
    };
  });
  const acceptedDecisions = project.decisions.decisions
    .filter(
      (
        decision
      ): decision is Extract<
        TemplateDecisionStateV1["decisions"][number],
        { kind: "accept-asset" }
      > => decision.kind === "accept-asset"
    )
    .map((decision) => ({
      semanticKey: decision.semanticKey,
      assetSha256: decision.assetSha256,
      role: decision.role,
      rightsConfirmed: decision.rightsConfirmed,
      decorative: decision.accessibility.decorative,
      rendering: decision.rendering,
    }));
  const previewMetadata = Object.fromEntries(
    Object.entries(reboundPreviews).map(([purpose, artifact]) => [
      purpose,
      {
        pageCount: artifact.pageCount,
        regions: artifact.regions,
      },
    ])
  );
  const pdfDigest = await sha256(firstPdf.bytes);
  const packDigest = await sha256(firstPack.bytes);
  const digests = {
    "analysis.json": analyzed.analysis.digest,
    "snapshot.json": project.snapshot.snapshotDigest,
    "template.wiki-pdf-template": packDigest,
    "template.pdf": pdfDigest,
  };
  const parity = clone({
    sourceDigest: analyzed.analysis.sourceDigest,
    analysisDigest: analyzed.analysis.digest,
    views: views.map(actionProjection),
    snapshotDigest: project.snapshot.snapshotDigest,
    previewMetadata,
    runtimeSnapshot: materialized.runtimeSnapshot,
    runtimeSnapshotDigest: await sha256(
      new TextEncoder().encode(JSON.stringify(materialized.runtimeSnapshot))
    ),
    pack: {
      digest: packDigest,
      compile: firstPack.compile,
      entry: firstPack.bytes.byteLength > 0 ? "atlcli.typ" : "",
      assets: Object.entries(materialized.manifest.assets ?? {})
        .map(([slot, reference]) => {
          const descriptor =
            materialized.manifest.assetDescriptors?.[reference.descriptor];
          return {
            slot,
            descriptor: reference.descriptor,
            sha256: descriptor?.sha256,
            path: descriptor?.path,
          };
        })
        .sort((left, right) => left.slot.localeCompare(right.slot)),
    },
    pdf: {
      digest: pdfDigest,
      ...inspection,
    },
    proofChain: {
      oracle: DOCX_TEMPLATE_INTAKE_FIXTURE_ORACLE,
      scenes: selectedScenes,
      decisions: acceptedDecisions,
      runtimeAssets: materialized.runtimeSnapshot.assets,
      packAssets: materialized.manifest.assetDescriptors,
      renderedPages: Array.from(
        { length: DOCX_TEMPLATE_INTAKE_EXPECTED_PDF_PAGES },
        (_, index) => index + 1
      ),
    },
  });
  return {
    result: {
      compilerVersion: firstPdf.report.compilerVersion,
      digests,
      reportNotes: firstPdf.report.notes.map(({ code, level }) => ({
        code,
        severity: level,
      })),
      deterministicWarmRepeat,
      parity,
    },
    finalPdfBytes: new Uint8Array(firstPdf.bytes),
  };
}
