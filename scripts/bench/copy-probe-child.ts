/**
 * Copy-probe child (issue #118 Phase 0.5): run ONE scenario in an isolated
 * process so `/usr/bin/time` peak RSS captures in-stage transients that
 * `process.memoryUsage` checkpoints cannot see.
 *
 *   bun --conditions=development scripts/bench/copy-probe-child.ts <scenario> <workDir>
 *
 * Scenarios use deterministic synthetic assets sized so the copy shape under
 * test dominates RSS noise (tens of MiB per object).
 */
import { mkdirSync } from "node:fs";
import {
  bindExportJobSpool,
  type ExportJobExecutionContext,
  type SpoolWriteLimitsV1,
} from "@atlcli/export-jobs";
import { FileExportSpoolStore } from "@atlcli/export-node";
import { checkpointPdfAssetsV1 } from "@atlcli/export-wiring/jobs";

const MIB = 1024 * 1024;
const LIMITS: SpoolWriteLimitsV1 = {
  maxObjectBytes: 256 * MIB,
  maxJobBytes: 1024 * MIB,
  maxTotalBytes: 2048 * MIB,
};

/** Deterministic pseudo-asset with a PNG signature (checkpoint layer never decodes). */
function syntheticAsset(sizeBytes: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let state = seed >>> 0;
  for (let offset = 8; offset < sizeBytes; offset += 4096) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[offset] = state & 0xff;
  }
  return bytes;
}

function context(spoolStore: FileExportSpoolStore): ExportJobExecutionContext {
  const execution: ExportJobExecutionContext = {
    jobId: "copy-probe",
    leaseEpoch: 1,
    signal: new AbortController().signal,
    spool: bindExportJobSpool(spoolStore, "copy-probe", 1, LIMITS),
    readSpool: (ref, options) => spoolStore.read(ref, options),
    artifacts: {
      async stage() {
        throw new Error("Artifact staging is outside this probe.");
      },
      async getStaged() {
        return undefined;
      },
    },
    async updateProgress() {},
    async updateStats() {},
    async appendEvent() {},
    async checkpoint(ref) {
      execution.checkpointRef = ref;
    },
  };
  return execution;
}

async function checkpointAssetsScenario(workDir: string): Promise<Record<string, number>> {
  const store = new FileExportSpoolStore(workDir);
  const execution = context(store);
  const assets = new Map<string, Uint8Array>([
    ["a.png", syntheticAsset(20 * MIB, 0x1111)],
    ["b.png", syntheticAsset(20 * MIB, 0x2222)],
    ["c.png", syntheticAsset(20 * MIB, 0x3333)],
    ["logo.png", syntheticAsset(64 * 1024, 0x4444)],
  ]);
  const resolver = checkpointPdfAssetsV1(execution, "probe-key", {
    async resolve(ref) {
      const bytes = assets.get(ref.filename ?? "");
      if (!bytes) throw new Error(`Unknown probe asset ${ref.filename}`);
      return { bytes, mediaType: "image/png", filename: ref.filename };
    },
  });
  let resolvedBytes = 0;
  for (const filename of ["a.png", "b.png", "c.png", "logo.png", "logo.png"]) {
    const result = await resolver.resolve({ kind: "attachment", filename });
    resolvedBytes += result.bytes.byteLength;
  }
  return { resolvedBytes, uniqueBytes: 3 * 20 * MIB + 64 * 1024 };
}

const [scenario, workDir] = [process.argv[2], process.argv[3]];
if (!scenario || !workDir) {
  throw new Error("Usage: copy-probe-child.ts <scenario> <workDir>");
}
mkdirSync(workDir, { recursive: true });
const marker =
  scenario === "checkpoint-assets"
    ? await checkpointAssetsScenario(workDir)
    : (() => {
        throw new Error(`Unknown copy-probe scenario: ${scenario}`);
      })();
console.log(`ATLCLI_COPY_PROBE_CHILD ${JSON.stringify({ scenario, ...marker })}`);
