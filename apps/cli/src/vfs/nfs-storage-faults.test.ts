import { expect, it } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { NfsJournal } from "./nfs-journal.js";
import { NfsPublisher } from "./nfs-publisher.js";

const run = (command: string, args: string[]) => promisify(execFile)(command, args, { timeout: 30_000 });

// Opt-in: creates only a disposable 64 MiB image, never fills the host volume.
for (const operation of ["create", "update"] as const) {
  it.skipIf(process.env.ATLCLI_NFS_STORAGE_FAULTS !== "1")(`recovers ${operation} after real filesystem ENOSPC following remote success`, async () => {
    const root = mkdtempSync(join(tmpdir(), "nfs-storage-fault-"));
    const mount = join(root, "volume"), image = join(root, "volume.dmg");
    mkdirSync(mount);
    let journal: NfsJournal | undefined;
    let publisher: NfsPublisher | undefined;
    let vfs: ConfluenceVfsImpl | undefined;
    const filler = join(mount, "filler");
    try {
      if (process.platform === "darwin") {
        await run("hdiutil", ["create", "-size", "64m", "-fs", "APFS", "-volname", "atlcli-storage-test", image]);
        await run("hdiutil", ["attach", "-nobrowse", "-mountpoint", mount, image]);
      } else if (process.platform === "linux") {
        await run("truncate", ["-s", "64M", image]);
        await run("mkfs.ext4", ["-q", "-m", "0", image]);
        await run("sudo", ["-n", "mount", "-o", "loop,nodev,nosuid", image, mount]);
        await run("sudo", ["-n", "chown", `${process.getuid!()}:${process.getgid!()}`, mount]);
      } else throw new Error("Storage fault tests require macOS or Linux");
      expect(statSync(mount).dev).not.toBe(statSync(root).dev);
      const capacity = statfsSync(mount);
      expect(capacity.bsize * capacity.blocks).toBeLessThanOrEqual(64 * 1024 * 1024);
      const fill = () => {
        const fd = openSync(filler, "wx");
        let total = 0;
        try {
          for (const size of [1024 * 1024, 4096]) {
            const chunk = Buffer.alloc(size, 0x61);
            for (;;) {
              if (total > 64 * 1024 * 1024) throw new Error("Unexpected filesystem capacity");
              try { total += writeSync(fd, chunk); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
                break;
              }
            }
          }
          fsyncSync(fd);
        } finally { closeSync(fd); }
        expect(total).toBeGreaterThan(1024 * 1024);
      };
      const client = new FakeConfluenceClient()
        .seedSpace({ id: "s1", key: "DOCSY", name: "Docs", homepageId: "100" })
        .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Original</p>" });
      const openVfs = () => ConfluenceVfsImpl.open({ profile: "fixture", client, spaces: ["DOCSY"],
        mode: "rw", allowDelete: false, coalesceMs: 0, cacheDir: join(root, "cache"), offline: false });
      vfs = await openVfs();
      const journalPath = join(mount, "journal.sqlite");
      journal = new NfsJournal(journalPath, "fixture:DOCSY");
      publisher = new NfsPublisher(journal, vfs, ["DOCSY"]);
      let id: string;
      let content: string;
      let remoteId = "100";
      if (operation === "create") {
        id = journal.createLocal("/DOCSY/newpage.md").id;
        content = "Saved Grüße 🐴";
        journal.write(id, 0, Buffer.from(content));
        const create = client.createPage.bind(client);
        client.createPage = async params => {
          const result = await create(params);
          remoteId = result.id;
          fill();
          return result;
        };
      } else {
        id = "100";
        const original = await vfs.readFile("/DOCSY/_index.md");
        journal.admit(id, "/DOCSY/_index.md", Buffer.from(original), 1);
        content = original.replace("Original", "Saved Grüße 🐴");
        journal.truncate(id, Buffer.byteLength(content));
        journal.write(id, 0, Buffer.from(content));
        const update = client.updatePage.bind(client);
        client.updatePage = async params => {
          const result = await update(params);
          fill();
          return result;
        };
      }
      await expect(publisher.publish(id)).rejects.toMatchObject({ code: "SQLITE_FULL" });
      expect(client.peekPage(remoteId)?.storage).toContain("Saved Grüße 🐴");
      const version = client.peekPage(remoteId)!.version;
      await publisher.stop(); publisher = undefined;
      journal.close(); journal = undefined;
      await vfs.close(); vfs = undefined;
      unlinkSync(filler);

      journal = new NfsJournal(journalPath, "fixture:DOCSY");
      expect(Buffer.from(journal.get(id)!.bytes).toString()).toBe(content);
      expect(Buffer.from(journal.publishIntent(id)!.bytes).toString()).toBe(content);
      vfs = await openVfs();
      publisher = new NfsPublisher(journal, vfs, ["DOCSY"]);
      expect((await publisher.publish(id))?.version).toBe(version);
      expect(client.peekPage(remoteId)?.version).toBe(version);
      expect(client.callsTo("createPage")).toBe(operation === "create" ? 1 : 0);
      expect(client.callsTo("updatePage")).toBe(operation === "update" ? 1 : 0);
      expect(journal.writeStatus().pendingPages).toBe(0);
      expect(journal.writeStatus().unresolvedPublications).toBe(0);
    } finally {
      await publisher?.stop();
      journal?.close();
      await vfs?.close();
      if (statSync(mount).dev !== statSync(root).dev) {
        if (process.platform === "darwin") await run("hdiutil", ["detach", mount]);
        else await run("sudo", ["-n", "umount", mount]);
      }
      // A failed normal detach intentionally leaves the owned image for recovery.
      if (statSync(mount).dev !== statSync(root).dev) throw new Error("Storage test volume remains attached");
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
}
