import { Database } from "bun:sqlite";
import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NfsJournal } from "./nfs-journal.js";

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
  expect(() => new NfsJournal(path, "other-account:DOCSY")).toThrow("identity");
  expect(() => journal.write("1", 8, bytes("x"))).toThrow();
  expect(() => journal.admit("2", "/DOCSY/other/_index.md", bytes("x"), 1)).toThrow("quota");
  journal.write("1", 0, bytes("X"));
  expect(() => journal.beginPublish("1")).toThrow("quota");
  expect(Buffer.from(journal.get("1")!.bytes).toString()).toBe("X2345678");
  expect(journal.get("1")!.revision).toBe(1);
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
    j.write(draft.id,0,Buffer.from("directory crash recovery"));
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
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 98304);
  journals.push(journal);
  journal.admit("1", "/DOCSY/a", bytes("acknowledged"), 1);
  journal.write("1", 0, bytes("ACK"));
  const before = journal.get("1")!;
  expect(() => journal.write("1", 0, new Uint8Array(100_000))).toThrow();
  expect(journal.get("1")).toEqual(before);
  expect(journal.databaseLimitBytes).toBe(98304);
  expect(statSync(path).size).toBeLessThanOrEqual(journal.databaseLimitBytes);
  expect(existsSync(path + "-wal")).toBe(false);
  expect(existsSync(path + "-journal")).toBe(false);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 98304);
  journals.push(recovered);
  expect(recovered.get("1")).toEqual(before);
});

it("reuses bounded database pages over repeated overwrites and publication intents", () => {
  const { path, journal: initial } = fixture(); initial.close();
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", 65536, 16384, 4, 131072);
  journals.push(journal);
  journal.admit("1", "/DOCSY/a", new Uint8Array(8192), 1);
  for (let i = 0; i < 80; i++) {
    journal.write("1", 0, new Uint8Array(8192).fill(i + 1));
    const intent = journal.beginPublish("1")!;
    journal.completePublish("1", intent.revision, i + 2);
    expect(statSync(path).size).toBeLessThanOrEqual(journal.databaseLimitBytes);
    expect(existsSync(path + "-wal")).toBe(false);
    expect(existsSync(path + "-journal")).toBe(false);
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
  expect(journal.writeStatus()).toEqual({ pendingPages: 1, failedPages: 1, displacedPages: 0, localEntries: 0, unresolvedPublications: 1 });
  journal.backupPage("100", "/DOCSY/backup");
  const expected = { pendingPages: 0, failedPages: 1, displacedPages: 1, localEntries: 1, unresolvedPublications: 1 };
  expect(journal.writeStatus()).toEqual(expected);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
  expect(recovered.writeStatus()).toEqual(expected);
  recovered.replaceLocal("/DOCSY/backup", "100");
  recovered.completePublish("100", recovered.beginPublish("100")!.revision, 2);
  expect(recovered.writeStatus()).toEqual({ pendingPages: 0, failedPages: 0, displacedPages: 0, localEntries: 0, unresolvedPublications: 0 });
});
