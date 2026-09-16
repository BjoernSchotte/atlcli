import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
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
    console.log("ACK");setInterval(()=>{},1000);`;
  const child = Bun.spawn([process.execPath, "--conditions=development", "-e", source], { stdout: "pipe", stderr: "pipe" });
  try {
    const reader = child.stdout.getReader();
    const ack = await Promise.race([reader.read(), Bun.sleep(5000).then(() => { throw new Error("No journal ACK"); })]);
    expect(Buffer.from(ack.value!).toString()).toContain("ACK");
    reader.releaseLock();
    child.kill("SIGKILL"); await child.exited;
    const recovered = new NfsJournal(path, "synthetic-account:DOCSY"); journals.push(recovered);
    expect(Buffer.from(recovered.get("1")!.bytes).toString()).toBe("durable 🐴");
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
