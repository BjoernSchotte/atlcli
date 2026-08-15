/** Opaque logical object identifier; it must not expose a physical backend path. */
export interface SpoolRefV1 {
  jobId: string;
  /** Creating lease epoch; prevents a stale executor from replacing newer bytes. */
  leaseEpoch: number;
  namespace: string;
  key: string;
}

/** Per-write limits enforced incrementally by a spool adapter. */
export interface SpoolWriteLimitsV1 {
  maxObjectBytes: number;
  maxJobBytes: number;
  maxTotalBytes: number;
}

/** Metadata for a completely committed spool object. */
export interface SpoolObjectV1 {
  ref: SpoolRefV1;
  byteLength: number;
  sha256: string;
  committedAt: number;
}

/** Idempotent byte-store cleanup accounting for activity and retention reports. */
export interface ExportByteCleanupResultV1 {
  objectsDeleted: number;
  bytesDeleted: number;
}
