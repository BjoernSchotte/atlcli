import type { PendingArtifactV1, StagedArtifactV1 } from "./artifact.js";
import type {
  ExportArtifactStore,
  ExportJobArtifacts,
  ExportJobSpool,
  ExportSpoolStore,
} from "./ports.js";
import type { SpoolObjectV1, SpoolRefV1, SpoolWriteLimitsV1 } from "./spool.js";

function assertExecutionIdentity(jobId: string, leaseEpoch: number): void {
  if (jobId.trim().length === 0) throw new Error("Execution job id must not be empty.");
  if (!Number.isSafeInteger(leaseEpoch) || leaseEpoch <= 0) {
    throw new Error("Execution lease epoch must be a positive safe integer.");
  }
}

/** Bind every executor spool write to the claim identity captured by the host. */
export function bindExportJobSpool(
  store: ExportSpoolStore,
  jobId: string,
  leaseEpoch: number,
): ExportJobSpool {
  assertExecutionIdentity(jobId, leaseEpoch);
  return {
    put(
      ref: Omit<SpoolRefV1, "jobId" | "leaseEpoch">,
      source: AsyncIterable<Uint8Array>,
      limits: SpoolWriteLimitsV1,
    ): Promise<SpoolObjectV1> {
      return store.put({ ...ref, jobId, leaseEpoch }, source, limits);
    },
    read(ref, options) {
      return store.read({ ...ref, jobId, leaseEpoch }, options);
    },
    stat(ref) {
      return store.stat({ ...ref, jobId, leaseEpoch });
    },
  };
}

/** Bind artifact staging and recovery lookup to one immutable claim identity. */
export function bindExportJobArtifacts(
  store: ExportArtifactStore,
  jobId: string,
  leaseEpoch: number,
): ExportJobArtifacts {
  assertExecutionIdentity(jobId, leaseEpoch);
  return {
    stage(artifact: PendingArtifactV1): Promise<StagedArtifactV1> {
      return store.stage(jobId, leaseEpoch, artifact);
    },
    getStaged(): Promise<StagedArtifactV1 | undefined> {
      return store.getStaged(jobId, leaseEpoch);
    },
  };
}
