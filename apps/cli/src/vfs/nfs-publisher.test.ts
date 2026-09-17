import { afterEach, expect, it, spyOn } from "bun:test";
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
    .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Original</p>" })
    .seedPage({ id: "200", title: "Second", parentId: "100", spaceKey: "DOCSY", storage: "<p>Second</p>" });
  const vfs = await ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY"],
    mode, allowDelete: false, coalesceMs: 0, cacheDir: join(root, "cache"), offline: false });
  const journal = new NfsJournal(join(root, "journal.sqlite"), "fixture:DOCSY");
  cleanup.push(async () => { await publisher.stop(); await vfs.close(); journal.close(); rmSync(root, { recursive: true, force: true }); });
  const original = await vfs.readFile("/DOCSY/_index.md");
  journal.admit("100", "/DOCSY/_index.md", Buffer.from(original), 1);
  const stage = (value: string) => {
    journal.truncate("100", Buffer.byteLength(value));
    journal.write("100", 0, Buffer.from(value));
  };
  const publisher = new NfsPublisher(journal, vfs, ["DOCSY"]);
  return { client, vfs, journal, original, stage, publisher, root };
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


async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!check() && Date.now() < deadline) await Bun.sleep(20);
  expect(check()).toBe(true);
}

it("automatically publishes only the latest image after a full quiet window", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Intermediate")); publisher.schedule("100");
  await Bun.sleep(300);
  stage(original.replace("Original", "Latest")); publisher.schedule("100");
  await Bun.sleep(300);
  expect(client.callsTo("updatePage")).toBe(0);
  await until(() => journal.pending().length === 0);
  expect(client.callsTo("updatePage")).toBe(1);
  expect(client.peekPage("100")?.storage).toContain("Latest");
});

it("serializes automatic follow-up saves behind an in-flight publication", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const update = client.updatePage.bind(client);
  let active = 0, peak = 0, calls = 0;
  client.updatePage = async params => {
    calls++; active++; peak = Math.max(peak, active);
    try { if (calls === 1) await gate; return await update(params); }
    finally { active--; }
  };
  stage(original.replace("Original", "First")); publisher.schedule("100");
  await until(() => calls === 1);
  stage(original.replace("Original", "Latest")); publisher.schedule("100");
  try { await Bun.sleep(600); expect(calls).toBe(1); }
  finally { release(); }
  await until(() => journal.pending().length === 0);
  expect(peak).toBe(1);
  expect(client.peekPage("100")?.version).toBe(3);
  expect(client.peekPage("100")?.storage).toContain("Latest");
});

it("stops timers without publishing partial work and resumes durable pending images", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Recovered")); publisher.schedule("100");
  await publisher.stop();
  await Bun.sleep(550);
  expect(client.callsTo("updatePage")).toBe(0);
  expect(journal.pending()).toHaveLength(1);
  const recovered = new NfsPublisher(journal, vfs, ["DOCSY"]);
  try {
    recovered.resume();
    await until(() => journal.pending().length === 0);
    expect(client.peekPage("100")?.storage).toContain("Recovered");
  } finally { await recovered.stop(); }
});

it("keeps sparse or binary NUL images local and publishes after the holes are repaired", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Unwritten\0bytes")); publisher.schedule("100");
  await until(() => journal.get("100")?.error === "EINVAL");
  expect(client.callsTo("updatePage")).toBe(0);
  stage(original.replace("Original", "Repaired")); publisher.schedule("100");
  await until(() => journal.pending().length === 0);
  expect(client.peekPage("100")?.storage).toContain("Repaired");
});


it("pauses a queued publication during backup rename and resumes its replacement", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Before backup"));
  publisher.schedule("100");
  journal.backupPage("100", "/DOCSY/backup.md");
  await Bun.sleep(600);
  expect(journal.get("100")!.error).toBeNull();
  expect(await publisher.publish("100")).toBeNull();
  expect(client.callsTo("updatePage")).toBe(0);
  const replacement = journal.createLocal("/DOCSY/replacement.tmp");
  journal.write(replacement.id, 0, Buffer.from(original.replace("Original", "Replacement")));
  journal.replaceLocal(replacement.path, "100");
  publisher.schedule("100");
  await until(() => journal.pending().length === 0);
  expect(client.callsTo("updatePage")).toBe(1);
  expect(client.peekPage("100")?.storage).toContain("Replacement");
});

it("leaves invalid displaced bytes and editor-local files outside publication validation", async () => {
  const { client, journal, stage, publisher } = await fixture();
  stage("unfinished editor save");
  const backup = journal.backupPage("100", "/DOCSY/backup.md");
  expect(await publisher.publish("100")).toBeNull();
  expect(await publisher.publish(backup.id)).toBeNull();
  expect(journal.get("100")!.error).toBeNull();
  expect(journal.get(backup.id)!.error).toBeNull();
  expect(client.callsTo("updatePage")).toBe(0);
});


it("pauses before the remote write when backup rename races with path resolution", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Frozen"));
  const readlink = vfs.readlink.bind(vfs);
  vfs.readlink = async path => {
    journal.backupPage("100", "/DOCSY/backup.md");
    return readlink(path);
  };
  expect(await publisher.publish("100")).toBeNull();
  expect(client.callsTo("updatePage")).toBe(0);
  expect(journal.get("100")!.error).toBeNull();
  vfs.readlink = readlink;
  journal.replaceLocal("/DOCSY/backup.md", "100");
  expect((await publisher.publish("100"))?.version).toBe(2);
  expect(client.peekPage("100")?.storage).toContain("Frozen");
  expect(journal.pending()).toHaveLength(0);
});


for (const stopWhileQueued of [false, true]) it(`bounds queued publication bodies and preserves work on stop=${stopWhileQueued}`, async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  const second = await vfs.readFile("/DOCSY/second-200/_index.md");
  journal.admit("200", "/DOCSY/second-200/_index.md", Buffer.from(second), 1);
  journal.write("200", Buffer.byteLength(second), Buffer.from("queued"));
  stage(original.replace("Original", "First edit"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const update = client.updatePage.bind(client);
  let entered = false;
  client.updatePage = async params => { if (!entered) { entered = true; await gate; } return update(params); };
  const get = spyOn(journal, "get");
  const first = publisher.publish("100");
  await until(() => entered);
  const queued = publisher.publish("200");
  expect(publisher.publish("200")).toBe(queued);
  expect(get.mock.calls.some(call => call[0] === "200")).toBe(false);
  const stopping = stopWhileQueued ? publisher.stop() : undefined;
  release();
  try {
    expect((await first)?.version).toBe(2);
    expect(await queued).toEqual(stopWhileQueued ? null : expect.objectContaining({ pageId: "200", version: 2 }));
    await stopping;
    expect(journal.pendingIds()).toEqual(stopWhileQueued ? ["200"] : []);
    expect(client.callsTo("updatePage")).toBe(stopWhileQueued ? 1 : 2);
  } finally { get.mockRestore(); }
});


it("keeps a fresh quiet window when a queued page changes behind another upload", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  const second = await vfs.readFile("/DOCSY/second-200/_index.md");
  journal.admit("200", "/DOCSY/second-200/_index.md", Buffer.from(second), 1);
  journal.write("200", Buffer.byteLength(second), Buffer.from("queued"));
  stage(original.replace("Original", "First edit"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const update = client.updatePage.bind(client);
  let entered = false;
  client.updatePage = async params => { if (!entered) { entered = true; await gate; } return update(params); };
  const first = publisher.publish("100");
  await until(() => entered);
  const queued = publisher.publish("200");
  journal.write("200", Buffer.byteLength(second), Buffer.from("latest"));
  publisher.schedule("200");
  release();
  await first;
  expect(await queued).toBeNull();
  await Bun.sleep(200);
  expect(client.callsTo("updatePage")).toBe(1);
  await until(() => journal.pendingIds().length === 0);
  expect(client.callsTo("updatePage")).toBe(2);
  expect(client.peekPage("200")?.storage).toContain("latest");
});


it("allows correcting a preflight merge conflict without freezing an unsent image", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "First"));
  await publisher.publish("100");
  const version = client.bumpVersion("100", "<p>Remote changed</p>");
  vfs.index.upsert({ id: "100", version });
  const remote = await vfs.readFile("/DOCSY/_index.md");
  journal.refreshClean("100", "/DOCSY/_index.md", Buffer.from(remote), version, journal.get("100")!.revision);
  stage(original.replace("Original", "Conflicting local change"));
  const calls = client.callsTo("updatePage");
  await expect(publisher.publish("100")).rejects.toMatchObject({ code: "EBUSY" });
  expect(journal.publishIntent("100")).toBeNull();
  expect(journal.get("100")!.error).toBe("EBUSY");
  expect(client.callsTo("updatePage")).toBe(calls);
  stage(remote + "\nResolved additional paragraph\n");
  await publisher.publish("100");
  expect(client.peekPage("100")?.storage).toContain("Remote changed");
  expect(client.peekPage("100")?.storage).toContain("Resolved additional paragraph");
  expect(journal.pendingIds()).toEqual([]);
});


it("prepares a newer revision again when edits arrive before intent persistence", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  stage(original.replace("Original", "Obsolete preparation"));
  const readlink = vfs.readlink.bind(vfs);
  let changed = false;
  vfs.readlink = async path => {
    if (!changed) { changed = true; stage(original.replace("Original", "Latest preparation")); }
    return readlink(path);
  };
  expect(await publisher.publish("100")).toBeNull();
  expect(client.callsTo("updatePage")).toBe(0);
  expect(journal.publishIntent("100")).toBeNull();
  await until(() => journal.pendingIds().length === 0);
  expect(client.callsTo("updatePage")).toBe(1);
  expect(client.peekPage("100")?.storage).toContain("Latest preparation");
});


it("completes a reconciled save at the existing remote version", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  stage("temporary editor content");
  stage(original);
  // A stale core index proposes an already-existing version. The core refetch
  // proves the storage already matches and returns that version without another version.
  vfs.index.upsert({ id: "100", version: 0 });
  const result = await publisher.publish("100");
  expect(result?.version).toBe(1);
  expect(client.peekPage("100")?.version).toBe(1);
  expect(journal.pendingIds()).toEqual([]);
  expect(journal.publishIntent("100")).toBeNull();
});


it("publishes an accepted intermediate version when a valid prefix precedes a delayed suffix", async () => {
  const { client, journal, original, stage, publisher } = await fixture();
  // Accepted contract: the quiet window publishes a valid snapshot, not a
  // guarantee that the editor will send no later blocks.
  stage(original.replace("Original", "Valid prefix"));
  publisher.schedule("100");
  await until(() => client.peekPage("100")?.version === 2);
  expect(client.peekPage("100")?.storage).toContain("Valid prefix");
  expect(client.peekPage("100")?.storage).not.toContain("Delayed suffix");
  stage(original.replace("Original", "Valid prefix\n\nDelayed suffix"));
  publisher.schedule("100");
  await until(() => journal.pendingIds().length === 0);
  expect(client.peekPage("100")?.storage).toContain("Valid prefix");
  expect(client.peekPage("100")?.storage).toContain("Delayed suffix");
  expect(client.callsTo("updatePage")).toBe(2);
});


it("automatically drains newer saved bytes after reconciling an interrupted publication", async () => {
  const { client, vfs, journal, original, stage, publisher } = await fixture();
  const update = client.updatePage.bind(client);
  client.updatePage = async params => { await update(params); throw new Error("Lost response"); };
  stage(original.replace("Original", "First"));
  await expect(publisher.publish("100")).rejects.toThrow();
  stage(original.replace("Original", "Latest"));
  await publisher.stop();
  client.updatePage = update;
  const recovered = new NfsPublisher(journal, vfs, ["DOCSY"]);
  try {
    recovered.resume();
    await until(() => journal.pendingIds().length === 0);
    expect(client.peekPage("100")?.version).toBe(3);
    expect(client.peekPage("100")?.storage).toContain("Latest");
    expect(journal.publishIntent("100")).toBeNull();
  } finally { await recovered.stop(); }
});


it("automatically creates plain Markdown once and resumes newer saves under the returned page ID", async () => {
  const { client, vfs, journal, publisher } = await fixture();
  const local = journal.createLocal("/DOCSY/newpage.md");
  journal.write(local.id, 0, Buffer.from("First plain page"));
  publisher.schedule(local.id);
  await until(() => journal.promotion(local.id) !== null);
  const pageId = journal.promotion(local.id)!.pageId;
  expect(client.peekPage(pageId)?.title).toBe("Newpage");
  expect(client.peekPage(pageId)?.storage).toContain("First plain page");
  expect(client.callsTo("createPage")).toBe(1);
  journal.truncate(pageId, 6); journal.write(pageId, 0, Buffer.from("Second")); publisher.schedule(pageId);
  await until(() => journal.pendingIds().length === 0);
  expect(client.peekPage(pageId)?.version).toBe(2);
  expect(client.peekPage(pageId)?.storage).toContain("Second");
  expect(client.callsTo("createPage")).toBe(1);
  expect((await vfs.resolve(await vfs.readlink(`/DOCSY/.by-id/${pageId}.md`))).id).toBe(pageId);
});

it("does not repeat an ambiguous create and recovers a confirmed receipt without another POST", async () => {
  const { client, journal, publisher } = await fixture();
  const local = journal.createLocal("/DOCSY/newpage.md");
  journal.write(local.id, 0, Buffer.from("Plain"));
  const create = client.createPage.bind(client);
  let pageId = "";
  client.createPage = async params => { const result = await create(params); pageId = result.id; throw new Error("Lost reply"); };
  await expect(publisher.publish(local.id)).rejects.toThrow();
  await expect(publisher.publish(local.id)).rejects.toMatchObject({ code: "EBUSY" });
  expect(client.callsTo("createPage")).toBe(1);
  const intent = journal.createIntent(local.id)!;
  expect(intent.pageId).toBeNull();
  // Simulates recovery of a proven receipt, not an automatic guess by title.
  journal.recordCreated(local.id, intent.revision, pageId, 1);
  expect((await publisher.publish(local.id))?.pageId).toBe(pageId);
  expect(client.callsTo("createPage")).toBe(1);
  expect(journal.promotion(local.id)?.pageId).toBe(pageId);
});

it("never creates pages for hidden drafts, swap files or page backups", async () => {
  const { client, journal, publisher } = await fixture();
  for (const path of ["/DOCSY/.newpage.md", "/DOCSY/newpage.md~", "/DOCSY/.newpage.md.swp"]) {
    const local = journal.createLocal(path); journal.write(local.id, 0, Buffer.from("Text"));
    expect(await publisher.publish(local.id)).toBeNull();
  }
  const backup = journal.backupPage("100", "/DOCSY/backup.md");
  journal.truncate(backup.id, 5); journal.write(backup.id, 0, Buffer.from("Plain"));
  expect(await publisher.publish(backup.id)).toBeNull();
  expect(client.callsTo("createPage")).toBe(0);
});

for (const boundary of ["before-post", "unknown-result", "confirmed-result"] as const) {
  it(`recovers new-page publication after reopening at ${boundary}`, async () => {
    const { client, vfs, journal, publisher, root } = await fixture();
    const local = journal.createLocal("/DOCSY/restart.md");
    journal.write(local.id, 0, Buffer.from("First image"));
    let createdId: string | undefined;
    if (boundary !== "before-post") {
      const intent = journal.beginCreate(local.id, local.path, "DOCSY", "100", journal.get(local.id)!.revision)!;
      const result = await vfs.writeFile(local.path, "First image", { createOnly: true, spaceKey: "DOCSY", parentId: "100" });
      createdId = result.pageId;
      if (boundary === "confirmed-result") journal.recordCreated(local.id, intent.revision, result.pageId, result.version);
    }
    journal.truncate(local.id, 0);
    journal.write(local.id, 0, Buffer.from("Latest image"));
    await publisher.stop(); await vfs.close(); journal.close();
    const reopened = new NfsJournal(join(root, "journal.sqlite"), "fixture:DOCSY");
    const freshVfs = await ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY"],
      mode: "rw", allowDelete: false, coalesceMs: 0, cacheDir: join(root, "fresh"), offline: false });
    const recovered = new NfsPublisher(reopened, freshVfs, ["DOCSY"]);
    try {
      recovered.resume();
      if (boundary === "unknown-result") {
        await until(() => reopened.writeStatus().failedPages === 1);
        expect(reopened.promotion(local.id)).toBeNull();
        expect(Buffer.from(reopened.get(local.id)!.bytes).toString()).toBe("Latest image");
        expect(Buffer.from(reopened.createIntent(local.id)!.bytes).toString()).toBe("First image");
        expect(client.peekPage(createdId!)?.storage).toContain("First image");
      } else {
        await until(() => reopened.promotion(local.id) !== null && reopened.writeStatus().pendingPages === 0);
        const pageId = reopened.promotion(local.id)!.pageId;
        expect(client.peekPage(pageId)?.storage).toContain("Latest image");
        expect(client.peekPage(pageId)?.version).toBe(boundary === "before-post" ? 1 : 2);
        expect(reopened.createIntent(local.id)).toBeNull();
        if (createdId) expect(pageId).toBe(createdId);
      }
      expect(client.callsTo("createPage")).toBe(1);
    } finally { await recovered.stop(); await freshVfs.close(); reopened.close(); }
  });
}


it("publishes an empty new Markdown document on resume without a WRITE", async () => {
  const { client, journal, publisher } = await fixture();
  const local = journal.createLocal("/DOCSY/empty.md");
  expect(journal.writeStatus().pendingPages).toBe(1);
  publisher.resume();
  await until(() => journal.promotion(local.id) !== null);
  const id = journal.promotion(local.id)!.pageId;
  expect(client.peekPage(id)?.title).toBe("Empty");
  expect(client.callsTo("createPage")).toBe(1);
  expect(journal.writeStatus().pendingPages).toBe(0);
  publisher.resume();
  await Bun.sleep(600);
  expect(client.callsTo("createPage")).toBe(1);
});


it("confirms interrupted trash on resume without a second DELETE", async () => {
  const { client, vfs, journal, publisher, root } = await fixture();
  journal.beginTrash("100", "/DOCSY/_index.md", "DOCSY");
  await client.deletePage("100");
  await publisher.stop(); journal.close();
  const reopened = new NfsJournal(join(root, "journal.sqlite"), "fixture:DOCSY");
  const recovered = new NfsPublisher(reopened, vfs, ["DOCSY"]);
  try {
    recovered.resume();
    await until(() => reopened.trashIntent("100")?.completed === 1);
    expect(client.callsTo("deletePage")).toBe(1);
    expect(reopened.writeStatus().unresolvedPublications).toBe(0);
    expect(Buffer.from(reopened.get("100")!.bytes).toString()).toContain("Original");
  } finally { await recovered.stop(); reopened.close(); }
});

it("keeps unresolved trash for current, inaccessible and failed confirmations", async () => {
  const { client, journal, publisher } = await fixture();
  journal.beginTrash("100", "/DOCSY/_index.md", "DOCSY");
  expect(await publisher.publish("100")).toBeNull();
  expect(journal.trashIntent("100")?.completed).toBe(0);
  client.isPageTrashed = async () => false;
  expect(await publisher.publish("100")).toBeNull();
  client.isPageTrashed = async () => { throw new Error("Unavailable"); };
  await expect(publisher.publish("100")).rejects.toThrow("Unavailable");
  expect(journal.writeStatus().unresolvedPublications).toBe(1);
  expect(client.callsTo("deletePage")).toBe(0);
});
