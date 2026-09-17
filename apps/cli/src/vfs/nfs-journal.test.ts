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
    expect(recovered.localEntries("/DOCSY")).toEqual([]);
    expect(Buffer.from(recovered.beginPublish("1")!.bytes).toString()).toBe("durable 🐴");
    expect(recovered.pending()).toHaveLength(1);
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
  const journal = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 65536);
  journals.push(journal);
  journal.admit("1", "/DOCSY/a", bytes("acknowledged"), 1);
  journal.write("1", 0, bytes("ACK"));
  const before = journal.get("1")!;
  expect(() => journal.write("1", 0, new Uint8Array(100_000))).toThrow();
  expect(journal.get("1")).toEqual(before);
  expect(journal.databaseLimitBytes).toBe(65536);
  expect(statSync(path).size).toBeLessThanOrEqual(journal.databaseLimitBytes);
  expect(existsSync(path + "-wal")).toBe(false);
  expect(existsSync(path + "-journal")).toBe(false);
  journal.close();
  const recovered = new NfsJournal(path, "synthetic-account:DOCSY", 1024 * 1024, 512 * 1024, 16, 65536);
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
