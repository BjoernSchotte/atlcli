/**
 * Extension copy-probe child (issue #118 Phase 0.5): measure the productive
 * `collectExecutorBytes` shape over the REAL IndexedDB chunk store
 * (fake-indexeddb in-process) with objects big enough that the per-object
 * collect transient dominates RSS noise.
 *
 *   bun --conditions=development apps/extension/tests/export-job-baseline/copy-probe-child.ts executor-collect
 */
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { IndexedDbExportByteStore } from "../../utils/export-jobs/chunk-store.js";
import { collectExecutorBytes, executorSpoolSource } from "../../utils/export-jobs/executor-store.js";
import type { SpoolRefV1, SpoolWriteLimitsV1 } from "@atlcli/export-jobs";

globalThis.indexedDB = new IDBFactory();
globalThis.IDBKeyRange = IDBKeyRange;

const MIB = 1024 * 1024;
const LIMITS: SpoolWriteLimitsV1 = {
  maxObjectBytes: 256 * MIB,
  maxJobBytes: 1024 * MIB,
  maxTotalBytes: 2048 * MIB,
};

function blob(sizeBytes: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(sizeBytes);
  let state = seed >>> 0;
  for (let offset = 0; offset < sizeBytes; offset += 4096) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    bytes[offset] = state & 0xff;
  }
  return bytes;
}

const scenario = process.argv[2];
if (scenario !== "executor-collect") {
  throw new Error(`Unknown extension copy-probe scenario: ${scenario}`);
}

const store = new IndexedDbExportByteStore({});
const refs: SpoolRefV1[] = [];
for (let index = 0; index < 3; index += 1) {
  const ref: SpoolRefV1 = {
    jobId: "copy-probe",
    leaseEpoch: 1,
    namespace: "ready-pdf",
    key: `probe:blob:${index}`,
  };
  await store.put(ref, executorSpoolSource(blob(40 * MIB, 0x1000 + index)), LIMITS);
  refs.push(ref);
}

// The productive materialize shape: stat for the exact size, collect, HOLD
// every blob until hydrate (mirrors executor-store materialize()).
const held: Uint8Array[] = [];
for (const ref of refs) {
  const stat = await store.stat(ref);
  held.push(
    await collectExecutorBytes(store.read(ref), LIMITS.maxObjectBytes, undefined, stat?.byteLength),
  );
}
const totalBytes = held.reduce((total, bytes) => total + bytes.byteLength, 0);
console.log(`ATLCLI_COPY_PROBE_CHILD ${JSON.stringify({ scenario, totalBytes })}`);
