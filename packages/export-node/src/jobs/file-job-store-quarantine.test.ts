import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DocxExportJobRequestV1, PdfExportJobRequestV1 } from "@atlcli/export-jobs";
import { FileExportJobStore, type FileExportQuarantinedRecordV1 } from "./file-job-store.js";

const HASH = "a".repeat(64);
// A template discriminant no atlcli build understands today, standing in for
// whatever a future or branch build writes next.
const FOREIGN_TEMPLATE = { kind: "remote", url: "https://example.com/pack" };
// Shapes from the original poisoning incident; valid since template packs
// landed, so they must load as-is.
const PACK_TEMPLATE = { kind: "pack", archiveSha256: HASH, recordKey: `template-pack:sha256:${HASH}` };
const BUILTIN_TEMPLATE = { kind: "builtin", id: "builtin-default", manifestVersion: "1" };

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root(): Promise<string> { const path = await mkdtemp(join(tmpdir(), "atlcli-quarantine-")); roots.push(path); return path; }

function pdfRequest(id: string): PdfExportJobRequestV1 {
  return { schema: "atlcli.export-job-request/1", id, idempotencyKey: `idem:${id}`, format: "pdf", renderer: "pdf-typst",
    source: { kind: "confluence", siteOrigin: "https://example.atlassian.net", locator: { kind: "page-id", id: "123" }, scope: { kind: "page" } },
    authRef: "profile:default", displayName: id, createdAt: 1, priority: "interactive", output: { policy: "collect" },
    template: { kind: "builtin", id: "builtin-default", manifestVersion: "1" }, settings: {}, options: { resolveMacros: true } };
}

function docxRequest(id: string): DocxExportJobRequestV1 {
  return { schema: "atlcli.export-job-request/1", id, idempotencyKey: `idem:${id}`, format: "docx", renderer: "docx-typescript",
    source: { kind: "confluence", siteOrigin: "https://example.atlassian.net", locator: { kind: "page-id", id: "123" }, scope: { kind: "page" } },
    authRef: "profile:default", displayName: id, createdAt: 1, priority: "interactive", output: { policy: "collect" },
    template: { recordKey: "default", sha256: HASH, name: "Default" }, options: { embedImages: true, resolveMacros: true } };
}

async function headPath(dir: string): Promise<string> {
  const names = (await readdir(join(dir, "journal"))).filter((name) => /^[0-9]{20}\.json$/.test(name)).sort();
  return join(dir, "journal", names.at(-1)!);
}

/** Rewrite the newest journal head in place, as a foreign build's writer would have. */
async function editHead(dir: string, edit: (catalog: any) => void): Promise<void> {
  const path = await headPath(dir);
  const catalog = JSON.parse(await readFile(path, "utf8"));
  edit(catalog);
  await writeFile(path, `${JSON.stringify(catalog)}\n`);
}

async function readHead(dir: string): Promise<any> {
  return JSON.parse(await readFile(await headPath(dir), "utf8"));
}

/** Seed one committed job, then poison its stored request as another build's writer. */
async function poisoned(id: string, mutateRequest: (request: any) => void): Promise<string> {
  const dir = await root();
  await new FileExportJobStore(dir).create({ request: pdfRequest(id) });
  await editHead(dir, (catalog) => { mutateRequest(catalog.requests[`request:${id}`]); });
  return dir;
}

describe("file export job store quarantine", () => {
  // Regression for the poisoned-journal bug: one stored request outside this
  // build's contract made #load throw for every store operation, so every new
  // `wiki export` died with exit 4 on
  // "request.template.kind: is not part of this contract shape".
  it("creates, lists, and claims new jobs although a foreign template record is present", async () => {
    const dir = await poisoned("historical", (request) => { request.template = FOREIGN_TEMPLATE; });
    const reported: FileExportQuarantinedRecordV1[] = [];
    const store = new FileExportJobStore(dir, { onQuarantine: (records) => reported.push(...records) });

    const created = await store.create({ request: pdfRequest("fresh") });

    expect(created.state).toBe("queued");
    expect((await store.list()).map((job) => job.id)).toEqual(["fresh"]);
    expect((await store.claimNext({ ownerId: "owner", now: 10, leaseDurationMs: 10_000 }))?.id).toBe("fresh");
    const entries = await store.listQuarantined();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("historical");
    expect(entries[0]!.reason).toContain("request.template.kind");
    expect((entries[0]!.request as any).template).toEqual(FOREIGN_TEMPLATE);
    // Several loads ran above; the observer hears about each record only once.
    expect(reported.map((record) => record.key)).toEqual(["historical"]);
  });

  it("loads the original incident's builtin and pack shapes as-is now that packs landed", async () => {
    const dir = await root();
    const seed = new FileExportJobStore(dir);
    await seed.create({ request: pdfRequest("was-builtin") });
    await seed.create({ request: pdfRequest("was-pack") });
    await editHead(dir, (catalog) => {
      catalog.requests["request:was-builtin"].template = BUILTIN_TEMPLATE;
      catalog.requests["request:was-pack"].template = PACK_TEMPLATE;
    });
    const reported: FileExportQuarantinedRecordV1[] = [];
    const store = new FileExportJobStore(dir, { onQuarantine: (records) => reported.push(...records) });

    expect((await store.list()).map((job) => job.id).sort()).toEqual(["was-builtin", "was-pack"]);
    expect((await store.getRequest("request:was-pack"))?.template).toEqual(PACK_TEMPLATE as never);
    expect(await store.listQuarantined()).toEqual([]);
    expect(reported).toEqual([]);
  });

  it("releases a quarantined record's idempotency key so an identical re-run creates a fresh job", async () => {
    const dir = await poisoned("poisoned", (request) => { request.template = FOREIGN_TEMPLATE; });
    const store = new FileExportJobStore(dir);

    const rerun = { ...pdfRequest("rerun"), idempotencyKey: "idem:poisoned" };

    expect((await store.create({ request: rerun })).id).toBe("rerun");
  });

  it("rejects a new job whose id is still held by a quarantined record", async () => {
    const dir = await poisoned("historical", (request) => { request.template = FOREIGN_TEMPLATE; });
    const store = new FileExportJobStore(dir);

    await store.list();
    await expect(store.create({ request: pdfRequest("historical") })).rejects.toMatchObject({ code: "duplicate-id" });
  });

  it("preserves the raw foreign unit verbatim across commits and store instances", async () => {
    const dir = await poisoned("historical", (request) => { request.template = FOREIGN_TEMPLATE; });
    const store = new FileExportJobStore(dir);

    await store.create({ request: pdfRequest("fresh") });

    const persisted = (await readHead(dir)).quarantined["historical"];
    expect(persisted.request.template).toEqual(FOREIGN_TEMPLATE);
    expect(persisted.snapshot.id).toBe("historical");
    expect(persisted.idempotencyKeys).toEqual(["idem:historical"]);
    expect((await new FileExportJobStore(dir).listQuarantined())[0]!.key).toBe("historical");
  });

  it("quarantines any contract violation, not only template drift", async () => {
    const dir = await root();
    await new FileExportJobStore(dir).create({ request: docxRequest("docx-historical") });
    await editHead(dir, (catalog) => { catalog.requests["request:docx-historical"].options.futureFlag = true; });
    const store = new FileExportJobStore(dir);

    expect((await store.create({ request: pdfRequest("fresh") })).state).toBe("queued");
    expect((await store.listQuarantined())[0]!.reason).toContain("request.options.futureFlag");
  });

  it("restores a quarantined unit once the running build parses it again", async () => {
    const dir = await root();
    await new FileExportJobStore(dir, { now: () => 5 }).create({ request: pdfRequest("frozen") });
    // A pre-template-pack build with this quarantine fix would have captured
    // exactly this unit; the running build understands it and must bring it
    // back, replay keys included.
    await editHead(dir, (catalog) => {
      catalog.quarantined = { frozen: { key: "frozen", reason: "request.template.kind: is not part of this contract shape", quarantinedAt: 2,
        snapshot: catalog.jobs["frozen"], requestRef: "request:frozen", request: catalog.requests["request:frozen"], events: catalog.events["frozen"],
        nextEventSeq: catalog.nextEventSeq["frozen"], transitions: catalog.transitions["frozen"], idempotencyKeys: ["idem:frozen"] } };
      delete catalog.jobs["frozen"]; delete catalog.requests["request:frozen"]; delete catalog.events["frozen"];
      delete catalog.nextEventSeq["frozen"]; delete catalog.transitions["frozen"]; delete catalog.idempotency["idem:frozen"];
    });
    const store = new FileExportJobStore(dir);

    expect((await store.list()).map((job) => job.id)).toEqual(["frozen"]);
    expect(await store.listQuarantined()).toEqual([]);
    expect((await store.getRequest("request:frozen"))?.template).toEqual(BUILTIN_TEMPLATE as never);
    // The rebuilt idempotency index acknowledges the restored job again.
    expect((await store.create({ request: pdfRequest("frozen") })).id).toBe("frozen");
  });
});
