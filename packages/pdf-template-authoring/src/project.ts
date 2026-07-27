/**
 * Host-neutral template-project orchestration.
 *
 * This module owns readiness, reconciliation, preview freshness, deterministic
 * build descriptions, privacy minimization, and the executable pack gate. It
 * intentionally performs no filesystem, terminal, browser-storage, or PDF
 * compiler I/O; hosts provide those capabilities through ports.
 */
import { sha256Hex } from "@atlcli/core";
import {
  canonicalCapabilityJson,
  packTemplate,
  unpackTemplate,
  validateManifest,
  type TemplateManifest,
} from "@atlcli/template-pack";
import {
  TEMPLATE_DECISION_STATE_SCHEMA_V1,
  TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
  TEMPLATE_PROJECT_STATE_SCHEMA_V1,
  type BuildTemplateProjectInputV1,
  type TemplateAssetHandleV1,
  type TemplateDecisionStateV1,
  type TemplateGeneratedPackCompilerV1,
  type TemplateImportViewV1,
  type TemplatePreviewCompiler,
  type TemplatePreviewRequestV1,
  type TemplateProjectAnalysisV1,
  type TemplateProjectBuildFailureCodeV1,
  type TemplateProjectBuildV1,
  type TemplateProjectPreviewArtifactV1,
  type TemplateProjectRecoveryActionV1,
  type TemplateProjectStateV1,
  type TemplateRuntimeAssetV1,
} from "./contracts.js";
import {
  reconcileTemplateDecisions,
  resolveTemplateLayers,
} from "./core.js";

const encoder = new TextEncoder();
const HASH_RE = /^[a-f0-9]{64}$/;
const FORBIDDEN_PACK_FIELD_RE =
  /"(?:decisionDigest|sourceDigest|baseline|candidates?|decisions?|trace)"\s*:/;

export interface CreateTemplateProjectStateInputV1 {
  analysis: TemplateProjectAnalysisV1;
  assetHandles: Readonly<Record<string, TemplateAssetHandleV1>>;
  catalog: {
    id: string;
    version: number;
    digest: string;
    descriptor: Parameters<typeof resolveTemplateLayers>[0]["catalog"];
  };
  baseline: {
    id: string;
    version: string;
    design: Readonly<Record<string, unknown>>;
  };
}

function stableJson(value: unknown): string {
  return `${canonicalCapabilityJson(value)}\n`;
}

function immutableJson<T>(value: T): T {
  const parsed = JSON.parse(canonicalCapabilityJson(value)) as T;
  const freeze = (item: unknown): void => {
    if (!item || typeof item !== "object" || Object.isFrozen(item)) return;
    Object.freeze(item);
    for (const child of Object.values(item as Record<string, unknown>)) {
      freeze(child);
    }
  };
  freeze(parsed);
  return parsed;
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalCapabilityJson(left) === canonicalCapabilityJson(right);
}

/**
 * Start a host-neutral authoring project from one analyzed source.
 *
 * Repository generation, source paths, terminal state, and presentation stay
 * host-owned. The returned state is the single portable input used by CLI and
 * future browser repositories.
 */
export async function createTemplateProjectState(
  input: CreateTemplateProjectStateInputV1
): Promise<TemplateProjectStateV1> {
  const decisions = {
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: [],
    preview: {},
  } satisfies TemplateDecisionStateV1;
  const snapshot = await resolveTemplateLayers({
    catalog: input.catalog.descriptor,
    catalogDigest: input.catalog.digest,
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      design: input.baseline.design,
    },
    sourceDigest: input.analysis.sourceDigest,
    decisions,
    candidates: input.analysis.candidates,
    mappingVersion: input.analysis.mappingVersion,
  });
  return immutableJson({
    schema: TEMPLATE_PROJECT_STATE_SCHEMA_V1,
    catalog: {
      id: input.catalog.id,
      version: input.catalog.version,
      digest: input.catalog.digest,
    },
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      digest: snapshot.baseline.digest,
    },
    analysis: input.analysis,
    decisions,
    snapshot,
    assetHandles: input.assetHandles,
  });
}

function cloneFiles(
  files: Readonly<Record<string, Uint8Array>>
): Readonly<Record<string, Uint8Array>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(files)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([path, bytes]) => [path, new Uint8Array(bytes)])
    )
  );
}

export class TemplateProjectBuildError extends Error {
  constructor(
    readonly code: TemplateProjectBuildFailureCodeV1,
    readonly recoveryActions: readonly TemplateProjectRecoveryActionV1[],
    message: string
  ) {
    super(message);
    this.name = "TemplateProjectBuildError";
  }
}

function fail(
  code: TemplateProjectBuildFailureCodeV1,
  recoveryActions: readonly TemplateProjectRecoveryActionV1[],
  message: string
): never {
  throw new TemplateProjectBuildError(code, recoveryActions, message);
}

function assertDigest(value: string, field: string): void {
  if (!HASH_RE.test(value)) {
    fail("runtime-mismatch", ["reanalyze"], `${field} is not a SHA-256 digest`);
  }
}

function assertReady(
  input: BuildTemplateProjectInputV1,
  requiredPreviewPurposes: readonly TemplatePreviewRequestV1["purpose"][]
): void {
  const { generation, project, view } = input;
  if (view.generation !== generation) {
    fail("preview-stale", ["preview"], "The review projection belongs to another generation");
  }
  if (view.summary.blockers > 0 || project.analysis.diagnostics.some(
    ({ severity }) => severity === "error"
  )) {
    fail("blocker-unresolved", ["review", "reanalyze"], "Blocking findings must be resolved");
  }
  if (view.summary.unanswered > 0) {
    fail("review-required", ["review"], "Review items are still unanswered");
  }
  if (
    project.analysis.inventoryDiagnosticCodes.length > 0 &&
    !project.decisions.decisions.some(
      (decision) =>
        decision.kind === "acknowledge-inventory" &&
        decision.analysisDigest === project.analysis.digest
    )
  ) {
    fail(
      "inventory-acknowledgement-required",
      ["acknowledge-inventory"],
      "The unsupported-feature inventory has not been acknowledged"
    );
  }
  const stale = project.snapshot.staleness.find(({ state }) => state !== "current");
  if (stale) {
    fail(
      stale.state === "catalog-migration-required"
        ? "catalog-migration-required"
        : "decision-stale",
      stale.state === "catalog-migration-required"
        ? ["migrate-catalog", "review"]
        : ["review", "reanalyze"],
      `Decision ${stale.decisionId} is stale (${stale.state})`
    );
  }
  for (const purpose of requiredPreviewPurposes) {
    const preview = input.previews[purpose];
    if (!preview) {
      fail("preview-required", ["preview"], `${purpose} has not been rendered`);
    }
    if (
      preview.generation !== generation ||
      preview.snapshotDigest !== project.snapshot.snapshotDigest
    ) {
      fail("preview-stale", ["preview"], `${purpose} is stale`);
    }
  }
  if (view.stage !== "ready-to-build") {
    fail("review-required", ["review", "preview"], "The project is not ready to build");
  }
}

function requiredPreviewRegions(
  purpose: TemplatePreviewRequestV1["purpose"]
): readonly TemplateProjectPreviewArtifactV1["regions"][number]["region"][] {
  if (purpose === "design-review") {
    return ["summary", "baseline", "current"];
  }
  return purpose === "asset-contact-sheet" ? ["asset-grid"] : ["feature-zoo"];
}

async function verifyPreviewArtifacts(
  input: BuildTemplateProjectInputV1,
  purposes: readonly TemplatePreviewRequestV1["purpose"][]
): Promise<void> {
  for (const purpose of purposes) {
    const artifact = input.previews[purpose]!;
    assertDigest(artifact.digest, `${purpose}.digest`);
    if (
      artifact.mediaType !== "application/pdf" ||
      !Number.isSafeInteger(artifact.byteLength) ||
      artifact.byteLength < 1 ||
      !Number.isSafeInteger(artifact.pageCount) ||
      artifact.pageCount < 1 ||
      requiredPreviewRegions(purpose).some(
        (region) => !artifact.regions.some((entry) => entry.region === region)
      )
    ) {
      fail(
        "preview-stale",
        ["preview"],
        `${purpose} does not satisfy the preview artifact contract`
      );
    }
    if (artifact.output.kind === "bytes") {
      if (
        artifact.output.bytes.byteLength !== artifact.byteLength ||
        (await sha256Hex(artifact.output.bytes)) !== artifact.digest
      ) {
        fail(
          "preview-stale",
          ["preview"],
          `${purpose} bytes do not match their digest`
        );
      }
    } else if (
      artifact.output.handle.sha256 !== artifact.digest ||
      artifact.output.handle.byteLength !== artifact.byteLength
    ) {
      fail(
        "preview-stale",
        ["preview"],
        `${purpose} handle does not match its digest`
      );
    }
  }
}

function acceptedAssetHandles(
  project: TemplateProjectStateV1
): readonly {
  decision: Extract<
    TemplateDecisionStateV1["decisions"][number],
    { kind: "accept-asset" }
  >;
  handle: TemplateAssetHandleV1;
}[] {
  return project.decisions.decisions
    .filter(
      (
        decision
      ): decision is Extract<
        TemplateDecisionStateV1["decisions"][number],
        { kind: "accept-asset" }
      > => decision.kind === "accept-asset"
    )
    .sort((left, right) => left.role.localeCompare(right.role))
    .map((decision) => {
      if (!decision.useConfirmed || !decision.rightsConfirmed) {
        fail(
          "asset-confirmation-required",
          ["review-asset"],
          `Asset ${decision.semanticKey} needs an explicit use and rights confirmation`
        );
      }
      if (
        !decision.accessibility.decorative &&
        !decision.accessibility.alt?.trim()
      ) {
        fail(
          "asset-confirmation-required",
          ["review-asset"],
          `Meaning-bearing asset ${decision.semanticKey} needs alternative text`
        );
      }
      const handle = project.assetHandles[decision.assetSha256];
      if (!handle || handle.sha256 !== decision.assetSha256) {
        fail(
          "asset-unavailable",
          ["review-asset", "reanalyze"],
          `Accepted asset ${decision.semanticKey} is unavailable`
        );
      }
      return { decision, handle };
    });
}

async function assertMinimalPack(
  manifest: TemplateManifest,
  canonicalTypst: string,
  files: Readonly<Record<string, Uint8Array>>,
  acceptedAssets?: readonly TemplateRuntimeAssetV1[]
): Promise<void> {
  const entryBytes = files[manifest.engine.entry];
  if (
    manifest.engine.entry !== "atlcli.typ" ||
    !entryBytes ||
    new TextDecoder().decode(entryBytes) !== canonicalTypst
  ) {
    fail(
      "non-canonical-source",
      ["reanalyze"],
      "atlcli.typ does not match the canonical source generator"
    );
  }
  if (!manifest.canonicalSource) {
    fail(
      "non-canonical-source",
      ["reanalyze"],
      "The generated manifest must declare canonicalSource"
    );
  }

  const descriptorPaths = new Set(
    Object.values(manifest.assetDescriptors ?? {}).map(({ path }) => path)
  );
  for (const descriptor of Object.values(manifest.assetDescriptors ?? {})) {
    const payload = files[descriptor.path];
    if (
      !payload ||
      payload.byteLength !== descriptor.byteLength ||
      (await sha256Hex(payload)) !== descriptor.sha256
    ) {
      fail(
        "runtime-mismatch",
        ["review-asset", "reanalyze"],
        `Generated asset ${descriptor.path} failed its manifest integrity check`
      );
    }
  }
  const allowed = new Set([manifest.engine.entry, ...descriptorPaths]);
  const foreign = Object.keys(files).find((path) => !allowed.has(path));
  if (foreign) {
    fail("runtime-mismatch", ["reanalyze"], `Generated pack contains foreign payload ${foreign}`);
  }
  if (acceptedAssets && descriptorPaths.size !== acceptedAssets.length) {
    fail(
      "runtime-mismatch",
      ["review-asset", "reanalyze"],
      "Generated asset inventory does not match confirmed assets"
    );
  }
  for (const asset of acceptedAssets ?? []) {
    const reference = manifest.assets?.[asset.slot];
    const descriptor = reference
      ? manifest.assetDescriptors?.[reference.descriptor]
      : undefined;
    if (
      !reference ||
      !descriptor ||
      descriptor.sha256 !== asset.sha256 ||
      !files[descriptor.path]
    ) {
      fail(
        "runtime-mismatch",
        ["review-asset", "reanalyze"],
        `Generated slot ${asset.slot} does not match its confirmed asset`
      );
    }
  }

  const manifestJson = stableJson(manifest);
  if (
    FORBIDDEN_PACK_FIELD_RE.test(manifestJson) ||
    FORBIDDEN_PACK_FIELD_RE.test(canonicalTypst)
  ) {
    fail(
      "runtime-mismatch",
      ["reanalyze"],
      "Generated pack leaked authoring or source provenance"
    );
  }
}

/**
 * Produce a complete deterministic build description. No file is read or
 * written here; asset reads and runtime generation are injected ports.
 */
export async function buildTemplateProject(
  input: BuildTemplateProjectInputV1
): Promise<TemplateProjectBuildV1> {
  assertDigest(input.project.analysis.digest, "analysis.digest");
  assertDigest(input.project.analysis.sourceDigest, "analysis.sourceDigest");
  assertDigest(input.project.snapshot.snapshotDigest, "snapshot.snapshotDigest");
  if (
    input.project.schema !== TEMPLATE_PROJECT_STATE_SCHEMA_V1 ||
    !sameJson(input.project.catalog, input.catalog)
  ) {
    fail(
      "catalog-migration-required",
      ["migrate-catalog"],
      "The project catalog pin differs from the active catalog"
    );
  }
  if (!sameJson(input.project.baseline, input.baseline)) {
    fail(
      "baseline-migration-required",
      ["migrate-baseline"],
      "The project baseline pin differs from the active baseline"
    );
  }
  if (
    input.project.snapshot.catalog.digest !== input.catalog.digest ||
    input.project.snapshot.baseline.digest !== input.baseline.digest
  ) {
    fail(
      "runtime-mismatch",
      ["reanalyze"],
      "The resolved snapshot is not bound to the pinned catalog and baseline"
    );
  }
  if (
    input.project.analysis.sourceDigest !==
      input.project.snapshot.sourceDigest ||
    input.project.snapshot.decisionDigest !==
      (await sha256Hex(
        encoder.encode(
          canonicalCapabilityJson(input.project.decisions.decisions)
        )
      ))
  ) {
    fail(
      "runtime-mismatch",
      ["reanalyze"],
      "The resolved snapshot is not bound to the current analysis and decisions"
    );
  }

  const requiredPreviews: TemplatePreviewRequestV1["purpose"][] = [
    "design-review",
    "compatibility-proof",
    ...(input.project.analysis.hasVisualCandidates
      ? (["asset-contact-sheet"] as const)
      : []),
  ];
  assertReady(input, requiredPreviews);
  await verifyPreviewArtifacts(input, requiredPreviews);

  const accepted = acceptedAssetHandles(input.project);
  const runtimeAssets: TemplateRuntimeAssetV1[] = [];
  for (const { decision, handle } of accepted) {
    try {
      await input.assetStore.verify(handle);
      const bytes = await input.assetStore.get(handle);
      if (
        bytes.byteLength !== handle.byteLength ||
        (await sha256Hex(bytes)) !== decision.assetSha256
      ) {
        throw new Error("asset bytes changed after verification");
      }
      runtimeAssets.push({
        slot: decision.role,
        sha256: decision.assetSha256,
        mediaType: handle.mediaType,
        bytes: new Uint8Array(bytes),
        accessibility: immutableJson(decision.accessibility),
        rendering: immutableJson(decision.rendering),
      });
    } catch {
      fail(
        "asset-unavailable",
        ["review-asset", "reanalyze"],
        `Accepted asset ${decision.semanticKey} failed verification`
      );
    }
  }

  const materialized = await input.materializer.materialize(
    input.project.snapshot,
    runtimeAssets
  );
  const manifest = validateManifest(materialized.manifest);
  if (!sameJson(manifest.design, input.project.snapshot.design)) {
    fail(
      "runtime-mismatch",
      ["reanalyze"],
      "The runtime manifest design differs from the resolved authoring snapshot"
    );
  }
  const expectedRuntimeSnapshot = {
    design: input.project.snapshot.design,
    assets: Object.fromEntries(
      runtimeAssets
        .map(({ slot, sha256, mediaType, accessibility, rendering }) => [
          slot,
          { sha256, mediaType, accessibility, rendering },
        ])
        .sort(([left], [right]) =>
          String(left).localeCompare(String(right))
        )
    ),
  };
  if (!sameJson(materialized.runtimeSnapshot, expectedRuntimeSnapshot)) {
    fail(
      "runtime-mismatch",
      ["reanalyze"],
      "The materialized runtime snapshot differs from the resolved design and confirmed assets"
    );
  }
  const files = cloneFiles(materialized.files);
  await assertMinimalPack(
    manifest,
    materialized.canonicalTypst,
    files,
    runtimeAssets
  );

  return Object.freeze({
    schema: TEMPLATE_PROJECT_BUILD_SCHEMA_V1,
    generation: input.generation,
    snapshotDigest: input.project.snapshot.snapshotDigest,
    analysisJson: stableJson(input.project.analysis),
    authoringSnapshotJson: stableJson(input.project.snapshot),
    runtimeSnapshotJson: stableJson(materialized.runtimeSnapshot),
    manifestJson: stableJson(manifest),
    manifest: immutableJson(manifest),
    canonicalTypst: materialized.canonicalTypst,
    files,
  });
}

/**
 * Render every required artifact against one immutable generation. Repositories
 * may persist these records beside, but never inside, immutable state.
 */
export async function renderTemplateProjectPreviews(input: {
  generation: string;
  snapshotDigest: string;
  summary: TemplateImportViewV1["summary"];
  hasVisualCandidates: boolean;
  compiler: TemplatePreviewCompiler;
}): Promise<
  Readonly<
    Record<TemplatePreviewRequestV1["purpose"], TemplateProjectPreviewArtifactV1>
  >
> {
  const purposes: TemplatePreviewRequestV1["purpose"][] = [
    "design-review",
    "compatibility-proof",
    ...(input.hasVisualCandidates
      ? (["asset-contact-sheet"] as const)
      : []),
  ];
  const artifacts: Partial<
    Record<TemplatePreviewRequestV1["purpose"], TemplateProjectPreviewArtifactV1>
  > = {};
  for (const purpose of purposes) {
    const result = await input.compiler.render({
      generation: input.generation,
      snapshotDigest: input.snapshotDigest,
      purpose,
      summary: input.summary,
    });
    assertDigest(result.digest, `${purpose}.digest`);
    if (
      result.mediaType !== "application/pdf" ||
      result.byteLength < 1 ||
      result.pageCount < 1 ||
      requiredPreviewRegions(purpose).some(
        (region) => !result.regions.some((entry) => entry.region === region)
      ) ||
      (result.output.kind === "bytes" &&
        (result.output.bytes.byteLength !== result.byteLength ||
          (await sha256Hex(result.output.bytes)) !== result.digest)) ||
      (result.output.kind === "asset-handle" &&
        (result.output.handle.sha256 !== result.digest ||
          result.output.handle.byteLength !== result.byteLength))
    ) {
      fail(
        "preview-stale",
        ["preview"],
        `${purpose} compiler result failed verification`
      );
    }
    artifacts[purpose] = Object.freeze({
      generation: input.generation,
      purpose,
      snapshotDigest: input.snapshotDigest,
      digest: result.digest,
      mediaType: result.mediaType,
      byteLength: result.byteLength,
      pageCount: result.pageCount,
      regions: immutableJson(result.regions),
      output:
        result.output.kind === "bytes"
          ? {
              kind: "bytes" as const,
              bytes: new Uint8Array(result.output.bytes),
            }
          : immutableJson(result.output),
    });
  }
  return Object.freeze(artifacts) as Readonly<
    Record<TemplatePreviewRequestV1["purpose"], TemplateProjectPreviewArtifactV1>
  >;
}

export interface ReanalyzeTemplateProjectInputV1 {
  current: TemplateProjectStateV1;
  analysis: TemplateProjectAnalysisV1;
  catalog: BuildTemplateProjectInputV1["catalog"] & {
    descriptor: Parameters<typeof resolveTemplateLayers>[0]["catalog"];
  };
  baseline: BuildTemplateProjectInputV1["baseline"] & {
    design: Readonly<Record<string, unknown>>;
  };
}

export interface PrepareTemplateProjectUndoInputV1 {
  current: TemplateProjectStateV1;
  targetDecisions: TemplateDecisionStateV1;
  catalog: ReanalyzeTemplateProjectInputV1["catalog"];
  baseline: ReanalyzeTemplateProjectInputV1["baseline"];
}

/**
 * Restore only prior authoring intent. Current analysis, private asset handles,
 * source identity, and catalog/baseline pins remain authoritative; derived
 * state is resolved again and every preview/build marker is invalidated.
 */
export async function prepareTemplateProjectUndo(
  input: PrepareTemplateProjectUndoInputV1
): Promise<TemplateProjectStateV1> {
  const reconciliation = reconcileTemplateDecisions(input.targetDecisions, {
    candidates: input.current.analysis.candidates,
    sourceDigest: input.current.analysis.sourceDigest,
    mappingVersion: input.current.analysis.mappingVersion,
    catalogDigest: input.catalog.digest,
  });
  const decisions: TemplateDecisionStateV1 = immutableJson({
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: reconciliation.decisions.decisions,
    preview: {},
  });
  const snapshot = await resolveTemplateLayers({
    catalog: input.catalog.descriptor,
    catalogDigest: input.catalog.digest,
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      design: input.baseline.design,
    },
    sourceDigest: input.current.analysis.sourceDigest,
    decisions,
    candidates: input.current.analysis.candidates,
    mappingVersion: input.current.analysis.mappingVersion,
  });
  return immutableJson({
    schema: TEMPLATE_PROJECT_STATE_SCHEMA_V1,
    catalog: input.current.catalog,
    baseline: input.current.baseline,
    analysis: input.current.analysis,
    decisions,
    snapshot,
    assetHandles: input.current.assetHandles,
  });
}

export async function assertPreparedTemplateProjectUndo(
  current: TemplateProjectStateV1,
  targetDecisions: TemplateDecisionStateV1,
  prepared: TemplateProjectStateV1
): Promise<void> {
  const expectedDecisionDigest = await sha256Hex(
    encoder.encode(canonicalCapabilityJson(prepared.decisions.decisions))
  );
  if (
    prepared.schema !== TEMPLATE_PROJECT_STATE_SCHEMA_V1 ||
    !sameJson(prepared.catalog, current.catalog) ||
    !sameJson(prepared.baseline, current.baseline) ||
    !sameJson(prepared.analysis, current.analysis) ||
    !sameJson(prepared.assetHandles, current.assetHandles) ||
    !sameJson(prepared.decisions.decisions, targetDecisions.decisions) ||
    Object.keys(prepared.decisions.preview).length > 0 ||
    prepared.decisions.builtFromDigest !== undefined ||
    prepared.snapshot.sourceDigest !== current.analysis.sourceDigest ||
    prepared.snapshot.decisionDigest !== expectedDecisionDigest
  ) {
    throw new Error(
      "Prepared undo must retain current analysis/assets and restore only target authoring intent"
    );
  }
}

/**
 * Replace derived analysis while preserving frozen authoring intent and asset
 * handles. Preview/build markers are invalidated; reconciliation marks every
 * accepted candidate or asset current or stale before the next commit.
 */
export async function reanalyzeTemplateProject(
  input: ReanalyzeTemplateProjectInputV1
): Promise<TemplateProjectStateV1> {
  const reconciliation = reconcileTemplateDecisions(input.current.decisions, {
    candidates: input.analysis.candidates,
    sourceDigest: input.analysis.sourceDigest,
    mappingVersion: input.analysis.mappingVersion,
    catalogDigest: input.catalog.digest,
  });
  const decisions: TemplateDecisionStateV1 = immutableJson({
    schema: TEMPLATE_DECISION_STATE_SCHEMA_V1,
    decisions: reconciliation.decisions.decisions,
    preview: {},
  });
  const snapshot = await resolveTemplateLayers({
    catalog: input.catalog.descriptor,
    catalogDigest: input.catalog.digest,
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      design: input.baseline.design,
    },
    sourceDigest: input.analysis.sourceDigest,
    decisions,
    candidates: input.analysis.candidates,
    mappingVersion: input.analysis.mappingVersion,
  });
  return immutableJson({
    schema: TEMPLATE_PROJECT_STATE_SCHEMA_V1,
    catalog: {
      id: input.catalog.id,
      version: input.catalog.version,
      digest: input.catalog.digest,
    },
    baseline: {
      id: input.baseline.id,
      version: input.baseline.version,
      digest: input.baseline.digest,
    },
    analysis: input.analysis,
    decisions,
    snapshot,
    assetHandles: input.current.assetHandles,
  });
}

/**
 * Deterministically pack the exact build description, then require a real
 * compiler gate before returning distributable bytes.
 */
export async function buildGeneratedPdfTemplatePack(
  build: TemplateProjectBuildV1,
  compiler: TemplateGeneratedPackCompilerV1
): Promise<{
  bytes: Uint8Array;
  compile: { digest: string; pageCount: number };
}> {
  if (
    build.schema !== TEMPLATE_PROJECT_BUILD_SCHEMA_V1 ||
    build.manifestJson !== stableJson(build.manifest) ||
    build.files[build.manifest.engine.entry] === undefined ||
    new TextDecoder().decode(build.files[build.manifest.engine.entry]!) !==
      build.canonicalTypst
  ) {
    fail(
      "non-canonical-source",
      ["reanalyze"],
      "The build description no longer matches its canonical source"
    );
  }
  await assertMinimalPack(
    build.manifest,
    build.canonicalTypst,
    build.files
  );
  const bytes = await packTemplate({
    manifest: build.manifest,
    files: Object.fromEntries(
      Object.entries(build.files).map(([path, value]) => [
        path,
        new Uint8Array(value),
      ])
    ),
  });
  const unpacked = unpackTemplate(bytes);
  const repacked = await packTemplate(unpacked);
  if (
    repacked.byteLength !== bytes.byteLength ||
    !new Uint8Array(repacked).every((byte, index) => byte === bytes[index])
  ) {
    fail("runtime-mismatch", ["reanalyze"], "Pack round-trip was not byte-identical");
  }
  const compile = await compiler.compile({
    packBytes: new Uint8Array(bytes),
    manifest: build.manifest,
    runtimeSnapshot: JSON.parse(build.runtimeSnapshotJson) as Readonly<
      Record<string, unknown>
    >,
  });
  assertDigest(compile.digest, "compile.digest");
  if (!Number.isSafeInteger(compile.pageCount) || compile.pageCount < 1) {
    fail("runtime-mismatch", ["reanalyze"], "Compiler returned no rendered page");
  }
  return {
    bytes: new Uint8Array(bytes),
    compile: immutableJson(compile),
  };
}
