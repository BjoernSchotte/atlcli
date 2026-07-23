import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  bindExportJobArtifacts,
  bindExportJobSpool,
  createEmptyExportJobStatsV1,
  DELIVERED_ARTIFACT_RETENTION_MS_V1,
  FULL_REPORT_RETENTION_MS_V1,
  prepareExportArtifactFinalizationIntent,
  type DocxExportJobRequestV1,
  type ExportJobExecutionContext,
  type ExportJobExecutor,
  type ExportJobFinalizeV1,
  type PendingArtifactV1,
  type PdfExportJobRequestV1,
} from "@atlcli/export-jobs";
import type { PreparedPdfExportV1 } from "@atlcli/pdf";
import type { PreparedDocxExportV1 } from "@atlcli/docx";
import type { DocxExportResultIntentV1 } from "@atlcli/export-wiring/jobs";
import { createFileExportJobPersistence } from "./persistence.js";
import { deliverFileExportArtifact } from "./delivery.js";
import { readFileExportReport } from "./executor-stores.js";
import {
  createFileExportExecutionContext,
  runClaimedFileExportJob,
} from "./runtime.js";
import { FileExportLock } from "./file-lock.js";
import { reconcileStaleExportJobs } from "./reconcile.js";
import { sweepFileExportJobRetentionV1 } from "./retention.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "atlcli-file-jobs-")); roots.push(path); return path; }

function request(id: string): DocxExportJobRequestV1 {
  return { schema: "atlcli.export-job-request/1", id, idempotencyKey: `idem:${id}`, format: "docx", renderer: "docx-typescript",
    source: { kind: "confluence", siteOrigin: "https://example.atlassian.net", locator: { kind: "page-id", id: "123" }, scope: { kind: "page" } },
    authRef: "profile:default", displayName: id, createdAt: 1, priority: "interactive", output: { policy: "collect" },
    template: { recordKey: "default", sha256: "0".repeat(64), name: "Default" }, options: { embedImages: true, resolveMacros: true } };
}
async function* bytes(value: string): AsyncIterable<Uint8Array> { yield new TextEncoder().encode(value); }
async function all(source: AsyncIterable<Uint8Array>): Promise<string> { const chunks: number[] = []; for await (const chunk of source) chunks.push(...chunk); return new TextDecoder().decode(Uint8Array.from(chunks)); }

describe("file export persistence", () => {
  it("durably creates before work and gives one claim to two independent instances", async () => {
    const dir = await root(); const first = createFileExportJobPersistence({ rootDir: dir }); const second = createFileExportJobPersistence({ rootDir: dir });
    await first.jobs.create({ request: request("job-1") });
    expect((await second.jobs.getRequest("request:job-1"))?.id).toBe("job-1");
    const claims = await Promise.all([
      first.jobs.claimNext({ ownerId: "a", now: 10, leaseDurationMs: 10_000 }),
      second.jobs.claimNext({ ownerId: "b", now: 10, leaseDurationMs: 10_000 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await second.jobs.get("job-1"))?.state).toBe("running");
  });

  it("persists an exact id claim without disturbing older queued work", async () => {
    const dir = await root(); const persistence = createFileExportJobPersistence({ rootDir: dir });
    await persistence.jobs.create({ request: request("older") });
    await persistence.jobs.create({ request: { ...request("current"), createdAt: 2 } });
    expect((await persistence.jobs.claimNext({ ownerId: "current-command", now: 10, leaseDurationMs: 10_000, ids: ["current"] }))?.id).toBe("current");
    expect((await persistence.jobs.get("older"))?.state).toBe("queued");
  });

  it("deduplicates a retry action with fresh identity while fencing output conflicts", async () => {
    let now = 10; const dir = await root(); const p = createFileExportJobPersistence({ rootDir: dir, now: () => now });
    await p.jobs.create({ request: request("origin") }); const running = (await p.jobs.claimNext({ ownerId: "a", now, leaseDurationMs: 100 }))!; now = 20;
    await p.jobs.compareAndSet({ kind: "transition", id: running.id, expectedRevision: running.revision, leaseEpoch: running.leaseEpoch, to: "failed", at: now,
      error: { code: "render.failed", message: "failed", category: "render", retryable: true, occurredAt: now } });
    const derivedFrom = { jobId: "origin", relation: "retry" as const, actionKey: "retry-click" };
    const child: DocxExportJobRequestV1 = { ...request("child"), displayName: "origin", createdAt: 30, priority: "retry", output: { policy: "path", targetRef: "/exports/origin.docx" } };
    expect((await p.jobs.create({ request: child, derivedFrom })).id).toBe("child");
    const acknowledgement: DocxExportJobRequestV1 = { ...child, id: "fresh", idempotencyKey: "idem:fresh", createdAt: 40 };
    expect((await p.jobs.create({ request: acknowledgement, derivedFrom })).id).toBe("child");
    await expect(p.jobs.create({ request: { ...acknowledgement, id: "conflict", idempotencyKey: "idem:conflict", output: { policy: "path", targetRef: "/exports/other.docx" } }, derivedFrom })).rejects.toMatchObject({ code: "derivation-conflict" });
  });

  it("claims only jobs whose opaque auth ref the process can resolve", async () => {
    const dir = await root(); const p = createFileExportJobPersistence({ rootDir: dir, now: () => 10 });
    await p.jobs.create({ request: { ...request("profile-a"), authRef: "cli-profile:a" } });
    await p.jobs.create({ request: { ...request("profile-b"), authRef: "cli-profile:b" } });
    expect((await p.jobs.claimNext({ ownerId: "b", now: 10, leaseDurationMs: 100, authRefs: ["cli-profile:b"] }))?.id).toBe("profile-b");
    expect(await p.jobs.claimNext({ ownerId: "c", now: 10, leaseDurationMs: 100, authRefs: ["cli-profile:c"] })).toBeUndefined();
  });

  it("serializes an actual cross-process claim through the journal lock", async () => {
    const dir = await root(); const persistence = createFileExportJobPersistence({ rootDir: dir }); await persistence.jobs.create({ request: request("job-process") });
    const entry = pathToFileURL(join(import.meta.dir, "../index.ts")).href;
    const code = `import { FileExportJobStore } from ${JSON.stringify(entry)}; const s=new FileExportJobStore(process.argv[1]); const c=await s.claimNext({ownerId:String(process.pid),now:10,leaseDurationMs:10000}); console.log(c?.id??"none")`;
    const spawn = () => Bun.spawn([process.execPath, "--conditions=development", "-e", code, dir], { stdout: "pipe", stderr: "pipe" });
    const a = spawn(), b = spawn(); const outputs = await Promise.all([new Response(a.stdout).text(), new Response(b.stdout).text()]); await Promise.all([a.exited, b.exited]);
    expect(outputs.map((value) => value.trim()).sort()).toEqual(["job-process", "none"]);
  });

  it("streams spool bytes, enforces quota, survives restart, and fences a cleaned epoch", async () => {
    const dir = await root(); const one = createFileExportJobPersistence({ rootDir: dir });
    const ref = { jobId: "job", leaseEpoch: 1, namespace: "pages", key: "1" };
    await one.spool.put(ref, bytes("abc"), { maxObjectBytes: 3, maxJobBytes: 3, maxTotalBytes: 3 });
    const two = createFileExportJobPersistence({ rootDir: dir }); expect(await all(two.spool.read(ref))).toBe("abc");
    await expect(two.spool.put({ ...ref, key: "2" }, bytes("d"), { maxObjectBytes: 3, maxJobBytes: 3, maxTotalBytes: 4 })).rejects.toThrow("Per-job");
    expect(await two.spool.deleteNamespace("job", 1)).toEqual({ objectsDeleted: 1, bytesDeleted: 3 });
    await expect(one.spool.put(ref, bytes("abc"), { maxObjectBytes: 3, maxJobBytes: 3, maxTotalBytes: 3 })).rejects.toThrow("closed");
  });

  it("reclaims a stale process, preserves its checkpoint bytes, and closes the old epoch", async () => {
    let now = 10; const dir = await root(); const p = createFileExportJobPersistence({ rootDir: dir, now: () => now }); await p.jobs.create({ request: request("stale-job") });
    let claimed = (await p.jobs.claimNext({ ownerId: "dead", now, leaseDurationMs: 10 }))!;
    const ref = { jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, namespace: "ready-docx", key: "checkpoint" };
    await p.spool.put(ref, bytes("checkpoint"), p.spoolLimits);
    claimed = await p.jobs.compareAndSet({ kind: "checkpoint", id: claimed.id, expectedRevision: claimed.revision, leaseEpoch: claimed.leaseEpoch, at: now, checkpointRef: "ready:checkpoint" });
    const staged = await p.artifacts.stage(claimed.id, claimed.leaseEpoch, { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "partial.docx", byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: bytes("abc") });
    now = 21; expect(await reconcileStaleExportJobs(p.jobs, p, now)).toMatchObject({ requeued: [claimed.id] });
    expect(await all(p.spool.read(ref))).toBe("checkpoint"); expect(await p.artifacts.getStaged(claimed.id, claimed.leaseEpoch)).toBeUndefined();
    await expect(p.spool.put({ ...ref, key: "late" }, bytes("late"), p.spoolLimits)).rejects.toThrow("closed");
    expect(staged.ref).toContain(claimed.id);
  });

  it("stages invisibly, recovers finalization, and atomically delivers without clobber", async () => {
    let now = 10; const dir = await root(); const persistence = createFileExportJobPersistence({ rootDir: dir, now: () => now });
    await persistence.jobs.create({ request: request("job-artifact") }); const claimed = (await persistence.jobs.claimNext({ ownerId: "a", now, leaseDurationMs: 1_000 }))!;
    const pending: PendingArtifactV1 = { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "x.docx", byteLength: 3,
      sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", bytes: bytes("abc") };
    const staged = await persistence.artifacts.stage(claimed.id, claimed.leaseEpoch, pending);
    await expect(all(persistence.artifacts.read(staged.ref))).rejects.toThrow("not committed");
    now = 20; const finalize: ExportJobFinalizeV1 = { id: claimed.id, expectedRevision: claimed.revision, leaseEpoch: claimed.leaseEpoch, stagedArtifact: staged, finishedAt: now };
    const intent = prepareExportArtifactFinalizationIntent(finalize); await persistence.artifacts.commitFinalization(intent);
    const restarted = createFileExportJobPersistence({ rootDir: dir, now: () => now });
    await restarted.jobs.finalizeArtifact(finalize); const succeeded = (await restarted.jobs.get(claimed.id))!;
    const outputDir = join(dir, "user-output"); await mkdir(outputDir); await chmod(outputDir, 0o755);
    const target = join(outputDir, "result.docx"); await deliverFileExportArtifact(restarted.artifacts, succeeded.artifact!, target); expect(await readFile(target, "utf8")).toBe("abc");
    expect((await stat(outputDir)).mode & 0o777).toBe(0o755);
    await expect(deliverFileExportArtifact(restarted.artifacts, succeeded.artifact!, target)).rejects.toThrow("already exists");
  });

  it("round-trips real prepared PDF shapes, binary assets, Date and Map across restart", async () => {
    const dir = await root(); const persistence = createFileExportJobPersistence({ rootDir: dir });
    const pdfRequest: PdfExportJobRequestV1 = { ...request("pdf-1"), format: "pdf", renderer: "pdf-typst", template: { id: "default", manifestVersion: "1" }, settings: {}, options: { resolveMacros: true } } as PdfExportJobRequestV1;
    await persistence.jobs.create({ request: pdfRequest }); const claimed = (await persistence.jobs.claimNext({ ownerId: "a", now: 1, leaseDurationMs: 100_000 }))!;
    const prepared: PreparedPdfExportV1 & { extensionMap: Map<string, number>; extensionDate: Date } = {
      schema: "atlcli.prepared-pdf-export/1", bundle: { main: "main", template: "template", assets: [{ path: "a.png", mediaType: "image/png", bytes: Uint8Array.of(1, 2, 3) }], sourceMap: [], notes: [] },
      filename: "x.pdf", profile: "tagged", sourceNotes: [], bundleNotes: [], counts: { images: 1, diagrams: 0, skipped: 0 }, complete: true, startedAt: 1, prepareMs: 2,
      extensionMap: new Map([["a", 1]]), extensionDate: new Date("2026-07-22T00:00:00Z"),
    };
    const checkpoint = await persistence.pdfReadyToRender.commit({ jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, request: pdfRequest, prepared,
      binding: { byteLength: 123, sha256: "a".repeat(64) }, estimate: { heapBytes: 1, spoolBytes: 2, outputBytes: 3, rasterPixels: 0, confidence: "estimated" }, signal: new AbortController().signal });
    const restarted = createFileExportJobPersistence({ rootDir: dir }); const materialized = await restarted.pdfReadyToRender.materialize({ checkpoint, jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, signal: new AbortController().signal }) as typeof prepared;
    expect([...materialized.bundle!.assets[0]!.bytes]).toEqual([1, 2, 3]); expect(materialized.extensionMap.get("a")).toBe(1); expect(materialized.extensionDate.toISOString()).toBe("2026-07-22T00:00:00.000Z");
    const attempt = await restarted.pdfReadyToRender.beginRenderAttempt({ checkpoint, jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, signal: new AbortController().signal }); expect(attempt.renderAttempts).toBe(1);
  });

  it("round-trips a prepared DOCX render state and its binary archive across restart", async () => {
    const dir = await root(); const persistence = createFileExportJobPersistence({ rootDir: dir }); const docxRequest = request("docx-ready");
    await persistence.jobs.create({ request: docxRequest }); const claimed = (await persistence.jobs.claimNext({ ownerId: "a", now: 1, leaseDurationMs: 100_000 }))!;
    const prepared: PreparedDocxExportV1 = {
      schema: "atlcli.prepared-docx-export/1",
      renderState: { archiveBytes: Uint8Array.of(80, 75, 3, 4), bodyXml: "<w:p/>", includes: [["include-1", "<w:p><w:r/></w:p>"]] },
      filename: "x.docx", complete: true, updateFields: "auto", trustedSeqSequenceNames: [], resolvedCount: 0, unsupportedNames: [], embeddedImages: 0, renderedDiagrams: 0,
      scan: { supported: [], unsupported: [], never: [], parts: ["word/document.xml"], hasContentPlaceholder: true, stylerefStyleNames: [], foreignPlaceholders: [], riskyFieldInstructions: [], seqSequenceNames: [] },
      sourceNotes: [], baseNotes: [], timings: { resolveMs: 0, bodyMs: 0, logoFetchMs: 0, includeFetchMs: 0, renderMs: 0, imageFetchMs: 0, imageFetches: 0, diagramRenderMs: 0, diagramRasterMs: 0 }, startedAt: 1,
    };
    const checkpoint = await persistence.docxReadyToRender.commit({ jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, request: docxRequest, prepared,
      binding: { byteLength: 4, sha256: "a".repeat(64) }, template: { recordKey: "default", byteLength: 10, sha256: "0".repeat(64) },
      estimate: { heapBytes: 1, spoolBytes: 4, outputBytes: 4, rasterPixels: 0, confidence: "estimated" }, signal: new AbortController().signal });
    const restarted = createFileExportJobPersistence({ rootDir: dir });
    const materialized = await restarted.docxReadyToRender.materialize({ checkpoint, jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, signal: new AbortController().signal });
    expect([...materialized.renderState!.archiveBytes]).toEqual([80, 75, 3, 4]);
    expect(materialized.renderState!.includes).toEqual([["include-1", "<w:p><w:r/></w:p>"]]);
  });

  it("keeps report refs logical and resolves report bytes through the store", async () => {
    const dir = await root(); const p = createFileExportJobPersistence({ rootDir: dir }); await p.jobs.create({ request: request("result-job") }); const claimed = (await p.jobs.claimNext({ ownerId: "a", now: 1, leaseDurationMs: 100_000 }))!;
    const context: ExportJobExecutionContext = { jobId: claimed.id, leaseEpoch: claimed.leaseEpoch, signal: new AbortController().signal,
      spool: bindExportJobSpool(p.spool, claimed.id, claimed.leaseEpoch, p.spoolLimits), artifacts: bindExportJobArtifacts(p.artifacts, claimed.id, claimed.leaseEpoch), updateProgress: async () => {}, updateStats: async () => {}, appendEvent: async () => {}, checkpoint: async () => {} };
    const intent: DocxExportResultIntentV1 = { schema: "atlcli.docx-result-intent/1", key: { schema: "atlcli.docx-result-key/1", ref: `docx-result:${"a".repeat(64)}`, jobId: claimed.id, requestId: claimed.id, requestKey: `idem:${claimed.id}`, requestSha256: "b".repeat(64), checkpointRef: "ready", preparedByteLength: 1, preparedSha256: "c".repeat(64), template: { recordKey: "default", byteLength: 1, sha256: "0".repeat(64) }, estimate: { heapBytes: 1, spoolBytes: 1, outputBytes: 3, rasterPixels: 0, confidence: "estimated" } },
      artifact: { mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", filename: "x.docx", byteLength: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" }, reportRef: "logical:report:1", reportSha256: "d".repeat(64), reportSummary: { issues: { info: 0, warning: 0, error: 0 }, topCodes: [], completeness: "complete" } };
    await p.docxResults.prepare({ intent, report: { schema: "report/1", notes: [] } as never }, context);
    expect(await readFileExportReport<{ schema: string; notes: unknown[] }>(p.jobs, intent.reportRef)).toEqual({ schema: "report/1", notes: [] });
    expect((await p.jobs.resolveExecutorReportPath(intent.reportRef))?.includes(intent.reportRef)).toBe(false);
  });

  it("removes executor state, reports, and CLI projections when tombstone cleanup completes", async () => {
    let now = 1;
    const dir = await root();
    const p = createFileExportJobPersistence({ rootDir: dir, now: () => now });
    await p.jobs.create({ request: request("cleanup-job") });
    const claimed = (await p.jobs.claimNext({ ownerId: "a", now, leaseDurationMs: 100_000 }))!;
    const context: ExportJobExecutionContext = {
      jobId: claimed.id,
      leaseEpoch: claimed.leaseEpoch,
      signal: new AbortController().signal,
      spool: bindExportJobSpool(p.spool, claimed.id, claimed.leaseEpoch, p.spoolLimits),
      artifacts: bindExportJobArtifacts(p.artifacts, claimed.id, claimed.leaseEpoch),
      updateProgress: async () => {},
      updateStats: async () => {},
      appendEvent: async () => {},
      checkpoint: async () => {},
    };
    const intent: DocxExportResultIntentV1 = {
      schema: "atlcli.docx-result-intent/1",
      key: {
        schema: "atlcli.docx-result-key/1",
        ref: `docx-result:${"e".repeat(64)}`,
        jobId: claimed.id,
        requestId: claimed.id,
        requestKey: `idem:${claimed.id}`,
        requestSha256: "b".repeat(64),
        checkpointRef: "ready",
        preparedByteLength: 1,
        preparedSha256: "c".repeat(64),
        template: { recordKey: "default", byteLength: 1, sha256: "0".repeat(64) },
        estimate: { heapBytes: 1, spoolBytes: 1, outputBytes: 3, rasterPixels: 0, confidence: "estimated" },
      },
      artifact: {
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        filename: "x.docx",
        byteLength: 3,
        sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      },
      reportRef: "logical:report:cleanup",
      reportSha256: "d".repeat(64),
      reportSummary: { issues: { info: 0, warning: 0, error: 0 }, topCodes: [], completeness: "complete" },
    };
    await p.docxResults.prepare({ intent, report: { schema: "report/1", notes: [] } as never }, context);
    const reportPath = (await p.jobs.resolveExecutorReportPath(intent.reportRef))!;
    const projectionDir = join(dir, "cli-projections");
    await mkdir(projectionDir, { recursive: true });
    const projectionPath = join(projectionDir, `${createHash("sha256").update(claimed.id).digest("hex")}.json`);
    await writeFile(projectionPath, "{}\n");

    now = 2;
    const latest = (await p.jobs.get(claimed.id))!;
    await p.jobs.compareAndSet({
      kind: "transition",
      id: latest.id,
      expectedRevision: latest.revision,
      leaseEpoch: latest.leaseEpoch,
      to: "failed",
      at: now,
      error: { code: "test.failed", message: "failed", category: "render", retryable: true, occurredAt: now },
    });
    now = 3;
    const deleted = await p.jobs.deleteTerminal({ finishedBefore: now });
    const tombstone = (await p.jobs.getTombstone(claimed.id))!;
    expect(deleted.deletedJobIds).toEqual([claimed.id]);

    await p.jobs.markTombstoneCleanupComplete(claimed.id, tombstone.ref, now);
    expect(await readFileExportReport(p.jobs, intent.reportRef)).toBeUndefined();
    expect(await p.jobs.loadExecutorResult(intent.key.ref)).toBeUndefined();
    await expect(stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(projectionPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the same restart-safe artifact/report retention policy in the CLI host", async () => {
    let now = 1;
    const dir = await root();
    const p = createFileExportJobPersistence({ rootDir: dir, now: () => now });
    await p.jobs.create({ request: request("retention-job") });
    const claimed = (await p.jobs.claimNext({
      ownerId: "cli",
      now,
      leaseDurationMs: 1_000,
    }))!;
    const requestPin = {
      jobId: claimed.id,
      leaseEpoch: claimed.leaseEpoch,
      namespace: "request-assets",
      key: "docx-template",
    };
    await p.spool.put(requestPin, bytes("template"), p.spoolLimits);
    const staged = await p.artifacts.stage(claimed.id, claimed.leaseEpoch, {
      mediaType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      filename: "retained.docx",
      byteLength: 3,
      sha256:
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
      bytes: bytes("abc"),
    });
    const reportDir = join(dir, "reports");
    await mkdir(reportDir, { recursive: true });
    const reportPath = join(reportDir, "retention-report.json");
    await writeFile(reportPath, "{\"schema\":\"report/1\"}\n");
    const reportRef = "logical:report:retention";
    await p.jobs.prepareExecutorResult({
      key: "retention-result",
      jobId: claimed.id,
      leaseEpoch: claimed.leaseEpoch,
      intent: { jobId: claimed.id },
      reportRef,
      reportPath,
    });
    now = 10;
    const succeeded = await p.jobs.finalizeArtifact({
      id: claimed.id,
      expectedRevision: claimed.revision,
      leaseEpoch: claimed.leaseEpoch,
      stagedArtifact: staged,
      reportRef,
      reportSummary: {
        issues: { info: 0, warning: 1, error: 0 },
        topCodes: [{ code: "image-skipped", count: 1 }],
        completeness: "partial",
      },
      finishedAt: now,
    });
    now = 20;
    await p.jobs.deliver(succeeded.id, succeeded.revision, now);
    now = Math.max(
      now + DELIVERED_ARTIFACT_RETENTION_MS_V1,
      10 + FULL_REPORT_RETENTION_MS_V1,
    );

    expect(await sweepFileExportJobRetentionV1(p, now)).toMatchObject({
      payloadReleases: 1,
      historyDeleted: 0,
    });
    const retained = (await p.jobs.get(claimed.id))!;
    expect(retained).toMatchObject({
      artifactReleasedAt: now,
      reportReleasedAt: now,
      reportSummary: {
        issues: { warning: 1 },
      },
    });
    expect(retained.artifact).toBeUndefined();
    expect(retained.reportRef).toBeUndefined();
    await expect(all(p.artifacts.read(staged.ref))).rejects.toThrow("not committed");
    await expect(stat(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await all(p.spool.read(requestPin))).toBe("template");

    const restarted = createFileExportJobPersistence({
      rootDir: dir,
      now: () => now,
    });
    expect(await sweepFileExportJobRetentionV1(restarted, now)).toEqual({
      payloadReleases: 0,
      historyDeleted: 0,
      tombstonesReconciled: 0,
    });
  });

  it("observes durable cross-instance cancellation without heartbeat journal flooding", async () => {
    const dir = await root(); const owner = createFileExportJobPersistence({ rootDir: dir }); const controller = createFileExportJobPersistence({ rootDir: dir });
    await owner.jobs.create({ request: request("cancel-job") }); const claimed = (await owner.jobs.claimNext({ ownerId: "owner", now: Date.now(), leaseDurationMs: 10_000 }))!;
    const runtime = createFileExportExecutionContext({ claimed, jobs: owner.jobs, spool: owner.spool, artifacts: owner.artifacts, spoolLimits: owner.spoolLimits, heartbeatIntervalMs: 5_000, cancelPollMs: 10 });
    const before = (await import("node:fs/promises")).readdir(join(dir, "journal")).then((values) => values.length);
    const latest = (await controller.jobs.get(claimed.id))!; await controller.jobs.compareAndSet({ kind: "transition", id: latest.id, expectedRevision: latest.revision, to: "cancelling", at: Date.now() });
    await new Promise((resolve) => setTimeout(resolve, 40)); expect(runtime.context.signal.aborted).toBe(true);
    const after = (await import("node:fs/promises")).readdir(join(dir, "journal")).then((values) => values.length); expect((await after) - (await before)).toBeLessThanOrEqual(2);
    await runtime.stop();
  });

  it("persists execution-context statistics and bounded stage/progress events", async () => {
    const dir = await root();
    let now = 10;
    const persistence = createFileExportJobPersistence({
      rootDir: dir,
      now: () => now,
    });
    await persistence.jobs.create({ request: request("runtime-telemetry") });
    const claimed = (await persistence.jobs.claimNext({
      ownerId: "telemetry-owner",
      now,
      leaseDurationMs: 10_000,
    }))!;
    const runtime = createFileExportExecutionContext({
      claimed,
      jobs: persistence.jobs,
      spool: persistence.spool,
      artifacts: persistence.artifacts,
      spoolLimits: persistence.spoolLimits,
      now: () => now,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
    });

    now = 20;
    await runtime.context.updateProgress({
      stage: "fetch",
      done: 1,
      total: 2,
      updatedAt: now,
    });
    await runtime.context.updateStats({
      ...createEmptyExportJobStatsV1(),
      pages: { discovered: 2, fetched: 1, composed: 0, skipped: 0 },
    });

    expect((await runtime.snapshot()).stats).toMatchObject({
      pages: { discovered: 2, fetched: 1, composed: 0, skipped: 0 },
      metricSupport: {
        "storage.spoolPeakBytes": "unavailable",
        "memory.heapPeakBytes": "unavailable",
        "memory.rendererPeakBytes": "unavailable",
      },
    });
    expect((await persistence.jobs.readEvents(claimed.id)).events).toEqual([
      { kind: "stage", seq: 1, at: 20, stage: "fetch" },
      {
        kind: "progress",
        seq: 2,
        at: 20,
        progress: { stage: "fetch", done: 1, total: 2, updatedAt: 20 },
      },
    ]);
    await runtime.stop();
  });

  it("records terminal state, artifact, and failure issues in the file runtime", async () => {
    const dir = await root();
    const persistence = createFileExportJobPersistence({ rootDir: dir, now: () => 20 });
    await persistence.jobs.create({ request: request("runtime-events") });
    const claimed = (await persistence.jobs.claimNext({
      ownerId: "worker",
      now: 10,
      leaseDurationMs: 10_000,
    }))!;
    const executor: ExportJobExecutor<DocxExportJobRequestV1> = {
      format: "docx",
      async execute(_request, context) {
        const stagedArtifact = await context.artifacts.stage({
          mediaType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          filename: "runtime.docx",
          byteLength: 3,
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
          bytes: bytes("abc"),
        });
        return {
          stagedArtifact,
          reportRef: "report:runtime-events",
          reportSummary: {
            issues: { info: 0, warning: 0, error: 0 },
            topCodes: [],
            completeness: "complete",
          },
        };
      },
    };

    const finished = await runClaimedFileExportJob({
      claimed,
      jobs: persistence.jobs,
      spool: persistence.spool,
      artifacts: persistence.artifacts,
      spoolLimits: persistence.spoolLimits,
      executor,
      now: () => 20,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
    });

    expect(finished.state).toBe("succeeded");
    expect((await persistence.jobs.readEvents(finished.id)).events).toMatchObject([
      { kind: "state", from: "running", to: "succeeded" },
      { kind: "artifact", artifact: { filename: "runtime.docx", byteLength: 3 } },
    ]);

    await persistence.jobs.create({ request: request("runtime-failure") });
    const failedClaim = (await persistence.jobs.claimNext({
      ownerId: "worker",
      now: 21,
      leaseDurationMs: 10_000,
      ids: ["runtime-failure"],
    }))!;
    const failed = await runClaimedFileExportJob({
      claimed: failedClaim,
      jobs: persistence.jobs,
      spool: persistence.spool,
      artifacts: persistence.artifacts,
      spoolLimits: persistence.spoolLimits,
      executor: {
        format: "docx",
        execute: async () => {
          throw new Error("render failed");
        },
      },
      now: () => 22,
      heartbeatIntervalMs: 60_000,
      cancelPollMs: 60_000,
    });
    expect(failed.state).toBe("failed");
    expect((await persistence.jobs.readEvents(failed.id)).events).toMatchObject([
      { kind: "state", from: "running", to: "failed" },
      { kind: "issue", level: "error", code: "executor.failed" },
    ]);
  });

  it("returns ascending event pages after a cursor", async () => {
    let now = 1_000;
    const dir = await root(); const p = createFileExportJobPersistence({ rootDir: dir, now: () => now }); await p.jobs.create({ request: request("events") });
    const claimed = (await p.jobs.claimNext({ ownerId: "a", now, leaseDurationMs: 100_000 }))!;
    let current = claimed;
    for (let index = 0; index < 3; index++) {
      now += 501;
      current = await p.jobs.compareAndSet({ kind: "progress", id: current.id, expectedRevision: current.revision, leaseEpoch: current.leaseEpoch, progress: { stage: "compose", done: index, total: 3, updatedAt: now } });
      now += 1;
      await p.jobs.appendEvent(current.id, { expectedRevision: current.revision, leaseEpoch: current.leaseEpoch, event: { kind: "progress", seq: index + 1, at: now, progress: current.progress! } });
    }
    expect(await p.jobs.readEvents(current.id, { afterSeq: 1, limit: 1 })).toEqual({
      events: [expect.objectContaining({ seq: 2 })],
      nextAfterSeq: 2,
      hasMore: true,
    });
  });

  it("recovers a stale nonce lock and fences the previous releaser", async () => {
    const dir = await root(); let now = 1; const first = new FileExportLock(join(dir, "locks", "test.lock"), { ttlMs: 10, pollMs: 1, now: () => now });
    const old = await first.acquire(); now = 20; const replacement = await first.acquire();
    await expect(old.release()).rejects.toThrow("lost"); await replacement.release();
  });

  it("serializes lease refresh against stale-lock replacement", async () => {
    const dir = await root(); let now = 1; const lock = new FileExportLock(join(dir, "locks", "refresh-race.lock"), { ttlMs: 10, pollMs: 1, now: () => now });
    const old = await lock.acquire(); now = 20; const abort = new AbortController(); const timer = setTimeout(() => abort.abort(), 50);
    const [refresh, replacement] = await Promise.allSettled([old.refresh(), lock.acquire({ signal: abort.signal })]); clearTimeout(timer);
    expect([refresh.status, replacement.status].filter((status) => status === "fulfilled")).toHaveLength(1);
    if (replacement.status === "fulfilled") await replacement.value.release();
    else await old.release();
  });

  it("keeps state directories and committed files private", async () => {
    const dir = await root(); await chmod(dir, 0o755); const p = createFileExportJobPersistence({ rootDir: dir }); await p.jobs.create({ request: request("private") });
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "journal"))).mode & 0o777).toBe(0o700);
    const head = (await import("node:fs/promises")).readdir(join(dir, "journal")).then((names) => names.find((name) => name.endsWith(".json"))!);
    expect((await stat(join(dir, "journal", await head))).mode & 0o777).toBe(0o600);
  });
});
