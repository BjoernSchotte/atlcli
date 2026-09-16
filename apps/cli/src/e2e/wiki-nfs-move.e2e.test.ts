import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getActiveProfile, loadConfig } from "@atlcli/core";
import { ConfluenceClient } from "@atlcli/confluence";
import { ConfluenceVfsImpl, formatDirName } from "@atlcli/confluence-vfs";
import { NfsFilesystem } from "../vfs/nfs-filesystem.js";

test.skipIf(process.env.ATLCLI_NFS_MOVE_E2E !== "1")("live DOCSY page move preserves an existing NFS handle", async () => {
  const profile = getActiveProfile(await loadConfig(), "mayflower");
  if (!profile) throw new Error("Missing mayflower test profile");
  const client = new ConfluenceClient(profile);
  const homepage = await client.getSpaceHomepageId("DOCSY");
  if (!homepage) throw new Error("DOCSY has no homepage");
  const marker = `ATLCLI NFS move ${crypto.randomUUID()}`;
  const cacheDir = mkdtempSync(join(tmpdir(), "nfs-live-move-"));
  const created: string[] = [];
  let vfs: ConfluenceVfsImpl | undefined;
  try {
    const parent = await client.createPage({ spaceKey: "DOCSY", parentId: homepage,
      title: `${marker} parent`, storage: "<p>Temporary NFS test destination.</p>" });
    created.push(parent.id);
    const child = await client.createPage({ spaceKey: "DOCSY", parentId: homepage,
      title: marker, storage: `<p>${marker}</p>` });
    created.push(child.id);
    vfs = await ConfluenceVfsImpl.open({ profile: profile.name, client, spaces: ["DOCSY"],
      mode: "ro", allowDelete: false, cacheDir, offline: false });
    const fs = new NfsFilesystem(vfs, ["DOCSY"]);
    const directory = await fs.lookup(1, formatDirName(child.title, child.id));
    const file = await fs.lookup(directory, "_index.md");
    expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64").toString()).toContain(marker);

    await client.movePage(child.id, parent.id);
    expect((await client.getPageMetadata(child.id)).parentId).toBe(parent.id);
    // Model the next expired directory listing; do not look up the new location first.
    await vfs.index.loadChildren(homepage, { force: true });
    expect(Buffer.from((await fs.read(file, 0, 65536)).data, "base64").toString()).toContain(marker);
    const newParent = await fs.lookup(1, formatDirName(parent.title, parent.id));
    expect(await fs.lookup(directory, "..")).toBe(newParent);
    expect(await fs.lookup(newParent, formatDirName(child.title, child.id))).toBe(directory);
    expect(await fs.lookup(directory, "_index.md")).toBe(file);
  } finally {
    const errors: unknown[] = [];
    try { await vfs?.close(); } catch (error) { errors.push(error); }
    for (const id of created.reverse()) {
      try { await client.deletePage(id); } catch (error) { errors.push(error); }
    }
    rmSync(cacheDir, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, "NFS live move fixture cleanup failed");
  }
}, 60_000);
