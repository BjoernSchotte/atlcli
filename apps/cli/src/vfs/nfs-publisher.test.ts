import { afterEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { NfsJournal } from "./nfs-journal.js";
import { NfsPublisher } from "./nfs-publisher.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function fixture(mode: "ro" | "rw" = "rw") {
  const root = mkdtempSync(join(tmpdir(), "nfs-publish-"));
  const client = new FakeConfluenceClient()
    .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Original</p>" });
  const vfs = await ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY"],
    mode, allowDelete: false, coalesceMs: 0, cacheDir: join(root, "cache"), offline: false });
  const journal = new NfsJournal(join(root, "journal.sqlite"), "fixture:DOCSY");
  cleanup.push(async () => { await vfs.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const original = await vfs.readFile("/DOCSY/_index.md");
  journal.admit("100", "/DOCSY/_index.md", Buffer.from(original), 1);
  const stage = (value: string) => {
    journal.truncate("100", Buffer.byteLength(value));
    journal.write("100", 0, Buffer.from(value));
  };
  const publisher = new NfsPublisher(journal, vfs, ["DOCSY"]);
  return { client, vfs, journal, original, stage, publisher };
}

it("publishes a durable image through the core while preserving newer local bytes", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "First"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let started!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const update = client.updatePage.bind(client);
  client.updatePage = async params => { started(); await gate; return update(params); };
  const first = publisher.publish("100");
  await entered;
  expect(publisher.publish("100")).toBe(first);
  stage(original.replace("Original", "Newer"));
  release();
  expect((await first)?.version).toBe(2);
  expect(client.peekPage("100")?.storage).toContain("First");
  expect(Buffer.from(journal.get("100")!.bytes).toString()).toContain("Newer");
  expect(journal.pending()).toHaveLength(1);
  expect(journal.get("100")!.baseVersion).toBe(2);
  expect((await publisher.publish("100"))?.version).toBe(3);
  expect(client.peekPage("100")?.storage).toContain("Newer");
  expect(journal.pending()).toHaveLength(0);
});

it("reconciles an ambiguous successful update without duplicating the version", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Saved"));
  const update = client.updatePage.bind(client);
  let loseReply = true;
  client.updatePage = async params => {
    const result = await update(params);
    if (loseReply) { loseReply = false; throw new Error("Lost response"); }
    return result;
  };
  await expect(publisher.publish("100")).rejects.toThrow();
  expect(journal.pending()).toHaveLength(1);
  expect(client.peekPage("100")?.version).toBe(2);
  expect((await publisher.publish("100"))?.version).toBe(2);
  expect(journal.pending()).toHaveLength(0);
  expect(await publisher.publish("100")).toBeNull();
});

it("keeps invalid UTF-8 staged without sending writes", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Changed"));
  journal.write("100", 0, new Uint8Array([0xff]));
  await expect(publisher.publish("100")).rejects.toMatchObject({ code: "EINVAL" });
  expect(journal.get("100")!.error).toBe("EINVAL");
  expect(client.callsTo("updatePage")).toBe(0);
  expect(journal.pending()).toHaveLength(1);
  stage(original.replace("Original", "Repaired"));
  expect((await publisher.publish("100"))?.version).toBe(2);
  expect(journal.pending()).toHaveLength(0);
});

it("retains the core read-only guard and the durable pending image", async () => {
  const { client, journal, original, stage, publisher } = await fixture("ro");
  stage(original.replace("Original", "Changed"));
  await expect(publisher.publish("100")).rejects.toMatchObject({ code: "EROFS" });
  expect(journal.get("100")!.error).toBe("EROFS");
  expect(client.callsTo("updatePage")).toBe(0);
  expect(journal.pending()).toHaveLength(1);
});


it("refuses a changed identity at the core write boundary without creating a page", async () => {
  const { client, vfs, original } = await fixture();
  await expect(vfs.writeFile("/DOCSY/_index.md", original,
    { id: "999", spaceKey: "DOCSY" })).rejects.toMatchObject({ code: "EBUSY" });
  await expect(vfs.writeFile("/DOCSY/_index.md", original,
    { id: "100", spaceKey: "mayflower" })).rejects.toMatchObject({ code: "EBUSY" });
  await expect(vfs.writeFile("/DOCSY/missing.md", original,
    { id: "100", spaceKey: "DOCSY" })).rejects.toMatchObject({ code: "EBUSY" });
  expect(client.callsTo("createPage")).toBe(0);
  expect(client.callsTo("updatePage")).toBe(0);
});

it("rejects altered page frontmatter before freezing a publication intent", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace('id: "100"', 'id: "999"'));
  await expect(publisher.publish("100")).rejects.toMatchObject({ code: "EINVAL" });
  expect(client.callsTo("updatePage")).toBe(0);
  stage(original.replace("Original", "Valid"));
  expect((await publisher.publish("100"))?.version).toBe(2);
  expect(journal.pending()).toHaveLength(0);
});


it("rebases later local edits without dropping remote content merged by the first publication", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  client.bumpVersion("100", "<p>Original</p><p>Remote addition.</p>");
  stage(original.replace("Original", "First"));
  expect((await publisher.publish("100"))?.version).toBe(3);
  expect(client.peekPage("100")?.storage).toContain("Remote addition.");
  // The editor still holds its original header and never saw the remote addition.
  stage(original.replace("Original", "Second"));
  expect((await publisher.publish("100"))?.version).toBe(4);
  expect(client.peekPage("100")?.storage).toContain("Second");
  expect(client.peekPage("100")?.storage).toContain("Remote addition.");
  expect(journal.pending()).toHaveLength(0);
});

it("replays a rebased follow-up from its immutable version after losing the reply", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "First"));
  await publisher.publish("100");
  stage(original.replace("Original", "Second"));
  const update = client.updatePage.bind(client);
  let loseReply = true;
  client.updatePage = async params => {
    const result = await update(params);
    if (loseReply) { loseReply = false; throw new Error("Lost reply"); }
    return result;
  };
  await expect(publisher.publish("100")).rejects.toThrow();
  expect(client.peekPage("100")?.version).toBe(3);
  expect((await publisher.publish("100"))?.version).toBe(3);
  expect(client.peekPage("100")?.storage).toContain("Second");
  expect(journal.pending()).toHaveLength(0);
});
