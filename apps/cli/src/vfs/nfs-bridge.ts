import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import type { ConfluenceVfs } from "@atlcli/confluence-vfs";
import { NfsFilesystem } from "./nfs-filesystem.js";
import { encodeNfsFrame, NFS_BRIDGE_VERSION, readNfsFrames } from "./nfs-framing.js";

export interface RunningNfsServer {
  port: number;
  pid: number;
  /** Resolves on any helper termination. Callers must recover a surviving mount. */
  exited: Promise<void>;
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
  vfs: ConfluenceVfs; spaces: readonly string[]; helperPath: string; port?: number;
}): Promise<RunningNfsServer> {
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid NFS port");
  if (!isAbsolute(options.helperPath)) throw new Error("NFS helper path must be absolute");
  const fs = new NfsFilesystem(options.vfs, options.spaces);
  const child = spawn(options.helperPath, [String(port)], { stdio: ["pipe", "pipe", "pipe"], env: {} });
  // Drain diagnostic output without collecting unbounded or tenant-derived text.
  child.stderr.resume();
  let resolveExit!: () => void;
  const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
  child.once("close", resolveExit);
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
        case "getattr": result = await fs.getattr(number(args.file)); break;
        case "read": result = await fs.read(number(args.file), number(args.offset), number(args.count)); break;
        case "readdir":
          if (typeof args.verifier !== "string" || !/^[0-9a-f]{16}$/.test(args.verifier)) throw new Error("Invalid NFS directory verifier");
          result = await fs.readdir(number(args.file), number(args.after), number(args.count), args.verifier); break;
        default: throw new Error("Unsupported NFS bridge operation");
      }
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "EIO";
      await reply({ id, error: code });
      return;
    }
    await reply({ id, result });
  };
  void (async () => {
    let initialized = false;
    const pending = new Set<Promise<void>>();
    try {
      for await (const raw of readNfsFrames(child.stdout)) {
        const message = record(raw);
        if (!initialized) {
          const bound = number(message.port);
          if (message.hello !== NFS_BRIDGE_VERSION || message.mode !== "ro" || bound < 1 || bound > 65535 || (port !== 0 && port !== bound)) {
            throw new Error("Incompatible NFS helper handshake");
          }
          initialized = true;
          clearTimeout(timer);
          resolveReady(bound);
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
    return { port: bound, pid: child.pid!, exited, stop: async () => {
      child.stdin.end();
      const kill = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { await exited; } finally { clearTimeout(kill); }
    } };
  } catch (error) {
    child.kill();
    await exited;
    throw error;
  }
}
