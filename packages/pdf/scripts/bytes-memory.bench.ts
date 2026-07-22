/**
 * Memory benchmark for the PDF byte path (spec 010, T5.6 "measure first").
 *
 * Architecture point 9 of `specs/export-expansion/010-extension-integration/PLAN.md`
 * lists four suspected allocation peaks and states that **nothing gets
 * optimized on suspicion**. This script produces the numbers that gate those
 * fixes.
 *
 * Run all scenarios (each in a fresh process, so RSS is not polluted by the
 * previous one):
 *
 *     bun packages/pdf/scripts/bytes-memory.bench.ts
 *
 * Run one:  `bun packages/pdf/scripts/bytes-memory.bench.ts validate`
 * Scenarios: validate | getall | status | blob | hash
 *
 * ## What this can and cannot measure — read before quoting a number
 *
 * This runs under **Bun (JavaScriptCore)**, not Chrome (V8). That gap is real
 * and is not papered over anywhere below.
 *
 *  - Numbers come from `bun:jsc`'s `heapStats()`, not
 *    `process.memoryUsage().heapUsed` — the latter reports **+0.0 MiB for a
 *    64 MiB string** under Bun and would have made every scenario here look
 *    free. `heapSize` counts the JS heap; `extraMemorySize` counts the
 *    externally-backed memory (typed arrays, string backing stores) JSC
 *    attributes to it. RSS is reported alongside as a cross-check.
 *  - `Bun.gc(true)` is forced before every sample, and every allocation is
 *    still **reachable** when sampled — a peak that is immediately collectable
 *    is still a peak.
 *  - The two assumptions the PLAN flags as gating the storage-format decision
 *    are **not answerable here**. They are now covered by the real MV3
 *    Chrome/V8 harness: `bun run bench:memory-chrome`. See the closing note.
 */

import { heapStats } from "bun:jsc";
import { validatePdfOutput } from "../src/validate.js";
// Resolved by path on purpose: `fake-indexeddb` is a devDependency of
// `apps/extension`, not of `packages/pdf`, and this bench must not add a
// dependency to a published package just to measure a host-side store.
import {
  IDBFactory,
  IDBKeyRange,
} from "../../../apps/extension/node_modules/fake-indexeddb/build/esm/index.js";

const MIB = 1024 * 1024;

interface Sample {
  heap: number;
  extra: number;
  rss: number;
}

function sample(): Sample {
  Bun.gc(true);
  const stats = heapStats();
  return {
    heap: stats.heapSize,
    extra: stats.extraMemorySize,
    rss: process.memoryUsage().rss,
  };
}

function mib(value: number): string {
  const n = value / MIB;
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}`;
}

function delta(before: Sample, after: Sample): string {
  return `heap ${mib(after.heap - before.heap).padStart(7)} MiB | extern ${mib(
    after.extra - before.extra
  ).padStart(7)} MiB | rss ${mib(after.rss - before.rss).padStart(7)} MiB`;
}

/**
 * A synthetic PDF that `validatePdfOutput` accepts, padded to `sizeBytes` with
 * a body that looks like a real compiled document: many `/Type /Page` and
 * `/FontFile2` markers scattered through binary filler, so the regex-match
 * arrays materialize realistically rather than matching once.
 */
function syntheticPdf(sizeBytes: number, pages: number): Uint8Array {
  const head =
    `%PDF-1.7\n` +
    `1 0 obj\n<< /Type /Catalog /Lang (en-GB) /Pages 2 0 R /StructTreeRoot 3 0 R /Outlines 9 0 R >>\nendobj\n` +
    `3 0 obj\n<< /MarkInfo << /Marked true >> >>\nendobj\n`;
  const tail = `trailer\n<< /Root 1 0 R >>\n%%EOF\n`;
  const bytes = new Uint8Array(sizeBytes);
  const encoder = new TextEncoder();
  bytes.set(encoder.encode(head), 0);
  const cursor = head.length;
  const bodyEnd = sizeBytes - tail.length;
  // Deterministic non-ASCII filler: exercises the Latin-1 decode over the byte
  // values a real PDF's compressed streams contain.
  for (let i = cursor; i < bodyEnd; i += 1) bytes[i] = (i * 31) & 0xff;
  const stride = Math.floor((bodyEnd - cursor) / pages);
  for (let page = 0; page < pages; page += 1) {
    const marker = encoder.encode(
      `\n${page + 10} 0 obj\n<< /Type /Page /FontFile2 ${page + 100} 0 R >>\nendobj\n`
    );
    const at = cursor + page * stride;
    if (at + marker.length < bodyEnd) bytes.set(marker, at);
  }
  bytes.set(encoder.encode(tail), bodyEnd);
  return bytes;
}

// ---------------------------------------------------------------------------
// Scenario: validate.ts:48, whole-file Latin-1 decode
// ---------------------------------------------------------------------------

function scenarioValidateDecode(sizes: number[] = [32, 64]): void {
  for (const sizeMiB of sizes) {
    const pdf = syntheticPdf(sizeMiB * MIB, 210);
    console.log(`\n  ${sizeMiB} MiB synthetic PDF, 210 page markers`);

    const beforeDecode = sample();
    const text = new TextDecoder("latin1").decode(pdf);
    const afterDecode = sample();
    console.log(`    decode()  live string .. ${delta(beforeDecode, afterDecode)}   len ${text.length}`);

    const beforeMatch = sample();
    const pageHits = text.match(/\/Type\s*\/Page\b/g);
    const fontHits = text.match(/\/FontFile(?:2|3)?\b/g);
    const afterMatch = sample();
    console.log(
      `    .match(/…/g) arrays .... ${delta(beforeMatch, afterMatch)}   ` +
        `${pageHits?.length ?? 0} page / ${fontHits?.length ?? 0} font hits`
    );
    if (text.length === 0 || pageHits === null || fontHits === null) throw new Error("unreachable");

    const t0 = performance.now();
    const inspection = validatePdfOutput(pdf);
    console.log(
      `    validatePdfOutput() .... ${(performance.now() - t0).toFixed(0)} ms  ${JSON.stringify(inspection)}`
    );
  }
  console.log(
    "\n  Latin-1 decode costs 2x the file size under JSC, so the string is a\n" +
      "  UTF-16 backing store, not a one-byte one. V8 has SeqOneByteString and may\n" +
      "  charge 1x instead — UNVERIFIED here. Either way it is a full extra copy of\n" +
      "  the entire file, alive at the same time as the bytes."
  );
}

/**
 * Live (reachable) set at the worst moment of each strategy.
 *
 * This is the number the chunked rewrite is accountable for, and the only one
 * that is deterministic. Total *footprint* — live set plus garbage the
 * collector has not gotten to — is GC-timing noise: the same chunked scan
 * measured anywhere between +6 MiB and +83 MiB of footprint across runs, while
 * its live set never moved. The whole-file decode has no such spread because
 * its 128 MiB cannot be collected at all until `validatePdfOutput` returns.
 */
function scenarioValidateLiveSet(chunked: boolean): void {
  const sizeMiB = 64;
  const pdf = syntheticPdf(sizeMiB * MIB, 210);
  const page = /\/Type\s*\/Page\b/g;
  const decoder = new TextDecoder("latin1");
  const total = pdf.byteLength;
  let hits = 0;

  if (!chunked) {
    const before = sample();
    const text = decoder.decode(pdf);
    for (const match of text.matchAll(page)) if (match.index >= 0) hits += 1;
    // sample() forces a full GC first, and `text` is still reachable here — so
    // this delta is live set, not footprint.
    const live = sample();
    console.log(`\n  ${sizeMiB} MiB PDF, whole-file decode`);
    console.log(`    live set at peak ....... ${delta(before, live)}   ${hits} hits`);
    if (text.length === 0) throw new Error("unreachable");
    return;
  }

  const CHUNK = 1024 * 1024;
  const midChunk = Math.floor(total / CHUNK / 2) * CHUNK;
  const before = sample();
  let live = before;
  for (let start = 0; start < total; start += CHUNK) {
    const cutoff = Math.min(total, start + CHUNK);
    let end = Math.min(total, cutoff + 20);
    while (end < total && [0x20, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0xa0].includes(pdf[end]!)) end += 1;
    const text = decoder.decode(pdf.subarray(start, Math.min(total, end + 20)));
    const owned = cutoff - start;
    for (const match of text.matchAll(page)) if (match.index < owned) hits += 1;
    if (start === midChunk) {
      // Mid-scan, with this window's string still reachable: the worst moment.
      live = sample();
      if (text.length === 0) throw new Error("unreachable");
    }
  }
  console.log(`\n  ${sizeMiB} MiB PDF, ${CHUNK / MIB} MiB chunks`);
  console.log(`    live set at peak ....... ${delta(before, live)}   ${hits} hits`);
}

// ---------------------------------------------------------------------------
// Scenario: job-store.ts:118/:200, store.getAll() as a quota check
// ---------------------------------------------------------------------------

interface BenchJob {
  id: string;
  sourceIdentity: string;
  createdAt: number;
  status: string;
  inputBytes: number;
  bundle: {
    main: string;
    template: string;
    assets: Array<{ path: string; mediaType: string; bytes: Uint8Array }>;
  };
  pdf?: Uint8Array;
}

function benchJob(index: number, payloadBytes: number): BenchJob {
  const bytes = new Uint8Array(payloadBytes);
  // Non-zero so no engine can back it with a shared zero page.
  for (let i = 0; i < payloadBytes; i += 4096) bytes[i] = (i + index) & 0xff;
  return {
    id: `bench-${String(index).padStart(4, "0")}`,
    sourceIdentity: `page:${index}`,
    createdAt: index,
    status: "prepared",
    inputBytes: payloadBytes,
    bundle: {
      main: "= Job",
      template: "template",
      assets: [{ path: `assets/a-${index}.png`, mediaType: "image/png", bytes }],
    },
  };
}

function openDb(factory: IDBFactory, stores: string[] = ["jobs"]): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open("bench", 1);
    request.onupgradeneeded = () => {
      for (const name of stores) {
        const store = request.result.createObjectStore(name, { keyPath: "id" });
        store.createIndex("createdAt", "createdAt");
        store.createIndex("bytes", "inputBytes");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function scenarioGetAll(): Promise<void> {
  globalThis.IDBKeyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
  const factory = new IDBFactory();
  const db = await openDb(factory, ["jobs", "meta"]);

  const jobCount = 8;
  const payloadBytes = 8 * MIB;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["jobs", "meta"], "readwrite");
    const jobs = tx.objectStore("jobs");
    const meta = tx.objectStore("meta");
    for (let i = 0; i < jobCount; i += 1) {
      jobs.add(benchJob(i, payloadBytes));
      meta.add({ id: `bench-${String(i).padStart(4, "0")}`, createdAt: i, inputBytes: payloadBytes });
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  console.log(
    `\n  store seeded with ${jobCount} jobs x ${payloadBytes / MIB} MiB = ${(jobCount * payloadBytes) / MIB} MiB of payload`
  );

  // (a) today's path: getAll() materializes every record to add two numbers.
  const beforeAll = sample();
  const t0 = performance.now();
  const { total, peak } = await new Promise<{ total: number; peak: Sample }>((resolve, reject) => {
    const tx = db.transaction("jobs", "readonly");
    const request = tx.objectStore("jobs").getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const rows = request.result as BenchJob[];
      const sum = rows.reduce((acc, row) => acc + row.inputBytes + (row.pdf?.byteLength ?? 0), 0);
      // Sampled while `rows` is still reachable — that IS the peak.
      resolve({ total: sum, peak: sample() });
    };
  });
  console.log(
    `    getAll() quota check ... ${delta(beforeAll, peak)}   ${(performance.now() - t0).toFixed(0)} ms  total ${total / MIB} MiB`
  );

  // (b) proposed: a key cursor over a numeric index; records never materialize.
  const beforeIdx = sample();
  const t1 = performance.now();
  const idx = await new Promise<{ total: number; peak: Sample }>((resolve, reject) => {
    const tx = db.transaction("jobs", "readonly");
    let sum = 0;
    const request = tx.objectStore("jobs").index("bytes").openKeyCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve({ total: sum, peak: sample() });
        return;
      }
      sum += cursor.key as number;
      cursor.continue();
    };
  });
  console.log(
    `    index key cursor ....... ${delta(beforeIdx, idx.peak)}   ${(performance.now() - t1).toFixed(0)} ms  total ${idx.total / MIB} MiB`
  );

  // (c) proposed: getAll() over a separate meta store holding only numbers.
  const beforeMeta = sample();
  const t2 = performance.now();
  const meta = await new Promise<{ total: number; peak: Sample }>((resolve, reject) => {
    const tx = db.transaction("meta", "readonly");
    const request = tx.objectStore("meta").getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const rows = request.result as Array<{ inputBytes: number }>;
      resolve({ total: rows.reduce((a, r) => a + r.inputBytes, 0), peak: sample() });
    };
  });
  console.log(
    `    meta-store getAll() .... ${delta(beforeMeta, meta.peak)}   ${(performance.now() - t2).toFixed(0)} ms  total ${meta.total / MIB} MiB`
  );
  db.close();
}

// ---------------------------------------------------------------------------
// Scenario: job-store.ts:152-181, a status field rewrites the whole payload
// ---------------------------------------------------------------------------

async function scenarioStatusRewrite(): Promise<void> {
  globalThis.IDBKeyRange = IDBKeyRange as unknown as typeof globalThis.IDBKeyRange;
  const factory = new IDBFactory();
  const db = await openDb(factory, ["jobs", "meta"]);
  const payloadBytes = 32 * MIB;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(["jobs", "meta"], "readwrite");
    tx.objectStore("jobs").add(benchJob(0, payloadBytes));
    tx.objectStore("meta").add({ id: "bench-0000", createdAt: 0, status: "prepared", inputBytes: payloadBytes });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  console.log(`\n  one job carrying a ${payloadBytes / MIB} MiB bundle`);

  const before = sample();
  const t0 = performance.now();
  const peak = await new Promise<Sample>((resolve, reject) => {
    const tx = db.transaction("jobs", "readwrite");
    const store = tx.objectStore("jobs");
    const request = store.get("bench-0000");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const current = request.result as BenchJob;
      const next = { ...current, status: "compiling" };
      const write = store.put(next);
      write.onsuccess = () => resolve(sample());
      write.onerror = () => reject(write.error);
    };
  });
  console.log(`    get + spread + put ..... ${delta(before, peak)}   ${(performance.now() - t0).toFixed(0)} ms`);

  const beforeSplit = sample();
  const t1 = performance.now();
  const splitPeak = await new Promise<Sample>((resolve, reject) => {
    const tx = db.transaction("meta", "readwrite");
    const store = tx.objectStore("meta");
    const request = store.get("bench-0000");
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const write = store.put({ ...(request.result as object), status: "compiling" });
      write.onsuccess = () => resolve(sample());
      write.onerror = () => reject(write.error);
    };
  });
  console.log(`    status-record put ...... ${delta(beforeSplit, splitPeak)}   ${(performance.now() - t1).toFixed(0)} ms`);
  db.close();
}

// ---------------------------------------------------------------------------
// Scenario: download.ts:19, the Blob copy
// ---------------------------------------------------------------------------

function scenarioBlobCopy(): void {
  for (const sizeMiB of [32, 64]) {
    const pdf = syntheticPdf(sizeMiB * MIB, 210);
    const before = sample();
    const t0 = performance.now();
    const blob = new Blob([pdf as BlobPart], { type: "application/pdf" });
    const after = sample();
    console.log(
      `\n  ${sizeMiB} MiB -> Blob ......... ${delta(before, after)}   ${(performance.now() - t0).toFixed(0)} ms  blob.size ${blob.size / MIB} MiB`
    );
    // Both stay reachable across the sample, exactly as in download.ts today.
    if (pdf.byteLength === 0) throw new Error("unreachable");
  }
  console.log(
    "\n  Blob payloads are native in both JSC and V8, so the cost lands in extern/rss,\n" +
      "  not the JS heap. What a PdfBytesHandle removes is the DUPLICATE: today the\n" +
      "  Uint8Array stays reachable in the caller while the Blob holds a second copy."
  );
}

// ---------------------------------------------------------------------------
// Scenario: prepare.ts's double FNV-1a scan per new asset
// ---------------------------------------------------------------------------

function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i += 1) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function scenarioDoubleHash(): void {
  const asset = syntheticPdf(8 * MIB, 4); // stand-in for one 8 MiB image
  const before = sample();
  const t0 = performance.now();
  fnv1a(asset);
  const onceMs = performance.now() - t0;
  const t1 = performance.now();
  fnv1a(asset);
  fnv1a(asset);
  const twiceMs = performance.now() - t1;
  const after = sample();
  console.log(`\n  8 MiB asset — 1 scan ${onceMs.toFixed(1)} ms, 2 scans ${twiceMs.toFixed(1)} ms`);
  console.log(`  allocation ............. ${delta(before, after)}`);
  console.log("  A byte scan allocates nothing: this is pure CPU, not memory.");
}

// ---------------------------------------------------------------------------

const SCENARIOS: Record<string, { title: string; run: () => void | Promise<void> }> = {
  // Split by size: RSS and JSC's heap accounting are monotonic within a
  // process, so a 32 MiB run in front of a 64 MiB run inflates the latter.
  "validate-32": {
    title: "validate.ts:48 — whole-file TextDecoder('latin1').decode(), 32 MiB",
    run: () => scenarioValidateDecode([32]),
  },
  "validate-64": {
    title: "validate.ts:48 — whole-file TextDecoder('latin1').decode(), 64 MiB",
    run: () => scenarioValidateDecode([64]),
  },
  "live-whole": {
    title: "validate.ts — LIVE SET, whole-file decode (the strategy T5.6 replaces)",
    run: () => scenarioValidateLiveSet(false),
  },
  "live-chunked": {
    title: "validate.ts — LIVE SET, 1 MiB chunked scan (the strategy T5.6 lands)",
    run: () => scenarioValidateLiveSet(true),
  },
  getall: {
    title: "job-store.ts:118/:200 — store.getAll() as a PDF_STORE_MAX_BYTES quota check",
    run: scenarioGetAll,
  },
  status: {
    title: "job-store.ts:152-181 — claimPdfJob()'s read-modify-put over the payload",
    run: scenarioStatusRewrite,
  },
  blob: { title: "download.ts:19 — new Blob([bytes]) before createObjectURL", run: scenarioBlobCopy },
  hash: {
    title: "prepare.ts:177 + asset-budget.ts:83-91 — FNV-1a scanned twice per new asset",
    run: scenarioDoubleHash,
  },
};

const UNVERIFIABLE = `
${"=".repeat(78)}
NOT MEASURED BY THIS BUN/JSC HARNESS — use the Chrome/V8 harness
${"=".repeat(78)}

  (i)  "A Chrome IndexedDB Blob stays out-of-heap on get()."
       fake-indexeddb is a pure-JS in-memory model with no out-of-line blob
       store — a Blob round-tripped through it is structured-cloned like any
       other value, so a "pass" here would measure the polyfill, not Chrome.
       The real harness now measures this with a Chrome profile and CDP.

  (ii) "PDF.js range-/chunk-loads from a blob: URL rather than buffering it
       whole." PDF.js is not loaded here, so this process cannot answer it.

  Run: bun run bench:memory-chrome

  Recorded Chrome 140 result: an IndexedDB Blob stays out of V8 backing
  storage, but the PDF.js worker did not demonstrate chunk-only retention.
  Per PLAN Architecture point 9, the PdfBytesHandle seam remains and the
  STORAGE FORMAT stays Uint8Array.
`;

const requested = process.argv[2];
if (requested && requested in SCENARIOS) {
  const scenario = SCENARIOS[requested]!;
  console.log(`${"=".repeat(78)}\n${scenario.title}\n${"=".repeat(78)}`);
  await scenario.run();
} else if (requested) {
  console.error(`Unknown scenario "${requested}". Known: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(1);
} else {
  // Each scenario runs in a fresh process: RSS is monotonic within a process,
  // so a 64 MiB allocation in one scenario would mask the next one's.
  console.log(`bun ${Bun.version} — ${process.platform}/${process.arch}\n`);
  for (const name of Object.keys(SCENARIOS)) {
    const child = Bun.spawnSync({
      cmd: ["bun", import.meta.path, name],
      stdout: "inherit",
      stderr: "inherit",
    });
    if (!child.success) process.exit(child.exitCode ?? 1);
  }
  console.log(UNVERIFIABLE);
}
