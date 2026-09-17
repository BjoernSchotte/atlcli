import { nfsMountOptionsFor } from "../../apps/cli/src/vfs/mount-transport.js";
/** Native read-only transport comparison. Run with bun --conditions=development. */
import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { open, opendir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { platform, release, arch, tmpdir } from "node:os";
import { ConfluenceVfsImpl } from "@atlcli/confluence-vfs";
import { FakeConfluenceClient } from "@atlcli/confluence-vfs/testing";
import { startNfsServer } from "../../apps/cli/src/vfs/nfs-bridge.js";
import { startWebdavServer } from "../../apps/cli/src/vfs/webdav-server.js";
import { isMounted, mountUrlFor, runMountCommand } from "../../apps/cli/src/commands/wiki-mount.js";

const helper = process.env.ATLCLI_NFS_TEST_HELPER;
const output = process.argv[2];
const sample = process.argv[3];
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
const results = { schema: 3, host: { os: platform(), release: release(), arch: arch(), bun: Bun.version },
  corpus: { pages: 26, attachmentBytes: attachment.length, backend: "in-process synthetic; no network latency" },
  cachePolicy: "Cold: fresh mount, endpoint, VFS and davfs cache. Warm: immediate identical workload on same mount.",
  limitations: ["Body payload bytes exclude API metadata/HTTP overhead", "Peak RSS covers one isolated transport run (startup, cold, warm and shutdown), not each phase", "Protocol requests count complete NFS RPC records or received WebDAV HTTP requests; incomplete records are excluded", "No Glow/editor/write timing"], records };

function peakRss(path: string): number {
  const usage = readFileSync(path, "utf8");
  const match = platform() === "darwin"
    ? /([0-9]+)\s+maximum resident set size/.exec(usage)
    : /Maximum resident set size \(kbytes\):\s*([0-9]+)/.exec(usage);
  assert(match, "Missing native peak RSS");
  const bytes = Number(match[1]) * (platform() === "darwin" ? 1 : 1024);
  assert(Number.isSafeInteger(bytes) && bytes > 0);
  return bytes;
}

// Isolate allocator high-water marks between transports/runs.
if (!sample) {
  const scratch = mkdtempSync(join(tmpdir(), "atlcli-bench-results-"));
  try {
    for (let run = 0; run < 5; run++) {
      for (const transport of run % 2 ? ["nfs", "webdav"] : ["webdav", "nfs"]) {
        const path = join(scratch, `${run}-${transport}.json`);
        const usagePath = join(scratch, `${run}-${transport}-usage.txt`);
        const child = Bun.spawn(["/usr/bin/time", platform() === "darwin" ? "-l" : "-v", "-o", usagePath,
          process.execPath, "--conditions=development", import.meta.path, path, `${run}:${transport}`], { stdout: "inherit", stderr: "inherit" });
        assert.equal(await child.exited, 0, `Benchmark ${run}:${transport}`);
        const parentPeakRss = peakRss(usagePath);
        const rows = JSON.parse(readFileSync(path, "utf8")).records;
        assert.equal(rows.length, 2);
        for (const row of rows) {
          assert(row.parentRss <= parentPeakRss, "Native peak must cover sampled RSS");
          records.push({ ...row, parentPeakRss });
        }
        writeFileSync(output!, JSON.stringify(results, null, 2) + "\n");
      }
    }
    assert.equal(records.length, 20);
  } finally { rmSync(scratch, { recursive: true, force: true }); }
  process.exit(0);
}
assert(/^[0-4]:(webdav|nfs)$/.test(sample), "Invalid benchmark worker");

for (let run = 0; run < 5; run++) {
  for (const transport of run % 2 ? ["nfs", "webdav"] : ["webdav", "nfs"]) {
    if (sample !== `${run}:${transport}`) continue;
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
    const usagePath = join(root, "helper-usage.txt");
    const timedHelper = join(root, "timed-helper");
    if (transport === "nfs") {
      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
      writeFileSync(timedHelper, `#!/bin/sh\nexec /usr/bin/time ${platform() === "darwin" ? "-l" : "-v"} -o ${quote(usagePath)} ${quote(resolve(helper!))} "$@"\n`, { mode: 0o700 });
    }
    let server: Awaited<ReturnType<typeof startNfsServer>> | Awaited<ReturnType<typeof startWebdavServer>> | undefined;
    try {
      server = transport === "nfs" ? await startNfsServer({ vfs, spaces: ["DOCSY"], helperPath: timedHelper })
        : await startWebdavServer({ vfs, spaces: ["DOCSY"] });
      let command: string[];
      if (transport === "nfs") {
        const opts = nfsMountOptionsFor(platform(), server.port);
        command = platform() === "linux" ? ["sudo", "-n", "mount", "-t", "nfs", "-o", opts, "127.0.0.1:/", mountpoint]
          : ["mount_nfs", "-o", opts, "127.0.0.1:/", mountpoint];
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
      const startupProtocolRequests = await server.requestCount();
      assert(isMounted(mountpoint));
      const expected = new Map<string, Buffer>();
      for (const phase of ["cold", "warm"]) {
        const before = { api: client.requestCount, bodyBytes, hits: vfs.cache!.stats().hits, vfsCalls, interrupted,
          protocol: await server.requestCount() };
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
        const wallMs = performance.now() - began;
        const protocolRequests = await server.requestCount() - before.protocol;
        const row: Record<string, unknown> = { transport, run: run + 1, phase, startupMs: phase === "cold" ? startupMs : 0,
          wallMs, firstListingMs, firstByteMs, readBytes, protocolRequests,
          startupProtocolRequests: phase === "cold" ? startupProtocolRequests : 0,
          startupApiRequests: phase === "cold" ? startupApiRequests : 0,
          startupBodyPayloadBytes: phase === "cold" ? startupBodyPayloadBytes : 0,
          apiRequests: client.requestCount - before.api, bodyPayloadBytes: bodyBytes - before.bodyBytes,
          apiMethods: client.calls.slice(before.api).reduce<Record<string, number>>((counts, call) => {
            counts[call.method] = (counts[call.method] ?? 0) + 1; return counts;
          }, {}),
          cacheHits: vfs.cache!.stats().hits - before.hits, vfsCalls: vfsCalls - before.vfsCalls,
          parentRss: process.memoryUsage().rss, interruptedRetries: interrupted - before.interrupted };
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
      const shutdownBegan = performance.now();
      if (isMounted(mountpoint)) {
        const command = platform() === "linux" ? ["sudo", "-n", "umount", mountpoint] : ["umount", mountpoint];
        assert.equal(await runMountCommand(command, true), 0, `Detach manually before removing ${root}`);
      }
      await server?.stop(); await vfs.close();
      const shutdownMs = performance.now() - shutdownBegan;
      const helperPeakRss = server && transport === "nfs" ? peakRss(usagePath) : 0;
      for (const row of records) Object.assign(row, { shutdownMs, helperPeakRss });
      writeFileSync(output!, JSON.stringify(results, null, 2) + "\n");
      if (platform() === "linux" && transport === "webdav") {
        await runMountCommand(["sudo", "-n", "chown", "-R", `${process.getuid!()}:${process.getgid!()}`, join(root, "davfs-cache")], true);
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
}
assert.equal(records.length, 2);
