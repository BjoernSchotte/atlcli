import { Database } from "bun:sqlite";
import { afterEach, expect, it, spyOn } from "bun:test";
import fs, { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { NfsJournal, nfsJournalLocation } from "./nfs-journal.js";

const roots: string[] = [];
const journals: NfsJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) { try { journal.close(); } catch {} }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(maxBytes = 4096, maxFileBytes = 1024, maxFiles = 4096) {
  const root = mkdtempSync(join(tmpdir(), "nfs-journal-")); roots.push(root);
  const path = join(root, "journal.sqlite");
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", maxBytes, maxFileBytes, maxFiles);
  journals.push(journal);
  return { path, journal };
}
const bytes = (value: string) => Buffer.from(value);

it("atomically promotes a page directory and body with distinct identities and retained children", () => {
  const { path, journal } = fixture();
  const directory = journal.createPageDirectory("/DOCSY/new-page", 0o700);
  const body = journal.local(`${directory.path}/_index.md`)!;
  expect(body.id).not.toBe(directory.id);
  expect(journal.attributes(body.id)?.mode).toBe(0o644);
  journal.write(body.id, 0, bytes("First"));
  const nested = journal.createPageDirectory(`${directory.path}/child`);
  const child = journal.local(`${nested.path}/_index.md`)!;
  journal.write(child.id, 0, bytes("Child"));
  const intent = journal.beginCreate(body.id, body.path, "DOCSY", "100", journal.get(body.id)!.revision)!;
  journal.write(body.id, 0, bytes("Later"));
  journal.recordCreated(body.id, intent.revision, "200", 1);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  const promoted = reopened.promoteCreated(body.id, "/DOCSY/new-page-200/_index.md");
  expect(Buffer.from(promoted.bytes).toString()).toBe("Later");
  expect(Buffer.from(reopened.publishedSource("200")!).toString()).toBe("First");
  expect(promoted.revision).toBeGreaterThan(promoted.publishedRevision);
  expect(reopened.promotion(directory.id)).toEqual({ localId: directory.id, path: directory.path, pageId: "200", directory: true });
  expect(reopened.promotion(directory.path)).toEqual(reopened.promotion("200", true));
  expect(reopened.promotion(body.id)).toEqual({ localId: body.id, path: body.path, pageId: "200" });
  expect(reopened.attributes(directory.id)?.mode).toBe(0o700);
  expect(reopened.attributes("200")?.mode).toBe(0o644);
  expect(reopened.get(nested.id)?.path).toBe("/DOCSY/new-page-200/child");
  expect(reopened.get(child.id)?.path).toBe("/DOCSY/new-page-200/child/_index.md");
  expect(Buffer.from(reopened.get(child.id)!.bytes).toString()).toBe("Child");
  expect(() => reopened.write(directory.id, 0, bytes("wrong"))).toThrow("directory");
  expect(() => reopened.truncate(directory.id, 0)).toThrow("directory");
  expect(reopened.promoteCreated(body.id, "/DOCSY/new-page-200/_index.md")).toEqual(promoted);
  reopened.close();
  const again = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(again);
  expect(again.promotion(directory.id)?.directory).toBe(true);
  expect(again.promotion(body.id)?.pageId).toBe("200");
});

it("rolls back a page-directory allocation when the second identity exceeds quota", () => {
  const { journal } = fixture(4096, 1024, 1);
  expect(() => journal.createPageDirectory("/DOCSY/new-page")).toThrow("quota");
  expect(journal.localEntries("/DOCSY")).toEqual([]);
  expect(journal.local("/DOCSY/new-page/_index.md")).toBeNull();
  expect(journal.createLocal("/DOCSY/still-available")).toBeDefined();
});

it("keeps a confirmed directory creation recoverable when descendant promotion collides", () => {
  const { journal } = fixture();
  const directory = journal.createPageDirectory("/DOCSY/new-page");
  const body = journal.local(`${directory.path}/_index.md`)!;
  const child = journal.createLocal(`${directory.path}/child.md`);
  journal.write(child.id, 0, bytes("Preserved"));
  journal.createLocal("/DOCSY/new-page-200/child.md");
  const intent = journal.beginCreate(body.id, body.path, "DOCSY", "100", body.revision)!;
  journal.recordCreated(body.id, intent.revision, "200", 1);
  expect(() => journal.promoteCreated(body.id, "/DOCSY/new-page-200/_index.md")).toThrow();
  expect(journal.createIntent(body.id)?.pageId).toBe("200");
  expect(journal.promotion(directory.id)).toBeNull();
  expect(journal.get("200")).toBeNull();
  expect(journal.get(child.id)?.path).toBe(child.path);
  expect(Buffer.from(journal.get(child.id)!.bytes).toString()).toBe("Preserved");
});

it("retires both page-directory aliases after confirmed trash without reusing their identities", () => {
  const { journal } = fixture();
  const directory = journal.createPageDirectory("/DOCSY/new-page");
  const body = journal.local(`${directory.path}/_index.md`)!;
  const intent = journal.beginCreate(body.id, body.path, "DOCSY", "100", body.revision)!;
  journal.recordCreated(body.id, intent.revision, "200", 1);
  journal.promoteCreated(body.id, "/DOCSY/new-page-200/_index.md");
  journal.beginTrash("200", "/DOCSY/new-page-200/_index.md", "DOCSY");
  journal.completeTrash("200");
  expect(journal.promotion(directory.id)).toBeNull();
  expect(journal.promotion(body.id)).toBeNull();
  expect(journal.get(directory.id)).toBeNull();
  expect(journal.get("200")).not.toBeNull();
  expect(journal.createPageDirectory(directory.path).id).not.toBe(directory.id);
});

it("migrates schema-fifteen file aliases without changing their identity or saved bytes", () => {
  const { path, journal } = fixture();
  const file = journal.createLocal("/DOCSY/newpage.md");
  journal.write(file.id, 0, bytes("Saved"));
  const intent = journal.beginCreate(file.id, file.path, "DOCSY", "100", journal.get(file.id)!.revision)!;
  journal.recordCreated(file.id, intent.revision, "200", 1);
  journal.promoteCreated(file.id, "/DOCSY/newpage-200/_index.md");
  journal.close();
  const legacy = new Database(path);
  legacy.exec("DROP INDEX promotion_directory; ALTER TABLE promotions DROP COLUMN directoryId; PRAGMA user_version=15");
  legacy.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.promotion(file.id)).toEqual({ localId: file.id, path: file.path, pageId: "200" });
  expect(reopened.promotion("200", true)).toBeNull();
  expect(Buffer.from(reopened.get("200")!.bytes).toString()).toBe("Saved");
  expect(reopened.createPageDirectory("/DOCSY/next").kind).toBe("directory");
});

it("refuses to relocate a child's frozen creation while promoting its directory", () => {
  const { journal } = fixture();
  const directory = journal.createPageDirectory("/DOCSY/new-page");
  const body = journal.local(`${directory.path}/_index.md`)!;
  const child = journal.createLocal(`${directory.path}/child.md`);
  journal.beginCreate(child.id, child.path, "DOCSY", "999", child.revision);
  const intent = journal.beginCreate(body.id, body.path, "DOCSY", "100", body.revision)!;
  journal.recordCreated(body.id, intent.revision, "200", 1);
  expect(() => journal.promoteCreated(body.id, "/DOCSY/new-page-200/_index.md")).toThrow("Child creation");
  expect(journal.get(child.id)?.path).toBe(child.path);
  expect(journal.createIntent(child.id)?.parentId).toBe("999");
  expect(journal.get("200")).toBeNull();
  expect(journal.createIntent(body.id)?.pageId).toBe("200");
});

it("syncs the journal directory and every ancestor before returning, including after a failed sync", () => {
  const root = mkdtempSync(join(tmpdir(), "nfs-journal-sync-")); roots.push(root);
  const path = join(root, "new", "nested", "journal.sqlite");
  const open = fs.openSync, sync = fs.fsyncSync;
  const directories = new Map<number, string>();
  const synced: string[] = [];
  const opened = spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = open(...args);
    directories.set(fd, String(args[0]));
    return fd;
  }) as typeof fs.openSync);
  let fail = true;
  const flushed = spyOn(fs, "fsyncSync").mockImplementation(fd => {
    synced.push(directories.get(fd)!);
    if (fail) throw Object.assign(new Error("Injected directory sync failure"), { code: "EIO" });
    sync(fd);
  });
  try {
    expect(() => new NfsJournal(path, "sync-test")).toThrow("Injected directory sync failure");
    for (const fd of directories.keys()) expect(() => fs.fstatSync(fd)).toThrow();
    fail = false;
    synced.length = 0;
    const journal = new NfsJournal(path, "sync-test"); journals.push(journal);
    const expected: string[] = [];
    for (let directory = realpathSync(dirname(path)); ; directory = dirname(directory)) {
      expected.push(directory);
      if (dirname(directory) === directory) break;
    }
    expect(synced).toEqual(expected);
    journal.admit("1", "/DOCSY/_index.md", bytes("durable"), 1);
    journal.close();
    const reopened = new NfsJournal(path, "sync-test"); journals.push(reopened);
    expect(Buffer.from(reopened.get("1")!.bytes).toString()).toBe("durable");
  } finally { flushed.mockRestore(); opened.mockRestore(); }
});

it("preserves byte ranges, split Unicode, truncation and sparse extension across reopen", () => {
  const { path, journal } = fixture();
  journal.admit("page:1", "/DOCSY/page/_index.md", bytes("before"), 7);
  journal.truncate("page:1", 0);
  const content = bytes("Grüße 🐴");
  for (let i = content.length - 1; i >= 0; i--) journal.write("page:1", i, content.subarray(i, i + 1));
  expect(Buffer.from(journal.get("page:1")!.bytes)).toEqual(content);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(Buffer.from(reopened.get("page:1")!.bytes)).toEqual(content);
  reopened.truncate("page:1", content.length + 3);
  expect([...reopened.get("page:1")!.bytes.slice(-3)]).toEqual([0, 0, 0]);
  expect(reopened.pending()).toHaveLength(1);
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it("retains the published snapshot and newer bytes independently", () => {
  const { journal } = fixture();
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("one"));
  const first = journal.beginPublish("1")!;
  journal.write("1", 0, bytes("two"));
  expect(Buffer.from(journal.beginPublish("1")!.bytes).toString()).toBe("one");
  journal.completePublish("1", first.revision, 2);
  expect(Buffer.from(journal.get("1")!.bytes).toString()).toBe("two");
  expect(journal.pending()).toHaveLength(1);
  const second = journal.beginPublish("1")!;
  expect(second.baseVersion).toBe(2);
  expect(Buffer.from(second.bytes).toString()).toBe("two");
  expect(() => journal.completePublish("1", first.revision, 3)).toThrow("Stale");
  journal.completePublish("1", second.revision, 3);
  expect(journal.pending()).toEqual([]);
});

it("does not dirty a byte-identical WRITE or TRUNCATE replay before or after publication", () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  expect(journal.write("1", 1, bytes("ld")).revision).toBe(0);
  expect(journal.truncate("1", 3).revision).toBe(0);
  expect(journal.beginPublish("1")).toBeNull();
  const changed = journal.write("1", 0, bytes("new"));
  const intent = journal.beginPublish("1")!;
  journal.failPublish("1", "REMOTE_RESULT_UNKNOWN");
  expect(journal.write("1", 0, bytes("new")).revision).toBe(changed.revision);
  expect(journal.truncate("1", 3).revision).toBe(changed.revision);
  expect(journal.get("1")!.error).toBe("REMOTE_RESULT_UNKNOWN");
  expect(journal.beginPublish("1")).toEqual(intent);
  journal.completePublish("1", intent.revision, 2);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.write("1", 0, bytes("new")).revision).toBe(changed.revision);
  expect(recovered.truncate("1", 3).revision).toBe(changed.revision);
  expect(recovered.pending()).toEqual([]);
  expect(recovered.beginPublish("1")).toBeNull();
  // Changed lengths remain mutations even when their extra bytes are zero.
  expect(recovered.truncate("1", 4).revision).toBe(changed.revision + 1);
  expect(recovered.write("1", 3, bytes("\0")).revision).toBe(changed.revision + 1);
  expect(recovered.truncate("1", 3).revision).toBe(changed.revision + 2);
});

it("preserves failed/ambiguous publication intent across restart and readmission", () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("new"));
  journal.beginPublish("1");
  journal.failPublish("1", "REMOTE_RESULT_UNKNOWN");
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  const file = recovered.admit("1", "/DOCSY/page/_index.md", bytes("overwrite"), 999);
  expect(Buffer.from(file.bytes).toString()).toBe("new");
  expect(file.error).toBe("REMOTE_RESULT_UNKNOWN");
  expect(recovered.beginPublish("1")!.baseVersion).toBe(1);
  expect(() => recovered.failPublish("1", "token=secret")).toThrow();
});

it("rejects profile/export mismatch and quota failures without altering acknowledged bytes", () => {
  const { path, journal } = fixture(8, 8);
  journal.admit("1", "/DOCSY/page/_index.md", bytes("12345678"), 1);
  expect(journal.write("1", 8, new Uint8Array()).revision).toBe(0);
  expect(() => journal.write("1", 8, bytes("x"))).toThrow();
  expect(() => journal.admit("2", "/DOCSY/other/_index.md", bytes("x"), 1)).toThrow("quota");
  journal.write("1", 0, bytes("X"));
  expect(() => journal.beginPublish("1")).toThrow("quota");
  expect(Buffer.from(journal.get("1")!.bytes).toString()).toBe("X2345678");
  expect(journal.get("1")!.revision).toBe(1);
  journal.close();
  expect(() => new NfsJournal(path, "other-account:DOCSY")).toThrow("identity");
});

it("recovers an acknowledged write and publication intent after SIGKILL", async () => {
  const { path, journal } = fixture(); journal.close();
  const source = `import { NfsJournal } from ${JSON.stringify(join(import.meta.dir, "nfs-journal.ts"))};
    const j=new NfsJournal(${JSON.stringify(path)},"synthetic-account:DOCSY");
    j.admit("1","/DOCSY/page/_index.md",new Uint8Array(),1);
    j.write("1",0,Buffer.from("durable 🐴"));j.beginPublish("1");
    const local=j.createLocal("/DOCSY/.save.tmp");
    j.write(local.id,0,Buffer.from("replaced after intent"));
    j.renameLocal(local.path,"/DOCSY/.renamed.tmp");
    j.replaceLocal("/DOCSY/.renamed.tmp","1");
    const replay=j.createLocal("/DOCSY/replay.tmp","0123456789abcdef");
    j.setAttributes(replay.id,{mode:384,atime:0});
    j.write(replay.id,0,Buffer.from("exclusive survives crash"));
    j.createLocalDirectory("/DOCSY/editor-dir");
    const draft=j.createLocal("/DOCSY/editor-dir/draft");
    const draftImage=j.write(draft.id,0,Buffer.from("directory crash recovery"));
    j.beginCreate(draft.id,draft.path,"DOCSY","100",draftImage.revision);
    j.recordCreated(draft.id,draftImage.revision,"123",1);
    j.admit("2","/DOCSY/second/_index.md",Buffer.from("safe backup"),1);
    j.backupPage("2","/DOCSY/second-backup");
    console.log("ACK");setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "--conditions=development", "-e", source], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ack = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("No journal ACK"); })]);
    expect(Buffer.from(ack.value!).toString()).toContain("ACK");
    reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
    expect(Buffer.from(recovered.get("1")!.bytes).toString()).toBe("replaced after intent");
    expect(recovered.localEntries("/DOCSY")).toHaveLength(3);
    expect(recovered.displaced("/DOCSY/second/_index.md")?.id).toBe("2");
    expect(Buffer.from(recovered.local("/DOCSY/second-backup")!.bytes).toString()).toBe("safe backup");
    expect(recovered.local("/DOCSY/editor-dir")?.kind).toBe("directory");
    expect(recovered.createIntent(recovered.local("/DOCSY/editor-dir/draft")!.id)).toMatchObject({ pageId: "123", version: 1, parentId: "100" });
    expect(Buffer.from(recovered.local("/DOCSY/editor-dir/draft")!.bytes).toString()).toBe("directory crash recovery");
    expect(Buffer.from(recovered.createLocal("/DOCSY/replay.tmp", "0123456789abcdef").bytes).toString()).toBe("exclusive survives crash");
    expect(Buffer.from(recovered.beginPublish("1")!.bytes).toString()).toBe("durable 🐴");
    expect(recovered.pending()).toHaveLength(1);
    expect(recovered.attributes(recovered.local("/DOCSY/replay.tmp")!.id)).toMatchObject({ mode: 0o600, atime: 0 });
  } finally { child.kill(); await child.exited; }
});


it("retains an unresolved publication warning when newer local bytes are saved", () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("sent"));
  const intent = journal.beginPublish("1")!;
  journal.failPublish("1", "REMOTE_RESULT_UNKNOWN");
  journal.truncate("1", 0);
  journal.write("1", 0, bytes("newer local edit"));
  expect(journal.get("1")!.error).toBe("REMOTE_RESULT_UNKNOWN");
  expect(Buffer.from(journal.beginPublish("1")!.bytes).toString()).toBe("sent");
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.get("1")!.error).toBe("REMOTE_RESULT_UNKNOWN");
  expect(Buffer.from(recovered.get("1")!.bytes).toString()).toBe("newer local edit");
  expect(recovered.beginPublish("1")!.revision).toBe(intent.revision);
  recovered.completePublish("1", intent.revision, 2);
  expect(recovered.get("1")!.error).toBeNull();
  expect(recovered.pending()).toHaveLength(1);
  expect(Buffer.from(recovered.beginPublish("1")!.bytes).toString()).toBe("newer local edit");
});


it("bounds empty-file entries and metadata without replacing recovered records", () => {
  const { path, journal } = fixture(16, 16, 2);
  expect(() => journal.admit("x".repeat(257), "/DOCSY/a", bytes(""), 1)).toThrow("Invalid");
  expect(() => journal.admit("1", "/" + "🐴".repeat(1024), bytes(""), 1)).toThrow("Invalid");
  expect(() => journal.admit("1", "/DOCSY/a\0b", bytes(""), 1)).toThrow("Invalid");
  journal.admit("1", "/DOCSY/a", bytes(""), 1);
  journal.admit("2", "/DOCSY/b", bytes(""), 1);
  expect(() => journal.admit("3", "/DOCSY/c", bytes(""), 1)).toThrow("file-count quota");
  expect(journal.get("3")).toBeNull();
  journal.write("1", 0, bytes("keep"));
  expect(Buffer.from(journal.admit("1", "/DOCSY/a", bytes("replace"), 99).bytes).toString()).toBe("keep");
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY", 16, 16, 1); journals.push(recovered);
  expect(Buffer.from(recovered.get("1")!.bytes).toString()).toBe("keep");
  expect(recovered.get("2")).not.toBeNull();
  expect(() => recovered.admit("3", "/DOCSY/c", bytes(""), 1)).toThrow("file-count quota");
});

it("caps SQLite storage and rolls back full-database writes without losing acknowledged bytes", () => {
  const { path, journal: initial } = fixture(); initial.close();
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 131072);
  journals.push(journal);
  journal.admit("1", "/DOCSY/a", bytes("acknowledged"), 1);
  journal.write("1", 0, bytes("ACK"));
  const before = journal.get("1")!;
  expect(() => journal.write("1", 0, new Uint8Array(100_000))).toThrow();
  expect(journal.get("1")).toEqual(before);
  expect(journal.databaseLimitBytes).toBe(131072);
  expect(statSync(path).size).toBeLessThanOrEqual(journal.databaseLimitBytes);
  expect(existsSync(path + "-wal")).toBe(false);
  expect(existsSync(path + "-journal") ? statSync(path + "-journal").size : 0).toBe(0);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 131072);
  journals.push(recovered);
  expect(recovered.get("1")).toEqual(before);
});

it("reuses bounded database pages over repeated overwrites and publication intents", () => {
  const { path, journal: initial } = fixture(); initial.close();
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", 65536, 16384, 4, 196608);
  journals.push(journal);
  journal.admit("1", "/DOCSY/a", new Uint8Array(8192), 1);
  for (let i = 0; i < 80; i++) {
    journal.write("1", 0, new Uint8Array(8192).fill(i + 1));
    const intent = journal.beginPublish("1")!;
    journal.completePublish("1", intent.revision, i + 2);
    expect(statSync(path).size).toBeLessThanOrEqual(journal.databaseLimitBytes);
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(path + "-journal") ? statSync(path + "-journal").size : 0).toBe(0);
  }
  expect(journal.pending()).toEqual([]);
});

it("migrates a recovered WAL and preserves databases larger than a reduced limit", async () => {
  const { path, journal } = fixture(); journal.close();
  const source = `import { Database } from "bun:sqlite";
    const db=new Database(${JSON.stringify(path)});
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=0;");
    db.run("INSERT INTO files VALUES (?, ?, ?, 1, 1, 0, NULL)", ["1", "/DOCSY/a", new Uint8Array(100_000).fill(7)]);
    console.log("ACK");setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ack = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("No legacy ACK"); })]);
    expect(Buffer.from(ack.value!).toString()).toContain("ACK");
    reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    expect(statSync(path + "-wal").size).toBeGreaterThan(100_000);
  } finally { child.kill(); await child.exited; }
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY", 200_000, 120_000, 4, 65536);
  journals.push(recovered);
  expect(recovered.databaseLimitBytes).toBeGreaterThan(65536);
  expect(recovered.get("1")!.bytes).toEqual(new Uint8Array(100_000).fill(7));
  expect(recovered.pending()).toHaveLength(1);
  expect(existsSync(path + "-wal")).toBe(false);
});

it("recovers the previous acknowledgement after a crash inside an uncommitted rollback transaction", async () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/a", bytes("durable previous image"), 1);
  journal.write("1", 0, bytes("ACK"));
  const previous = journal.get("1");
  journal.close();
  const source = `import { Database } from "bun:sqlite";
    const db=new Database(${JSON.stringify(path)});
    db.exec("PRAGMA cache_size=1; PRAGMA synchronous=EXTRA; BEGIN IMMEDIATE;");
    db.run("UPDATE files SET bytes=?, revision=revision+1 WHERE id='1'", [new Uint8Array(100_000).fill(8)]);
    console.log("UNCOMMITTED");setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "-e", source], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ready = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("No transaction marker"); })]);
    expect(Buffer.from(ready.value!).toString()).toContain("UNCOMMITTED");
    reader.releaseLock();
    expect(existsSync(path + "-journal")).toBe(true);
    child.kill("SIGKILL"); await child.exited;
    const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
    expect(recovered.get("1")).toEqual(previous);
    expect(recovered.pending()).toEqual([previous!]);
  } finally { child.kill(); await child.exited; }
});


it("retains the published source across restart and includes it in the quota", () => {
  const { path, journal } = fixture(9, 9);
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("one"));
  journal.completePublish("1", journal.beginPublish("1")!.revision, 2);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY", 9, 9); journals.push(reopened);
  expect(Buffer.from(reopened.publishedSource("1")!).toString()).toBe("one");
  reopened.write("1", 0, bytes("two"));
  reopened.beginPublish("1"); // file + intent + published source = nine bytes
  expect(() => reopened.admit("2", "/DOCSY/other.md", bytes("x"), 1)).toThrow("quota");
  reopened.completePublish("1", reopened.get("1")!.revision, 3);
  expect(Buffer.from(reopened.publishedSource("1")!).toString()).toBe("two");
});

it("upgrades schema-one pending records without inventing a publication base", () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/page/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("new"));
  journal.close();
  const old = new Database(path);
  old.exec("DROP TABLE locals; DROP TABLE bases; PRAGMA user_version=1;"); old.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(Buffer.from(reopened.get("1")!.bytes).toString()).toBe("new");
  expect(reopened.pending()).toHaveLength(1);
  expect(reopened.publishedSource("1")).toBeNull();
});


it("recovers local editor files without ever publishing their temporary names", () => {
  const { path, journal } = fixture();
  const file = journal.createLocal("/DOCSY/.editor.tmp");
  journal.write(file.id, 0, bytes("local draft 🐴"));
  expect(journal.pending()).toEqual([]);
  expect(journal.beginPublish(file.id)).toBeNull();
  expect(() => journal.createLocal(file.path)).toThrow("exists");
  for (const invalid of ["relative", "/", "/DOCSY/../escape", "/DOCSY/x/", "/DOCSY//x"]) {
    expect(() => journal.createLocal(invalid)).toThrow("Invalid");
  }
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.local(file.path)?.id).toBe(file.id);
  expect(Buffer.from(reopened.local(file.path)!.bytes).toString()).toBe("local draft 🐴");
  expect(reopened.localEntries("/DOCSY")).toHaveLength(1);
  expect(reopened.localEntries("/DOC")).toEqual([]);
  expect(reopened.pending()).toEqual([]);
  const replaced = reopened.createLocal("/DOCSY/backup.tmp");
  reopened.renameLocal(file.path, replaced.path);
  expect(reopened.get(replaced.id)).toBeNull();
  expect(reopened.local(file.path)).toBeNull();
  expect(reopened.local(replaced.path)?.id).toBe(file.id);
  reopened.renameLocal(replaced.path, replaced.path);
  reopened.removeLocal(replaced.path);
  expect(reopened.localEntries("/DOCSY")).toEqual([]);
  expect(reopened.get(file.id)).toBeNull();
});

it("atomically replaces page bytes while preserving an ambiguous publication and page identity", () => {
  const { path, journal } = fixture();
  journal.admit("1", "/DOCSY/_index.md", bytes("old"), 1);
  journal.write("1", 0, bytes("sent"));
  const intent = journal.beginPublish("1")!;
  journal.failPublish("1", "REMOTE_RESULT_UNKNOWN");
  const temporary = journal.createLocal("/DOCSY/.save.tmp");
  journal.write(temporary.id, 0, bytes("replacement"));
  const replaced = journal.replaceLocal(temporary.path, "1");
  expect(replaced.id).toBe("1");
  expect(replaced.path).toBe("/DOCSY/_index.md");
  expect(replaced.error).toBe("REMOTE_RESULT_UNKNOWN");
  expect(replaced.revision).toBe(intent.revision + 1);
  expect(journal.get(temporary.id)).toBeNull();
  expect(journal.beginPublish("1")).toEqual(intent);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.local(temporary.path)).toBeNull();
  expect(Buffer.from(reopened.get("1")!.bytes).toString()).toBe("replacement");
  expect(reopened.beginPublish("1")).toEqual(intent);
  reopened.completePublish("1", intent.revision, 2);
  expect(reopened.pending().map((file) => file.id)).toEqual(["1"]);
  expect(Buffer.from(reopened.beginPublish("1")!.bytes).toString()).toBe("replacement");
});

it("accounts for local-file quotas and rolls back failed replacement without losing its source", () => {
  const { path, journal } = fixture(8, 8, 2);
  journal.admit("1", "/DOCSY/_index.md", bytes("old"), 1);
  const local = journal.createLocal("/DOCSY/.save.tmp");
  journal.write(local.id, 0, bytes("newer"));
  expect(() => journal.createLocal("/DOCSY/another")).toThrow("quota");
  expect(() => journal.write(local.id, 5, bytes("x"))).toThrow("quota");
  expect(() => journal.replaceLocal(local.path, local.id)).toThrow("admitted page");
  expect(Buffer.from(journal.local(local.path)!.bytes).toString()).toBe("newer");
  journal.close();
  const reduced = new NfsJournal(path, "synthetic-account:DOCSY", 8, 4, 2); journals.push(reduced);
  expect(() => reduced.replaceLocal(local.path, "1")).toThrow("size");
  expect(Buffer.from(reduced.local(local.path)!.bytes).toString()).toBe("newer");
  expect(Buffer.from(reduced.get("1")!.bytes).toString()).toBe("old");
  reduced.close();
  const restored = new NfsJournal(path, "synthetic-account:DOCSY", 8, 8, 2); journals.push(restored);
  expect(Buffer.from(restored.replaceLocal(local.path, "1").bytes).toString()).toBe("newer");
  expect(restored.local(local.path)).toBeNull();
});


it("persists exclusive-create verifiers and never truncates a matching replay", () => {
  const { path, journal } = fixture();
  const verifier = "0123456789abcdef";
  const file = journal.createLocal("/DOCSY/exclusive.tmp", verifier);
  journal.write(file.id, 0, bytes("acknowledged draft"));
  expect(journal.createLocal(file.path, verifier).id).toBe(file.id);
  expect(() => journal.createLocal(file.path, "fedcba9876543210")).toThrow("exists");
  expect(() => journal.createLocal(file.path)).toThrow("exists");
  expect(() => journal.createLocal("/DOCSY/invalid", "xyz")).toThrow("verifier");
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(Buffer.from(reopened.createLocal(file.path, verifier).bytes).toString()).toBe("acknowledged draft");
  reopened.removeLocal(file.path);
  expect(reopened.createLocal(file.path, verifier).id).not.toBe(file.id);
});

it("upgrades schema-three local files without inventing an exclusive verifier", () => {
  const { path, journal } = fixture();
  const local = journal.createLocal("/DOCSY/legacy.tmp");
  journal.write(local.id, 0, bytes("keep"));
  journal.close();
  const old = new Database(path);
  old.exec("ALTER TABLE locals DROP COLUMN verifier; PRAGMA user_version=3;"); old.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(() => reopened.createLocal(local.path, "0000000000000000")).toThrow("exists");
  expect(Buffer.from(reopened.local(local.path)!.bytes).toString()).toBe("keep");
});


it("persists local file attributes without publishing metadata-only changes", () => {
  const { path, journal } = fixture();
  const file = journal.createLocal("/DOCSY/private.tmp");
  journal.setAttributes(file.id, { mode: 0o600, atime: 0, mtime: 1234 });
  expect(journal.pending()).toEqual([]);
  expect(() => journal.setAttributes(file.id, { mode: 0o7777 })).toThrow("Invalid");
  expect(journal.attributes(file.id)).toEqual({ mode: 0o600, atime: 0, mtime: 1234 });
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.attributes(file.id)).toEqual({ mode: 0o600, atime: 0, mtime: 1234 });
  recovered.write(file.id, 0, bytes("changed"));
  expect(recovered.attributes(file.id)!.mtime).toBeGreaterThan(1234);
  recovered.removeLocal(file.path);
  expect(recovered.attributes(file.id)).toBeNull();
});


it("durably stages editor directories, renames their children and replaces only page bytes", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("old"), 1);
  const directory = journal.createLocalDirectory("/DOCSY/_index.md.sb-test");
  journal.setAttributes(directory.id, { mode: 0o700 });
  const nested = journal.createLocalDirectory(`${directory.path}/nested`);
  const file = journal.createLocal(`${nested.path}/draft`, "0123456789abcdef");
  journal.write(file.id, 0, bytes("replacement 🐴"));
  expect(journal.localEntries(directory.path).map(entry => entry.kind)).toEqual(["directory"]);
  expect(() => journal.removeLocal(directory.path, true)).toThrow("not empty");
  expect(() => journal.removeLocal(directory.path)).toThrow("type mismatch");
  expect(() => journal.removeLocal(file.path, true)).toThrow("type mismatch");
  expect(() => journal.write(directory.id, 0, bytes(""))).toThrow("directory");
  expect(() => journal.write(directory.id, 0, bytes("x"))).toThrow("directory");
  expect(() => journal.truncate(directory.id, 0)).toThrow("directory");
  expect(() => journal.replaceLocal(directory.path, "100")).toThrow("directory");
  expect(() => journal.createLocal(`${file.path}/child`)).toThrow("parent is a file");
  expect(() => journal.renameLocal(directory.path, `${directory.path}/child`)).toThrow("into itself");
  expect(journal.pending()).toEqual([]);
  expect(journal.beginPublish(directory.id)).toBeNull();
  journal.renameLocal(directory.path, "/DOCSY/renamed");
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.local(directory.path)).toBeNull();
  expect(recovered.local("/DOCSY/renamed")).toMatchObject({ id: directory.id, kind: "directory" });
  expect(recovered.attributes(directory.id)?.mode).toBe(0o700);
  expect(recovered.local("/DOCSY/renamed/nested/draft")).toMatchObject({ id: file.id, kind: "file" });
  expect(recovered.createLocal("/DOCSY/renamed/nested/draft", "0123456789abcdef").id).toBe(file.id);
  expect(Buffer.from(recovered.replaceLocal("/DOCSY/renamed/nested/draft", "100").bytes).toString()).toBe("replacement 🐴");
  recovered.removeLocal("/DOCSY/renamed/nested", true);
  recovered.removeLocal("/DOCSY/renamed", true);
  expect(recovered.localEntries("/DOCSY")).toEqual([]);
  expect(recovered.pending().map(entry => entry.id)).toEqual(["100"]);
});

it("counts directories against the journal quota and rolls back invalid tree replacements", () => {
  const { journal } = fixture(64, 64, 4);
  const source = journal.createLocalDirectory("/DOCSY/source");
  const child = journal.createLocal(`${source.path}/child`);
  const target = journal.createLocalDirectory("/DOCSY/target");
  const occupied = journal.createLocal(`${target.path}/keep`);
  expect(() => journal.createLocalDirectory("/DOCSY/excess")).toThrow("quota");
  expect(() => journal.renameLocal(source.path, target.path)).toThrow("not empty");
  expect(journal.local(child.path)?.id).toBe(child.id);
  expect(journal.local(occupied.path)?.id).toBe(occupied.id);
  expect(() => journal.renameLocal(child.path, target.path)).toThrow("type mismatch");
  expect(() => journal.renameLocal(source.path, occupied.path)).toThrow("type mismatch");
  journal.removeLocal(occupied.path);
  journal.renameLocal(source.path, target.path);
  expect(journal.get(target.id)).toBeNull();
  expect(journal.local(target.path)?.id).toBe(source.id);
  expect(journal.local(`${target.path}/child`)?.id).toBe(child.id);
});

it("migrates schema-five temporary files without changing identity or exclusive-create replay", () => {
  const { path, journal } = fixture();
  const file = journal.createLocal("/DOCSY/legacy", "0123456789abcdef");
  journal.write(file.id, 0, bytes("keep"));
  journal.close();
  const old = new Database(path);
  old.exec("ALTER TABLE locals DROP COLUMN kind; PRAGMA user_version=5;"); old.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.local(file.path)).toMatchObject({ kind: "file", id: file.id });
  expect(Buffer.from(recovered.createLocal(file.path, "0123456789abcdef").bytes).toString()).toBe("keep");
  expect(recovered.createLocalDirectory("/DOCSY/new-dir").kind).toBe("directory");
});


it("rolls back failed regular CREATE attributes and initial sizes", () => {
  const { journal } = fixture(8, 8);
  expect(() => journal.createRegularLocal("/DOCSY/invalid-mode", true, { mode: 0o7777 })).toThrow();
  expect(journal.local("/DOCSY/invalid-mode")).toBeNull();
  expect(() => journal.createRegularLocal("/DOCSY/invalid-size", false, { size: 9 })).toThrow();
  expect(journal.local("/DOCSY/invalid-size")).toBeNull();
  const file = journal.createRegularLocal("/DOCSY/ok", false, { size: 4, mode: 0o600 });
  expect([...file.bytes]).toEqual([0, 0, 0, 0]);
  journal.write(file.id, 0, bytes("keep"));
  expect(() => journal.createRegularLocal(file.path, true, { size: 0 })).toThrow("exists");
  expect(Buffer.from(journal.local(file.path)!.bytes).toString()).toBe("keep");
  expect(journal.pending()).toEqual([]);
});


it("recovers page backup renames and restores publication only after replacement", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("original"), 3);
  journal.setAttributes("100", { mode: 0o600, mtime: 123 });
  journal.write("100", 0, bytes("modified"));
  const intent = journal.beginPublish("100")!;
  const backup = journal.backupPage("100", "/DOCSY/_index.md.backup");
  expect(Buffer.from(backup.bytes).toString()).toBe("modified");
  expect(journal.attributes(backup.id)).toEqual({ mode: 0o600, atime: null, mtime: journal.attributes("100")!.mtime });
  expect(journal.displaced("/DOCSY/_index.md")?.id).toBe("100");
  expect(journal.pending()).toEqual([]);
  expect(journal.beginPublish("100")).toBeNull();
  expect(() => journal.backupPage("100", "/DOCSY/duplicate")).toThrow("already moved");
  expect(journal.local("/DOCSY/duplicate")).toBeNull();
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.displaced("/DOCSY/_index.md")?.baseVersion).toBe(3);
  expect(recovered.beginPublish("100")).toBeNull();
  const replacement = recovered.createLocal("/DOCSY/new.tmp");
  recovered.write(replacement.id, 0, bytes("replacement"));
  recovered.replaceLocal(replacement.path, "100");
  expect(recovered.displaced("/DOCSY/_index.md")).toBeNull();
  expect(recovered.pending().map(file => file.id)).toEqual(["100"]);
  expect(recovered.beginPublish("100")).toEqual(intent);
  expect(Buffer.from(recovered.local(backup.path)!.bytes).toString()).toBe("modified");
  recovered.completePublish("100", intent.revision, 4);
  expect(Buffer.from(recovered.beginPublish("100")!.bytes).toString()).toBe("replacement");
});

it("rolls back backup quota failures and preserves original and overwritten local bytes", () => {
  const { journal } = fixture(8, 8, 3);
  journal.admit("100", "/DOCSY/_index.md", bytes("original"), 1);
  const oldBackup = journal.createLocal("/DOCSY/backup");
  // Replacing an empty backup still requires space for the new snapshot.
  expect(() => journal.backupPage("100", oldBackup.path)).toThrow("quota");
  expect(journal.local(oldBackup.path)?.id).toBe(oldBackup.id);
  expect(journal.displaced("/DOCSY/_index.md")).toBeNull();
  expect(Buffer.from(journal.get("100")!.bytes).toString()).toBe("original");
  expect(() => journal.backupPage(oldBackup.id, "/DOCSY/not-page")).toThrow("admitted page");
});


it("retains exclusive recreation replay after restart without truncating acknowledged bytes", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("before"), 1);
  journal.backupPage("100", "/DOCSY/backup");
  journal.restoreCreated("/DOCSY/_index.md", {}, "0123456789abcdef");
  journal.write("100", 0, bytes("acknowledged"));
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(Buffer.from(recovered.exclusivePageReplay("/DOCSY/_index.md", "0123456789abcdef")!.bytes).toString()).toBe("acknowledged");
  expect(recovered.exclusivePageReplay("/DOCSY/_index.md", "fedcba9876543210")).toBeNull();
  const replacement = recovered.createLocal("/DOCSY/next");
  recovered.replaceLocal(replacement.path, "100");
  expect(recovered.exclusivePageReplay("/DOCSY/_index.md", "0123456789abcdef")).toBeNull();
});


it("reports durable recovery counts without treating local editor entries as publishable pages", () => {
  const { path, journal } = fixture();
  expect(journal.writeStatus()).toEqual({ pendingPages: 0, failedPages: 0, displacedPages: 0, localEntries: 0, unresolvedPublications: 0 });
  journal.admit("100", "/DOCSY/_index.md", bytes("original"), 1);
  journal.write("100", 0, bytes("changed"));
  journal.beginPublish("100");
  journal.failPublish("100", "REMOTE_RESULT_UNKNOWN");
  expect(journal.pendingIds()).toEqual(["100"]);
  expect(journal.writeStatus()).toEqual({ pendingPages: 1, failedPages: 1, displacedPages: 0, localEntries: 0, unresolvedPublications: 1 });
  journal.backupPage("100", "/DOCSY/backup");
  const expected = { pendingPages: 0, failedPages: 1, displacedPages: 1, localEntries: 1, unresolvedPublications: 1 };
  expect(journal.writeStatus()).toEqual(expected);
  expect(journal.pendingIds()).toEqual([]);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.writeStatus()).toEqual(expected);
  recovered.replaceLocal("/DOCSY/backup", "100");
  recovered.completePublish("100", recovered.beginPublish("100")!.revision, 2);
  expect(recovered.writeStatus()).toEqual({ pendingPages: 0, failedPages: 0, displacedPages: 0, localEntries: 0, unresolvedPublications: 0 });
});


it("reports pending and failed new pages across restart without counting backups or hidden drafts", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("original"), 1);
  journal.backupPage("100", "/DOCSY/backup.md");
  const hidden = journal.createLocal("/DOCSY/.save.md");
  journal.write(hidden.id, 0, bytes("temporary"));
  journal.failPublish(hidden.id, "EINVAL");
  const draft = journal.createLocal("/DOCSY/newpage.md");
  journal.write(draft.id, 0, bytes("plain"));
  expect(journal.writeStatus()).toMatchObject({ pendingPages: 1, failedPages: 0 });
  journal.beginCreate(draft.id, draft.path, "DOCSY", "100", journal.get(draft.id)!.revision);
  journal.failPublish(draft.id, "REMOTE_RESULT_UNKNOWN");
  const expected = { pendingPages: 1, failedPages: 1, displacedPages: 1, localEntries: 3, unresolvedPublications: 1 };
  expect(journal.writeStatus()).toEqual(expected);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.writeStatus()).toEqual(expected);
  const intent = recovered.createIntent(draft.id)!;
  recovered.recordCreated(draft.id, intent.revision, "200", 1);
  recovered.promoteCreated(draft.id, "/DOCSY/newpage-200.md");
  expect(recovered.writeStatus()).toEqual({ pendingPages: 0, failedPages: 0, displacedPages: 1, localEntries: 2, unresolvedPublications: 0 });
});

it("refreshes only unchanged clean images and retains their original merge source", () => {
  const { journal } = fixture();
  journal.admit("100", "/DOCSY/page", bytes("before"), 1);
  const refreshed = journal.refreshClean("100", "/DOCSY/page", bytes("remote"), 2, 0);
  expect(Buffer.from(refreshed.bytes).toString()).toBe("remote");
  expect(refreshed.revision).toBe(refreshed.publishedRevision);
  expect(Buffer.from(journal.publishedSource("100")!).toString()).toBe("before");
  expect(journal.refreshClean("100", "/DOCSY/page", bytes("stale fetch"), 3, 0)).toEqual(refreshed);
  journal.write("100", 0, bytes("local!"));
  const dirty = journal.get("100")!;
  expect(journal.refreshClean("100", "/DOCSY/page", bytes("new remote"), 3, dirty.revision)).toEqual(dirty);
  journal.beginPublish("100");
  expect(journal.refreshClean("100", "/DOCSY/page", bytes("new remote"), 3, dirty.revision)).toEqual(dirty);
});


it("rolls back refresh quota failures and preserves displaced clean pages", () => {
  const { path, journal } = fixture(12, 12);
  const before = journal.admit("100", "/DOCSY/page", bytes("before"), 1);
  expect(() => journal.refreshClean("100", "/DOCSY/page", bytes("too long"), 2, 0)).toThrow("quota");
  expect(journal.get("100")).toEqual(before);
  expect(journal.publishedSource("100")).toBeNull();
  journal.backupPage("100", "/DOCSY/backup");
  expect(journal.refreshClean("100", "/DOCSY/page", bytes("remote"), 2, 0)).toEqual(before);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.get("100")).toEqual(before);
  expect(recovered.displaced("/DOCSY/page")?.id).toBe("100");
});


it("accepts confirmed same-version completion but rejects older versions and stale revisions", () => {
  const { journal } = fixture();
  journal.admit("100", "/DOCSY/page", bytes("before"), 3);
  journal.write("100", 0, bytes("staged"));
  const intent = journal.beginPublish("100")!;
  expect(() => journal.completePublish("100", intent.revision, 2)).toThrow("Stale");
  expect(() => journal.completePublish("100", intent.revision + 1, 3)).toThrow("Stale");
  journal.write("100", 0, bytes("newest"));
  journal.completePublish("100", intent.revision, 3);
  expect(Buffer.from(journal.get("100")!.bytes).toString()).toBe("newest");
  expect(journal.pendingIds()).toEqual(["100"]);
  expect(journal.publishIntent("100")).toBeNull();
  expect(Buffer.from(journal.publishedSource("100")!).toString()).toBe("staged");
});


it("rejects concurrent journal owners and releases ownership on close", async () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("saved"), 1);
  expect(() => { const second = new NfsJournal(path, "synthetic-account:DOCSY"); second.close(); }).toThrow("locked");
  const code = `import { NfsJournal } from ${JSON.stringify(join(import.meta.dir, "nfs-journal.ts"))};
    try { const j = new NfsJournal(${JSON.stringify(path)}, "synthetic-account:DOCSY"); j.close(); process.exit(1); }
    catch (error) { process.exit(String(error).includes("locked") ? 0 : 2); }`;
  const child = Bun.spawn([process.execPath, "--conditions=development", "-e", code], { stdout: "pipe", stderr: "pipe" });
  expect(await child.exited).toBe(0);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(Buffer.from(reopened.get("100")!.bytes).toString()).toBe("saved");
});


it("freezes new-page intents and confirmed receipts across restart without losing newer editor bytes", () => {
  const { path, journal } = fixture();
  journal.createLocalDirectory("/DOCSY/drafts");
  const local = journal.createLocal("/DOCSY/drafts/newpage.md");
  const first = journal.write(local.id, 0, bytes("First"));
  expect(journal.beginCreate(local.id, local.path, "DOCSY", "100", first.revision - 1)).toBeNull();
  const intent = journal.beginCreate(local.id, local.path, "DOCSY", "100", first.revision)!;
  journal.write(local.id, 0, bytes("Newer"));
  expect(journal.beginCreate(local.id, local.path, "DOCSY", "100", first.revision + 1)).toEqual(intent);
  expect(() => journal.beginCreate(local.id, local.path, "DOCSY", "200", first.revision)).toThrow("frozen");
  expect(() => journal.renameLocal("/DOCSY/drafts", "/DOCSY/renamed")).toThrow("reconciled");
  expect(() => journal.removeLocal(local.path)).toThrow("reconciled");
  expect(() => journal.completePublish(local.id, first.revision, 1)).toThrow("promotion");
  expect(journal.pendingIds()).toEqual([]);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.createIntent(local.id)).toEqual(intent);
  expect(Buffer.from(recovered.get(local.id)!.bytes).toString()).toBe("Newer");
  recovered.recordCreated(local.id, first.revision, "123", 1);
  recovered.recordCreated(local.id, first.revision, "123", 1);
  expect(() => recovered.recordCreated(local.id, first.revision, "124", 1)).toThrow("conflicting");
  expect(() => recovered.recordCreated(local.id, first.revision + 1, "123", 1)).toThrow("conflicting");
  recovered.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.createIntent(local.id)).toMatchObject({ pageId: "123", version: 1, revision: first.revision });
  expect(Buffer.from(reopened.createIntent(local.id)!.bytes).toString()).toBe("First");
  expect(Buffer.from(reopened.get(local.id)!.bytes).toString()).toBe("Newer");
});

it("rolls back new-page intent quota failures and upgrades schema eight without changing bytes", () => {
  const { path, journal } = fixture(5, 5);
  const local = journal.createLocal("/DOCSY/newpage.md");
  const image = journal.write(local.id, 0, bytes("12345"));
  expect(() => journal.beginCreate(local.id, local.path, "OTHER", "100", image.revision)).toThrow("target");
  expect(() => journal.beginCreate(local.id, local.path, "DOCSY", "100", image.revision)).toThrow("quota");
  expect(journal.createIntent(local.id)).toBeNull();
  expect(journal.publishIntent(local.id)).toBeNull();
  journal.close();
  const db = new Database(path); db.exec("DROP TABLE creations; PRAGMA user_version=8"); db.close();
  const upgraded = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(upgraded);
  expect(Buffer.from(upgraded.get(local.id)!.bytes).toString()).toBe("12345");
  expect(upgraded.beginCreate(local.id, local.path, "DOCSY", "100", image.revision)).not.toBeNull();
});


it("promotes confirmed creations atomically and retains aliases, metadata and newer bytes after restart", () => {
  const { path, journal } = fixture();
  const local = journal.createLocal("/DOCSY/new.md", "0123456789abcdef");
  journal.setAttributes(local.id, { mode: 0o600 });
  const first = journal.write(local.id, 0, bytes("First"));
  journal.beginCreate(local.id, local.path, "DOCSY", "100", first.revision);
  expect(() => journal.promoteCreated(local.id, "/DOCSY/new-123.md")).toThrow("confirmed");
  journal.recordCreated(local.id, first.revision, "123", 1);
  journal.write(local.id, 0, bytes("Newer"));
  expect(() => journal.promoteCreated(local.id, "/OTHER/new-123.md")).toThrow("export");
  journal.promoteCreated(local.id, "/DOCSY/new-123.md");
  expect(journal.promoteCreated(local.id, "/DOCSY/new-123.md").id).toBe("123");
  expect(journal.get(local.id)).toBeNull();
  expect(journal.local(local.path)).toBeNull();
  expect(journal.createIntent(local.id)).toBeNull();
  expect(journal.pendingIds()).toEqual(["123"]);
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.promotion(local.id)).toEqual({ localId: local.id, path: local.path, pageId: "123" });
  expect(reopened.promotion(local.path)?.pageId).toBe("123");
  expect(Buffer.from(reopened.get("123")!.bytes).toString()).toBe("Newer");
  expect(Buffer.from(reopened.publishedSource("123")!).toString()).toBe("First");
  expect(reopened.attributes("123")?.mode).toBe(0o600);
  expect(reopened.exclusivePageReplay("/DOCSY/new-123.md", "0123456789abcdef")?.id).toBe("123");
});


it("durably reserves clean pages for trash and preserves bytes against later mutations", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/page/_index.md", bytes("published"), 1);
  journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY");
  journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY");
  expect(journal.writeStatus().unresolvedPublications).toBe(1);
  expect(() => journal.beginTrash("100", "/DOCSY/other.md", "DOCSY")).toThrow("frozen");
  for (const mutate of [
    () => journal.write("100", 0, new Uint8Array()),
    () => journal.truncate("100", 0),
    () => journal.setAttributes("100", { mode: 0o600 }),
    () => journal.backupPage("100", "/DOCSY/backup.md"),
    () => journal.beginPublish("100"),
  ]) expect(mutate).toThrow("reserved for trash");
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.trashIntent("100")).toMatchObject({ spaceKey: "DOCSY", completed: 0 });
  expect(() => recovered.write("100", 0, bytes("later"))).toThrow("reserved for trash");
  recovered.completeTrash("100");
  expect(recovered.writeStatus().unresolvedPublications).toBe(0);
  expect(recovered.trashIntent("100")?.completed).toBe(1);
  expect(() => recovered.truncate("100", 0)).toThrow("reserved for trash");
  expect(Buffer.from(recovered.get("100")!.bytes).toString()).toBe("published");
});

it("retires creation aliases only on confirmed trash and preserves the tombstone across reopen", () => {
  const { path, journal } = fixture();
  const local = journal.createLocal("/DOCSY/new.md", "0123456789abcdef");
  const image = journal.write(local.id, 0, bytes("Original"));
  journal.beginCreate(local.id, local.path, "DOCSY", "100", image.revision);
  journal.recordCreated(local.id, image.revision, "123", 1);
  journal.promoteCreated(local.id, "/DOCSY/new-123.md");
  journal.beginTrash("123", "/DOCSY/new-123.md", "DOCSY");
  expect(journal.promotion(local.path)?.pageId).toBe("123");
  journal.completeTrash("123");
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.promotion(local.path)).toBeNull();
  expect(reopened.promotion(local.id)).toBeNull();
  expect(reopened.exclusivePageReplay("/DOCSY/new-123.md", "0123456789abcdef")).toBeNull();
  expect(reopened.trashIntent("123")?.completed).toBe(1);
  expect(Buffer.from(reopened.get("123")!.bytes).toString()).toBe("Original");
  expect(reopened.createLocal(local.path).id).not.toBe(local.id);
});

it("refuses trash of dirty, displaced, foreign and unresolved pages", () => {
  const { journal } = fixture();
  journal.admit("100", "/DOCSY/page/_index.md", bytes("published"), 1);
  journal.write("100", 0, bytes("edited"));
  expect(() => journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY")).toThrow("unpublished");
  const intent = journal.beginPublish("100")!;
  expect(() => journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY")).toThrow("unpublished");
  journal.completePublish("100", intent.revision, 2);
  journal.createLocal("/DOCSY/page/draft.md");
  expect(() => journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY")).toThrow("local editor data");
  journal.removeLocal("/DOCSY/page/draft.md");
  expect(() => journal.beginTrash("100", "/OTHER/page.md", "OTHER")).toThrow("different export");
  journal.backupPage("100", "/DOCSY/backup.md");
  expect(() => journal.beginTrash("100", "/DOCSY/page/_index.md", "DOCSY")).toThrow("unpublished");
  expect(journal.trashIntent("100")).toBeNull();
});


it("locates durable export journals by exact identity and resumes them across reordered spaces", () => {
  const root = mkdtempSync(join(tmpdir(), "nfs-export-journal-")); roots.push(root);
  const identity = { cacheDir: root, profile: "mayflower", accountId: "account/one",
    instanceUrl: "https://example.test/wiki/", spaces: ["DOCSY", "mayflower"] };
  const original = nfsJournalLocation(identity);
  const reordered = nfsJournalLocation({ ...identity, instanceUrl: "https://example.test/wiki",
    spaces: ["mayflower", "DOCSY", "DOCSY"] });
  expect(reordered).toEqual(original);
  expect(original.path).toMatch(/nfs-journals\/[0-9a-f]{64}\.sqlite$/);
  for (const changed of [{ profile: "other" }, { accountId: "account_one" },
    { instanceUrl: "https://other.test/wiki" }, { spaces: ["DOCSY"] }]) {
    expect(nfsJournalLocation({ ...identity, ...changed }).path).not.toBe(original.path);
  }
  let journal = new NfsJournal(original.path, original.scope);
  const local = journal.createLocal("/DOCSY/newpage.md");
  journal.write(local.id, 0, Buffer.from("Retained bytes"));
  journal.close();
  journal = new NfsJournal(reordered.path, reordered.scope); journals.push(journal);
  expect(Buffer.from(journal.local("/DOCSY/newpage.md")!.bytes).toString()).toBe("Retained bytes");
  expect(statSync(original.path).mode & 0o777).toBe(0o600);
});

it("rejects missing identities, credential-bearing sites and invalid exports before opening a journal", () => {
  const identity = { cacheDir: "/tmp", profile: "fixture", accountId: "account",
    instanceUrl: "https://example.test/wiki", spaces: ["DOCSY"] };
  for (const changed of [{ accountId: "" }, { profile: "" }, { cacheDir: "" },
    { instanceUrl: "https://user:secret@example.test/wiki" }, { instanceUrl: "file:///tmp" },
    { instanceUrl: "https://example.test/wiki?token=x" }, { spaces: [] }, { spaces: ["../DOCSY"] }]) {
    expect(() => nfsJournalLocation({ ...identity, ...changed })).toThrow();
  }
});

it("retains an uncertain reparent across reopen and reserves both trees", () => {
  const { path, journal } = fixture();
  journal.admit("200", "/DOCSY/page-200/_index.md", bytes("Body"), 1);
  const move = { id: "200", kind: "page" as const, source: "/DOCSY/page-200", target: "/DOCSY/target-201/page-200",
    spaceKey: "DOCSY", sourceParentId: "100", sourceTitle: "Page", targetParentId: "201", title: "Page" };
  journal.beginMove(move);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.pendingMoves()).toEqual([{ ...move, completed: 0 }]);
  expect(() => recovered.write("200", 0, bytes("Lost"))).toThrow("reconciliation");
  expect(() => recovered.createLocal(`${move.target}/new.md`)).toThrow("reconciliation");
  expect(() => recovered.beginMove({ ...move, target: "/DOCSY/other-202/page-200" })).toThrow("frozen");
  recovered.completeMove(move.source);
  expect(recovered.pendingMoves()).toEqual([]);
  expect(recovered.get("200")?.path).toBe(`${move.target}/_index.md`);
  expect(Buffer.from(recovered.get("200")!.bytes).toString()).toBe("Body");
  expect(recovered.moveIntent(move.source)?.completed).toBe(1);
});

it("refreshes changed metadata at the same version without repeatedly dirtying a clean image", () => {
  const { journal } = fixture();
  journal.admit("200", "/DOCSY/page-200/_index.md", bytes("old metadata"), 1);
  const fresh = journal.refreshClean("200", "/DOCSY/target-201/page-200/_index.md", bytes("new metadata"), 1, 0, true);
  expect(Buffer.from(fresh.bytes).toString()).toBe("new metadata");
  expect(fresh.revision).toBe(fresh.publishedRevision);
  expect(journal.refreshClean("200", fresh.path, fresh.bytes, 1, fresh.revision, true)).toEqual(fresh);
  expect(Buffer.from(journal.publishedSource("200")!).toString()).toBe("old metadata");
  expect(journal.pendingIds()).toEqual([]);
});

it("migrates schema-thirteen pending moves as pages and keeps folder intents across reopen", () => {
  const { path, journal } = fixture();
  const move = { id: "200", kind: "page" as const, source: "/DOCSY/page-200", target: "/DOCSY/target-201/page-200",
    spaceKey: "DOCSY", sourceParentId: "100", sourceTitle: "Page", targetParentId: "201", title: "Page" };
  journal.beginMove(move); journal.close();
  const db = new Database(path); db.exec("ALTER TABLE moves DROP COLUMN kind; PRAGMA user_version=13"); db.close();
  const upgraded = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(upgraded);
  expect(upgraded.pendingMoves()).toEqual([{ ...move, completed: 0 }]);
  upgraded.beginMove({ ...move, id: "300", kind: "folder", source: "/DOCSY/folder-300", target: "/DOCSY/other-301/folder-300", targetParentId: "301" });
  upgraded.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(reopened.moveIntent("/DOCSY/folder-300")?.kind).toBe("folder");
});

it("migrates old move receipts without inventing a source title", () => {
  const { path, journal } = fixture();
  const move = { id: "200", kind: "page" as const, source: "/DOCSY/page-200", target: "/DOCSY/target-201/page-200",
    sourceParentId: "100", sourceTitle: "Original Title", targetParentId: "201", spaceKey: "DOCSY", title: "Original Title" };
  journal.beginMove(move); journal.close();
  const db = new Database(path); db.exec("ALTER TABLE moves DROP COLUMN sourceTitle; PRAGMA user_version=14"); db.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.pendingMoves()).toEqual([{ ...move, sourceTitle: null, completed: 0 }]);
});

it("reserves and remaps the intermediate path of a combined move across reopen", () => {
  const { path, journal } = fixture();
  const move = { id: "200", kind: "page" as const, source: "/DOCSY/page-200", target: "/DOCSY/target-201/renamed-200",
    sourceParentId: "100", sourceTitle: "Page", targetParentId: "201", spaceKey: "DOCSY", title: "Renamed" };
  journal.beginMove(move); journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.moveIntent(move.source)?.sourceTitle).toBe("Page");
  expect(() => recovered.createLocal("/DOCSY/target-201/page-200/draft.md")).toThrow("reconciliation");
  recovered.admit("200", "/DOCSY/target-201/page-200/_index.md", bytes("read during recovery"), 2);
  expect(() => recovered.write("200", 0, bytes("blocked"))).toThrow("reconciliation");
  recovered.completeMove(move.source);
  expect(recovered.get("200")?.path).toBe(`${move.target}/_index.md`);
  expect(Buffer.from(recovered.get("200")!.bytes).toString()).toBe("read during recovery");
});


it("releases the writer lock after a mixed editor and publication session without GC", () => {
  const { path, journal } = fixture();
  journal.admit("100", "/DOCSY/_index.md", bytes("before"), 1);
  journal.setAttributes("100", { mode: 0o644, mtime: 1234 });
  journal.write("100", 0, bytes("saved!"));
  journal.beginPublish("100");
  journal.failPublish("100", "EACCES");
  const local = journal.createLocal("/DOCSY/.editor.tmp");
  journal.write(local.id, 0, bytes("draft"));
  journal.localEntries("/DOCSY"); journal.localFileIds(); journal.pendingIds();
  journal.pending(); journal.isBackup(local.id); journal.attributes("100");
  journal.displaced("/DOCSY/_index.md"); journal.exclusivePageReplay("/DOCSY/_index.md", "0000000000000000");
  journal.createIntent(local.id); journal.promotion(local.id); journal.publishedSource("100");
  journal.moveIntent("/DOCSY/page-100"); journal.pendingMoves(); journal.writeStatus();
  journal.close();
  const reopened = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(reopened);
  expect(Buffer.from(reopened.get("100")!.bytes).toString()).toBe("saved!");
  expect(reopened.publishIntent("100")).not.toBeNull();
  expect(Buffer.from(reopened.local("/DOCSY/.editor.tmp")!.bytes).toString()).toBe("draft");
});
