import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  templatePackRecordKey,
  type PdfTemplatePackReferenceV1,
  type TemplatePackReachabilityV1,
  type TemplatePackRecordV1,
  type TemplatePackReconcileResultV1,
  type TemplatePackStoreLimitsV1,
  type TemplatePackStoreV1,
} from "@atlcli/export-jobs";
import {
  ensurePrivateDirectory,
  writeDurableAtomic,
} from "./atomic-fs.js";
import { FileExportLock } from "./file-lock.js";
import { readJsonFiles } from "./file-byte-utils.js";

interface FileTemplatePackRecordV1 extends TemplatePackRecordV1 {
  schema: "atlcli.template-pack-record/1";
}

interface FileTemplatePackLinksV1 {
  schema: "atlcli.template-pack-links/1";
  recordKey: string;
  references: TemplatePackReachabilityV1[];
  updatedAt: number;
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function keyDigest(recordKey: string): string {
  return createHash("sha256").update(recordKey).digest("hex");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw (
      signal.reason ??
      new DOMException("Template pack operation was cancelled.", "AbortError")
    );
  }
}

function validateLimits(limits: TemplatePackStoreLimitsV1): void {
  if (
    !Number.isSafeInteger(limits.maxObjectBytes) ||
    limits.maxObjectBytes < 0 ||
    !Number.isSafeInteger(limits.maxTotalBytes) ||
    limits.maxTotalBytes < 0
  ) {
    throw new RangeError(
      "Template pack limits must be non-negative safe integers."
    );
  }
}

function validateReference(reference: PdfTemplatePackReferenceV1): void {
  if (
    reference.kind !== "pack" ||
    reference.recordKey !== templatePackRecordKey(reference.archiveSha256)
  ) {
    throw new Error("Invalid content-addressed template pack reference.");
  }
}

/** Durable file implementation of the host-wide template-pack store. */
export class FileTemplatePackStoreV1 implements TemplatePackStoreV1 {
  readonly #recordsDir: string;
  readonly #linksDir: string;
  readonly #lock: FileExportLock;

  constructor(
    readonly rootDir: string,
    options: { lockTtlMs?: number; now?: () => number } = {}
  ) {
    this.#recordsDir = join(rootDir, "template-packs", "records");
    this.#linksDir = join(rootDir, "template-packs", "links");
    this.#lock = new FileExportLock(
      join(rootDir, "locks", "template-packs.lock"),
      {
        ttlMs: options.lockTtlMs ?? 30_000,
        now: options.now,
      }
    );
  }

  #markerPath(recordKey: string): string {
    return join(this.#recordsDir, `${keyDigest(recordKey)}.json`);
  }

  #dataPath(recordKey: string): string {
    return join(this.#recordsDir, `${keyDigest(recordKey)}.bin`);
  }

  #linksPath(recordKey: string): string {
    return join(this.#linksDir, `${keyDigest(recordKey)}.json`);
  }

  async #markers(): Promise<FileTemplatePackRecordV1[]> {
    return (await readJsonFiles<FileTemplatePackRecordV1>(this.#recordsDir)).map(
      ({ value }) => value
    );
  }

  async put(input: {
    bytes: Uint8Array;
    limits: TemplatePackStoreLimitsV1;
    now: number;
    signal?: AbortSignal;
  }): Promise<TemplatePackRecordV1> {
    throwIfAborted(input.signal);
    validateLimits(input.limits);
    if (!(input.bytes instanceof Uint8Array)) {
      throw new TypeError("Template pack bytes must be a Uint8Array.");
    }
    if (input.bytes.byteLength > input.limits.maxObjectBytes) {
      throw new RangeError("Template pack object byte limit exceeded.");
    }
    const bytes = new Uint8Array(input.bytes);
    const archiveSha256 = digest(bytes);
    const recordKey = templatePackRecordKey(archiveSha256);
    await ensurePrivateDirectory(this.#recordsDir);
    const lease = await this.#lock.acquire({
      signal: input.signal,
      label: "template-pack-put",
    });
    try {
      throwIfAborted(input.signal);
      const markers = await this.#markers();
      const existing = markers.find(
        (record) => record.recordKey === recordKey
      );
      if (existing) {
        await this.get(
          { kind: "pack", recordKey, archiveSha256 },
          { signal: input.signal }
        );
        return structuredClone(existing);
      }
      const total =
        markers.reduce((sum, record) => sum + record.byteLength, 0) +
        bytes.byteLength;
      if (total > input.limits.maxTotalBytes) {
        throw new RangeError("Template pack total byte limit exceeded.");
      }
      const record: FileTemplatePackRecordV1 = {
        schema: "atlcli.template-pack-record/1",
        recordKey,
        archiveSha256,
        byteLength: bytes.byteLength,
        createdAt: input.now,
      };
      await writeDurableAtomic(this.#dataPath(recordKey), bytes);
      await writeDurableAtomic(
        this.#markerPath(recordKey),
        `${JSON.stringify(record)}\n`
      );
      return structuredClone(record);
    } finally {
      await lease.release();
    }
  }

  async get(
    reference: PdfTemplatePackReferenceV1,
    options?: { signal?: AbortSignal }
  ): Promise<{ record: TemplatePackRecordV1; bytes: Uint8Array }> {
    throwIfAborted(options?.signal);
    validateReference(reference);
    const marker = (await this.#markers()).find(
      (record) => record.recordKey === reference.recordKey
    );
    if (!marker) throw new Error("Template pack record was not found.");
    const bytes = new Uint8Array(await readFile(this.#dataPath(reference.recordKey)));
    throwIfAborted(options?.signal);
    if (
      marker.schema !== "atlcli.template-pack-record/1" ||
      marker.archiveSha256 !== reference.archiveSha256 ||
      marker.recordKey !== reference.recordKey ||
      marker.byteLength !== bytes.byteLength ||
      digest(bytes) !== reference.archiveSha256
    ) {
      throw new Error("Template pack record failed integrity verification.");
    }
    return { record: structuredClone(marker), bytes };
  }

  async verify(
    reference: PdfTemplatePackReferenceV1,
    options?: { signal?: AbortSignal }
  ): Promise<TemplatePackRecordV1> {
    return (await this.get(reference, options)).record;
  }

  async link(
    input: TemplatePackReachabilityV1 & { at: number }
  ): Promise<void> {
    await this.verify({
      kind: "pack",
      recordKey: input.recordKey,
      archiveSha256: input.archiveSha256,
    });
    if (!input.jobId || !input.requestRef || !Number.isFinite(input.at)) {
      throw new Error("Template pack reachability link is invalid.");
    }
    await ensurePrivateDirectory(this.#linksDir);
    const lease = await this.#lock.acquire({ label: "template-pack-link" });
    try {
      const existing = (
        await readJsonFiles<FileTemplatePackLinksV1>(this.#linksDir)
      ).find(({ value }) => value.recordKey === input.recordKey)?.value;
      const references = new Map(
        (existing?.references ?? []).map((reference) => [
          reference.jobId,
          reference,
        ])
      );
      references.set(input.jobId, {
        jobId: input.jobId,
        requestRef: input.requestRef,
        recordKey: input.recordKey,
        archiveSha256: input.archiveSha256,
      });
      const links: FileTemplatePackLinksV1 = {
        schema: "atlcli.template-pack-links/1",
        recordKey: input.recordKey,
        references: [...references.values()].sort((left, right) =>
          left.jobId.localeCompare(right.jobId)
        ),
        updatedAt: input.at,
      };
      await writeDurableAtomic(
        this.#linksPath(input.recordKey),
        `${JSON.stringify(links)}\n`
      );
    } finally {
      await lease.release();
    }
  }

  async reconcile(input: {
    completeScan: true;
    references: readonly TemplatePackReachabilityV1[];
    now: number;
    orphanGraceMs: number;
  }): Promise<TemplatePackReconcileResultV1> {
    if (
      input.completeScan !== true ||
      !Number.isFinite(input.now) ||
      !Number.isFinite(input.orphanGraceMs) ||
      input.orphanGraceMs < 0
    ) {
      throw new Error(
        "Template pack reconciliation requires a complete scan and valid grace period."
      );
    }
    await ensurePrivateDirectory(this.#recordsDir);
    await ensurePrivateDirectory(this.#linksDir);
    const lease = await this.#lock.acquire({
      label: "template-pack-reconcile",
    });
    try {
      const reachable = new Map<string, TemplatePackReachabilityV1[]>();
      for (const reference of input.references) {
        validateReference({
          kind: "pack",
          recordKey: reference.recordKey,
          archiveSha256: reference.archiveSha256,
        });
        const list = reachable.get(reference.recordKey) ?? [];
        list.push(structuredClone(reference));
        reachable.set(reference.recordKey, list);
      }
      const deletedRecords: string[] = [];
      let deletedBytes = 0;
      const markers = await this.#markers();
      for (const marker of markers) {
        const references = reachable.get(marker.recordKey);
        if (references) {
          const links: FileTemplatePackLinksV1 = {
            schema: "atlcli.template-pack-links/1",
            recordKey: marker.recordKey,
            references: references.sort((left, right) =>
              left.jobId.localeCompare(right.jobId)
            ),
            updatedAt: input.now,
          };
          await writeDurableAtomic(
            this.#linksPath(marker.recordKey),
            `${JSON.stringify(links)}\n`
          );
          continue;
        }
        if (marker.createdAt + input.orphanGraceMs > input.now) continue;
        await rm(this.#dataPath(marker.recordKey), { force: true });
        await rm(this.#markerPath(marker.recordKey), { force: true });
        await rm(this.#linksPath(marker.recordKey), { force: true });
        deletedRecords.push(marker.recordKey);
        deletedBytes += marker.byteLength;
      }
      return {
        deletedRecords: deletedRecords.sort(),
        deletedBytes,
        retainedRecords: markers.length - deletedRecords.length,
      };
    } finally {
      await lease.release();
    }
  }
}
