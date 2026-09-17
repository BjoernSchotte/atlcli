import { afterEach, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { NfsJournal } from "./nfs-journal.js";
import { recoverNfsJournal } from "./nfs-recovery.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nfs-recovery-")); roots.push(root);
  const path = join(root, "journal.sqlite");
  const journal = new NfsJournal(path, "synthetic:DOCSY");
  journal.admit("100", "/DOCSY/_index.md", Buffer.from("old"), 1);
  journal.write("100", 0, Buffer.from("base"));
  journal.completePublish("100", journal.beginPublish("100")!.revision, 2);
  journal.write("100", 0, Buffer.from("sent")); journal.beginPublish("100");
  journal.write("100", 0, new Uint8Array([255, 0, 128, 10]));
  journal.failPublish("100", "REMOTE_RESULT_UNKNOWN");
  journal.createLocalDirectory("/DOCSY/editor");
  journal.backupPage("100", "/DOCSY/backup");
  journal.close();
  return { root, path };
}

it("lists recovery metadata and exports distinct binary images without changing the journal", () => {
  const { root, path } = fixture();
  const original = readFileSync(path);
  const records = recoverNfsJournal(path) as Record<string, unknown>[];
  expect(records).toHaveLength(3);
  expect(records.find(row => row.id === "100")).toMatchObject({ size: 4, error: "REMOTE_RESULT_UNKNOWN", displacedPath: "/DOCSY/_index.md", hasBase: 1 });
  expect(JSON.stringify(records)).not.toContain('"bytes"');
  for (const [image, expected] of [["current", Buffer.from([255, 0, 128, 10])], ["intent", Buffer.from("sent")], ["base", Buffer.from("base")]] as const) {
    const output = join(root, image);
    expect(recoverNfsJournal(path, { id: "100", image, output })).toMatchObject({ bytes: 4 });
    expect(readFileSync(output)).toEqual(expected);
    expect(statSync(output).mode & 0o777).toBe(0o600);
    expect(() => recoverNfsJournal(path, { id: "100", image, output })).toThrow();
    expect(readFileSync(output)).toEqual(expected);
  }
  const link = join(root, "link"); symlinkSync(path, link);
  expect(() => recoverNfsJournal(path, { id: "100", output: link })).toThrow();
  expect(readFileSync(path)).toEqual(original);
});

it("fails closed for missing journals, images, invalid arguments and unsupported schemas", () => {
  const { root, path } = fixture();
  const missing = join(root, "missing.sqlite");
  expect(() => recoverNfsJournal(missing)).toThrow();
  expect(existsSync(missing)).toBe(false);
  const output = join(root, "out");
  expect(() => recoverNfsJournal(path, { id: "missing", output })).toThrow("No such");
  expect(() => recoverNfsJournal(path, { id: "100" })).toThrow("Use a journal");
  expect(() => recoverNfsJournal(path, { image: "intent" })).toThrow("Use a journal");
  expect(() => recoverNfsJournal(path, { id: "100", output, image: "files; DROP TABLE files" })).toThrow();
  expect(existsSync(output)).toBe(false);
  const db = new Database(path); db.exec("PRAGMA user_version=999"); db.close();
  expect(() => recoverNfsJournal(path)).toThrow("schema 8");
});

it("provides offline inspection and export through the source CLI", async () => {
  const { root, path } = fixture();
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, "--conditions=development", "run", "--cwd", "apps/cli", "src/index.ts", "wiki", "mount", "recovery", path, ...args, "--json"], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(""); expect(code).toBe(0); return stdout;
  };
  expect(await run()).toContain("REMOTE_RESULT_UNKNOWN");
  const output = join(root, "export.bin");
  expect(await run("--id", "100", "--output", output)).toContain('"bytes": 4');
  expect(readFileSync(output)).toEqual(Buffer.from([255, 0, 128, 10]));
});


it("exposes creation receipts and exports their frozen bytes independently of later edits", () => {
  const { root, path } = fixture();
  const journal = new NfsJournal(path, "synthetic:DOCSY");
  const file = journal.createLocal("/DOCSY/newpage.md");
  const first = journal.write(file.id, 0, Buffer.from("First"));
  journal.beginCreate(file.id, file.path, "DOCSY", "100", first.revision);
  journal.recordCreated(file.id, first.revision, "200", 1);
  journal.write(file.id, 0, Buffer.from("Newer"));
  journal.close();
  const records = recoverNfsJournal(path) as Record<string, unknown>[];
  expect(records.find(row => row.id === file.id)).toMatchObject({ creationPath: file.path, creationParent: "100", createdPageId: "200", createdVersion: 1 });
  const output = join(root, "creation.md");
  recoverNfsJournal(path, { id: file.id, image: "intent", output });
  expect(readFileSync(output, "utf8")).toBe("First");
});

it("still inspects schema-eight journals without upgrading them", () => {
  const { path } = fixture();
  const db = new Database(path); db.exec("DROP TABLE creations; PRAGMA user_version=8"); db.close();
  const before = readFileSync(path);
  expect((recoverNfsJournal(path) as unknown[]).length).toBe(3);
  expect(readFileSync(path)).toEqual(before);
});
