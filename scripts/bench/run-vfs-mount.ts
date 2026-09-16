/** Native read-only transport comparison. Run with bun --conditions=development. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, release, arch, tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { startNfsServer } from "../../apps/cli/src/vfs/nfs-bridge.js";
import { startWebdavServer } from "../../apps/cli/src/vfs/webdav-server.js";
import { isMounted, mountUrlFor, runMountCommand } from "../../apps/cli/src/commands/wiki-mount.js";

const helper = process.env.ATLCLI_NFS_TEST_HELPER;
const output = process.argv[2];
assert(helper && output, "Set ATLCLI_NFS_TEST_HELPER and pass the output JSON path");
assert(["darwin", "linux"].includes(platform()), "Native macOS/Linux only");
const attachment = Buffer.from("Grüße 🐴\n".repeat(100_000));
const records: Record<string, unknown>[] = [];
let interrupted = 0;
async function retryInterrupted<T>(action: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await action(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EINTR" || attempt >= 3) throw error;
      interrupted++;
    }
  }
}
const results = { schema: 1, host: { os: platform(), release: release(), arch: arch(), bun: Bun.version },
  corpus: { pages: 26, attachmentBytes: attachment.length, backend: "in-process synthetic; no network latency" },
  cachePolicy: "Cold: fresh mount, endpoint, VFS and davfs cache. Warm: immediate identical workload on same mount.",
  limitations: ["Body payload bytes exclude API metadata/HTTP overhead", "RSS is a final sample, not a peak", "VFS calls are not wire protocol request counts", "No Glow/editor/write timing"], records };

for (let run = 0; run < 5; run++) {
  for (const transport of run % 2 ? ["nfs", "webdav"] : ["webdav", "nfs"]) {
    const root = mkdtempSync(join(tmpdir(), "atlcli-mount-bench-"));
    const mountpoint = join(root, "mount"); mkdirSync(mountpoint);
    const client = new FakeConfluenceClient()
      .seedSpace({ id: "1", key: "DOCSY", name: "Benchmark", homepageId: "100" })
      .seedPage({ id: "100", title: "Home", spaceKey: "DOCSY", storage: "<p>Benchmark home</p>" });
    const paths = ["_index.md", "_attachments/proof.txt"];
    const directories = [""];
    for (let section = 0; section < 5; section++) {
      const id = String(200 + section), directory = `section-${section}-${id}`;
      client.seedPage({ id, title: `Section ${section}`, spaceKey: "DOCSY", parentId: "100", storage: "<p>Section</p>" });
      directories.push(directory); paths.push(`${directory}/_index.md`);
      for (let page = 0; page < 4; page++) {
        const child = String(1000 + section * 4 + page);
        client.seedPage({ id: child, title: `Page ${page}`, spaceKey: "DOCSY", parentId: id,
          storage: `<p>${"Long Unicode Grüße 🐴. ".repeat(400)}</p>` });
        paths.push(`${directory}/page-${page}-${child}/_index.md`);
      }
    }
    client.seedAttachment({ id: "a1", pageId: "100", filename: "proof.txt", bytes: attachment });
    let bodyBytes = 0;
    const getPage = client.getPage.bind(client), download = client.downloadAttachment.bind(client);
    client.getPage = async (...args) => { const page = await getPage(...args); bodyBytes += Buffer.byteLength(page.storage); return page; };
    client.downloadAttachment = async (...args) => { const bytes = await download(...args); bodyBytes += bytes.length; return bytes; };
    const started = performance.now();
    const vfs = await ConfluenceVfsImpl.open({ client, profile: "benchmark-fixture", spaces: ["DOCSY"],
      mode: "ro", allowDelete: false, offline: false, cacheDir: join(root, "vfs") });
    let vfsCalls = 0;
    for (const method of ["stat", "readdir", "readFileBytes", "resolve", "readlink"] as const) {
      const original = vfs[method].bind(vfs);
      (vfs as any)[method] = (...args: any[]) => { vfsCalls++; return (original as any)(...args); };
    }
    let server: Awaited<ReturnType<typeof startNfsServer>> | Awaited<ReturnType<typeof startWebdavServer>> | undefined;
    try {
      server = transport === "nfs" ? await startNfsServer({ vfs, spaces: ["DOCSY"], helperPath: resolve(helper!) })
        : await startWebdavServer({ vfs, spaces: ["DOCSY"] });
      let command: string[];
      if (transport === "nfs") {
        const opts = `vers=3,tcp,ro,soft,timeo=10,retrans=2,port=${server.port},mountport=${server.port}`;
        command = platform() === "linux" ? ["sudo", "-n", "mount", "-t", "nfs", "-o", `${opts},nolock`, "127.0.0.1:/", mountpoint]
          : ["mount_nfs", "-o", `${opts},nolocks`, "127.0.0.1:/", mountpoint];
      } else {
        const url = mountUrlFor((server as Awaited<ReturnType<typeof startWebdavServer>>).url, ["DOCSY"]);
        if (platform() === "linux") {
          const config = join(root, "davfs.conf"), cache = join(root, "davfs-cache"); mkdirSync(cache);
          chmodSync(root, 0o755);
          // Synthetic public fixtures only; the system davfs daemon needs cache access.
          chmodSync(cache, 0o777);
          writeFileSync(config, `ask_auth 0\nuse_locks 0\ncache_dir ${cache}\n`);
          command = ["sudo", "-n", "mount", "-t", "davfs", "-o", `ro,uid=${process.getuid!()},gid=${process.getgid!()},conf=${config}`, url, mountpoint];
        } else command = ["mount_webdav", "-S", url, mountpoint];
      }
      assert.equal(await runMountCommand(command), 0, `Attach ${transport}`);
      const startupMs = performance.now() - started;
      const startupApiRequests = client.requestCount, startupBodyPayloadBytes = bodyBytes;
      assert(isMounted(mountpoint));
      const expected = new Map<string, Buffer>();
      for (const phase of ["cold", "warm"]) {
        const before = { api: client.requestCount, bodyBytes, hits: vfs.cache!.stats().hits, vfsCalls, interrupted };
        const began = performance.now(); let firstListingMs = 0, firstByteMs = 0, readBytes = 0;
        for (const directory of directories) {
          const entries: string[] = [];
          for await (const entry of await opendir(join(mountpoint, directory))) entries.push(entry.name);
          assert(entries.includes("_index.md"));
          if (!firstListingMs) firstListingMs = performance.now() - began;
        }
        const actual = new Map<string, Buffer>();
        for (const path of paths) {
          const file = await retryInterrupted(() => open(join(mountpoint, path), "r"));
          try {
            const first = Buffer.alloc(1); const { bytesRead } = await file.read(first, 0, 1, 0);
            if (!firstByteMs) firstByteMs = performance.now() - began;
            assert.equal(bytesRead, 1);
            const chunks: Buffer[] = [];
            let position = 0;
            for (;;) {
              const chunk = Buffer.alloc(128 * 1024);
              const { bytesRead } = await retryInterrupted(() => file.read(chunk, 0, chunk.length, position));
              if (bytesRead === 0) break;
              chunks.push(chunk.subarray(0, bytesRead)); position += bytesRead;
            }
            const bytes = Buffer.concat(chunks);
            actual.set(path, bytes); readBytes += bytes.length;
          } finally { await file.close(); }
        }
        const row: Record<string, unknown> = { transport, run: run + 1, phase, startupMs: phase === "cold" ? startupMs : 0,
          wallMs: performance.now() - began, firstListingMs, firstByteMs, readBytes,
          startupApiRequests: phase === "cold" ? startupApiRequests : 0,
          startupBodyPayloadBytes: phase === "cold" ? startupBodyPayloadBytes : 0,
          apiRequests: client.requestCount - before.api, bodyPayloadBytes: bodyBytes - before.bodyBytes,
          apiMethods: client.calls.slice(before.api).reduce<Record<string, number>>((counts, call) => {
            counts[call.method] = (counts[call.method] ?? 0) + 1; return counts;
          }, {}),
          cacheHits: vfs.cache!.stats().hits - before.hits, vfsCalls: vfsCalls - before.vfsCalls,
          parentRss: process.memoryUsage().rss, interruptedRetries: interrupted - before.interrupted,
          helperRss: "pid" in server ? Number(execFileSync("ps", ["-o", "rss=", "-p", String(server.pid)], { encoding: "utf8" }).trim()) * 1024 : 0 };
        for (const [path, bytes] of actual) {
          if (phase === "cold") expected.set(path, Buffer.from(await vfs.readFileBytes(`/DOCSY/${path}`)));
          assert(bytes.equals(expected.get(path)!), `${transport} ${phase} ${path}: ${bytes.length} bytes vs expected ${expected.get(path)!.length}`);
        }
        if (phase === "warm") assert.equal(row.apiRequests, 0, "Warm reads within the metadata TTL must not call the backend");
        records.push(row);
        writeFileSync(output!, JSON.stringify(results, null, 2) + "\n");
        console.error(`${transport} ${run + 1}/5 ${phase}: ${Number(row.wallMs).toFixed(1)}ms, ${row.apiRequests} API calls`);
      }
    } finally {
      if (isMounted(mountpoint)) {
        const command = platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint];
        assert.equal(await runMountCommand(command, true), 0, `Detach manually before removing ${root}`);
      }
      await server?.stop(); await vfs.close();
      if (platform() === "linux" && transport === "webdav") {
        await runMountCommand(["sudo", "-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, join(root, "davfs-cache")], true);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}
assert.equal(records.length, 20);
