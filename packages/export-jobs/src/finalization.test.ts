import { describe, expect, it } from "bun:test";
import type { ExportArtifactV1 } from "./artifact.js";
import type { ExportJobFinalizeV1 } from "./store-contracts.js";
import {
  ExportArtifactFinalizationConflict,
  InMemoryExportArtifactFinalizationJournal,
  exportArtifactFinalizationRef,
  finalizeExportArtifactDurably,
  resumePreparedExportArtifactFinalization,
  type ExportArtifactFinalizationCommitter,
  type ExportArtifactFinalizationIntentV1,
  type ExportJobFinalizationCommitter,
} from "./finalization.js";

const finalize: ExportJobFinalizeV1 = {
  id: "job:with:delimiters",
  expectedRevision: 4,
  leaseEpoch: 2,
  stagedArtifact: {
    ref: "artifact:job:2",
    mediaType: "application/pdf",
    filename: "space.pdf",
    byteLength: 3,
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    jobId: "job:with:delimiters",
    leaseEpoch: 2,
    stagedAt: 80,
  },
  reportRef: "report:job",
  reportSummary: {
    issues: { info: 0, warning: 1, error: 0 },
    topCodes: [{ code: "asset-skipped", count: 1 }],
    completeness: "partial",
  },
  finishedAt: 100,
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class IdempotentArtifactCommitter implements ExportArtifactFinalizationCommitter {
  artifact?: ExportArtifactV1;
  attempts = 0;
  writes = 0;

  async commit(intent: ExportArtifactFinalizationIntentV1): Promise<ExportArtifactV1> {
    this.attempts += 1;
    if (!this.artifact) {
      this.artifact = clone(intent.artifact);
      this.writes += 1;
    } else if (JSON.stringify(this.artifact) !== JSON.stringify(intent.artifact)) {
      throw new Error("competing artifact");
    }
    return clone(this.artifact);
  }
}

class IdempotentJobCommitter implements ExportJobFinalizationCommitter {
  intentRef?: string;
  artifact?: ExportArtifactV1;
  attempts = 0;
  writes = 0;

  async commit(
    intent: ExportArtifactFinalizationIntentV1,
    artifact: ExportArtifactV1,
  ): Promise<void> {
    this.attempts += 1;
    if (!this.intentRef) {
      this.intentRef = intent.ref;
      this.artifact = clone(artifact);
      this.writes += 1;
      return;
    }
    if (this.intentRef !== intent.ref || JSON.stringify(this.artifact) !== JSON.stringify(artifact)) {
      throw new Error("competing terminal metadata");
    }
  }
}

function ports() {
  return {
    journal: new InMemoryExportArtifactFinalizationJournal(),
    artifacts: new IdempotentArtifactCommitter(),
    jobs: new IdempotentJobCommitter(),
  };
}

describe("durable artifact finalization", () => {
  it("replays deterministically after a crash immediately after intent persistence", async () => {
    const stores = ports();
    await expect(
      finalizeExportArtifactDurably(stores, finalize, {
        afterIntentPrepared: () => {
          throw new Error("crash after intent");
        },
      }),
    ).rejects.toThrow("crash after intent");

    const ref = exportArtifactFinalizationRef(finalize);
    expect(await stores.journal.get(ref)).toMatchObject({ status: "prepared", ref });
    expect(stores.artifacts.writes).toBe(0);
    expect(stores.jobs.writes).toBe(0);

    const artifact = await resumePreparedExportArtifactFinalization(stores, finalize.id);
    expect(artifact).toMatchObject({ ref: finalize.stagedArtifact.ref, committedAt: 100 });
    expect(await stores.journal.get(ref)).toMatchObject({ status: "completed", completedAt: 100 });
    expect(stores.artifacts.writes).toBe(1);
    expect(stores.jobs.writes).toBe(1);
  });

  it("replays after byte promotion without duplicating bytes or terminal metadata", async () => {
    const stores = ports();
    await expect(
      finalizeExportArtifactDurably(stores, finalize, {
        afterArtifactCommitted: () => {
          throw new Error("crash after byte promotion");
        },
      }),
    ).rejects.toThrow("crash after byte promotion");

    expect(stores.artifacts.writes).toBe(1);
    expect(stores.jobs.writes).toBe(0);
    expect(await stores.journal.get(exportArtifactFinalizationRef(finalize))).toMatchObject({
      status: "prepared",
    });

    await finalizeExportArtifactDurably(stores, clone(finalize));
    expect(stores.artifacts.attempts).toBe(2);
    expect(stores.artifacts.writes).toBe(1);
    expect(stores.jobs.writes).toBe(1);

    // A completed journal entry is the fast path and does not touch either store.
    await finalizeExportArtifactDurably(stores, clone(finalize));
    expect(stores.artifacts.attempts).toBe(2);
    expect(stores.jobs.attempts).toBe(1);
  });

  it("replays after terminal metadata commit and rejects conflicting reuse", async () => {
    const stores = ports();
    await expect(
      finalizeExportArtifactDurably(stores, finalize, {
        afterJobCommitted: () => {
          throw new Error("crash after metadata commit");
        },
      }),
    ).rejects.toThrow("crash after metadata commit");

    expect(stores.artifacts.writes).toBe(1);
    expect(stores.jobs.writes).toBe(1);
    await finalizeExportArtifactDurably(stores, clone(finalize));
    expect(stores.artifacts.writes).toBe(1);
    expect(stores.jobs.writes).toBe(1);

    const conflicting = clone(finalize);
    conflicting.stagedArtifact.filename = "other.pdf";
    await expect(finalizeExportArtifactDurably(stores, conflicting)).rejects.toBeInstanceOf(
      ExportArtifactFinalizationConflict,
    );
  });
});
