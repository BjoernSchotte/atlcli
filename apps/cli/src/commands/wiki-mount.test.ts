/**
 * Platform commands and mount bookkeeping (WP7.5, WP7.6).
 *
 * The pure parts are unit-tested: which command each platform gets, and how
 * mount records are written and pruned. Actually attaching a volume needs a
 * kernel and belongs to WP7.9's gated live run.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  mountCommandFor,
  mountStateDir,
  mountStatePath,
  readMounts,
  runMountCommand,
  unmountCommandFor,
  wikiMountHelp,
  type MountRecord,
} from "./wiki-mount.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "vfs-mount-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("platform commands", () => {
  it("keeps the server responsive while the OS client is running", async () => {
    const server = createServer((_req, res) => res.end("ready"));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };
    try {
      const status = await runMountCommand([process.execPath, "-e",
        `const r = await fetch('http://127.0.0.1:${port}', {signal: AbortSignal.timeout(1000)}); process.exit((await r.text()) === 'ready' ? 0 : 1);`], true);
      expect(status).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("uses mount_webdav on macOS, with the dialog suppressed", () => {
    const command = mountCommandFor("darwin", "http://127.0.0.1:8080/", "/Users/x/confluence", "atlcli-DOCSY");
    expect(command).toEqual({
      run: ["mount_webdav", "-S", "-v", "atlcli-DOCSY", "http://127.0.0.1:8080/", "/Users/x/confluence"],
    });
  });

  it("uses net use on Windows", () => {
    expect(mountCommandFor("win32", "http://127.0.0.1:8080/", "X:", "atlcli-DOCSY")).toEqual({
      run: ["net", "use", "X:", "http://127.0.0.1:8080/"],
    });
  });

  /**
   * Linux prints rather than runs: davfs2 needs root, and a CLI that asks for
   * a password to mount something is a CLI that teaches a bad habit.
   */
  it("prints instructions on Linux instead of running anything", () => {
    const command = mountCommandFor("linux", "http://127.0.0.1:8080/", "/home/x/confluence", "atlcli-DOCSY");
    expect("run" in command).toBe(false);
    if ("instructions" in command) {
      expect(command.instructions).toContain("mount -t davfs");
      expect(command.instructions).toContain("fstab");
      expect(command.instructions).toContain("will not do it for you");
    }
  });

  it("pairs each platform with its unmount", () => {
    expect(unmountCommandFor("darwin", "/Users/x/confluence")).toEqual({
      run: ["umount", "/Users/x/confluence"],
    });
    expect(unmountCommandFor("win32", "X:")).toEqual({ run: ["net", "use", "X:", "/delete"] });
    expect("instructions" in unmountCommandFor("linux", "/home/x/confluence")).toBe(true);
  });
});

describe("mount records", () => {
  function write(record: Partial<MountRecord> & { mountpoint: string; pid: number }): void {
    mkdirSync(mountStateDir(root), { recursive: true });
    const full: MountRecord = {
      url: "http://127.0.0.1:1234/",
      port: 1234,
      spaces: ["DOCSY"],
      mode: "ro",
      startedAt: new Date().toISOString(),
      ...record,
    };
    writeFileSync(mountStatePath(root, record.mountpoint), JSON.stringify(full));
  }

  it("gives each mountpoint its own state file", () => {
    expect(mountStatePath(root, "/a")).not.toBe(mountStatePath(root, "/b"));
    expect(mountStatePath(root, "/a")).toBe(mountStatePath(root, "/a"));
  });

  it("lists a mount whose process is alive", () => {
    write({ mountpoint: "/mnt/live", pid: process.pid });
    expect(readMounts(root).map((m) => m.mountpoint)).toEqual(["/mnt/live"]);
  });

  /**
   * A record whose process died is worse than no record: it makes `mount list`
   * claim a volume that is not there. Reading prunes.
   */
  it("prunes a record whose process is gone", () => {
    write({ mountpoint: "/mnt/dead", pid: 0x7ffffffe });
    expect(readMounts(root)).toEqual([]);
    expect(readMounts(root)).toEqual([]);
  });

  it("prunes a record it cannot parse", () => {
    mkdirSync(mountStateDir(root), { recursive: true });
    writeFileSync(mountStatePath(root, "/mnt/broken"), "not json");
    expect(readMounts(root)).toEqual([]);
  });

  it("returns nothing when no mount has ever been made", () => {
    expect(readMounts(join(root, "never"))).toEqual([]);
  });
});

describe("help", () => {
  it("names the platform behaviour and the Windows limit", () => {
    const help = wikiMountHelp();
    expect(help).toContain("mount_webdav");
    expect(help).toContain("net use");
    expect(help).toContain("davfs2");
    expect(help).toContain("50 MB");
  });

  it("points full-text search at wiki sh, because shell search bounds body reads", () => {
    const help = wikiMountHelp();
    expect(help).toContain("does not enforce the shell prefetch budget");
    expect(help).toContain("atlcli wiki sh");
  });

  it("says writing is off by default", () => {
    expect(wikiMountHelp()).toContain("default: ro");
  });
});
