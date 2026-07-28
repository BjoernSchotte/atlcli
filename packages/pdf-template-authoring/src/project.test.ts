import { describe, expect, test } from "bun:test";
import { sha256Hex } from "@atlcli/core";
import {
  BUILTIN_PDF_DESIGN,
  BUILTIN_PDF_TEMPLATE_MANIFEST,
  PDF_TEMPLATE_CAPABILITIES_V1,
} from "@atlcli/pdf/internal";
import {
  canonicalCapabilityJson,
  computeCapabilityCatalogDigest,
  packTemplate,
  unpackTemplate,
  type TemplateManifest,
} from "@atlcli/template-pack";
import { templateProjectRepositoryContract } from "../test/repository-contract.js";
import {
  AUTHORING_RESOLUTION_SCHEMA_V1,
  TEMPLATE_CANDIDATE_SCHEMA_V1,
  TEMPLATE_DECISION_STATE_SCHEMA_V1,
  TEMPLATE_IMPORT_VIEW_SCHEMA_V1,
  TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
  TEMPLATE_PROJECT_STATE_SCHEMA_V1,
  InMemoryTemplateAssetStore,
  InMemoryTemplatePreviewCompiler,
  InMemoryTemplateProjectRepository,
  TemplateProjectBuildError,
  buildGeneratedPdfTemplatePack,
  buildTemplateProject,
  prepareTemplateProjectUndo,
  reanalyzeTemplateProject,
  renderTemplateProjectPreviews,
  resolveTemplateLayers,
  type AuthoringResolutionSnapshotV1,
  type BuildTemplateProjectInputV1,
  type TemplateCandidateV1,
  type TemplateDecisionStateV1,
  type TemplateGeneratedPackCompilerV1,
  type TemplateImportViewV1,
  type TemplateProjectAnalysisV1,
  type TemplateProjectBuildFailureCodeV1,
  type TemplateProjectPreviewArtifactV1,
  type TemplateProjectStateV1,
  type TemplateRuntimeAssetV1,
  type TemplateRuntimeMaterializer,
} from "./index.browser.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const baselineDesign = BUILTIN_PDF_DESIGN as unknown as Readonly<
  Record<string, unknown>
>;

let catalogDigest = "";
let baselineDigest = "";

async function initialize(): Promise<void> {
  if (catalogDigest) return;
  catalogDigest = await computeCapabilityCatalogDigest(
    PDF_TEMPLATE_CAPABILITIES_V1
  );
  const empty = await resolveTemplateLayers({
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    catalogDigest,
    baseline: {
      id: "editorial-indigo",
      version: "1",
      design: baselineDesign,
    },
    sourceDigest: HASH_A,
    decisions: decisions(),
    candidates: [],
    mappingVersion: "mapping-1",
  });
  baselineDigest = empty.baseline.digest;
}

function decisions(
  entries: TemplateDecisionStateV1["decisions"] = [],
  preview = true
): TemplateDecisionStateV1 {
  return {
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: entries,
    preview: preview
      ? {
          designReviewDigest: HASH_A,
          compatibilityProofDigest: HASH_A,
        }
      : {},
  };
}

function analysis(
  overrides: Partial<TemplateProjectAnalysisV1> = {}
): TemplateProjectAnalysisV1 {
  return {
    digest: HASH_A,
    sourceDigest: HASH_A,
    mappingVersion: "mapping-1",
    candidates: [],
    diagnostics: [],
    inventoryDiagnosticCodes: [],
    hasVisualCandidates: false,
    ...overrides,
  };
}

async function project(
  options: {
    analysis?: TemplateProjectAnalysisV1;
    decisions?: TemplateDecisionStateV1;
    assetHandles?: TemplateProjectStateV1["assetHandles"];
  } = {}
): Promise<TemplateProjectStateV1> {
  await initialize();
  const projectAnalysis = options.analysis ?? analysis();
  const projectDecisions = options.decisions ?? decisions();
  const snapshot = await resolveTemplateLayers({
    catalog: PDF_TEMPLATE_CAPABILITIES_V1,
    catalogDigest,
    baseline: {
      id: "editorial-indigo",
      version: "1",
      design: baselineDesign,
    },
    sourceDigest: projectAnalysis.sourceDigest,
    decisions: projectDecisions,
    candidates: projectAnalysis.candidates,
    mappingVersion: projectAnalysis.mappingVersion,
  });
  return {
    schema: TEMPLATE_PROJECT_STATE_SCHEMA_V1,
    catalog: {
      id: PDF_TEMPLATE_CAPABILITIES_V1.id,
      version: PDF_TEMPLATE_CAPABILITIES_V1.version,
      digest: catalogDigest,
    },
    baseline: {
      id: "editorial-indigo",
      version: "1",
      digest: baselineDigest,
    },
    analysis: projectAnalysis,
    decisions: projectDecisions,
    snapshot,
    assetHandles: options.assetHandles ?? {},
  };
}

function view(
  generation: string,
  overrides: Partial<TemplateImportViewV1> = {}
): TemplateImportViewV1 {
  return {
    schema: TEMPLATE_IMPORT_VIEW_SCHEMA_V1,
    generation,
    stage: "ready-to-build",
    summary: {
      readyToApply: 0,
      needsReview: 0,
      cannotTransfer: 0,
      blockers: 0,
      unanswered: 0,
    },
    sections: [],
    diagnostics: [],
    availableActions: [],
    nextActions: [],
    preview: { designReview: "ready", compatibilityProof: "ready" },
    ...overrides,
  };
}

function preview(
  generation: string,
  snapshotDigest: string,
  purpose: TemplateProjectPreviewArtifactV1["purpose"]
): TemplateProjectPreviewArtifactV1 {
  const regions =
    purpose === "design-review"
      ? (["summary", "baseline", "current"] as const)
      : purpose === "asset-contact-sheet"
        ? (["asset-grid"] as const)
        : (["feature-zoo"] as const);
  return {
    generation,
    purpose,
    snapshotDigest,
    digest: HASH_B,
    mediaType: "application/pdf",
    byteLength: 1,
    pageCount: 1,
    regions: regions.map((region) => ({ page: 1, region })),
    output: {
      kind: "asset-handle",
      handle: {
        id: `preview:${purpose}:${HASH_B}`,
        sha256: HASH_B,
        mediaType: "application/pdf",
        byteLength: 1,
      },
    },
  };
}

class FakeMaterializer implements TemplateRuntimeMaterializer {
  constructor(private readonly reverse = false) {}

  async materialize(
    snapshot: AuthoringResolutionSnapshotV1,
    assets: readonly TemplateRuntimeAssetV1[]
  ) {
    const descriptors: NonNullable<TemplateManifest["assetDescriptors"]> = {};
    const references: NonNullable<TemplateManifest["assets"]> = {};
    const payload: Record<string, Uint8Array> = {};
    for (const asset of assets) {
      const id = asset.slot.replace(/^asset\./u, "asset-");
      const path = `assets/${asset.slot}/${asset.sha256}.png`;
      (descriptors as Record<string, unknown>)[id] = {
        path,
        sha256: asset.sha256,
        mediaType: "image/png",
        byteLength: asset.bytes.byteLength,
        dimensions: { width: 1, height: 1, unit: "pixel" },
      };
      (references as Record<string, unknown>)[asset.slot] = {
        descriptor: id,
        writer: "pdf.asset.logo.v1",
        decorative: asset.accessibility.decorative,
        ...(asset.accessibility.alt ? { alt: asset.accessibility.alt } : {}),
      };
      payload[path] = new Uint8Array(asset.bytes);
    }
    const canonicalTypst =
      "#let atlcli-document(document, settings: (:)) = none\n";
    const manifest: TemplateManifest = {
      ...BUILTIN_PDF_TEMPLATE_MANIFEST,
      id: "generated-test-template",
      name: "Generated test template",
      version: "1.0.0",
      design: snapshot.design as unknown as TemplateManifest["design"],
      canonicalSource: { api: "wiki.pdf-canonical-typst", revision: "1" },
      assetDescriptors: descriptors,
      assets: references,
      decorations: [],
      provenance: undefined,
    };
    const ordered = this.reverse
      ? { ...payload, "atlcli.typ": encoder.encode(canonicalTypst) }
      : { "atlcli.typ": encoder.encode(canonicalTypst), ...payload };
    return {
      manifest,
      canonicalTypst,
      runtimeSnapshot: {
        assets: Object.fromEntries(
          [...assets]
            .sort((left, right) => left.slot.localeCompare(right.slot))
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
        ),
        design: snapshot.design,
      },
      files: ordered,
    };
  }
}

const fakeCompiler: TemplateGeneratedPackCompilerV1 = {
  async compile({ packBytes }) {
    return { digest: await sha256Hex(packBytes), pageCount: 1 };
  },
};

async function buildInput(
  generation = HASH_C,
  projectState?: TemplateProjectStateV1,
  materializer: TemplateRuntimeMaterializer = new FakeMaterializer()
): Promise<BuildTemplateProjectInputV1> {
  const current = projectState ?? (await project());
  const previews: BuildTemplateProjectInputV1["previews"] = {
    "design-review": preview(
      generation,
      current.snapshot.snapshotDigest,
      "design-review"
    ),
    "compatibility-proof": preview(
      generation,
      current.snapshot.snapshotDigest,
      "compatibility-proof"
    ),
    ...(current.analysis.hasVisualCandidates
      ? {
          "asset-contact-sheet": preview(
            generation,
            current.snapshot.snapshotDigest,
            "asset-contact-sheet"
          ),
        }
      : {}),
  };
  return {
    generation,
    project: current,
    catalog: current.catalog,
    baseline: current.baseline,
    view: view(generation),
    previews,
    assetStore: new InMemoryTemplateAssetStore(),
    materializer,
  };
}

describe("repository contract", () => {
  templateProjectRepositoryContract(async () =>
    new InMemoryTemplateProjectRepository()
  );

  test("stateful undo restores only intent and re-resolves current safe inputs", async () => {
    const target = await project({
      decisions: decisions([
        {
          id: "old-name",
          kind: "override",
          target: "branding.organizationName",
          value: "Old intent",
        },
      ]),
    });
    const current = await project({
      analysis: analysis({ digest: HASH_B, sourceDigest: HASH_B }),
      decisions: decisions([
        {
          id: "new-name",
          kind: "override",
          target: "branding.organizationName",
          value: "New intent",
        },
      ]),
      assetHandles: {
        [HASH_C]: {
          id: `asset:${HASH_C}`,
          sha256: HASH_C,
          mediaType: "image/png",
          byteLength: 1,
        },
      },
    });
    const prepared = await prepareTemplateProjectUndo({
      current,
      targetDecisions: target.decisions,
      catalog: {
        id: PDF_TEMPLATE_CAPABILITIES_V1.id,
        version: PDF_TEMPLATE_CAPABILITIES_V1.version,
        digest: catalogDigest,
        descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
      },
      baseline: {
        id: "editorial-indigo",
        version: "1",
        digest: baselineDigest,
        design: baselineDesign,
      },
    });
    expect(prepared.analysis).toEqual(current.analysis);
    expect(prepared.assetHandles).toEqual(current.assetHandles);
    expect(prepared.snapshot.sourceDigest).toBe(HASH_B);
    expect(prepared.decisions.preview).toEqual({});
    expect(
      (prepared.snapshot.design.branding as { organizationName: string })
        .organizationName
    ).toBe("Old intent");

    const repository = new InMemoryTemplateProjectRepository();
    const first = await repository.commit({
      projectId: "stateful-undo",
      expectedGeneration: null,
      analysisDigest: target.analysis.digest,
      decisions: target.decisions,
      snapshotDigest: target.snapshot.snapshotDigest,
      project: target,
      privateIntake: { source: "old-private" },
    });
    const second = await repository.commit({
      projectId: "stateful-undo",
      expectedGeneration: first.generation,
      analysisDigest: current.analysis.digest,
      decisions: current.decisions,
      snapshotDigest: current.snapshot.snapshotDigest,
      project: current,
      privateIntake: { source: "current-private" },
    });
    await expect(
      repository.undo({
        projectId: "stateful-undo",
        expectedGeneration: second.generation,
        targetGeneration: first.generation,
      })
    ).rejects.toThrow("requires a prepared authoring result");
    const undone = await repository.undo({
      projectId: "stateful-undo",
      expectedGeneration: second.generation,
      targetGeneration: first.generation,
      preparedProject: prepared,
    });
    expect(undone.project).toEqual(prepared);
    expect(undone.privateIntakeDigest).toBe(second.privateIntakeDigest);
    expect(undone.generation).not.toBe(first.generation);
    expect((await repository.listHistory("stateful-undo"))).toHaveLength(3);
  });
});

describe("deterministic project build and privacy boundary", () => {
  test("canonicalizes logical order and emits a minimal private pack", async () => {
    const state = await project();
    const first = await buildTemplateProject(
      await buildInput(HASH_C, state, new FakeMaterializer(false))
    );
    const reorderedState = JSON.parse(
      JSON.stringify({
        assetHandles: state.assetHandles,
        snapshot: state.snapshot,
        decisions: state.decisions,
        analysis: state.analysis,
        baseline: state.baseline,
        catalog: state.catalog,
        schema: state.schema,
      })
    ) as TemplateProjectStateV1;
    const second = await buildTemplateProject(
      await buildInput(HASH_C, reorderedState, new FakeMaterializer(true))
    );
    expect(second.analysisJson).toBe(first.analysisJson);
    expect(second.authoringSnapshotJson).toBe(first.authoringSnapshotJson);
    expect(second.runtimeSnapshotJson).toBe(first.runtimeSnapshotJson);
    expect(second.manifestJson).toBe(first.manifestJson);
    expect(second.canonicalTypst).toBe(first.canonicalTypst);

    const firstPack = await buildGeneratedPdfTemplatePack(first, fakeCompiler);
    const secondPack = await buildGeneratedPdfTemplatePack(second, fakeCompiler);
    expect(secondPack.bytes).toEqual(firstPack.bytes);
    expect(Object.keys(unpackTemplate(firstPack.bytes).files)).toEqual([
      "atlcli.typ",
    ]);
    const unpacked = unpackTemplate(firstPack.bytes);
    const text = [
      canonicalCapabilityJson(unpacked.manifest),
      ...Object.values(unpacked.files).map((bytes) => decoder.decode(bytes)),
    ].join("\n");
    for (const prohibited of [
      "decisionDigest",
      "sourceDigest",
      "\"baseline\"",
      "\"candidates\"",
      "\"decisions\"",
      "\"trace\"",
    ]) {
      expect(text).not.toContain(prohibited);
    }
  });

  test("copies only explicitly confirmed assets into the build inventory", async () => {
    await initialize();
    const bytes = new Uint8Array([137, 80, 78, 71]);
    const digest = await sha256Hex(bytes);
    const assetStore = new InMemoryTemplateAssetStore();
    const handle = await assetStore.put({
      sha256: digest,
      mediaType: "image/png",
      bytes,
    });
    const rejectedBytes = new Uint8Array([4, 3, 2, 1]);
    const rejectedDigest = await sha256Hex(rejectedBytes);
    const rejectedHandle = await assetStore.put({
      sha256: rejectedDigest,
      mediaType: "image/png",
      bytes: rejectedBytes,
    });
    const undecidedBytes = new Uint8Array([8, 8, 8]);
    const undecidedDigest = await sha256Hex(undecidedBytes);
    const undecidedHandle = await assetStore.put({
      sha256: undecidedDigest,
      mediaType: "image/png",
      bytes: undecidedBytes,
    });
    const candidate: TemplateCandidateV1 = {
      schema: TEMPLATE_CANDIDATE_SCHEMA_V1,
      id: "candidate-logo",
      semanticKey: "asset.logo.primary",
      candidateFingerprint: HASH_B,
      sourceFingerprint: HASH_C,
      group: { id: "asset.logo", cardinality: "zero-or-one", atomic: true },
      writes: [],
      rank: 1,
      kind: "asset",
      valueNature: "source-explicit",
      confidence: "conclusive",
      compatibility: "native",
      adoption: "review",
      evidence: [{ id: "asset-evidence", partRef: "header", locator: "image.1" }],
      rule: { id: "asset-logo", version: "1" },
      explanations: [],
      diagnostics: [],
    };
    const assetDecision = {
      id: "decision-logo",
      kind: "accept-asset" as const,
      semanticKey: candidate.semanticKey,
      candidateFingerprint: candidate.candidateFingerprint,
      sourceFingerprint: candidate.sourceFingerprint,
      sourceDigest: HASH_A,
      catalogDigest,
      importerVersion: "1",
      mappingVersion: "mapping-1",
      assetSha256: digest,
      role: "asset.logo",
      useConfirmed: true as const,
      rightsConfirmed: true as const,
      accessibility: { decorative: false, alt: "Organization logo" },
      rendering: { kind: "slot-default" as const },
    };
    const assetState = await project({
      analysis: analysis({
        candidates: [candidate],
        hasVisualCandidates: true,
      }),
      decisions: decisions([
        assetDecision,
        {
          id: "rejected",
          kind: "reject-candidate",
          semanticKey: "asset.rejected",
          candidateFingerprint: HASH_C,
          groupId: "asset.rejected",
        },
      ]),
      assetHandles: {
        [digest]: handle,
        [rejectedDigest]: rejectedHandle,
        [undecidedDigest]: undecidedHandle,
      },
    });
    const input = await buildInput(HASH_C, assetState);
    input.assetStore = assetStore;
    const build = await buildTemplateProject(input);
    expect(Object.keys(build.files).sort()).toEqual([
      `assets/asset.logo/${digest}.png`,
      "atlcli.typ",
    ]);
    expect(build.manifest.assets?.["asset.logo"]?.alt).toBe(
      "Organization logo"
    );
    expect(canonicalCapabilityJson(build.manifest)).not.toContain("rejected");
    expect(canonicalCapabilityJson(build.manifest)).not.toContain(
      rejectedDigest
    );
    expect(canonicalCapabilityJson(build.manifest)).not.toContain(
      undecidedDigest
    );
    const reverseBuild = await buildTemplateProject({
      ...input,
      materializer: new FakeMaterializer(true),
    });
    expect(
      (await buildGeneratedPdfTemplatePack(reverseBuild, fakeCompiler)).bytes
    ).toEqual(
      (await buildGeneratedPdfTemplatePack(build, fakeCompiler)).bytes
    );
  });
});

describe("readiness, migrations, and reconciliation", () => {
  test.each([
    [
      "review-required",
      async (input: BuildTemplateProjectInputV1) => {
        input.view = view(input.generation, {
          stage: "review-required",
          summary: { ...input.view.summary, unanswered: 1 },
        });
      },
    ],
    [
      "inventory-acknowledgement-required",
      async (input: BuildTemplateProjectInputV1) => {
        input.project = await project({
          analysis: analysis({ inventoryDiagnosticCodes: ["WORD_UNSUPPORTED"] }),
        });
      },
    ],
    [
      "blocker-unresolved",
      async (input: BuildTemplateProjectInputV1) => {
        input.view = view(input.generation, {
          stage: "blocked",
          summary: { ...input.view.summary, blockers: 1 },
        });
      },
    ],
    [
      "preview-required",
      async (input: BuildTemplateProjectInputV1) => {
        input.previews = {
          "design-review": input.previews["design-review"],
        };
      },
    ],
    [
      "preview-stale",
      async (input: BuildTemplateProjectInputV1) => {
        input.previews = {
          ...input.previews,
          "design-review": preview(
            HASH_B,
            input.project.snapshot.snapshotDigest,
            "design-review"
          ),
        };
      },
    ],
  ])("fails with typed recovery for %s", async (code, mutate) => {
    const input = await buildInput();
    await mutate(input);
    try {
      await buildTemplateProject(input);
      throw new Error("expected build to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(TemplateProjectBuildError);
      expect((error as TemplateProjectBuildError).code).toBe(
        code as TemplateProjectBuildFailureCodeV1
      );
      expect((error as TemplateProjectBuildError).recoveryActions.length).toBeGreaterThan(0);
    }
  });

  test("requires explicit catalog and baseline migration", async () => {
    const catalogInput = await buildInput();
    catalogInput.catalog = { ...catalogInput.catalog, digest: HASH_B };
    await expect(buildTemplateProject(catalogInput)).rejects.toMatchObject({
      code: "catalog-migration-required",
      recoveryActions: ["migrate-catalog"],
    });

    const baselineInput = await buildInput();
    baselineInput.baseline = { ...baselineInput.baseline, digest: HASH_B };
    await expect(buildTemplateProject(baselineInput)).rejects.toMatchObject({
      code: "baseline-migration-required",
      recoveryActions: ["migrate-baseline"],
    });
  });

  test("a source or mapping change preserves intent and marks it stale", async () => {
    await initialize();
    const candidate: TemplateCandidateV1 = {
      schema: TEMPLATE_CANDIDATE_SCHEMA_V1,
      id: "candidate-page",
      semanticKey: "page.size",
      candidateFingerprint: HASH_B,
      sourceFingerprint: HASH_C,
      group: { id: "page.size", cardinality: "zero-or-one", atomic: true },
      writes: [{ target: "page.size", value: "letter" }],
      rank: 1,
      kind: "token",
      valueNature: "source-explicit",
      confidence: "conclusive",
      compatibility: "native",
      adoption: "safe",
      evidence: [{ id: "page", partRef: "document", locator: "section.0" }],
      rule: { id: "page-size", version: "1" },
      explanations: [],
      diagnostics: [],
    };
    const accepted = {
      id: "accepted-page",
      kind: "accept-candidate" as const,
      semanticKey: candidate.semanticKey,
      candidateFingerprint: candidate.candidateFingerprint,
      groupId: candidate.group.id,
      groupAtomic: true,
      rank: 1,
      frozenWrites: candidate.writes,
      sourceFingerprint: candidate.sourceFingerprint,
      sourceDigest: HASH_A,
      catalogDigest,
      importerVersion: "1",
      mappingVersion: "mapping-1",
      decidedBy: { kind: "user" as const },
    };
    const current = await project({
      analysis: analysis({ candidates: [candidate] }),
      decisions: decisions([accepted]),
      assetHandles: {
        [HASH_C]: {
          id: `asset:${HASH_C}`,
          sha256: HASH_C,
          mediaType: "image/png",
          byteLength: 1,
        },
      },
    });
    const next = await reanalyzeTemplateProject({
      current,
      analysis: analysis({
        digest: HASH_B,
        sourceDigest: HASH_B,
        mappingVersion: "mapping-2",
        candidates: [candidate],
      }),
      catalog: {
        id: PDF_TEMPLATE_CAPABILITIES_V1.id,
        version: PDF_TEMPLATE_CAPABILITIES_V1.version,
        digest: catalogDigest,
        descriptor: PDF_TEMPLATE_CAPABILITIES_V1,
      },
      baseline: {
        id: "editorial-indigo",
        version: "1",
        digest: baselineDigest,
        design: baselineDesign,
      },
    });
    expect(next.decisions.decisions).toEqual(current.decisions.decisions);
    expect(next.assetHandles).toEqual(current.assetHandles);
    expect(next.analysis.digest).toBe(HASH_B);
    expect(next.decisions.preview).toEqual({});
    expect(next.snapshot.staleness).toEqual([
      { decisionId: "accepted-page", state: "mapping-changed" },
    ]);
    const input = await buildInput(HASH_C, next);
    await expect(buildTemplateProject(input)).rejects.toMatchObject({
      code: "decision-stale",
    });
  });
});

describe("preview and executable pack gates", () => {
  test("renders generation-bound design, compatibility, and conditional contact artifacts", async () => {
    const summary = {
      readyToApply: 2,
      needsReview: 1,
      cannotTransfer: 3,
      blockers: 0,
      unanswered: 3,
    };
    const withoutVisuals = await renderTemplateProjectPreviews({
      generation: HASH_A,
      snapshotDigest: HASH_B,
      summary,
      hasVisualCandidates: false,
      compiler: new InMemoryTemplatePreviewCompiler(),
    });
    expect(Object.keys(withoutVisuals).sort()).toEqual([
      "compatibility-proof",
      "design-review",
    ]);
    expect(withoutVisuals["design-review"].regions.map(({ region }) => region))
      .toEqual(["summary", "baseline", "current"]);
    expect(withoutVisuals["compatibility-proof"].regions).toEqual([
      { page: 1, region: "feature-zoo" },
    ]);
    expect(decoder.decode(
      (withoutVisuals["design-review"].output as { kind: "bytes"; bytes: Uint8Array }).bytes
    )).toContain('"readyToApply":2');

    const withVisuals = await renderTemplateProjectPreviews({
      generation: HASH_A,
      snapshotDigest: HASH_B,
      summary,
      hasVisualCandidates: true,
      compiler: new InMemoryTemplatePreviewCompiler(),
    });
    expect(withVisuals["asset-contact-sheet"].regions).toEqual([
      { page: 1, region: "asset-grid" },
    ]);
    const contactText = decoder.decode(
      (withVisuals["asset-contact-sheet"].output as {
        kind: "bytes";
        bytes: Uint8Array;
      }).bytes
    );
    expect(contactText).not.toContain("sourceDigest");
    expect(contactText).not.toContain("document text");
  });

  test("rejects modified canonical source and broken executable gates", async () => {
    const build = await buildTemplateProject(await buildInput());
    const modified = {
      ...build,
      files: {
        ...build.files,
        "atlcli.typ": encoder.encode(`${build.canonicalTypst}\n// modified`),
      },
    };
    await expect(
      buildGeneratedPdfTemplatePack(modified, fakeCompiler)
    ).rejects.toMatchObject({ code: "non-canonical-source" });

    const brokenCompiler: TemplateGeneratedPackCompilerV1 = {
      async compile() {
        throw new Error("Typst generator/feature mismatch");
      },
    };
    await expect(
      buildGeneratedPdfTemplatePack(build, brokenCompiler)
    ).rejects.toThrow("Typst generator/feature mismatch");
    const result = await buildGeneratedPdfTemplatePack(build, fakeCompiler);
    const unpacked = unpackTemplate(result.bytes);
    const repacked = await packTemplate(unpacked);
    expect(repacked).toEqual(result.bytes);
    expect(result.compile.pageCount).toBe(1);
  });

  test("rejects internally inconsistent build snapshots", async () => {
    const current = await project();
    const inconsistent = {
      ...current,
      snapshot: {
        ...current.snapshot,
        schema: AUTHORING_RESOLUTION_SCHEMA_V1,
        sourceDigest: HASH_B,
      },
    };
    await expect(
      buildTemplateProject(await buildInput(HASH_C, inconsistent))
    ).rejects.toMatchObject({ code: "runtime-mismatch" });
  });
});
