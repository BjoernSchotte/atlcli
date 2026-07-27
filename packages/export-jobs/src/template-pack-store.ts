import type { PdfTemplatePackReferenceV1 } from "./request.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;

/** Protect freshly written, not-yet-linked records across process crashes. */
export const TEMPLATE_PACK_ORPHAN_GRACE_MS_V1 = 24 * 60 * 60 * 1_000;

export interface TemplatePackStoreLimitsV1 {
  maxObjectBytes: number;
  maxTotalBytes: number;
}

export interface TemplatePackRecordV1 {
  schema: "atlcli.template-pack-record/1";
  recordKey: string;
  archiveSha256: string;
  byteLength: number;
  createdAt: number;
}

export interface TemplatePackReachabilityV1 {
  jobId: string;
  requestRef: string;
  recordKey: string;
  archiveSha256: string;
}

export interface TemplatePackReconcileResultV1 {
  deletedRecords: string[];
  deletedBytes: number;
  retainedRecords: number;
}

/**
 * Host-wide content-addressed storage available before a job is created or
 * claimed. This is deliberately distinct from the lease-bound job spool.
 */
export interface TemplatePackStoreV1 {
  put(input: {
    bytes: Uint8Array;
    limits: TemplatePackStoreLimitsV1;
    now: number;
    signal?: AbortSignal;
  }): Promise<TemplatePackRecordV1>;
  get(
    reference: PdfTemplatePackReferenceV1,
    options?: { signal?: AbortSignal }
  ): Promise<{ record: TemplatePackRecordV1; bytes: Uint8Array }>;
  verify(
    reference: PdfTemplatePackReferenceV1,
    options?: { signal?: AbortSignal }
  ): Promise<TemplatePackRecordV1>;
  link(input: TemplatePackReachabilityV1 & { at: number }): Promise<void>;
  reconcile(input: {
    completeScan: true;
    references: readonly TemplatePackReachabilityV1[];
    now: number;
    orphanGraceMs: number;
  }): Promise<TemplatePackReconcileResultV1>;
}

export function templatePackRecordKey(archiveSha256: string): string {
  if (!SHA256_RE.test(archiveSha256)) {
    throw new Error("Template pack archive SHA-256 is invalid.");
  }
  return `template-pack:sha256:${archiveSha256}`;
}

export function templatePackReference(
  record: TemplatePackRecordV1
): PdfTemplatePackReferenceV1 {
  return {
    kind: "pack",
    archiveSha256: record.archiveSha256,
    recordKey: record.recordKey,
  };
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const owned = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", owned.buffer);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

function validateReference(reference: PdfTemplatePackReferenceV1): void {
  if (
    reference.kind !== "pack" ||
    !SHA256_RE.test(reference.archiveSha256) ||
    reference.recordKey !== templatePackRecordKey(reference.archiveSha256)
  ) {
    throw new Error("Invalid content-addressed template pack reference.");
  }
}

/**
 * Deterministic contract implementation used by non-persistent hosts and
 * tests. Persistent hosts implement the same byte and reachability semantics.
 */
export class InMemoryTemplatePackStoreV1 implements TemplatePackStoreV1 {
  readonly #records = new Map<
    string,
    { record: TemplatePackRecordV1; bytes: Uint8Array }
  >();
  readonly #links = new Map<string, Map<string, TemplatePackReachabilityV1>>();

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
    const archiveSha256 = await sha256Hex(bytes);
    throwIfAborted(input.signal);
    const recordKey = templatePackRecordKey(archiveSha256);
    const existing = this.#records.get(recordKey);
    if (existing) {
      if (
        existing.record.byteLength !== bytes.byteLength ||
        (await sha256Hex(existing.bytes)) !== archiveSha256
      ) {
        throw new Error("Template pack content-addressed record is corrupt.");
      }
      return structuredClone(existing.record);
    }
    const total =
      [...this.#records.values()].reduce(
        (sum, entry) => sum + entry.record.byteLength,
        0
      ) + bytes.byteLength;
    if (total > input.limits.maxTotalBytes) {
      throw new RangeError("Template pack total byte limit exceeded.");
    }
    const record: TemplatePackRecordV1 = {
      schema: "atlcli.template-pack-record/1",
      recordKey,
      archiveSha256,
      byteLength: bytes.byteLength,
      createdAt: input.now,
    };
    this.#records.set(recordKey, { record, bytes });
    return structuredClone(record);
  }

  async get(
    reference: PdfTemplatePackReferenceV1,
    options?: { signal?: AbortSignal }
  ): Promise<{ record: TemplatePackRecordV1; bytes: Uint8Array }> {
    throwIfAborted(options?.signal);
    validateReference(reference);
    const entry = this.#records.get(reference.recordKey);
    if (!entry) throw new Error("Template pack record was not found.");
    if (
      entry.record.archiveSha256 !== reference.archiveSha256 ||
      entry.record.recordKey !== reference.recordKey ||
      entry.record.byteLength !== entry.bytes.byteLength ||
      (await sha256Hex(entry.bytes)) !== reference.archiveSha256
    ) {
      throw new Error("Template pack record failed integrity verification.");
    }
    throwIfAborted(options?.signal);
    return {
      record: structuredClone(entry.record),
      bytes: new Uint8Array(entry.bytes),
    };
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
    const links = this.#links.get(input.recordKey) ?? new Map();
    links.set(input.jobId, {
      jobId: input.jobId,
      requestRef: input.requestRef,
      recordKey: input.recordKey,
      archiveSha256: input.archiveSha256,
    });
    this.#links.set(input.recordKey, links);
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
    const reachable = new Map<string, Map<string, TemplatePackReachabilityV1>>();
    for (const reference of input.references) {
      validateReference({ kind: "pack", ...reference });
      const record = this.#records.get(reference.recordKey);
      if (!record) {
        throw new Error(
          `Referenced template pack record was not found: ${reference.recordKey}`
        );
      }
      const jobs = reachable.get(reference.recordKey) ?? new Map();
      jobs.set(reference.jobId, structuredClone(reference));
      reachable.set(reference.recordKey, jobs);
    }

    const deletedRecords: string[] = [];
    let deletedBytes = 0;
    for (const [recordKey, entry] of this.#records) {
      if (reachable.has(recordKey)) continue;
      if (entry.record.createdAt + input.orphanGraceMs > input.now) continue;
      this.#records.delete(recordKey);
      this.#links.delete(recordKey);
      deletedRecords.push(recordKey);
      deletedBytes += entry.record.byteLength;
    }
    this.#links.clear();
    for (const [recordKey, links] of reachable) {
      this.#links.set(recordKey, links);
    }
    return {
      deletedRecords: deletedRecords.sort(),
      deletedBytes,
      retainedRecords: this.#records.size,
    };
  }
}
