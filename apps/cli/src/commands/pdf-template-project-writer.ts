/**
 * Node filesystem adapters for host-neutral PDF template projects.
 *
 * The authoring package owns state transitions and build semantics. This file
 * owns only safe paths, immutable generation persistence, optimistic locking,
 * preview bytes, and content-addressed private assets.
 */
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { sha256Hex } from "@atlcli/core";
import {
  TEMPLATE_PROJECT_GENERATION_SCHEMA_V1,
  TemplateProjectGenerationConflictError,
  TemplateProjectNotFoundError,
  assertPreparedTemplateProjectUndo,
  type TemplateAssetHandleV1,
  type TemplateAssetStore,
  type TemplateDecisionStateV1,
  type TemplatePreviewRequestV1,
  type TemplateProjectBuildV1,
  type TemplateProjectCommitV1,
  type TemplateProjectGenerationV1,
  type TemplateProjectHistoryItemV1,
  type TemplateProjectPreviewArtifactV1,
  type TemplateProjectRepository,
  type TemplateProjectUndoV1,
  type VerifiedAssetCandidateV1,
} from "@atlcli/pdf-template-authoring";
import { canonicalCapabilityJson } from "@atlcli/template-pack";

const PROJECT_MARKER_SCHEMA = "wiki.pdf-template-project/v1" as const;
const CURRENT_SCHEMA = "wiki.pdf-template-project-current/v1" as const;
const LOCK_SCHEMA = "wiki.pdf-template-project-lock/v1" as const;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROJECT_ID_RE = /^[A-Za-z][A-Za-z0-9._:-]{0,191}$/;
const HASH_RE = /^[a-f0-9]{64}$/;

interface ProjectMarkerV1 {
  schema: typeof PROJECT_MARKER_SCHEMA;
  projectId: string;
}

interface CurrentMarkerV1 {
  schema: typeof CURRENT_SCHEMA;
  projectId: string;
  generation: string;
}

interface ProjectLockV1 {
  schema: typeof LOCK_SCHEMA;
  ownerId: string;
  pid: number;
  acquiredAt: number;
  expiresAt: number;
  baseGeneration: string | null;
}

export type PdfTemplateProjectFsErrorCode =
  | "project-exists"
  | "project-busy"
  | "unsafe-entry"
  | "corrupt-project"
  | "preview-conflict";

export class PdfTemplateProjectFsError extends Error {
  constructor(
    readonly code: PdfTemplateProjectFsErrorCode,
    message: string
  ) {
    super(message);
    this.name = "PdfTemplateProjectFsError";
  }
}

export interface DirectoryTemplateProjectRepositoryOptions {
  now?: () => number;
  leaseMs?: number;
  ownerId?: () => string;
  fault?: "after-generation-write" | "after-pointer-swap";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function statNoFollow(
  path: string
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function stableJson(value: unknown): string {
  return `${canonicalCapabilityJson(value)}\n`;
}

function immutableJson<T>(value: T): T {
  return Object.freeze(JSON.parse(canonicalCapabilityJson(value)) as T);
}

async function digestJson(value: unknown): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalCapabilityJson(value)));
}

function assertProjectId(projectId: string): void {
  if (!PROJECT_ID_RE.test(projectId)) {
    throw new PdfTemplateProjectFsError(
      "corrupt-project",
      "Template project id is not a stable identifier"
    );
  }
}

function assertChild(root: string, path: string): void {
  const absoluteRoot = resolve(root);
  const absolute = resolve(path);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}${sep}`)) {
    throw new PdfTemplateProjectFsError(
      "unsafe-entry",
      "Generated project path escaped the project directory"
    );
  }
}

async function ensureDirectoryNoLinks(path: string): Promise<void> {
  const existing = await statNoFollow(path);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new PdfTemplateProjectFsError(
        "unsafe-entry",
        `Refusing non-directory project path ${path}`
      );
    }
    return;
  }
  await mkdir(path, { mode: PRIVATE_DIRECTORY_MODE });
  await chmod(path, PRIVATE_DIRECTORY_MODE);
}

async function readRegular(path: string): Promise<Uint8Array> {
  const info = await statNoFollow(path);
  if (!info || !info.isFile() || info.isSymbolicLink()) {
    throw new PdfTemplateProjectFsError(
      "unsafe-entry",
      `Refusing non-regular project file ${path}`
    );
  }
  return new Uint8Array(await readFile(path));
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(new TextDecoder().decode(await readRegular(path))) as T;
  } catch (error) {
    if (error instanceof PdfTemplateProjectFsError) throw error;
    throw new PdfTemplateProjectFsError(
      "corrupt-project",
      `Template project JSON is unreadable: ${basename(path)}`
    );
  }
}

async function atomicWrite(path: string, value: Uint8Array | string): Promise<void> {
  const directory = dirname(path);
  await ensureDirectoryNoLinks(directory);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", PRIVATE_FILE_MODE);
  let moved = false;
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    await rename(temporary, path);
    moved = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!moved) await unlink(temporary).catch(() => undefined);
  }
}

function generationPayload(
  input: TemplateProjectCommitV1,
  parentGeneration: string | null,
  privateIntakeDigest?: string
): Omit<TemplateProjectGenerationV1, "generation" | "schema"> {
  return {
    projectId: input.projectId,
    parentGeneration,
    analysisDigest: input.analysisDigest,
    decisions: input.decisions,
    ...(input.snapshotDigest === undefined
      ? {}
      : { snapshotDigest: input.snapshotDigest }),
    ...(input.project === undefined ? {} : { project: input.project }),
    ...(privateIntakeDigest === undefined ? {} : { privateIntakeDigest }),
  };
}

async function makeGeneration(
  input: TemplateProjectCommitV1,
  parentGeneration: string | null,
  privateIntakeDigest?: string
): Promise<TemplateProjectGenerationV1> {
  const payload = generationPayload(input, parentGeneration, privateIntakeDigest);
  return immutableJson({
    schema: TEMPLATE_PROJECT_GENERATION_SCHEMA_V1,
    ...payload,
    generation: await digestJson(payload),
  });
}

function previewMetadata(
  artifact: TemplateProjectPreviewArtifactV1
): Omit<TemplateProjectPreviewArtifactV1, "output"> & {
  output: { kind: "bytes"; file: string } | { kind: "asset-handle"; handle: TemplateAssetHandleV1 };
} {
  return {
    generation: artifact.generation,
    purpose: artifact.purpose,
    snapshotDigest: artifact.snapshotDigest,
    digest: artifact.digest,
    mediaType: artifact.mediaType,
    byteLength: artifact.byteLength,
    pageCount: artifact.pageCount,
    regions: artifact.regions,
    output:
      artifact.output.kind === "bytes"
        ? { kind: "bytes", file: `${artifact.purpose}.pdf` }
        : artifact.output,
  };
}

export class DirectoryTemplateProjectRepository
  implements TemplateProjectRepository
{
  readonly root: string;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #ownerId: () => string;
  readonly #fault?: DirectoryTemplateProjectRepositoryOptions["fault"];

  constructor(
    root: string,
    options: DirectoryTemplateProjectRepositoryOptions = {}
  ) {
    this.root = resolve(root);
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#ownerId = options.ownerId ?? randomUUID;
    this.#fault = options.fault;
    if (!Number.isFinite(this.#leaseMs) || this.#leaseMs <= 0) {
      throw new RangeError("Project lock lease must be positive");
    }
  }

  #markerPath(): string {
    return join(this.root, "project.json");
  }

  #currentPath(): string {
    return join(this.root, "current.json");
  }

  #generationPath(generation: string): string {
    if (!HASH_RE.test(generation)) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Generation is not a SHA-256 digest"
      );
    }
    return join(this.root, "state", generation, "generation.json");
  }

  #privatePath(generation: string): string {
    return join(this.root, ".intake", "state", `${generation}.json`);
  }

  async #assertRoot(projectId: string): Promise<void> {
    const rootInfo = await statNoFollow(this.root);
    if (!rootInfo) throw new TemplateProjectNotFoundError(projectId);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      throw new PdfTemplateProjectFsError(
        "unsafe-entry",
        "Template project root must be a real directory"
      );
    }
    const marker = await readJson<ProjectMarkerV1>(this.#markerPath());
    if (
      marker.schema !== PROJECT_MARKER_SCHEMA ||
      marker.projectId !== projectId
    ) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Template project marker does not match the requested project"
      );
    }
  }

  async #readCurrent(projectId: string): Promise<CurrentMarkerV1> {
    await this.#assertRoot(projectId);
    const current = await readJson<CurrentMarkerV1>(this.#currentPath());
    if (
      current.schema !== CURRENT_SCHEMA ||
      current.projectId !== projectId ||
      !HASH_RE.test(current.generation)
    ) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Template project current pointer is invalid"
      );
    }
    return current;
  }

  async #readGeneration(
    projectId: string,
    generation: string
  ): Promise<TemplateProjectGenerationV1> {
    const value = await readJson<TemplateProjectGenerationV1>(
      this.#generationPath(generation)
    );
    if (
      value.schema !== TEMPLATE_PROJECT_GENERATION_SCHEMA_V1 ||
      value.projectId !== projectId ||
      value.generation !== generation
    ) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Template project generation identity is invalid"
      );
    }
    const { schema: _schema, generation: _generation, ...payload } = value;
    if ((await digestJson(payload)) !== generation) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Template project generation digest does not match its contents"
      );
    }
    if (value.privateIntakeDigest) {
      const privateBytes = await readRegular(this.#privatePath(generation));
      if ((await sha256Hex(privateBytes)) !== value.privateIntakeDigest) {
        throw new PdfTemplateProjectFsError(
          "corrupt-project",
          "Private intake sidecar failed its digest check"
        );
      }
    }
    return immutableJson(value);
  }

  async read(projectId: string): Promise<TemplateProjectGenerationV1> {
    const current = await this.#readCurrent(projectId);
    return this.#readGeneration(projectId, current.generation);
  }

  async #initialize(
    input: TemplateProjectCommitV1
  ): Promise<TemplateProjectGenerationV1> {
    if (input.expectedGeneration !== null) {
      throw new TemplateProjectNotFoundError(input.projectId);
    }
    if (await exists(this.root)) {
      throw new PdfTemplateProjectFsError(
        "project-exists",
        "Initialization requires a target path that does not exist"
      );
    }
    const privateBytes =
      input.privateIntake === undefined
        ? undefined
        : new TextEncoder().encode(canonicalCapabilityJson(input.privateIntake));
    const generation = await makeGeneration(
      input,
      null,
      privateBytes ? await sha256Hex(privateBytes) : undefined
    );
    const parent = dirname(this.root);
    await ensureDirectoryNoLinks(parent);
    const staging = join(
      parent,
      `.${basename(this.root)}.atlcli-staging-${randomUUID()}`
    );
    await mkdir(staging, { mode: PRIVATE_DIRECTORY_MODE });
    let moved = false;
    try {
      await ensureDirectoryNoLinks(join(staging, "state"));
      await ensureDirectoryNoLinks(
        join(staging, "state", generation.generation)
      );
      await atomicWrite(
        join(staging, "project.json"),
        stableJson({ schema: PROJECT_MARKER_SCHEMA, projectId: input.projectId })
      );
      await atomicWrite(
        join(staging, "state", generation.generation, "generation.json"),
        stableJson(generation)
      );
      if (privateBytes) {
        await ensureDirectoryNoLinks(join(staging, ".intake"));
        await ensureDirectoryNoLinks(join(staging, ".intake", "state"));
        await atomicWrite(
          join(staging, ".intake", "state", `${generation.generation}.json`),
          privateBytes
        );
      }
      await atomicWrite(
        join(staging, "current.json"),
        stableJson({
          schema: CURRENT_SCHEMA,
          projectId: input.projectId,
          generation: generation.generation,
        })
      );
      if (await exists(this.root)) {
        throw new PdfTemplateProjectFsError(
          "project-exists",
          "Initialization target appeared while the project was staged"
        );
      }
      await rename(staging, this.root);
      moved = true;
      return this.read(input.projectId);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code === "EEXIST" ||
        (error as NodeJS.ErrnoException).code === "ENOTEMPTY"
      ) {
        throw new PdfTemplateProjectFsError(
          "project-exists",
          "Initialization target already exists"
        );
      }
      throw error;
    } finally {
      if (!moved) await rm(staging, { recursive: true, force: true });
    }
  }

  async #acquireLock(baseGeneration: string | null): Promise<ProjectLockV1> {
    const path = join(this.root, ".project.lock");
    const create = async (): Promise<ProjectLockV1> => {
      const acquiredAt = this.#now();
      const lock: ProjectLockV1 = {
        schema: LOCK_SCHEMA,
        ownerId: this.#ownerId(),
        pid: process.pid,
        acquiredAt,
        expiresAt: acquiredAt + this.#leaseMs,
        baseGeneration,
      };
      const handle = await open(path, "wx", PRIVATE_FILE_MODE);
      try {
        await handle.writeFile(stableJson(lock));
        await handle.sync();
      } finally {
        await handle.close();
      }
      return lock;
    };
    try {
      return await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const info = await statNoFollow(path);
    if (!info || !info.isFile() || info.isSymbolicLink()) {
      throw new PdfTemplateProjectFsError(
        "unsafe-entry",
        "Project lock is not a regular file"
      );
    }
    const existing = await readJson<ProjectLockV1>(path);
    const current = await this.#readCurrent(
      (await readJson<ProjectMarkerV1>(this.#markerPath())).projectId
    );
    if (
      existing.schema !== LOCK_SCHEMA ||
      existing.expiresAt > this.#now() ||
      existing.baseGeneration !== current.generation ||
      baseGeneration !== current.generation
    ) {
      throw new PdfTemplateProjectFsError(
        "project-busy",
        "Another writer owns the template project"
      );
    }
    const quarantine = join(
      this.root,
      `.project.lock.stale-${existing.ownerId}-${randomUUID()}`
    );
    await rename(path, quarantine);
    await unlink(quarantine);
    const afterRecovery = await this.#readCurrent(current.projectId);
    if (afterRecovery.generation !== baseGeneration) {
      throw new TemplateProjectGenerationConflictError(
        current.projectId,
        baseGeneration,
        afterRecovery.generation
      );
    }
    try {
      return await create();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new PdfTemplateProjectFsError(
          "project-busy",
          "Another writer acquired the recovered project lock"
        );
      }
      throw error;
    }
  }

  async #releaseLock(lock: ProjectLockV1): Promise<void> {
    const path = join(this.root, ".project.lock");
    const current = await readJson<ProjectLockV1>(path).catch(() => undefined);
    if (current?.ownerId === lock.ownerId) {
      await unlink(path);
    }
  }

  async #writeGeneration(
    generation: TemplateProjectGenerationV1,
    privateBytes?: Uint8Array
  ): Promise<void> {
    const stateRoot = join(this.root, "state");
    await ensureDirectoryNoLinks(stateRoot);
    const target = join(stateRoot, generation.generation);
    const existing = await statNoFollow(target);
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        throw new PdfTemplateProjectFsError(
          "unsafe-entry",
          "Generation target is not a real directory"
        );
      }
      const prior = await readRegular(join(target, "generation.json"));
      if (new TextDecoder().decode(prior) !== stableJson(generation)) {
        throw new PdfTemplateProjectFsError(
          "corrupt-project",
          "Existing immutable generation has different contents"
        );
      }
    } else {
      const staging = join(stateRoot, `.${generation.generation}.${randomUUID()}.tmp`);
      await mkdir(staging, { mode: PRIVATE_DIRECTORY_MODE });
      let moved = false;
      try {
        await atomicWrite(
          join(staging, "generation.json"),
          stableJson(generation)
        );
        await rename(staging, target);
        moved = true;
      } finally {
        if (!moved) await rm(staging, { recursive: true, force: true });
      }
    }
    if (privateBytes) {
      const privatePath = this.#privatePath(generation.generation);
      const existingPrivate = await statNoFollow(privatePath);
      if (existingPrivate) {
        const prior = await readRegular(privatePath);
        if ((await sha256Hex(prior)) !== generation.privateIntakeDigest) {
          throw new PdfTemplateProjectFsError(
            "corrupt-project",
            "Existing private intake generation has different contents"
          );
        }
      } else {
        await atomicWrite(privatePath, privateBytes);
      }
    }
    await this.#readGeneration(generation.projectId, generation.generation);
  }

  async commit(
    input: TemplateProjectCommitV1
  ): Promise<TemplateProjectGenerationV1> {
    assertProjectId(input.projectId);
    if (!(await exists(this.root))) return this.#initialize(input);
    const current = await this.#readCurrent(input.projectId);
    const lock = await this.#acquireLock(current.generation);
    try {
      const lockedCurrent = await this.#readCurrent(input.projectId);
      if (lockedCurrent.generation !== input.expectedGeneration) {
        throw new TemplateProjectGenerationConflictError(
          input.projectId,
          input.expectedGeneration,
          lockedCurrent.generation
        );
      }
      const previous = await this.#readGeneration(
        input.projectId,
        lockedCurrent.generation
      );
      let privateBytes: Uint8Array | undefined;
      if (input.privateIntake !== undefined) {
        privateBytes = new TextEncoder().encode(
          canonicalCapabilityJson(input.privateIntake)
        );
      } else if (previous.privateIntakeDigest) {
        privateBytes = await readRegular(this.#privatePath(previous.generation));
      }
      const generation = await makeGeneration(
        input,
        previous.generation,
        privateBytes ? await sha256Hex(privateBytes) : undefined
      );
      await this.#writeGeneration(generation, privateBytes);
      if (this.#fault === "after-generation-write") {
        throw new Error("Injected failure after generation write");
      }
      await atomicWrite(
        this.#currentPath(),
        stableJson({
          schema: CURRENT_SCHEMA,
          projectId: input.projectId,
          generation: generation.generation,
        })
      );
      if (this.#fault === "after-pointer-swap") {
        throw new Error("Injected failure after pointer swap");
      }
      return this.read(input.projectId);
    } finally {
      await this.#releaseLock(lock);
    }
  }

  async listHistory(
    projectId: string
  ): Promise<readonly TemplateProjectHistoryItemV1[]> {
    let current = await this.read(projectId);
    const reverse: TemplateProjectHistoryItemV1[] = [];
    for (;;) {
      reverse.push({
        generation: current.generation,
        parentGeneration: current.parentGeneration,
        analysisDigest: current.analysisDigest,
      });
      if (!current.parentGeneration) break;
      current = await this.#readGeneration(projectId, current.parentGeneration);
    }
    return immutableJson(reverse.reverse());
  }

  async undo(input: TemplateProjectUndoV1): Promise<TemplateProjectGenerationV1> {
    const current = await this.read(input.projectId);
    if (current.generation !== input.expectedGeneration) {
      throw new TemplateProjectGenerationConflictError(
        input.projectId,
        input.expectedGeneration,
        current.generation
      );
    }
    const target = await this.#readGeneration(
      input.projectId,
      input.targetGeneration
    );
    const restoredDecisions: TemplateDecisionStateV1 = immutableJson({
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
      project = immutableJson(input.preparedProject);
    }
    const privateIntake = current.privateIntakeDigest
      ? await this.readPrivateIntake(current.generation)
      : undefined;
    return this.commit({
      projectId: input.projectId,
      expectedGeneration: current.generation,
      analysisDigest: current.analysisDigest,
      decisions: restoredDecisions,
      ...(project?.snapshot.snapshotDigest ?? target.snapshotDigest
        ? {
            snapshotDigest:
              project?.snapshot.snapshotDigest ?? target.snapshotDigest,
          }
        : {}),
      ...(project ? { project } : {}),
      ...(privateIntake ? { privateIntake } : {}),
    });
  }

  async readPrivateIntake(
    generation: string
  ): Promise<Readonly<Record<string, unknown>>> {
    return immutableJson(
      await readJson<Readonly<Record<string, unknown>>>(
        this.#privatePath(generation)
      )
    );
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
    const lock = await this.#acquireLock(current.generation);
    try {
      const lockedCurrent = await this.#readCurrent(projectId);
      if (lockedCurrent.generation !== artifact.generation) {
        throw new TemplateProjectGenerationConflictError(
          projectId,
          artifact.generation,
          lockedCurrent.generation
        );
      }
      const directory = join(this.root, "previews", artifact.generation);
      await ensureDirectoryNoLinks(join(this.root, "previews"));
      await ensureDirectoryNoLinks(directory);
      const metadataPath = join(directory, `${artifact.purpose}.json`);
      const existing = await statNoFollow(metadataPath);
      if (existing) {
        const prior = await this.getPreview(
          projectId,
          artifact.generation,
          artifact.purpose
        );
        if (
          !prior ||
          prior.digest !== artifact.digest ||
          prior.byteLength !== artifact.byteLength
        ) {
          throw new PdfTemplateProjectFsError(
            "preview-conflict",
            "A different preview already exists for this generation"
          );
        }
        return;
      }
      if (artifact.output.kind === "bytes") {
        if (
          artifact.output.bytes.byteLength !== artifact.byteLength ||
          (await sha256Hex(artifact.output.bytes)) !== artifact.digest
        ) {
          throw new PdfTemplateProjectFsError(
            "corrupt-project",
            "Preview bytes do not match their metadata"
          );
        }
        await atomicWrite(
          join(directory, `${artifact.purpose}.pdf`),
          artifact.output.bytes
        );
      } else if (
        artifact.output.handle.sha256 !== artifact.digest ||
        artifact.output.handle.byteLength !== artifact.byteLength
      ) {
        throw new PdfTemplateProjectFsError(
          "corrupt-project",
          "Preview handle does not match its metadata"
        );
      }
      await atomicWrite(metadataPath, stableJson(previewMetadata(artifact)));
    } finally {
      await this.#releaseLock(lock);
    }
  }

  async getPreview(
    projectId: string,
    generation: string,
    purpose: TemplatePreviewRequestV1["purpose"]
  ): Promise<TemplateProjectPreviewArtifactV1 | undefined> {
    await this.#assertRoot(projectId);
    const path = join(this.root, "previews", generation, `${purpose}.json`);
    if (!(await exists(path))) return undefined;
    const metadata = await readJson<ReturnType<typeof previewMetadata>>(path);
    if (
      metadata.generation !== generation ||
      metadata.purpose !== purpose ||
      metadata.mediaType !== "application/pdf"
    ) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Preview metadata identity is invalid"
      );
    }
    if (metadata.output.kind === "asset-handle") {
      return immutableJson(metadata as TemplateProjectPreviewArtifactV1);
    }
    const bytes = await readRegular(
      join(this.root, "previews", generation, metadata.output.file)
    );
    if (
      bytes.byteLength !== metadata.byteLength ||
      (await sha256Hex(bytes)) !== metadata.digest
    ) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Preview bytes failed their digest check"
      );
    }
    return Object.freeze({
      ...immutableJson({
        generation: metadata.generation,
        purpose: metadata.purpose,
        snapshotDigest: metadata.snapshotDigest,
        digest: metadata.digest,
        mediaType: metadata.mediaType,
        byteLength: metadata.byteLength,
        pageCount: metadata.pageCount,
        regions: metadata.regions,
      }),
      output: { kind: "bytes" as const, bytes },
    });
  }
}

export class DirectoryTemplateAssetStore implements TemplateAssetStore {
  readonly root: string;

  constructor(projectRoot: string) {
    this.root = join(resolve(projectRoot), ".intake", "assets");
  }

  #paths(sha256: string): { bytes: string; metadata: string } {
    if (!HASH_RE.test(sha256)) {
      throw new PdfTemplateProjectFsError(
        "corrupt-project",
        "Asset handle is not a SHA-256 digest"
      );
    }
    return {
      bytes: join(this.root, `${sha256}.bin`),
      metadata: join(this.root, `${sha256}.json`),
    };
  }

  async put(candidate: VerifiedAssetCandidateV1): Promise<TemplateAssetHandleV1> {
    if ((await sha256Hex(candidate.bytes)) !== candidate.sha256) {
      throw new Error("Verified asset digest does not match its bytes");
    }
    await ensureDirectoryNoLinks(dirname(this.root));
    await ensureDirectoryNoLinks(this.root);
    const paths = this.#paths(candidate.sha256);
    const handle: TemplateAssetHandleV1 = {
      id: `asset:${candidate.sha256}`,
      sha256: candidate.sha256,
      mediaType: candidate.mediaType,
      byteLength: candidate.bytes.byteLength,
    };
    if (await exists(paths.bytes)) {
      const existing = await readRegular(paths.bytes);
      if (
        existing.byteLength !== candidate.bytes.byteLength ||
        (await sha256Hex(existing)) !== candidate.sha256
      ) {
        throw new PdfTemplateProjectFsError(
          "corrupt-project",
          "Content-addressed asset path contains different bytes"
        );
      }
    } else {
      await atomicWrite(paths.bytes, candidate.bytes);
    }
    if (await exists(paths.metadata)) {
      const existing = await readJson<TemplateAssetHandleV1>(paths.metadata);
      if (canonicalCapabilityJson(existing) !== canonicalCapabilityJson(handle)) {
        throw new PdfTemplateProjectFsError(
          "corrupt-project",
          "Content-addressed asset metadata conflicts"
        );
      }
    } else {
      await atomicWrite(paths.metadata, stableJson(handle));
    }
    return immutableJson(handle);
  }

  async get(handle: TemplateAssetHandleV1): Promise<Uint8Array> {
    await this.verify(handle);
    return readRegular(this.#paths(handle.sha256).bytes);
  }

  async verify(handle: TemplateAssetHandleV1): Promise<void> {
    if (handle.id !== `asset:${handle.sha256}`) {
      throw new Error("Template asset verification failed");
    }
    const paths = this.#paths(handle.sha256);
    const metadata = await readJson<TemplateAssetHandleV1>(paths.metadata);
    const bytes = await readRegular(paths.bytes);
    if (
      canonicalCapabilityJson(metadata) !== canonicalCapabilityJson(handle) ||
      bytes.byteLength !== handle.byteLength ||
      (await sha256Hex(bytes)) !== handle.sha256
    ) {
      throw new Error("Template asset verification failed");
    }
  }
}

/**
 * Copy only already-confirmed, build-owned asset members into the project
 * `assets/` area. Existing files are never replaced or removed.
 */
export async function copyAcceptedTemplateProjectAssets(
  projectRoot: string,
  build: TemplateProjectBuildV1
): Promise<readonly string[]> {
  const root = resolve(projectRoot);
  const written: string[] = [];
  for (const [relative, bytes] of Object.entries(build.files)
    .filter(([path]) => path.startsWith("assets/"))
    .sort(([left], [right]) => left.localeCompare(right))) {
    const target = join(root, relative);
    assertChild(root, target);
    const parts = relative.split("/").slice(0, -1);
    let directory = root;
    for (const part of parts) {
      directory = join(directory, part);
      await ensureDirectoryNoLinks(directory);
    }
    if (await exists(target)) {
      const existing = await readRegular(target);
      if (
        existing.byteLength !== bytes.byteLength ||
        (await sha256Hex(existing)) !== (await sha256Hex(bytes))
      ) {
        throw new PdfTemplateProjectFsError(
          "unsafe-entry",
          `Refusing to overwrite modified accepted asset ${relative}`
        );
      }
    } else {
      await atomicWrite(target, bytes);
    }
    written.push(relative);
  }
  return Object.freeze(written);
}

export async function listTemplateProjectRootEntries(
  projectRoot: string
): Promise<readonly string[]> {
  return Object.freeze((await readdir(projectRoot)).sort());
}
