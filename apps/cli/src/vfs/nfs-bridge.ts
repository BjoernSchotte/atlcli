import { SweepDetector, type SweepReport } from "./mount-client-probes.js";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { VfsError, type ConfluenceVfs } from "@atlcli/confluence-vfs";
import { NfsPublisher } from "./nfs-publisher.js";
import type { NfsJournal, NfsWriteStatus } from "./nfs-journal.js";
import { NfsFilesystem, NFS_MAX_READ } from "./nfs-filesystem.js";
import { encodeNfsFrame, NFS_BRIDGE_VERSION, readNfsFrames } from "./nfs-framing.js";

export interface RunningNfsServer {
  port: number;
  pid: number;
  /** Resolves on any helper termination. Callers must recover a surviving mount. */
  exited: Promise<void>;
  /** Complete received RPC records, including mount calls and retries. */
  requestCount(): Promise<number>;
  /** Local journal state; a stable NFS write is not a Confluence publication. */
  writeStatus(): NfsWriteStatus | null;
  stop(): Promise<void>;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid NFS bridge message");
  return value as Record<string, unknown>;
}
function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid NFS bridge integer");
  return value;
}

export async function startNfsServer(options: {
  vfs: ConfluenceVfs; spaces: readonly string[]; journal?: NfsJournal;
  journalLocation?: { path: string; scope: string };
  helperPath: string; port?: number; onSweep?: (report: SweepReport) => void;
}): Promise<RunningNfsServer> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid NFS port");
  if (!isAbsolute(options.helperPath)) throw new Error("NFS helper path must be absolute");
  if (options.journalLocation) {
    if (options.journal) throw new Error("Use either an owned journal location or a borrowed journal");
    const { NfsJournal } = await import("./nfs-journal.js");
    const journal = new NfsJournal(options.journalLocation.path, options.journalLocation.scope);
    try {
      const server = await startNfsServer({ ...options, journalLocation: undefined, journal });
      let stopping: Promise<void> | undefined;
      let closed = false;
      let finalStatus: NfsWriteStatus | null = null;
      return { ...server,
        writeStatus: () => closed ? finalStatus : server.writeStatus(),
        stop: () => stopping ??= (async () => {
          await server.stop();
          try { finalStatus = journal.writeStatus(); }
          finally { journal.close(); closed = true; }
        })(),
      };
    } catch (error) { journal.close(); throw error; }
  }

  const fs = new NfsFilesystem(options.vfs, options.spaces, new SweepDetector(50, 10_000, options.onSweep), options.journal);
  const publisher = options.journal ? new NfsPublisher(options.journal, options.vfs, options.spaces) : undefined;
  const child = spawn(options.helperPath, [String(port), ...(options.journal ? ["--staged-rw"] : [])], { stdio: ["pipe", "pipe", "pipe"], env: {} });
  // Drain diagnostic output without collecting unbounded or tenant-derived text.
  child.stderr.resume();
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  child.once("close", resolveExit);
  child.once("close", () => { void publisher?.stop(); });
  let statsSequence = 0;
  let stats: { id: number; resolve(value: number): void; reject(error: Error): void } | undefined;
  child.once("close", () => stats?.reject(new Error("NFS helper stopped")));
  child.stdin.on("error", () => { child.kill(); });
  let resolveReady!: (port: number) => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<number>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  child.once("error", () => rejectReady(new Error("Could not start NFS helper")));
  const timer = setTimeout(() => { rejectReady(new Error("NFS helper handshake timed out")); child.kill(); }, 5000);
  let writeTail: Promise<void> = Promise.resolve();
  const reply = (value: unknown): Promise<void> => {
    const frame = encodeNfsFrame(value);
    writeTail = writeTail.then(() => new Promise<void>((resolve, reject) => {
      child.stdin.write(frame, (error) => error ? reject(error) : resolve());
    }));
    return writeTail;
  };
  const serve = async (message: Record<string, unknown>): Promise<void> => {
    const id = number(message.id);
    const args = record(message.args);
    let result: unknown;
    try {
      switch (message.op) {
        case "lookup":
          if (typeof args.name !== "string") throw new Error("Invalid NFS name");
          result = await fs.lookup(number(args.parent), args.name); break;
        case "create": {
          if (typeof args.name !== "string" || typeof args.guarded !== "boolean") throw new VfsError("EINVAL", "Invalid CREATE request");
          const values: { mode?: number; size?: number } = {};
          for (const key of ["mode", "size"] as const) if (args[key] !== undefined) values[key] = number(args[key]);
          const created = await fs.createRegular(number(args.parent), args.name, args.guarded, values);
          const pending = created.pageId ?? fs.publicationId(created.file);
          if (pending !== null) publisher?.schedule(pending);
          result = created.file; break;
        }
        case "create-exclusive": {
          if (typeof args.name !== "string" || typeof args.verifier !== "string" || !/^[0-9a-f]{16}$/.test(args.verifier)) throw new VfsError("EINVAL", "Invalid exclusive CREATE");
          const file = await fs.create(number(args.parent), args.name, args.verifier);
          const pending = fs.publicationId(file);
          if (pending !== null) publisher?.schedule(pending);
          result = file; break;
        }
        case "mkdir": {
          if (typeof args.name !== "string") throw new VfsError("EINVAL", "Invalid NFS name");
          const directory = await fs.mkdir(number(args.parent), args.name, number(args.mode));
          const pending = fs.publicationId(directory);
          if (pending !== null) publisher?.schedule(pending);
          result = directory; break;
        }
        case "rmdir":
        case "remove":
          if (typeof args.name !== "string") throw new VfsError("EINVAL", "Invalid NFS name");
          await fs.remove(number(args.parent), args.name, message.op === "rmdir");
          result = null; break;
        case "rename": {
          if (typeof args.name !== "string" || typeof args.targetName !== "string") throw new VfsError("EINVAL", "Invalid NFS name");
          const pageId = await fs.rename(number(args.parent), args.name, number(args.targetParent), args.targetName);
          if (pageId !== null) publisher?.schedule(pageId);
          result = null; break;
        }
        case "set-attributes": {
          const values: { mode?: number; atime?: number; mtime?: number } = {};
          for (const key of ["mode", "atime", "mtime"] as const) if (args[key] !== undefined) values[key] = number(args[key]);
          await fs.setAttributes(number(args.file), values);
          result = await fs.getattr(number(args.file)); break;
        }
        case "getattr": result = await fs.getattr(number(args.file)); break;
        case "read": result = await fs.read(number(args.file), number(args.offset), number(args.count)); break;
        case "write": {
          if (typeof args.data !== "string" || args.data.length > Math.ceil(NFS_MAX_READ / 3) * 4) throw new VfsError("EINVAL", "Invalid NFS write data");
          const bytes = Buffer.from(args.data, "base64");
          if (bytes.toString("base64") !== args.data || bytes.length > NFS_MAX_READ) throw new VfsError("EINVAL", "Invalid NFS write data");
          const pageId = await fs.write(number(args.file), number(args.offset), bytes);
          if (pageId !== null) publisher?.schedule(pageId);
          result = await fs.getattr(number(args.file)); break;
        }
        case "truncate": {
          const pageId = await fs.truncate(number(args.file), number(args.size));
          if (pageId !== null) publisher?.schedule(pageId);
          result = await fs.getattr(number(args.file)); break;
        }
        case "readdir":
          if (typeof args.verifier !== "string" || !/^[0-9a-f]{16}$/.test(args.verifier)) throw new Error("Invalid NFS directory verifier");
          result = await fs.readdir(number(args.file), number(args.after), number(args.count), args.verifier); break;
        default: throw new Error("Unsupported NFS bridge operation");
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "EIO";
      await reply({ id, error: code === "SQLITE_FULL" ? "ENOSPC" : code });
      return;
    }
    await reply({ id, result });
  };
  const serving = (async () => {
    let initialized = false;
    const pending = new Set<Promise<void>>();
    try {
      for await (const raw of readNfsFrames(child.stdout)) {
        const message = record(raw);
        if (!initialized) {
          const bound = number(message.port);
          if (message.hello !== NFS_BRIDGE_VERSION || message.mode !== (options.journal ? "staged-rw" : "ro") || bound < 1 || bound > 65535 || (port !== 0 && port !== bound)) {
            throw new Error("Incompatible NFS helper handshake");
          }
          initialized = true;
          clearTimeout(timer);
          resolveReady(bound);
          continue;
        }
        if ("stats" in message) {
          const id = number(message.stats), requests = number(message.requests);
          if (stats?.id === id) stats.resolve(requests);
          continue;
        }
        if (pending.size >= 32) await Promise.race(pending);
        const task = serve(message);
        pending.add(task);
        void task.then(() => pending.delete(task), () => { pending.delete(task); child.kill(); });
      }
      await Promise.all(pending);
      if (!initialized) throw new Error("NFS helper exited before handshake");
    } catch (error) {
      rejectReady(error instanceof Error ? error : new Error("NFS bridge failed"));
      child.kill();
    } finally { clearTimeout(timer); }
  })();
  try {
    const bound = await ready;
    publisher?.resume();
    let stopping: Promise<void> | undefined;
    return { port: bound, pid: child.pid!, exited,
      writeStatus: () => options.journal?.writeStatus() ?? null,
      requestCount: async () => {
      if (stats) throw new Error("NFS statistics request already pending");
      if (child.exitCode !== null || child.signalCode !== null) throw new Error("NFS helper stopped");
      const id = ++statsSequence;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await new Promise<number>((resolve, reject) => {
          stats = { id, resolve, reject };
          timeout = setTimeout(() => reject(new Error("NFS statistics timed out")), 5000);
          void reply({ stats: id }).catch(reject);
        });
      } finally { clearTimeout(timeout); stats = undefined; }
    }, stop: () => stopping ??= (async () => {
      const publishing = publisher?.stop();
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await exited; await serving; await publishing; } finally { clearTimeout(kill); }
      const status = options.journal?.writeStatus();
      if (status && Object.values(status).some(count => count > 0)) {
        process.stderr.write(`atlcli: NFS stopped with durable local recovery data: ${status.pendingPages} pending pages, ${status.failedPages} failed pages, ${status.displacedPages} interrupted replacements, ${status.localEntries} local editor entries, ${status.unresolvedPublications} unresolved publications. Keep the journal; local durability does not confirm Confluence publication.\n`);
      }
    })() };
  } catch (error) {
    child.kill();
    await exited;
    await serving;
    await publisher?.stop();
    throw error;
  }
}
