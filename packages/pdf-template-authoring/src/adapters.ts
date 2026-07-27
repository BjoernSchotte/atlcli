import { sha256Hex } from "@atlcli/core";
import { canonicalCapabilityJson } from "@atlcli/template-pack";
import {
  TEMPLATE_PROJECT_GENERATION_SCHEMA_V1,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type TemplateDecisionStateV1,
  type TemplatePreviewCompiler,
  type TemplateProjectPreviewArtifactV1,
  type TemplatePreviewRequestV1,
  type TemplatePreviewResultV1,
  type TemplateProjectCommitV1,
  type TemplateProjectGenerationV1,
  type TemplateProjectHistoryItemV1,
  type TemplateProjectRepository,
  type TemplateProjectUndoV1,
  type VerifiedAssetCandidateV1,
} from "./contracts.js";
import { assertPreparedTemplateProjectUndo } from "./project.js";

async function digest(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalCapabilityJson(value)));
}

function clone<T>(value: T): T {
  return JSON.parse(canonicalCapabilityJson(value)) as T;
}

function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
  }
  return value;
}

function immutable<T>(value: T): T {
  return freeze(clone(value));
}

export class TemplateProjectNotFoundError extends Error {
  constructor(readonly projectId: string) {
    super(`Template project does not exist: ${projectId}`);
    this.name = "TemplateProjectNotFoundError";
  }
}

export class TemplateProjectGenerationConflictError extends Error {
  constructor(
    readonly projectId: string,
    readonly expected: string | null,
    readonly actual: string | null
  ) {
    super(`Template project generation conflict for ${projectId}`);
    this.name = "TemplateProjectGenerationConflictError";
  }
}

/**
 * Deterministic, browser-safe reference adapter used by contract tests and
 * embedders that want an ephemeral draft.
 */
export class InMemoryTemplateProjectRepository
  implements TemplateProjectRepository
{
  readonly #projects = new Map<string, TemplateProjectGenerationV1[]>();
  readonly #privateIntake = new Map<string, Readonly<Record<string, unknown>>>();
  readonly #previews = new Map<string, TemplateProjectPreviewArtifactV1>();

  async read(projectId: string): Promise<TemplateProjectGenerationV1> {
    const history = this.#projects.get(projectId);
    const current = history?.at(-1);
    if (!current) throw new TemplateProjectNotFoundError(projectId);
    return immutable(current);
  }

  async commit(
    input: TemplateProjectCommitV1
  ): Promise<TemplateProjectGenerationV1> {
    const history = this.#projects.get(input.projectId) ?? [];
    const current = history.at(-1);
    const actual = current?.generation ?? null;
    if (actual !== input.expectedGeneration) {
      throw new TemplateProjectGenerationConflictError(
        input.projectId,
        input.expectedGeneration,
        actual
      );
    }
    const payload = {
      projectId: input.projectId,
      parentGeneration: actual,
      analysisDigest: input.analysisDigest,
      decisions: input.decisions,
      ...(input.snapshotDigest === undefined
        ? {}
        : { snapshotDigest: input.snapshotDigest }),
      ...(input.project === undefined ? {} : { project: input.project }),
      ...(input.privateIntake === undefined
        ? {}
        : { privateIntakeDigest: await digest(input.privateIntake) }),
    };
    const generation: TemplateProjectGenerationV1 = {
      schema: TEMPLATE_PROJECT_GENERATION_SCHEMA_V1,
      ...payload,
      generation: await digest(payload),
    };
    history.push(immutable(generation));
    this.#projects.set(input.projectId, history);
    if (input.privateIntake !== undefined) {
      this.#privateIntake.set(
        `${input.projectId}:${generation.generation}`,
        immutable(input.privateIntake)
      );
    } else if (current?.privateIntakeDigest) {
      const inherited = this.#privateIntake.get(
        `${input.projectId}:${current.generation}`
      );
      if (inherited) {
        this.#privateIntake.set(
          `${input.projectId}:${generation.generation}`,
          inherited
        );
      }
    }
    return immutable(generation);
  }

  async listHistory(
    projectId: string
  ): Promise<readonly TemplateProjectHistoryItemV1[]> {
    const history = this.#projects.get(projectId);
    if (!history) throw new TemplateProjectNotFoundError(projectId);
    return immutable(
      history.map(({ generation, parentGeneration, analysisDigest }) => ({
        generation,
        parentGeneration,
        analysisDigest,
      }))
    );
  }

  async undo(input: TemplateProjectUndoV1): Promise<TemplateProjectGenerationV1> {
    const history = this.#projects.get(input.projectId);
    const current = history?.at(-1);
    if (!current) throw new TemplateProjectNotFoundError(input.projectId);
    if (current.generation !== input.expectedGeneration) {
      throw new TemplateProjectGenerationConflictError(
        input.projectId,
        input.expectedGeneration,
        current.generation
      );
    }
    const target = history?.find(
      ({ generation }) => generation === input.targetGeneration
    );
    if (!target) {
      throw new TemplateProjectNotFoundError(
        `${input.projectId}@${input.targetGeneration}`
      );
    }
    const restoredDecisions: TemplateDecisionStateV1 = immutable({
      ...target.decisions,
      preview: {},
    });
    let project;
    if (current.project && target.project) {
      if (!input.preparedProject) {
        throw new Error("Stateful project undo requires a prepared authoring result");
      }
      await assertPreparedTemplateProjectUndo(
        current.project,
        target.decisions,
        input.preparedProject
      );
      project = immutable(input.preparedProject);
    }
    const privateIntake = this.#privateIntake.get(
      `${input.projectId}:${current.generation}`
    );
    return this.commit({
      projectId: input.projectId,
      expectedGeneration: current.generation,
      analysisDigest: current.analysisDigest,
      decisions: restoredDecisions,
      ...((project?.snapshot.snapshotDigest ?? target.snapshotDigest) === undefined
        ? {}
        : {
            snapshotDigest:
              project?.snapshot.snapshotDigest ?? target.snapshotDigest,
          }),
      ...(project === undefined ? {} : { project }),
      ...(privateIntake === undefined ? {} : { privateIntake }),
    });
  }

  async putPreview(
    projectId: string,
    artifact: TemplateProjectPreviewArtifactV1
  ): Promise<void> {
    const current = await this.read(projectId);
    if (current.generation !== artifact.generation) {
      throw new TemplateProjectGenerationConflictError(
        projectId,
        artifact.generation,
        current.generation
      );
    }
    if (
      artifact.output.kind === "bytes"
        ? artifact.output.bytes.byteLength !== artifact.byteLength ||
          (await sha256Hex(artifact.output.bytes)) !== artifact.digest
        : artifact.output.handle.sha256 !== artifact.digest ||
          artifact.output.handle.byteLength !== artifact.byteLength
    ) {
      throw new Error("Template preview output does not match its metadata");
    }
    const verifiedCurrent = await this.read(projectId);
    if (verifiedCurrent.generation !== artifact.generation) {
      throw new TemplateProjectGenerationConflictError(
        projectId,
        artifact.generation,
        verifiedCurrent.generation
      );
    }
    const key = `${projectId}:${artifact.generation}:${artifact.purpose}`;
    const output =
      artifact.output.kind === "bytes"
        ? { kind: "bytes" as const, bytes: new Uint8Array(artifact.output.bytes) }
        : immutable(artifact.output);
    const copy = Object.freeze({
      ...immutable({
        generation: artifact.generation,
        purpose: artifact.purpose,
        snapshotDigest: artifact.snapshotDigest,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        pageCount: artifact.pageCount,
        regions: artifact.regions,
      }),
      output,
    });
    const existing = this.#previews.get(key);
    if (
      existing &&
      (existing.digest !== copy.digest ||
        existing.byteLength !== copy.byteLength)
    ) {
      throw new Error("Template preview already exists with different bytes");
    }
    this.#previews.set(key, copy);
  }

  async getPreview(
    projectId: string,
    generation: string,
    purpose: TemplatePreviewRequestV1["purpose"]
  ): Promise<TemplateProjectPreviewArtifactV1 | undefined> {
    const artifact = this.#previews.get(`${projectId}:${generation}:${purpose}`);
    if (!artifact) return undefined;
    return Object.freeze({
      ...immutable({
        generation: artifact.generation,
        purpose: artifact.purpose,
        snapshotDigest: artifact.snapshotDigest,
        digest: artifact.digest,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        pageCount: artifact.pageCount,
        regions: artifact.regions,
      }),
      output:
        artifact.output.kind === "bytes"
          ? {
              kind: "bytes" as const,
              bytes: new Uint8Array(artifact.output.bytes),
            }
          : immutable(artifact.output),
    });
  }
}

export class InMemoryTemplateAssetStore implements TemplateAssetStore {
  readonly #assets = new Map<string, { handle: TemplateAssetHandleV1; bytes: Uint8Array }>();

  async put(candidate: VerifiedAssetCandidateV1): Promise<TemplateAssetHandleV1> {
    const actual = await sha256Hex(candidate.bytes);
    if (actual !== candidate.sha256) {
      throw new Error("Verified asset digest does not match its bytes");
    }
    const handle: TemplateAssetHandleV1 = {
      id: `asset:${candidate.sha256}`,
      sha256: candidate.sha256,
      mediaType: candidate.mediaType,
      byteLength: candidate.bytes.byteLength,
    };
    this.#assets.set(handle.id, {
      handle: immutable(handle),
      bytes: new Uint8Array(candidate.bytes),
    });
    return immutable(handle);
  }

  async get(handle: TemplateAssetHandleV1): Promise<Uint8Array> {
    await this.verify(handle);
    const stored = this.#assets.get(handle.id);
    if (!stored) throw new Error("Template asset is unavailable");
    return new Uint8Array(stored.bytes);
  }

  async verify(handle: TemplateAssetHandleV1): Promise<void> {
    const stored = this.#assets.get(handle.id);
    if (
      !stored ||
      stored.handle.sha256 !== handle.sha256 ||
      stored.handle.mediaType !== handle.mediaType ||
      stored.handle.byteLength !== handle.byteLength ||
      (await sha256Hex(stored.bytes)) !== handle.sha256
    ) {
      throw new Error("Template asset verification failed");
    }
  }
}

export class InMemoryTemplatePreviewCompiler
  implements TemplatePreviewCompiler
{
  async render(
    input: TemplatePreviewRequestV1
  ): Promise<TemplatePreviewResultV1> {
    const canonical = new TextEncoder().encode(canonicalCapabilityJson(input));
    const regions: TemplatePreviewResultV1["regions"] =
      input.purpose === "asset-contact-sheet"
        ? [{ page: 1, region: "asset-grid" }]
        : input.purpose === "design-review"
          ? [
              { page: 1, region: "summary" },
              { page: 1, region: "baseline" },
              { page: 1, region: "current" },
            ]
          : [{ page: 1, region: "feature-zoo" }];
    const result: TemplatePreviewResultV1 = {
      digest: await sha256Hex(canonical),
      mediaType: "application/pdf",
      byteLength: canonical.byteLength,
      pageCount: 1,
      regions,
      output: { kind: "bytes", bytes: new Uint8Array(canonical) },
    };
    Object.freeze(result.regions);
    Object.freeze(result.output);
    return Object.freeze(result);
  }
}
