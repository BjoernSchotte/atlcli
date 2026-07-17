import type { PdfCompilerDiagnostic, PdfSourceBundle } from "@atlcli/pdf/browser";

const DB_NAME = "atlcli-pdf";
const DB_VERSION = 1;
const STORE = "jobs";
export const PDF_JOB_MAX_BYTES = 64 * 1024 * 1024;
export const PDF_STORE_MAX_BYTES = 128 * 1024 * 1024;
export const PDF_JOB_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export type PdfJobStatus = "prepared" | "compiling" | "complete" | "failed" | "cancelled";

export interface StoredPdfJob {
  id: string;
  sourceIdentity: string;
  createdAt: number;
  status: PdfJobStatus;
  inputBytes: number;
  bundle: PdfSourceBundle;
  pdf?: Uint8Array;
  diagnostics?: PdfCompilerDiagnostic[];
  compilerVersion?: string;
  error?: string;
}

function resolveFactory(factory?: IDBFactory): IDBFactory {
  const value = factory ?? globalThis.indexedDB;
  if (!value) throw new Error("IndexedDB is unavailable for PDF export.");
  return value;
}

export function isPdfJobId(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export function createPdfJobId(randomUUID: () => string = () => crypto.randomUUID()): string {
  const id = randomUUID();
  if (!isPdfJobId(id)) throw new Error("PDF job id generator returned an invalid UUID.");
  return id;
}

function sourceBundleBytes(bundle: PdfSourceBundle): number {
  const encoder = new TextEncoder();
  return (
    encoder.encode(bundle.main).byteLength +
    encoder.encode(bundle.template).byteLength +
    bundle.assets.reduce((total, asset) => total + asset.bytes.byteLength, 0)
  );
}

function storedJobBytes(job: StoredPdfJob): number {
  return job.inputBytes + (job.pdf?.byteLength ?? 0);
}

export function openPdfJobDb(factory?: IDBFactory): Promise<IDBDatabase> {
  const idb = resolveFactory(factory);
  return new Promise((resolve, reject) => {
    const request = idb.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Failed to open PDF job database."));
  });
}

function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore, resolve: (value: T) => void, reject: (reason?: unknown) => void) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    let value: T;
    let hasValue = false;
    const finish = (result: T): void => {
      value = result;
      hasValue = true;
    };
    try {
      run(tx.objectStore(STORE), finish, reject);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => {
      if (!hasValue) reject(new Error("PDF job transaction completed without a result."));
      else resolve(value!);
    };
    tx.onabort = () => reject(tx.error ?? new Error("PDF job transaction aborted."));
    tx.onerror = () => reject(tx.error ?? new Error("PDF job transaction failed."));
  });
}

export async function putPdfJob(
  input: { id: string; sourceIdentity: string; bundle: PdfSourceBundle; createdAt?: number },
  factory?: IDBFactory
): Promise<StoredPdfJob> {
  if (!isPdfJobId(input.id)) throw new Error("Invalid PDF job id.");
  const inputBytes = sourceBundleBytes(input.bundle);
  if (inputBytes > PDF_JOB_MAX_BYTES) {
    throw new Error(`PDF export input exceeds the ${PDF_JOB_MAX_BYTES} byte job limit.`);
  }
  const job: StoredPdfJob = {
    id: input.id,
    sourceIdentity: input.sourceIdentity,
    createdAt: input.createdAt ?? Date.now(),
    status: "prepared",
    inputBytes,
    bundle: input.bundle,
  };
  const db = await openPdfJobDb(factory);
  try {
    return await transaction(db, "readwrite", (store, done, reject) => {
      const inventory = store.getAll();
      inventory.onerror = () => reject(inventory.error);
      inventory.onsuccess = () => {
        const total = (inventory.result as StoredPdfJob[]).reduce(
          (sum, stored) => sum + storedJobBytes(stored),
          0
        );
        if (total + inputBytes > PDF_STORE_MAX_BYTES) {
          reject(new Error("PDF export storage exceeds the 128 MB total quota."));
          return;
        }
        const request = store.add(job);
        request.onsuccess = () => done(job);
        request.onerror = () => reject(request.error ?? new Error("Failed to store PDF job."));
      };
    });
  } finally {
    db.close();
  }
}

export async function getPdfJob(id: string, factory?: IDBFactory): Promise<StoredPdfJob | undefined> {
  const db = await openPdfJobDb(factory);
  try {
    return await transaction(db, "readonly", (store, done, reject) => {
      const request = store.get(id);
      request.onsuccess = () => done(request.result as StoredPdfJob | undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

async function updateExisting(
  id: string,
  update: (job: StoredPdfJob) => StoredPdfJob | null,
  factory?: IDBFactory
): Promise<StoredPdfJob | undefined> {
  const db = await openPdfJobDb(factory);
  try {
    return await transaction(db, "readwrite", (store, done, reject) => {
      const request = store.get(id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const current = request.result as StoredPdfJob | undefined;
        if (!current) {
          done(undefined);
          return;
        }
        const next = update(current);
        if (!next) {
          done(current);
          return;
        }
        const write = store.put(next);
        write.onsuccess = () => done(next);
        write.onerror = () => reject(write.error);
      };
    });
  } finally {
    db.close();
  }
}

export function claimPdfJob(id: string, factory?: IDBFactory): Promise<StoredPdfJob | undefined> {
  return updateExisting(id, (job) =>
    job.status === "prepared" ? { ...job, status: "compiling" } : null, factory
  );
}

export async function completePdfJob(
  id: string,
  output: { pdf: Uint8Array; diagnostics: PdfCompilerDiagnostic[]; compilerVersion: string },
  factory?: IDBFactory
): Promise<StoredPdfJob | undefined> {
  if (output.pdf.byteLength > PDF_JOB_MAX_BYTES) {
    throw new Error(`PDF result exceeds the ${PDF_JOB_MAX_BYTES} byte job limit.`);
  }
  const db = await openPdfJobDb(factory);
  try {
    return await transaction(db, "readwrite", (store, done, reject) => {
      const inventory = store.getAll();
      inventory.onerror = () => reject(inventory.error);
      inventory.onsuccess = () => {
        const jobs = inventory.result as StoredPdfJob[];
        const current = jobs.find((job) => job.id === id);
        if (!current || current.status !== "compiling") {
          done(current);
          return;
        }
        const total = jobs.reduce((sum, job) => sum + storedJobBytes(job), 0);
        if (total + output.pdf.byteLength > PDF_STORE_MAX_BYTES) {
          reject(new Error("PDF export storage exceeds the 128 MB total quota."));
          return;
        }
        const next: StoredPdfJob = {
          ...current,
          status: "complete",
          pdf: output.pdf,
          diagnostics: output.diagnostics,
          compilerVersion: output.compilerVersion,
        };
        const write = store.put(next);
        write.onsuccess = () => done(next);
        write.onerror = () => reject(write.error);
      };
    });
  } finally {
    db.close();
  }
}

export function failPdfJob(
  id: string,
  error: string,
  diagnostics: PdfCompilerDiagnostic[] = [],
  factory?: IDBFactory
): Promise<StoredPdfJob | undefined> {
  return updateExisting(id, (job) =>
    job.status === "prepared" || job.status === "compiling"
      ? { ...job, status: "failed", error, diagnostics }
      : null, factory
  );
}

export function cancelPdfJob(id: string, factory?: IDBFactory): Promise<StoredPdfJob | undefined> {
  return updateExisting(id, (job) =>
    job.status === "complete" || job.status === "failed"
      ? null
      : { ...job, status: "cancelled", error: "PDF export was cancelled." }, factory
  );
}

export async function deletePdfJob(id: string, factory?: IDBFactory): Promise<void> {
  const db = await openPdfJobDb(factory);
  try {
    await transaction(db, "readwrite", (store, done, reject) => {
      const request = store.delete(id);
      request.onsuccess = () => done(undefined);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function cleanupPdfJobs(
  options: { now?: number; maxAgeMs?: number } = {},
  factory?: IDBFactory
): Promise<number> {
  const cutoff = (options.now ?? Date.now()) - (options.maxAgeMs ?? PDF_JOB_MAX_AGE_MS);
  const db = await openPdfJobDb(factory);
  try {
    return await transaction(db, "readwrite", (store, done, reject) => {
      let deleted = 0;
      const request = store.index("createdAt").openCursor(IDBKeyRange.upperBound(cutoff, true));
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          done(deleted);
          return;
        }
        cursor.delete();
        deleted += 1;
        cursor.continue();
      };
    });
  } finally {
    db.close();
  }
}
